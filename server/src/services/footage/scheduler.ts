/**
 * The periodic index pass, run from inside the server process.
 *
 * ## Why this exists at all
 *
 * A render that downloads a clip gets a provenance row and nothing else: the
 * download hook records *where* the clip came from, it does not describe it
 * (`hook.ts`). Until an index pass runs, that clip is on disk, is in
 * `footage_index`, and is **not searchable** — so "the next render can reuse
 * it" is false. Something has to close that gap on a schedule.
 *
 * ## Why it is in-process
 *
 * The obvious homes were tried and both fail on this machine. macOS TCC denies
 * a cron job and a launchd agent access to `~/Documents`, where the repo lives:
 * the job never reaches bun, it dies at `getcwd: Operation not permitted` with
 * exit 126. Neither survived, and neither can be made to without moving the
 * repo or granting Full Disk Access to `/bin/sh`. The server process, started
 * by the user in a terminal, already has that access and already runs for as
 * long as the loop needs to. So the loop lives here.
 *
 * ## The four properties that matter
 *
 *  1. **It never runs twice at once.** Two concurrent `indexAll` runs would
 *     both describe the same clips — the expensive half — and race each other's
 *     writes. Guarded twice: an in-process flag for our own overlapping ticks,
 *     and the shared Mongo lock (`lock.ts`) for a CLI run started by hand.
 *     A `FootageLockedError` from that lock is not a failure, it is the answer
 *     "someone else is already indexing", and the tick simply skips.
 *  2. **It never destabilises the server.** Every failure is caught here.
 *     Nothing this module starts can reject into the process, because an
 *     unhandled rejection from a background timer takes the API down with it.
 *     A failed pass is logged, and the next tick tries again — the filesystem
 *     is the work-list, so a lost pass costs freshness and nothing else.
 *  3. **It does not fire on startup.** The first tick lands one full interval
 *     in. A boot-time pass over a cold cache would compete with
 *     `recoverInterruptedTasks` for Mongo and hold the event loop while the
 *     first requests are arriving, for work that has waited hours already.
 *  4. **It stops before Mongo does.** `shutdown()` calls
 *     `stopFootageIndexScheduler()` ahead of `disconnect()`. Without that
 *     ordering a tick can fire against a closed client, and the first thing it
 *     would do is take a lock it can never release.
 */

import { getSettings } from "../../config/settings.ts";
import { errorMessage, errorName, logger } from "../../utils/logger.ts";
import { indexAll, type IndexRunResult } from "./index.ts";
import { FootageLockedError, withLock } from "./lock.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Floor on the computed period.
 *
 * `index_interval_minutes` is a float so the loop can be exercised in seconds
 * rather than minutes, which also means a slipped decimal point can ask for a
 * tick every few milliseconds. Zero still disables; anything above zero is
 * held to at least this, so a typo degrades to "often" instead of to a spin.
 */
export const MIN_INTERVAL_MS = 1_000;

/** What the lock document records while a scheduled pass holds it. */
const LOCK_LABEL = "footage index (scheduled)";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What one tick did.
 *
 * Returned rather than thrown, including for failures: a caller that wants to
 * know is a test or a future manual trigger, and neither is served by an
 * exception from a function whose whole contract is that it does not raise.
 */
export type PassOutcome =
  /** The pass ran to completion (`aborted` and `fatal` live on the result). */
  | { status: "ran"; result: IndexRunResult }
  /** Another process holds the library lock — a CLI run, or a second server. */
  | { status: "locked"; reason: string }
  /** This process is already mid-pass; the tick coalesced into that one. */
  | { status: "busy" }
  /** `footage_index.enabled` is off, so nothing should be added to the library. */
  | { status: "disabled" }
  /** Anything else. Logged here, never rethrown. */
  | { status: "failed"; error: unknown };

/**
 * The seams a test replaces.
 *
 * The suite uses no mocking library, so every dependency that touches the
 * clock, Mongo, Qdrant or Gemini is a function with a real default and an
 * injectable override. In particular the timer is injected, which is what lets
 * a test fire ticks on demand instead of waiting on wall-clock time.
 */
