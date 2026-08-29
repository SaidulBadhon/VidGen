/**
 * The single-writer lock for the footage library.
 *
 * Design v3 deleted v2's per-row leases — an `owner_id`, a `generation`
 * counter and tombstones — because the mechanism they were copied from
 * (`isOwnerAlive()`) cannot work for a long-lived worker: it reports the
 * *current* process's own pid as dead, so a sweep would reset rows its own
 * live workers held, and it reports any foreign hostname as alive, so a row
 * abandoned by a Ctrl-C'd host CLI would be immortal. Nothing replaced them
 * per row, because the filesystem is the work-list and re-running the indexer
 * is idempotent by construction.
 *
 * What *does* need protecting is the pair of assumptions the whole design
 * rests on:
 *
 *  1. **One writer at a time.** Two concurrent `indexAll` runs would both
 *     describe the same clips — the expensive half — and race each other's
 *     "mark indexed" writes. Nothing would corrupt, but the Gemini bill would
 *     double for no benefit.
 *  2. **No cache clear underneath a run.** `POST /api/v1/cache/clear` deletes
 *     the files an in-flight run is describing, so it answers 409 while this
 *     lock is held (design §4.1). That single check is what removes v2's
 *     entire clear-versus-indexer resurrection race.
 *
 * **Expiry is logical, not a Mongo TTL index.** A TTL index is swept by a
 * background thread that runs about once a minute, so a lock with a 60 s TTL
 * could survive for two — and, worse, its removal is invisible to the process
 * holding it. Here `expires_at` is compared against `now` inside the *same*
 * conditional update that acquires the lock, so the deadline is exact, is
 * evaluated by the server, and needs no reaper. A crashed holder therefore
 * blocks a new run for at most `LOCK_TTL_MS`, and never longer.
 *
 * The owner token is what makes release and heartbeat safe: both are
 * conditional on it, so a process whose lock already expired and was taken by
 * someone else can neither extend nor free the new holder's lock.
 */

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { Collection } from "mongodb";

import { connect } from "../../db/client.ts";
import { errorMessage, errorName, logger } from "../../utils/logger.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The one lock document's id. There is exactly one — the library is a single
 * resource, not a set of independently lockable rows.
 */
export const FOOTAGE_LOCK_ID = "footage_index_lock";

/**
 * Its own collection rather than a sentinel row inside `footage_index`.
 *
 * `footage_index` carries a unique index on `local_file` and is read with
 * `find({})` by both the indexer and `stats()`; a lock document living there
 * would have to be filtered out of every one of those reads, and the first
 * caller to forget would count it as a clip or try to index it.
 */
const LOCK_COLLECTION = "footage_locks";

/**
 * How long a lock survives without a heartbeat.
 *
 * This is not "how long a run takes" — a run holds the lock for as long as it
 * likes by heartbeating. It is "how long a *dead* holder blocks the next run",
 * so it wants to be short. One minute is comfortably longer than three missed
 * heartbeats against a briefly stalled Mongo, and short enough that a
 * `kill -9` during an overnight pull does not make the morning's run fail.
 */
export const LOCK_TTL_MS = 60_000;

/**
 * Heartbeat period, a third of the TTL: two consecutive failures still leave a
 * third attempt before the lock is forfeit.
 */
const HEARTBEAT_INTERVAL_MS = Math.floor(LOCK_TTL_MS / 3);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The lock document. Local to this module — nothing else reads its shape. */
interface FootageLockDocument {
  _id: string;
  /** Random per acquisition. Release and heartbeat are conditional on it. */
  owner: string;
  /** What is holding it, for the 409 body and for `footage status`. */
  label: string;
  hostname: string;
  pid: number;
  acquired_at: Date;
  heartbeat_at: Date;
  /** Compared against `now` by the server; the lock is free once it passes. */
  expires_at: Date;
}

/** What a caller that lost the race is told, and what `isLocked()` returns. */
export interface FootageLockStatus {
  label: string;
  hostname: string;
  pid: number;
  acquired_at: Date;
  heartbeat_at: Date;
  expires_at: Date;
}

/** Raised when the lock is already held. T11 maps this to HTTP 409. */
export class FootageLockedError extends Error {
  readonly status: FootageLockStatus | null;

  constructor(status: FootageLockStatus | null) {
    super(
      status
        ? `the footage index is locked by ${status.label} ` +
            `(${status.hostname} pid ${status.pid}, held since ${status.acquired_at.toISOString()})`
        : "the footage index is locked by another run",
    );
    this.name = "FootageLockedError";
    this.status = status;
  }
}

/**
 * Handed to the function running under the lock.
 *
 * `signal` aborts if the lock is ever lost mid-run — which can only happen
 * when heartbeats have failed for a full TTL, i.e. Mongo has been unreachable
 * for a minute. A long run should honour it rather than keep writing points
 * for a library some other process now believes it owns.
 */
export interface FootageLockHandle {
  owner: string;
  signal: AbortSignal;
  /** False once a heartbeat has found the lock taken by someone else. */
  held(): boolean;
}

