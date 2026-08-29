/**
 * Index orchestration for the semantic footage library.
 *
 * **The filesystem is the work-list** (design §4.1). `indexAll` walks
 * `cacheVideosDir()` and, for every `vid-*.mp4` it finds, makes one statement
 * true: *this file has a current point in Qdrant*. Everything else follows
 * from that:
 *
 *  - **Idempotent.** A second run over an indexed cache reads Mongo, decides
 *    there is nothing to do, and stops. No describe, no embed, no upsert.
 *  - **Crash-proof.** The file on disk is the durable record. A run killed
 *    halfway leaves the clips it finished indexed and the rest untouched, and
 *    the description of the clip it was working on is cached *before* the
 *    embed, so resuming re-pays for at most one embedding and never for a
 *    second Gemini describe.
 *  - **No leases, no owner ids, no generation counters, no tombstones, no
 *    in-server queue and no shutdown drain.** Concurrency is handled by one
 *    lock document (`lock.ts`), taken by the entry point rather than in here,
 *    so a caller composing `reconcile` and `indexAll` holds it once across
 *    both instead of deadlocking against itself.
 *
 * Mongo's `footage_index` is a **cache of descriptions plus a failure
 * record**, never a queue. Losing it costs Gemini spend, never correctness —
 * which is why nothing here treats a missing row as anything but "work to do",
 * and why no row is ever the reason a file is skipped when its point is
 * absent (`reconcile` closes that loop from the Qdrant side).
 *
 * **Nothing here deletes a clip.** A file that will not probe, will not
 * describe or will not embed keeps its bytes and gets a `failed` row; a live
 * render may be holding it, and design §4.7 makes explicit cache-clear the
 * only thing that removes files.
 */

import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { EmbeddingModel, LanguageModel } from "ai";

import { footageIndexCollection } from "../../db/client.ts";
import type { FootageIndexDocument } from "../../db/types.ts";
import { getSettings } from "../../config/settings.ts";
import { errorMessage, errorName, logger } from "../../utils/logger.ts";
import { redactSecrets } from "../../utils/misc.ts";
import { cacheVideosDir } from "../../utils/paths.ts";
import { probe } from "../video/probe.ts";