export interface SchedulerDeps {
  /** Period in ms; `<= 0` disables. Defaults to the `footage_index` setting. */
  intervalMs?: () => number;
  /** The master switch. Defaults to `footage_index.enabled`. */
  enabled?: () => boolean;
  /** One pass under the shared lock. Defaults to `withLock(() => indexAll())`. */
  index?: (signal: AbortSignal) => Promise<IndexRunResult>;
  /** Repeating timer. Defaults to an unref'd `setInterval`. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/**
 * The running timer, or null. One per process: there is one cache directory
 * and one lock, so a second loop would only ever contend with the first.
 */
let timer: unknown = null;

/** The deps the running loop was started with, so ticks keep their seams. */
let timerDeps: SchedulerDeps = {};

/** How a running loop clears its own timer, captured at start. */
let timerClear: (handle: unknown) => void = defaultClearTimer;

/**
 * The pass currently in flight, or null.
 *
 * This *is* the in-process coalescing guard — a non-null value means a pass is
 * running, and a tick that sees one returns rather than starting a second.
 * Holding the promise rather than a boolean also gives a caller something to
 * await, which is how a test observes a tick it fired.
 */
let inFlight: Promise<PassOutcome> | null = null;

/** Aborts the in-flight pass on shutdown. Null whenever `inFlight` is null. */
let inFlightAbort: AbortController | null = null;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const handle = setInterval(fn, ms);
  // Unref'd for the same reason the lock's heartbeat is: a background timer
  // must never be the thing keeping the process from exiting.
  handle.unref?.();
  return handle;
}

function defaultClearTimer(handle: unknown): void {
  clearInterval(handle as ReturnType<typeof setInterval>);
}

/**
 * The real pass: the whole cache directory, under the library lock.
 *
 * `waitMs` is left at its default of zero. Queueing behind another writer is
 * pointless for a loop that will come back on its own in an interval, and a
 * blocked acquisition would hold this pass open across the next tick.
 *
 * Two signals reach `indexAll`: ours, which shutdown aborts, and the lock's,
 * which fires if the heartbeat loses the lock mid-run. Either one should stop
 * the pass, which is what `AbortSignal.any` expresses.
 */
async function defaultIndex(signal: AbortSignal): Promise<IndexRunResult> {
  return withLock(
    async (lock) => indexAll({ signal: AbortSignal.any([signal, lock.signal]) }),
    { label: LOCK_LABEL },
  );
}

// ---------------------------------------------------------------------------
// Interval
// ---------------------------------------------------------------------------

/**
 * The configured period in milliseconds, or `0` when the loop is off.
 *
 * A non-finite or negative setting reads as disabled rather than as an error:
 * a bad number in the settings document must not stop the server from booting.
 */
export function footageIndexIntervalMs(): number {
  let minutes: number;
  try {
    minutes = getSettings().footage_index.index_interval_minutes;
  } catch {
    // Settings are not loaded — before `initSettings`, or in a unit test that
    // never installed them. Nothing to schedule against.
    return 0;
  }
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.max(MIN_INTERVAL_MS, Math.round(minutes * 60_000));
}

// ---------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------

/**
 * Runs one index pass, unless one is already running.
 *
 * **Never rejects.** Every failure comes back as `{ status: "failed" }`, and
 * the returned promise is the one the coalescing guard hands to a second
 * caller, so awaiting it is safe from anywhere.
 *
 * Exported because the tick body and a deliberate trigger want exactly the
 * same thing, including the guard: a manual run that ignored the in-flight
 * pass would be the one way to get two describers going at once.
 */
export function runFootageIndexPass(deps: SchedulerDeps = {}): Promise<PassOutcome> {
  const existing = inFlight;
  if (existing) {
    logger.debug("footage index scheduler: a pass is already running, skipping this tick");
    // The *same* promise, so a caller that awaits it waits for the pass that
    // is actually running rather than for nothing.
    return existing.then(() => ({ status: "busy" }) as PassOutcome);
  }

  const controller = new AbortController();
  inFlightAbort = controller;

  const pass = executePass(deps, controller.signal);
  inFlight = pass;

  return pass.finally(() => {
    if (inFlight === pass) {
      inFlight = null;
      inFlightAbort = null;
    }
  });
}

/**
 * The body of a pass, with every exit logged.
 *
 * Logging lives here rather than at the call site so that a tick, a test and
 * any future manual trigger all produce the same lines.
 */
async function executePass(deps: SchedulerDeps, signal: AbortSignal): Promise<PassOutcome> {
  const enabled = deps.enabled ?? (() => settingEnabled());
  const index = deps.index ?? defaultIndex;

  try {
    if (!enabled()) {
      logger.debug("footage index scheduler: footage_index.enabled is false, skipping this pass");
      return { status: "disabled" };
    }

    const result = await index(signal);
    logRun(result);
    return { status: "ran", result };
  } catch (error) {
    if (error instanceof FootageLockedError) {
      // Not a failure. Another writer — a hand-run CLI, a second server — is
      // doing exactly this work, and the next tick will find it done.
      logger.debug(`footage index scheduler: skipping, ${error.message}`);
      return { status: "locked", reason: error.message };
    }
    // The catch-all that keeps property 2 true. Nothing escapes into a timer
    // callback, where it would surface as an unhandled rejection.
    logger.error(
      `footage index scheduler: pass failed: error=${errorName(error)}, detail=${errorMessage(error)}`,
    );
    return { status: "failed", error };
  }
}