export interface WithLockOptions {
  /** Recorded on the document, e.g. `"index"`, `"pull"`, `"reconcile"`. */
  label?: string;
  /**
   * Milliseconds to keep retrying acquisition before giving up. Zero — the
   * default — fails immediately, which is what a CLI subcommand and an HTTP
   * handler both want: a queued second indexer is not more useful than an
   * error saying one is already running.
   */
  waitMs?: number;
  /** Poll period while waiting. */
  retryMs?: number;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * `connect()` rather than a `db/client.ts` accessor: this collection is
 * private to the lock, so adding a public accessor for it would widen that
 * module's surface for one caller. `connect()` returns the live handle when
 * one exists, so inside the server this is not a connection attempt.
 */
async function lockCollection(): Promise<Collection<FootageLockDocument>> {
  const database = await connect();
  return database.collection<FootageLockDocument>(LOCK_COLLECTION);
}

function toStatus(document: FootageLockDocument): FootageLockStatus {
  return {
    label: document.label,
    hostname: document.hostname,
    pid: document.pid,
    acquired_at: document.acquired_at,
    heartbeat_at: document.heartbeat_at,
    expires_at: document.expires_at,
  };
}

/** Mongo's duplicate-key code, which here means "someone else holds it". */
function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === 11000;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Who holds the lock right now, or `null` if it is free.
 *
 * An expired document reads as free, matching what `acquire` would do with it,
 * so a caller can never be told "locked" by a row no acquisition would respect.
 */
export async function isLocked(): Promise<FootageLockStatus | null> {
  const collection = await lockCollection();
  const document = await collection.findOne({ _id: FOOTAGE_LOCK_ID });
  if (!document) return null;
  if (document.expires_at.getTime() <= Date.now()) return null;
  return toStatus(document);
}

/**
 * Takes the lock, or throws `FootageLockedError`.
 *
 * The write is one conditional upsert. The filter matches only an *expired*
 * document, so if a live one exists Mongo falls through to the insert, which
 * collides on `_id` and raises a duplicate key — the atomic "someone else has
 * it" signal, decided by the server rather than by a read-then-write here.
 */
async function acquire(label: string): Promise<string> {
  const collection = await lockCollection();
  const owner = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

  try {
    await collection.updateOne(
      { _id: FOOTAGE_LOCK_ID, expires_at: { $lte: now } },
      {
        $set: {
          owner,
          label,
          hostname: hostname(),
          pid: process.pid,
          acquired_at: now,
          heartbeat_at: now,
          expires_at: expiresAt,
        },
      },
      { upsert: true },
    );
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    throw new FootageLockedError(await isLocked());
  }

  return owner;
}

/**
 * Pushes the deadline out, but only while this process still owns the lock.
 *
 * Returns false when the document is gone or has been taken over — never
 * re-acquiring it, because the point of losing a lock is that another writer
 * is already acting on the assumption that it is theirs.
 */
async function heartbeat(owner: string): Promise<boolean> {
  const collection = await lockCollection();
  const now = new Date();
  const result = await collection.updateOne(
    { _id: FOOTAGE_LOCK_ID, owner },
    { $set: { heartbeat_at: now, expires_at: new Date(now.getTime() + LOCK_TTL_MS) } },
  );
  return result.matchedCount === 1;
}

/** Frees the lock, if this process still holds it. */
async function release(owner: string): Promise<void> {
  const collection = await lockCollection();
  await collection.deleteOne({ _id: FOOTAGE_LOCK_ID, owner });
}

/**
 * Runs `fn` as the library's single writer.
 *
 * Every long footage operation — `indexAll`, `reconcile`, a pull — is meant to
 * be wrapped here by its entry point (the CLI, a route) rather than to take
 * the lock internally, so that a caller composing two of them holds it once
 * across both instead of deadlocking against itself.
 *
 * The lock is always released, including when `fn` throws, and the heartbeat
 * timer is unref'd so it can never be the reason a CLI process fails to exit.
 */
export async function withLock<T>(
  fn: (lock: FootageLockHandle) => Promise<T>,
  options: WithLockOptions = {},
): Promise<T> {
  const { label = "footage", waitMs = 0, retryMs = 1_000 } = options;

  const owner = await acquireWithWait(label, waitMs, retryMs);

  const controller = new AbortController();
  let stillHeld = true;

  const timer = setInterval(() => {
    void (async () => {
      try {
        if (await heartbeat(owner)) return;
        // Only reachable after a full TTL of failed heartbeats: someone else
        // has taken the lock, so this run must stop rather than keep writing.
        stillHeld = false;
        logger.warning(`footage lock lost while running ${label}; aborting the run`);
        controller.abort(new FootageLockedError(await isLocked().catch(() => null)));
      } catch (error) {
        // A transient Mongo failure is not a lost lock — there are two more
        // attempts before the deadline passes.
        logger.debug(
          `footage lock heartbeat failed: error=${errorName(error)}, detail=${errorMessage(error)}`,
        );
      }
    })();
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  try {
    return await fn({ owner, signal: controller.signal, held: () => stillHeld });
  } finally {
    clearInterval(timer);
    try {
      if (stillHeld) await release(owner);
    } catch (error) {
      // The lock expires on its own, so a failed release costs at most one
      // TTL of waiting — never correctness, and never this call's result.
      logger.warning(
        `failed to release the footage lock: error=${errorName(error)}, detail=${errorMessage(error)}`,
      );
    }
  }
}

/** `acquire` plus the optional bounded wait, kept out of `withLock`'s body. */
async function acquireWithWait(label: string, waitMs: number, retryMs: number): Promise<string> {
  const deadline = Date.now() + Math.max(0, waitMs);

  for (;;) {
    try {
      return await acquire(label);
    } catch (error) {
      if (!(error instanceof FootageLockedError)) throw error;
      if (Date.now() + retryMs > deadline) throw error;
      await Bun.sleep(retryMs);
    }
  }
}

/**
 * Test and operator escape hatch: drops the lock whoever holds it.
 *
 * Deliberately not called by anything in the normal flow. It exists because a
 * machine that lost power mid-run leaves a document that is free anyway after
 * one TTL, and an operator staring at a 409 should have something better to do
 * than wait or open a Mongo shell.
 */
export async function forceReleaseLock(): Promise<boolean> {
  const collection = await lockCollection();
  const result = await collection.deleteOne({ _id: FOOTAGE_LOCK_ID });
  return result.deletedCount === 1;
}