import { ClipDescribeError, describeClip, resolveDescribeModel } from "./describe.ts";
import { embedClipDescription, embedSearchQuery, resolveEmbeddingModel } from "./embed.ts";
import { isLocked, type FootageLockStatus } from "./lock.ts";
import {
  deletePoints,
  ensureCollection,
  health,
  overwritePointPayload,
  queryPoints,
  scrollAll,
  upsertPoint,
  type FootageFilter,
  type FootageMatch,
  type FootagePayload,
} from "./qdrant.ts";
import {
  clipDescriptionSchema,
  pointIdFor,
  DESCRIBE_VERSION,
  EMBED_VERSION,
  type ClipDescription,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Files the library owns.
 *
 * `saveVideo` and the pull both name their output `vid-<md5(url)>.mp4`, and
 * `media.ts` counts and clears exactly this pattern. Matching it here keeps
 * three views of the same directory in agreement, and — because an in-flight
 * download is `.vid-….part` — excludes partial files without needing to know
 * about them.
 */
const CLIP_NAME_PATTERN = /^vid-[^/\\]*\.mp4$/i;

/**
 * How many times a clip is put through the pipeline before a plain re-run
 * stops trying.
 *
 * A file that fails is usually going to keep failing — a truncated download, a
 * codec ffprobe cannot read — and each attempt costs an ffmpeg encode and a
 * Gemini call. Three is enough to ride out a rate limit or a transient 500 and
 * few enough that a permanently broken clip cannot quietly become a recurring
 * bill. `retryFailed` overrides it once the cause has been fixed.
 */
export const MAX_INDEX_ATTEMPTS = 3;

/** Failures kept per row. A history, not a scalar (design §5) — but bounded. */
const MAX_STORED_ERRORS = 10;

/** Default and ceiling for `searchFootage`. */
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 100;

/** Rows per `updateMany`/`find` chunk when reconcile touches many at once. */
const MONGO_CHUNK_SIZE = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What happened to one clip. */
export type IndexOutcome = "indexed" | "refreshed" | "skipped" | "missing" | "failed";

export interface IndexOneResult {
  local_file: string;
  outcome: IndexOutcome;
  /** Why it was skipped, or what went wrong. */
  reason?: string;
  /** True only when Gemini was actually asked to describe the clip. */
  described: boolean;
  /** True when a vector was produced — false on the payload-only path. */
  embedded: boolean;
  elapsed_ms: number;
}

export interface IndexOptions {
  /** Re-index even a row that is already current. Descriptions are still reused. */
  force?: boolean;
  /** Ignore the cached description and pay Gemini again. Implies `force`. */
  redescribe?: boolean;
  /** Try rows that have already used up `MAX_INDEX_ATTEMPTS`. */
  retryFailed?: boolean;
  signal?: AbortSignal;
}

/** Models resolved once for a whole run rather than once per clip. */
interface RunModels {
  describe: { model: LanguageModel; modelName: string };
  embedding: EmbeddingModel<string>;
}

interface IndexOneInternalOptions extends IndexOptions {
  models?: RunModels;
}

export interface IndexAllOptions extends IndexOptions {
  /** Clips in flight at once. Defaults to `footage_index.concurrency`. */
  concurrency?: number;
  /** Stop after this many clips that actually need work. */
  limit?: number;
}

export interface IndexRunResult {
  /** Files matching `vid-*.mp4` in the cache directory. */
  scanned: number;
  /** Clips that needed work and were attempted. */
  attempted: number;
  indexed: number;
  /** Payload-only refreshes: a new search term, no re-describe, no re-embed. */
  refreshed: number;
  skipped: number;
  /** Vanished between the directory walk and the attempt. */
  missing: number;
  failed: number;
  /** Gemini describe calls actually made — the number the bill is about. */
  described: number;
  /** True when a signal, a lost lock or a fatal error stopped the run early. */
  aborted: boolean;
  /**
   * Set when the run stopped because the *library* was unusable — no API key,
   * Qdrant unreachable, Mongo refusing writes — rather than because a clip was
   * bad. Callers should surface it; a CLI should exit non-zero on it.
   */
  fatal?: string;
  /** Per-clip failures. Never fatal, always recorded (design §4.1). */
  errors: { local_file: string; message: string }[];
  elapsed_ms: number;
}

export interface ReconcileResult extends IndexRunResult {
  /** Points removed because their file is no longer on disk. */
  points_deleted: number;
  /** Rows whose file is gone, kept for their description but unlinked from Qdrant. */
  rows_unlinked: number;
}

export interface FootageStats {
  files: { count: number; bytes: number };
  rows: {
    total: number;
    indexed: number;
    stale: number;
    failed: number;
    /** `indexed` at both current versions — the rows a re-run would skip. */
    current: number;
  };
  qdrant: {
    ok: boolean;
    url: string;
    collection: string;
    alias: string;
    version?: string;
    detail?: string;
    /** Null when Qdrant did not answer: unknown is not the same as empty. */
    points: number | null;
  };
  /** Null when Qdrant did not answer, for the same reason. */
  drift: {
    /** Points whose file is gone — `reconcile` deletes these. */
    orphan_points: number;
    /** Current rows with no point — `reconcile` re-indexes these. */
    missing_points: number;
  } | null;
  lock: FootageLockStatus | null;
}

// ---------------------------------------------------------------------------
// The work decision
// ---------------------------------------------------------------------------

export type WorkKind = "skip" | "payload" | "full";

export interface WorkDecision {
  kind: WorkKind;
  reason: string;
}

/**
 * What, if anything, a row needs — the one function that decides where Gemini
 * spend happens. Pure, so it is unit-testable without Mongo.
 *
 * The `payload` branch is guarded far more tightly than "the state says
 * stale", and deliberately so. `state` has no value meaning *new*: the
 * download hook creates provenance rows as `stale` with `describe_version: 0`,
 * `embed_version: 0` and `description: null`, because that is the only one of
 * the three states that means "the payload is not current". Branching on the
 * state alone would send a clip that has never been near the describer down
 * the payload-only path, which would write a Qdrant payload with no summary
 * and no vector — or, since `overwritePayload` 404s on a point that does not
 * exist, fail every hook-created row for a reason that reads like a Qdrant
 * fault. So the branch additionally requires the row to be at the *current*
 * describe and embed versions **and** to actually hold a description.
 */
export function decideWork(
  row: FootageIndexDocument | undefined,
  options: Pick<IndexOptions, "force" | "redescribe" | "retryFailed"> = {},
): WorkDecision {
  if (!row) return { kind: "full", reason: "no row" };
  if (options.redescribe) return { kind: "full", reason: "re-describe requested" };
  if (options.force) return { kind: "full", reason: "forced" };

  const describeCurrent = row.describe_version === DESCRIBE_VERSION;
  const embedCurrent = row.embed_version === EMBED_VERSION;

  if (row.state === "indexed" && describeCurrent && embedCurrent) {
    return { kind: "skip", reason: "already indexed at the current versions" };
  }

  if (row.state === "failed" && !options.retryFailed && (row.attempts ?? 0) >= MAX_INDEX_ATTEMPTS) {
    return {
      kind: "skip",
      reason: `failed ${row.attempts} time(s); re-run with retryFailed to try again`,
    };
  }

  // Everything below is the guard described above: a hook-created row reaches
  // none of these and correctly falls through to a full index.
  if (row.state === "stale" && describeCurrent && embedCurrent && row.description) {
    return { kind: "payload", reason: "search terms changed" };
  }

  if (!describeCurrent) return { kind: "full", reason: `describe_version ${row.describe_version}` };
  if (!embedCurrent) return { kind: "full", reason: `embed_version ${row.embed_version}` };
  if (!row.description) return { kind: "full", reason: "no cached description" };
  return { kind: "full", reason: `state ${row.state}` };
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

/** Whether a name is one of the library's clips. Shared with the CLI and tests. */
export function isCacheClipName(name: string): boolean {
  return CLIP_NAME_PATTERN.test(name);
}

/**
 * Every clip in the cache directory, sorted so runs are reproducible.
 *
 * `create = false`: listing a directory must not be the thing that creates it,
 * and an absent cache directory is legitimately an empty library.
 */
export async function listCacheClips(): Promise<string[]> {
  const directory = cacheVideosDir(false);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && isCacheClipName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** `stat` that answers `null` for a file that is not there. */
async function statClip(path: string): Promise<{ bytes: number } | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return { bytes: info.size };
  } catch {
    return null;
  }
}

/** Orientation from the probed shape; `aspect` is a Qdrant filter, not a ratio. */
function orientationOf(width: number, height: number): string | undefined {
  if (!width || !height) return undefined;
  if (width > height) return "landscape";
  if (width < height) return "portrait";
  return "square";
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A message safe to store and to log.
 *
 * These strings end up in `footage_index.errors[]` and on the wire, and a
 * provider error routinely pastes the request URL — key included — into its
 * message. `describe.ts` already redacts its own; this covers everything else.
 */
function safeMessage(error: unknown): string {
  let apiKey: string | undefined;
  try {
    apiKey = getSettings().app.gemini_api_key;
  } catch {
    // Settings never loaded; there is no key in scope to leak.
  }
  return redactSecrets(errorMessage(error), apiKey);
}

// ---------------------------------------------------------------------------
// Mongo writes
// ---------------------------------------------------------------------------

/** Shape probed off the file, carried into both Mongo and the payload. */
interface ClipShape {
  duration: number;
  width: number;
  height: number;
  bytes: number;
}

/**
 * Stores a fresh description **before** the embed and the upsert.
 *
 * This ordering is the entire resume story. Describing is the expensive half —
 * an ffmpeg proxy plus a video-model call — while embedding is one cheap text
 * request. Writing the description first means a run killed at any point after
 * it re-uses that description on the next pass, so an interrupted run costs at
 * most one repeated embed and never a repeated describe.
 *
 * The row is left un-indexed on purpose: `embed_version` keeps whatever it
 * had (0 for a hook row), so `decideWork` still sees a full job.
 */
async function cacheDescription(
  id: string,
  localFile: string,
  description: ClipDescription,
  shape: ClipShape,
): Promise<void> {
  const now = new Date();
  await footageIndexCollection().updateOne(
    { _id: id },
    {
      $set: {
        description,
        describe_version: DESCRIBE_VERSION,
        duration: shape.duration,
        width: shape.width,
        height: shape.height,
        bytes: shape.bytes,
        last_attempt_at: now,
        updated_at: now,
      },
      $setOnInsert: {
        local_file: localFile,
        state: "stale",
        provider: "",
        search_terms: [],
        embed_version: 0,
        created_at: now,
      },
    },
    { upsert: true },
  );
}

/**
 * Marks the row indexed — but only if its search terms have not moved.
 *
 * A term can arrive from the download hook at any moment, including between
 * the read that built the payload just upserted and this write (design §4.5).
 * An unconditional `state: "indexed"` there would bury that term: the payload
 * in Qdrant would not have it, and no future run would ever notice, because
 * "indexed at the current versions" is exactly the condition for skipping.
 *
 * So the update is a compare-and-set on the terms array. When it misses, the
 * row is marked `stale` instead, which costs one payload-only re-upsert on the
 * next run and loses nothing.
 */
async function markIndexed(
  id: string,
  patch: Partial<FootageIndexDocument>,
  terms: string[] | null,
): Promise<boolean> {
  const collection = footageIndexCollection();
  const now = new Date();
  const base = { ...patch, last_attempt_at: now, updated_at: now };

  if (terms) {
    const result = await collection.updateOne(
      { _id: id, search_terms: terms },
      { $set: { ...base, state: "indexed" }, $inc: { attempts: 1 } },
    );
    if (result.matchedCount === 1) return true;
  }

  await collection.updateOne(
    { _id: id },
    { $set: { ...base, state: terms ? "stale" : "indexed" }, $inc: { attempts: 1 } },
  );
  if (terms) {
    logger.info(`footage: ${patch.local_file ?? id} gained a search term mid-index; left stale for a refresh`);
  }
  return !terms;
}

/**
 * Records a failure and leaves the file alone.
 *
 * The bytes stay on disk: a render may be holding this very clip, and design
 * §4.7 makes an explicit cache clear the only thing that deletes files.
 * `errors` is appended to rather than overwritten, because "failed ffprobe,
 * then timed out, then tripped a schema violation" is a different problem from
 * "hit the same rate limit three times", and only the history tells them apart.
 */
async function markFailed(id: string, localFile: string, message: string): Promise<void> {
  const now = new Date();
  await footageIndexCollection().updateOne(
    { _id: id },
    {
      $set: { state: "failed", last_attempt_at: now, updated_at: now },
      $inc: { attempts: 1 },
      $push: { errors: { $each: [{ at: now, message }], $slice: -MAX_STORED_ERRORS } },
      $setOnInsert: {
        local_file: localFile,
        description: null,
        provider: "",
        search_terms: [],
        describe_version: 0,
        embed_version: 0,
        created_at: now,
      },
    },
    { upsert: true },
  );
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/**
 * Provenance as it stands *right now*, read immediately before every upsert.
 *
 * Deliberately a fresh read rather than the row `indexOne` already has:
 * describing a clip takes seconds, and the download hook can add a search term
 * during them. Building the payload from the older copy would drop that term
 * from Qdrant permanently, because the row would then be marked indexed and
 * never looked at again.
 */
async function readProvenance(id: string): Promise<FootageIndexDocument | null> {
  return footageIndexCollection().findOne({ _id: id });
}

/** Assembles the Qdrant payload from a row, a description and a shape. */
function buildPayload(input: {
  localFile: string;
  row: FootageIndexDocument | null;
  description: ClipDescription;
  shape: ClipShape;
  describeModel: string;
  embedModel: string;
}): FootagePayload {
  const { localFile, row, description, shape, describeModel, embedModel } = input;
  const aspect = orientationOf(shape.width, shape.height);

  const payload: FootagePayload = {
    local_file: localFile,
    provider: row?.provider ?? "",
    search_terms: row?.search_terms ?? [],
    ...description,
    describe_model: describeModel,
    describe_version: DESCRIBE_VERSION,
    embed_model: embedModel,
    embed_version: EMBED_VERSION,
    indexed_at: new Date().toISOString(),
  };

  // Only when known: an absent field reads better than an explicit null, and
  // `overwritePayload` replaces the whole payload, so a value dropped here is
  // genuinely dropped rather than left stale.
  if (row?.asset_id) payload.asset_id = row.asset_id;
  if (row?.rendition_id) payload.rendition_id = row.rendition_id;
  if (row?.source_page) payload.source_page = row.source_page;
  if (row?.creator) payload.creator = row.creator;
  if (shape.duration) payload.duration = shape.duration;
  if (shape.width) payload.width = shape.width;
  if (shape.height) payload.height = shape.height;
  if (shape.bytes) payload.bytes = shape.bytes;
  if (aspect) payload.aspect = aspect;

  return payload;
}

/**
 * The stored description, or null when it cannot be trusted.
 *
 * `FootageIndexDocument.description` widens every enum-ish field to `string`
 * on purpose — rows outlive the schema that wrote them — so the value is
 * parsed rather than cast. A row written at an older `DESCRIBE_VERSION`, or
 * one whose shape drifted, is simply not a cache hit, and the clip is
 * described again.
 */
function cachedDescription(row: FootageIndexDocument | undefined): ClipDescription | null {
  if (!row?.description) return null;
  if (row.describe_version !== DESCRIBE_VERSION) return null;
  const parsed = clipDescriptionSchema.safeParse(row.description);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// indexOne
// ---------------------------------------------------------------------------

/** Rebuilds the path from the basename, so no caller can walk out of the cache. */
function normaliseLocalFile(input: string): string {
  const file = basename(String(input ?? "").trim());
  if (!file || file === "." || file === "..") {
    throw new Error(`not a cache clip name: ${JSON.stringify(input)}`);
  }
  return file;
}

/**
 * Resolves both models up front, outside the per-clip failure handler.
 *
 * A missing `gemini_api_key` is the whole library being unusable, not this
 * clip being bad. Resolving here means that failure propagates out of
 * `indexOne` and stops the run, instead of being written onto a thousand rows
 * as a thousand identical failures — which is the distinction
 * `ClipDescribeError`'s `config` stage exists to draw.
 */
function resolveModels(clip: string): RunModels {
  const describe = resolveDescribeModel(clip);
  return {
    describe: { model: describe.model, modelName: describe.modelName },
    embedding: resolveEmbeddingModel(),
  };
}

/**
 * Brings one clip's point up to date.
 *
 * Accepts a basename or an absolute path; only the basename is ever used,
 * because `local_file` is the identity (design §4.2) and an absolute path
 * differs between the host process and a container.
 *
 * Per-clip failures are recorded on the row and returned as
 * `outcome: "failed"`. Anything that escapes is a failure of the *library* —
 * no API key, Qdrant unreachable, Mongo refusing writes — and stops the caller
 * rather than being blamed on the clip.
 */
export async function indexOne(
  localFile: string,
  options: IndexOneInternalOptions = {},
): Promise<IndexOneResult> {
  const startedAt = Date.now();
  const file = normaliseLocalFile(localFile);
  const id = pointIdFor(file);
  const path = join(cacheVideosDir(false), file);

  const done = (
    outcome: IndexOutcome,
    extra: { reason?: string; described?: boolean; embedded?: boolean } = {},
  ): IndexOneResult => ({
    local_file: file,
    outcome,
    reason: extra.reason,
    described: extra.described ?? false,
    embedded: extra.embedded ?? false,
    elapsed_ms: Date.now() - startedAt,
  });

  const fileStat = await statClip(path);
  if (!fileStat) return done("missing", { reason: "file is not in the cache directory" });

  const collection = footageIndexCollection();
  const row = (await collection.findOne({ _id: id })) ?? undefined;
  const decision = decideWork(row, options);
  if (decision.kind === "skip") return done("skipped", { reason: decision.reason });

  // Throws when Qdrant is unreachable, which must stop a sweep *before* it
  // pays Gemini for a thousand descriptions it could not store. Memoised, so
  // this is one round trip per process, not one per clip.
  await ensureCollection();

  const settings = getSettings();
  const embedModelName = settings.footage_index.embed_model;

  // --- payload-only (design §4.5) -----------------------------------------
  // A search term arrived for a clip that is already described and embedded.
  // Nothing about the pixels changed, so neither the description nor the
  // vector is recomputed: the payload is rewritten in place and the row goes
  // back to `indexed`.
  if (decision.kind === "payload") {
    const description = cachedDescription(row);
    if (description) {
      try {
        const fresh = await readProvenance(id);
        const shape: ClipShape = {
          duration: fresh?.duration ?? row?.duration ?? 0,
          width: fresh?.width ?? row?.width ?? 0,
          height: fresh?.height ?? row?.height ?? 0,
          bytes: fresh?.bytes ?? fileStat.bytes,
        };
        const payload = buildPayload({
          localFile: file,
          row: fresh,
          description,
          shape,
          // The row does not store which describer wrote it — only the payload
          // does — so a refresh can honestly report no more than the model
          // that is configured now.
          describeModel: settings.footage_index.describe_model,
          embedModel: embedModelName,
        });

        await overwritePointPayload(payload);
        await markIndexed(
          id,
          { local_file: file, embed_version: EMBED_VERSION, describe_version: DESCRIBE_VERSION },
          Array.isArray(fresh?.search_terms) ? fresh.search_terms : null,
        );
        return done("refreshed", { reason: decision.reason });
      } catch (error) {
        // The commonest cause is a point that is not there — Qdrant answers
        // `overwritePayload` on a missing id with 404 — which is a real state
        // after a cache clear or a rebuilt volume. Falling through to the full
        // path re-creates it, and still re-uses the cached description, so the
        // recovery costs one embed rather than one describe.
        logger.debug(
          `footage: payload refresh for ${file} did not apply, indexing it fully instead ` +
            `(error=${errorName(error)}, detail=${safeMessage(error)})`,
        );
      }
    }
  }

  // --- full index ----------------------------------------------------------
  // Resolved before the try: a configuration failure is not this clip's fault
  // and must not be recorded against it.
  const models = options.models ?? resolveModels(file);

  try {
    const media = await probe(path);
    const shape: ClipShape = {
      duration: media.duration,
      width: media.width,
      height: media.height,
      bytes: fileStat.bytes,
    };

    let description = options.redescribe ? null : cachedDescription(row);
    let describeModelName = settings.footage_index.describe_model;
    let described = false;

    if (!description) {
      const result = await describeClip(path, {
        model: models.describe.model,
        modelName: models.describe.modelName,
        signal: options.signal,
      });
      description = result.description;
      describeModelName = result.describe_model || describeModelName;
      described = true;
      // Before the embed and before the upsert: see `cacheDescription`.
      await cacheDescription(id, file, description, shape);
    }

    const vector = await embedClipDescription(
      description,
      options.signal ? { abortSignal: options.signal } : {},
      { model: models.embedding },
    );

    // Re-read immediately before the upsert, never earlier (design §4.5).
    const fresh = await readProvenance(id);
    const payload = buildPayload({
      localFile: file,
      row: fresh,
      description,
      shape,
      describeModel: describeModelName,
      embedModel: embedModelName,
    });

    await upsertPoint(payload, vector);
    await markIndexed(
      id,
      {
        local_file: file,
        description,
        describe_version: DESCRIBE_VERSION,
        embed_version: EMBED_VERSION,
        duration: shape.duration,
        width: shape.width,
        height: shape.height,
        bytes: shape.bytes,
      },
      Array.isArray(fresh?.search_terms) ? fresh.search_terms : null,
    );

    return done("indexed", { reason: decision.reason, described, embedded: true });
  } catch (error) {
    // A cancelled run is not a property of the clip, and neither is an unusable
    // library: both are rethrown so the row keeps whatever state it had.
    if (options.signal?.aborted) throw error;
    if (error instanceof ClipDescribeError && error.stage === "config") throw error;

    const message = safeMessage(error);
    logger.warning(`footage: failed to index ${file}: ${errorName(error)}: ${message}`);
    await markFailed(id, file, message);
    return done("failed", { reason: message });
  }
}

// ---------------------------------------------------------------------------
// Bounded parallel pass
// ---------------------------------------------------------------------------

/** Fixed-size worker pool over an array, preserving no order. */
async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const size = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length));
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  });
  await Promise.all(runners);
}