/** `footage_index.enabled`, defaulting to off when settings are not loaded. */
function settingEnabled(): boolean {
  try {
    return Boolean(getSettings().footage_index.enabled);
  } catch {
    return false;
  }
}

/**
 * Info when the pass did something, debug when it did not.
 *
 * A quiet loop is the normal state — an indexed cache resolves every file to a
 * skip and reports `attempted: 0` — and an hourly "nothing to do" at info would
 * train everyone to ignore the line that matters. When work *did* happen the
 * line is worth having in `storage/logs`, because it is the only evidence the
 * loop is alive.
 */
function logRun(result: IndexRunResult): void {
  const summary =
    `scanned=${result.scanned}, attempted=${result.attempted}, indexed=${result.indexed}, ` +
    `refreshed=${result.refreshed}, failed=${result.failed}, described=${result.described}, ` +
    `${(result.elapsed_ms / 1000).toFixed(1)}s`;

  if (result.fatal) {
    // The library itself is unusable — no API key, Qdrant down, Mongo refusing
    // writes. Loud, but still not thrown: the next tick retries.
    logger.warning(`footage index scheduler: pass stopped: ${result.fatal} (${summary})`);
    return;
  }
  if (result.attempted > 0) {
    logger.info(`footage index scheduler: ${summary}`);
    return;
  }
  logger.debug(`footage index scheduler: nothing to index (${summary})`);
}

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------

/**
 * Arms the loop. Returns the period it armed, or `0` when it did not.
 *
 * Synchronous and non-blocking on purpose: the bootstrap calls this on the way
 * to `Bun.serve`, and an index pass must never be something the first HTTP
 * request waits behind. The first tick is one full interval away (property 3).
 *
 * Starting twice is a no-op rather than an error — the second call keeps the
 * first loop, because two loops would only contend for one lock.
 */
export function startFootageIndexScheduler(deps: SchedulerDeps = {}): number {
  if (timer !== null) {
    logger.debug("footage index scheduler: already running");
    return 0;
  }

  const interval = (deps.intervalMs ?? footageIndexIntervalMs)();
  if (!Number.isFinite(interval) || interval <= 0) {
    logger.info("footage index scheduler: disabled (footage_index.index_interval_minutes is 0)");
    return 0;
  }

  timerDeps = deps;
  timerClear = deps.clearTimer ?? defaultClearTimer;
  timer = (deps.setTimer ?? defaultSetTimer)(tick, interval);

  logger.info(
    `footage index scheduler: every ${(interval / 60_000).toFixed(2)} min, ` +
      `first pass in ${(interval / 1000).toFixed(0)}s`,
  );
  return interval;
}

/**
 * The timer callback.
 *
 * Returns `void`, so the promise has to be detached — and detaching it is only
 * safe because `runFootageIndexPass` cannot reject. The `.catch` is belt and
 * braces for that invariant, not a substitute for it.
 */
function tick(): void {
  void runFootageIndexPass(timerDeps).catch((error: unknown) => {
    logger.error(`footage index scheduler: tick escaped: ${errorMessage(error)}`);
  });
}

/**
 * Disarms the loop and asks any in-flight pass to stop.
 *
 * Deliberately synchronous and *not* awaiting the pass. It is called from
 * `shutdown()`, which is a few milliseconds from `process.exit(0)`; waiting for
 * a describe call in flight would trade a clean exit for a slow one. Aborting
 * is enough — `indexAll` stops between clips, `withLock` releases on the way
 * out, and a lock that outlives the process expires on its own within one TTL.
 *
 * The order in `shutdown()` matters more than anything this function does:
 * clearing the timer has to happen before `disconnect()`, or a tick fires
 * against a closed Mongo client.
 */
export function stopFootageIndexScheduler(): void {
  if (timer !== null) {
    try {
      timerClear(timer);
    } catch (error) {
      logger.debug(`footage index scheduler: clearing the timer failed: ${errorMessage(error)}`);
    }
    timer = null;
    timerDeps = {};
    timerClear = defaultClearTimer;
    logger.debug("footage index scheduler: stopped");
  }

  // Independent of the timer: a pass started by a manual trigger should also
  // be told to stop when the process is going away.
  inFlightAbort?.abort(new Error("the server is shutting down"));
}

/** Whether the loop is armed. Used by tests and by nothing else. */
export function isFootageIndexSchedulerRunning(): boolean {
  return timer !== null;
}

/**
 * The pass in flight, or null.
 *
 * The seam a test uses to await a tick it fired through an injected timer,
 * since the timer callback itself can only return `void`.
 */
export function currentFootageIndexPass(): Promise<PassOutcome> | null {
  return inFlight;
}