function emptyRun(scanned: number, startedAt: number): IndexRunResult {
  return {
    scanned,
    attempted: 0,
    indexed: 0,
    refreshed: 0,
    skipped: 0,
    missing: 0,
    failed: 0,
    described: 0,
    aborted: false,
    errors: [],
    elapsed_ms: Date.now() - startedAt,
  };
}

/**
 * Runs the pipeline over a list of files, at bounded concurrency.
 *
 * The skip decision is taken here, from one bulk read of `footage_index`,
 * rather than inside `indexOne`: on a warm library almost every file is a skip
 * and the difference is one query against a thousand. `indexOne` re-reads the
 * row it is given anyway, so the bulk copy is only ever used to decide *not*
 * to look.
 *
 * Per-clip failures are tallied and never stop the pass. A failure that
 * escapes `indexOne` is the library being unusable, so it stops the pass and
 * lands in `fatal` — with everything finished so far still reported.
 */
async function runIndexPass(
  files: string[],
  rows: Map<string, FootageIndexDocument>,
  options: IndexAllOptions,
  seed: IndexRunResult,
): Promise<IndexRunResult> {
  const result = seed;

  const work: string[] = [];
  for (const file of files) {
    const decision = decideWork(rows.get(file), options);
    if (decision.kind === "skip") {
      result.skipped++;
      continue;
    }
    work.push(file);
    if (options.limit !== undefined && work.length >= options.limit) break;
  }

  if (work.length === 0) return result;

  // Resolved once for the run: an unset API key fails here, before an ffmpeg
  // encode is spent on the first clip, and every clip then shares one client.
  let models: RunModels;
  try {
    models = resolveModels(work[0]!);
  } catch (error) {
    result.fatal = safeMessage(error);
    result.aborted = true;
    logger.error(`footage index stopped: ${result.fatal}`);
    result.elapsed_ms = Date.now() - (Date.now() - result.elapsed_ms);
    return result;
  }

  let fatal: unknown;
  const controller = new AbortController();
  const signal = options.signal;
  const onOuterAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }

  try {
    await pool(work, options.concurrency ?? getSettings().footage_index.concurrency, async (file) => {
      if (controller.signal.aborted) return;
      try {
        const outcome = await indexOne(file, { ...options, models, signal: controller.signal });
        result.attempted++;
        if (outcome.described) result.described++;
        switch (outcome.outcome) {
          case "indexed":
            result.indexed++;
            break;
          case "refreshed":
            result.refreshed++;
            break;
          case "missing":
            result.missing++;
            break;
          case "failed":
            result.failed++;
            result.errors.push({ local_file: file, message: outcome.reason ?? "unknown" });
            break;
          default:
            result.skipped++;
        }
      } catch (error) {
        if (!fatal && !controller.signal.aborted) {
          fatal = error;
          controller.abort(error);
        }
      }
    });
  } finally {
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }

  if (fatal) {
    result.fatal = safeMessage(fatal);
    result.aborted = true;
    logger.error(`footage index stopped: ${errorName(fatal)}: ${result.fatal}`);
  } else if (controller.signal.aborted) {
    result.aborted = true;
  }

  return result;
}

/** One bulk read of every row, keyed by filename. */
async function loadRows(): Promise<Map<string, FootageIndexDocument>> {
  const rows = new Map<string, FootageIndexDocument>();
  for await (const row of footageIndexCollection().find({})) {
    if (row.local_file) rows.set(row.local_file, row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// indexAll
// ---------------------------------------------------------------------------

/**
 * Brings every clip in the cache directory up to date.
 *
 * The caller owns the lock: `withLock(() => indexAll())`. Taking it in here
 * would deadlock a caller that wanted to reconcile and index under one lock,
 * and would leave `indexOne` — which shares all of this — with a different
 * rule.
 *
 * Re-running this on an indexed cache is a no-op: every file resolves to a
 * `skip`, so there is no describe, no embed, no upsert and no write.
 */
export async function indexAll(options: IndexAllOptions = {}): Promise<IndexRunResult> {
  const startedAt = Date.now();
  const files = await listCacheClips();
  const result = emptyRun(files.length, startedAt);

  if (files.length === 0) {
    logger.info("footage index: the cache directory holds no clips");
    return result;
  }

  try {
    // Fails the run before any Gemini spend if the vector store is unusable.
    await ensureCollection();
  } catch (error) {
    result.fatal = safeMessage(error);
    result.aborted = true;
    logger.error(`footage index stopped: qdrant is unusable: ${result.fatal}`);
    result.elapsed_ms = Date.now() - startedAt;
    return result;
  }

  const rows = await loadRows();
  await runIndexPass(files, rows, options, result);
  result.elapsed_ms = Date.now() - startedAt;

  logger.info(
    `footage index: ${result.scanned} file(s), ${result.indexed} indexed, ` +
      `${result.refreshed} refreshed, ${result.skipped} skipped, ${result.failed} failed, ` +
      `${result.described} describe call(s), ${(result.elapsed_ms / 1000).toFixed(1)}s`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

/**
 * Makes Qdrant and the cache directory agree, in both directions.
 *
 * *Qdrant has a point the filesystem does not have a file for* — deleted, and
 * the row (if any) is unlinked rather than dropped: its description is kept,
 * because a clip re-downloaded from the same URL lands under the same
 * filename, and paying Gemini twice for the same bytes is exactly what the
 * cache exists to prevent. Unlinking is `embed_version: 0`, which is what
 * makes the row un-eligible for the payload-only path — a payload rewrite
 * against a point that no longer exists is precisely the failure this branch
 * would otherwise create.
 *
 * *The filesystem has a file Qdrant has no point for* — indexed, by the same
 * pass `indexAll` uses.
 *
 * As with `indexAll`, the caller owns the lock.
 */
export async function reconcile(options: IndexAllOptions = {}): Promise<ReconcileResult> {
  const startedAt = Date.now();
  const files = await listCacheClips();
  const present = new Set(files);
  const result: ReconcileResult = {
    ...emptyRun(files.length, startedAt),
    points_deleted: 0,
    rows_unlinked: 0,
  };

  try {
    await ensureCollection();
  } catch (error) {
    result.fatal = safeMessage(error);
    result.aborted = true;
    logger.error(`footage reconcile stopped: qdrant is unusable: ${result.fatal}`);
    result.elapsed_ms = Date.now() - startedAt;
    return result;
  }

  // --- Qdrant → filesystem -------------------------------------------------
  // `scrollAll` answers `[]` rather than a partial list when it fails, so a
  // read failure deletes nothing instead of mistaking half an index for an
  // index whose second half is gone.
  const points = await scrollAll();
  const orphans = points
    .filter((point) => {
      const file = point.payload?.local_file;
      return !file || !present.has(file);
    })
    .map((point) => point.id);

  if (orphans.length > 0) {
    result.points_deleted = await deletePoints(orphans);
    logger.info(`footage reconcile: deleted ${result.points_deleted} point(s) with no file on disk`);
  }

  // --- rows whose file is gone --------------------------------------------
  const rows = await loadRows();
  const unlink: string[] = [];
  for (const [file, row] of rows) {
    if (present.has(file)) continue;
    if (row.embed_version === 0 && row.state === "stale") continue; // already unlinked
    unlink.push(row._id);
  }

  for (let start = 0; start < unlink.length; start += MONGO_CHUNK_SIZE) {
    const chunk = unlink.slice(start, start + MONGO_CHUNK_SIZE);
    const update = await footageIndexCollection().updateMany(
      { _id: { $in: chunk } },
      { $set: { state: "stale", embed_version: 0, updated_at: new Date() } },
    );
    result.rows_unlinked += update.modifiedCount;
  }
  if (result.rows_unlinked > 0) {
    logger.info(
      `footage reconcile: unlinked ${result.rows_unlinked} row(s) whose file is gone, keeping their descriptions`,
    );
  }

  // --- filesystem → Qdrant -------------------------------------------------
  // A row that says `indexed` but has no point would otherwise be skipped
  // forever, so those rows are forced back into the work list here.
  const indexedFiles = new Set(
    points.map((point) => point.payload?.local_file).filter((file): file is string => Boolean(file)),
  );
  const pending: string[] = [];
  for (const file of files) {
    const row = rows.get(file);
    if (row && !indexedFiles.has(file)) rows.delete(file); // treat as "no row" → full work
    pending.push(file);
  }
  void indexedFiles;

  await runIndexPass(pending, rows, options, result);
  result.elapsed_ms = Date.now() - startedAt;

  logger.info(
    `footage reconcile: ${result.points_deleted} point(s) deleted, ${result.rows_unlinked} row(s) unlinked, ` +
      `${result.indexed} indexed, ${result.refreshed} refreshed, ${result.skipped} skipped, ${result.failed} failed`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/**
 * Semantic search over the library.
 *
 * Deliberately asymmetric about failure. The Qdrant half degrades — a search
 * against a dead instance returns `[]`, because `queryPoints` never throws and
 * a render path must not be handed an exception it forgot to catch. The
 * embedding half throws: an unset API key or a wrong model is a configuration
 * fault, and answering "no results" to it would hide a broken library behind a
 * plausible-looking empty answer for as long as nobody checked.
 */
export async function searchFootage(
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
  filter?: FootageFilter,
): Promise<FootageMatch[]> {
  const text = String(query ?? "").trim();
  if (!text) throw new Error("a footage search needs a query");

  const requested = Math.trunc(Number(limit)) || DEFAULT_SEARCH_LIMIT;
  const capped = Math.min(Math.max(requested, 1), MAX_SEARCH_LIMIT);

  const vector = await embedSearchQuery(text);
  return queryPoints(vector, capped, filter);
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

/**
 * What `footage status` and `GET /footage/stats` report.
 *
 * The drift numbers are the point of it: "1,004 files, 1,004 rows, 1,004
 * points" is the only reading that means the library is whole, and each pair
 * that disagrees names a different repair. They cost a full scroll of the
 * collection, which is why this is a maintenance call and not something a
 * render path is expected to make.
 *
 * `points` and `drift` are `null` rather than zero when Qdrant does not
 * answer: an unknown count and an empty collection are different facts, and
 * reporting the second for the first would read as "the index was wiped".
 */
export async function stats(): Promise<FootageStats> {
  const files = await listCacheClips();
  const present = new Set(files);

  let bytes = 0;
  await pool(files, 8, async (file) => {
    const info = await statClip(join(cacheVideosDir(false), file));
    if (info) bytes += info.bytes;
  });

  const rows = await loadRows();
  const counts = { total: rows.size, indexed: 0, stale: 0, failed: 0, current: 0 };
  for (const row of rows.values()) {
    if (row.state === "indexed") counts.indexed++;
    else if (row.state === "stale") counts.stale++;
    else if (row.state === "failed") counts.failed++;
    if (
      row.state === "indexed" &&
      row.describe_version === DESCRIBE_VERSION &&
      row.embed_version === EMBED_VERSION
    ) {
      counts.current++;
    }
  }

  const qdrantHealth = await health();
  let points: number | null = null;
  let drift: FootageStats["drift"] = null;

  if (qdrantHealth.ok) {
    const stored = await scrollAll();
    points = stored.length;
    const indexedFiles = new Set(
      stored.map((point) => point.payload?.local_file).filter((file): file is string => Boolean(file)),
    );
    let orphan = 0;
    for (const point of stored) {
      const file = point.payload?.local_file;
      if (!file || !present.has(file)) orphan++;
    }
    let missing = 0;
    for (const file of files) {
      if (!indexedFiles.has(file)) missing++;
    }
    drift = { orphan_points: orphan, missing_points: missing };
  }

  return {
    files: { count: files.length, bytes },
    rows: counts,
    qdrant: { ...qdrantHealth, points },
    drift,
    lock: await isLocked().catch(() => null),
  };
}
