/**
 * Bulk footage pull for the semantic library (design §4.3).
 *
 * This module fills `storage/cache_videos` with clips the index can then
 * describe and embed. It is the one stage that talks to a stock provider on
 * purpose rather than as a side effect of a render, and the whole reason it
 * exists as a separate file is that **it touches no render-path code**: it has
 * its own paginating Pexels client and its own downloader, so `saveVideo()` and
 * `searchVideosPexels()` are read but never modified, and "the pull does not
 * change material selection" is a fact about the diff rather than a promise.
 *
 * Four things here are load-bearing, and each one is a bug that was avoided
 * rather than a preference:
 *
 *  1. **Pages are constructed, never followed.** Pexels answers with a
 *     `next_page` whose path is doubled (`/v1/v1/videos/search?…`); that URL
 *     404s with an empty body, which under an unchecked `response.json()` would
 *     surface as an empty result set and read as "this term is thin". Verified
 *     live: `page=2` on the correct path returns 20 videos, the `next_page` it
 *     hands back returns HTTP 404 and zero bytes.
 *  2. **`searchWithCache` is never called.** Its cache key carries no page
 *     number (`material/cache.ts`), so paginating through it would overwrite
 *     page 1 with page 7 for the render path — for 24 hours, across every
 *     render, for every term this pull touches.
 *  3. **The destination filename is `vid-<md5(url without query)>.mp4`**,
 *     byte-identical to what `material/download.ts` computes. Anything else and
 *     the render path re-downloads every clip this already fetched, and the
 *     `vid-*.mp4` filter in `media.ts` hides them from `/cache/stats` and
 *     `/cache/clear`.
 *  4. **The run document is the only record of a clip that was never
 *     downloaded.** A file that does not exist leaves no trace on disk, so
 *     without `footage_runs` "term X is thin", "term X was rate-limited", "the
 *     budget ran out before term X" and "the run was killed" are the same
 *     observation. They are four different things to do next.
 */

import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { rename, statfs, unlink } from "node:fs/promises";
import { join } from "node:path";

import { appConfig } from "../../config/settings.ts";
import { footageRunsCollection, isConnected } from "../../db/client.ts";
import type {
  FootageCreator,
  FootageRunDocument,
  FootageRunStopReason,
  FootageRunTermResult,
} from "../../db/types.ts";
import {
  VideoAspect,
  aspectOrientation,
  aspectToResolution,
  type VideoAspectValue,
} from "../../models/schema.ts";
import { errorMessage, errorName, logger } from "../../utils/logger.ts";
import { getUuid, md5, rotateApiKey, sleep } from "../../utils/misc.ts";
import { cacheVideosDir, storageDir } from "../../utils/paths.ts";
import {
  BROWSER_USER_AGENT,
  describeProviderError,
  providerFetch,
  safePublicUrl,
} from "../material/http.ts";
import { creatorInfo, matchesVideoAspect } from "../material/search.ts";
import { isValidVideo } from "../video/probe.ts";
// `provenance.ts` imports this module's search and filename helpers in return.
// The cycle is safe and deliberate: every edge in both directions is a hoisted
// function declaration, and neither module touches the other's bindings while
// it is being evaluated.
import { recordClipProvenance } from "./provenance.ts";
import { allTerms } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The video search endpoint, with `page` appended by `searchPage`.
 *
 * Note this is `api.pexels.com/videos/search`, not the `/v1/videos/search` the
 * render path uses. Both answer today; this is the address the API documents
 * and the one whose `page` parameter was verified against a live key.
 */
const PEXELS_SEARCH_URL = "https://api.pexels.com/videos/search";

/** Hard ceiling Pexels enforces on `per_page`. */
const PEXELS_MAX_PER_PAGE = 80;

/**
 * How many pages one term/orientation pair may consume.
 *
 * Measured yield is 15-20 accepted per 20-result page (19 of 20 on the live
 * probe used to write this file), so at the settled `--per-term 4` the first
 * page almost always suffices. The cap exists for the rare term that returns
 * mostly 4K-only assets, and three pages is already 60 candidates.
 */
const DEFAULT_PAGE_CAP = 3;

/** Clips fetched per term, per orientation. The plan's settled value. */
const DEFAULT_PER_TERM = 4;

/** Simultaneous downloads. Also one half of the budget-overshoot bound. */
const DEFAULT_CONCURRENCY = 4;

/**
 * Refuse to start a download when less than this is free on the storage volume.
 *
 * A full disk does not fail cleanly: ffmpeg, Mongo and the render all share
 * this volume, so the damage of overrunning it lands somewhere other than here.
 */
const DEFAULT_MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * Largest single clip this will keep.
 *
 * The exact-resolution rule already restricts renditions to 1920x1080 or
 * 1080x1920, which measure in the tens of megabytes, so this is a guard against
 * a pathological asset rather than a normal limit — and it is the other half of
 * the overshoot bound: see `checkBudget`.
 */
const DEFAULT_MAX_CLIP_BYTES = 300 * 1024 * 1024;

/** Flush the download sink at least this often, so a clip is never fully resident. */
const DOWNLOAD_FLUSH_BYTES = 8 * 1024 * 1024;

/** One search request's timeout. Matches the render path's provider timeout. */
const SEARCH_TIMEOUT_MS = 60_000;

/** One clip download's timeout. Matches `saveVideo`'s. */
const DOWNLOAD_TIMEOUT_MS = 240_000;

/** Attempts per HTTP request, including the first. */
const MAX_ATTEMPTS = 4;

/** First backoff step; doubled per attempt. */
const BACKOFF_BASE_MS = 2_000;

/** Ceiling on one backoff sleep, including a `Retry-After` the provider sends. */
const BACKOFF_MAX_MS = 60_000;

// ---------------------------------------------------------------------------
// Options and results
// ---------------------------------------------------------------------------

export interface PullOptions {
  /** Search terms. Defaults to every seed term, in `terms.json` order. */
  terms?: string[];
  /** Orientations to pull. Defaults to portrait and landscape. */
  aspects?: VideoAspectValue[];
  /** Clips wanted per term per orientation. */
  perTerm?: number;
  /** Ceiling on bytes actually written to disk by this run. */
  maxBytes?: number;
  /** Refuse to start a download below this much free space. */
  minFreeBytes?: number;
  /** Largest single clip to keep. */
  maxClipBytes?: number;
  /** Simultaneous downloads. */
  concurrency?: number;
  /** Pages per term/orientation. */
  pageCap?: number;
  /** List what would be fetched and write nothing — no files, no run document. */
  dryRun?: boolean;
  signal?: AbortSignal;
}

/** One clip the run selected: everything needed to fetch it, or to report it. */
export interface PullCandidate {
  term: string;
  aspect: VideoAspectValue;
  /** The rendition's direct URL. Carries no credentials; never persisted. */
  url: string;
  /** `vid-<md5(url without query)>.mp4` — the render path's name for this clip. */
  localFile: string;
  page: number;
  assetId: string;
  renditionId: string;
  sourcePage: string | null;
  /**
   * Whose work this is. Optional on the type so that a fixture built before
   * provenance existed still satisfies it; absent and `null` mean the same
   * thing to `recordClipProvenance`, which writes the field only when it has
   * something to say.
   */
  creator?: FootageCreator | null;
  width: number;
  height: number;
  duration: number;
  /** True when the destination was already on disk before this run looked. */
  existing: boolean;
}

export interface PullResult {
  /** The `footage_runs` `_id`, or null on a dry run, which writes nothing. */
  runId: string | null;
  dryRun: boolean;
  startedAt: Date;
  finishedAt: Date;
  stopReason: FootageRunStopReason;
  perTerm: FootageRunTermResult[];
  bytesWritten: number;
  clipsAdded: number;
  clipsFailed: number;
  /** Candidates already on disk. Counted toward coverage, never downloaded. */
  clipsSkippedExisting: number;
  /**
   * Provenance rows written for clips this run put on disk or found already
   * there. Optional so the field can be added without invalidating a literal
   * of this type written before provenance existed.
   */
  provenanceWritten?: number;
  /** Provenance writes that failed. Never a failed download — see below. */
  provenanceFailed?: number;
  /**
   * Every candidate the run selected, in selection order. On a dry run this is
   * the whole output: it is the list of what would be fetched.
   */
  candidates: PullCandidate[];
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable with no network, no filesystem, no Mongo)
// ---------------------------------------------------------------------------

/**
 * The repo's exact-resolution rendition rule, applied verbatim.
 *
 * `material/search.ts` accepts a `video_file` only when it matches the
 * requested orientation *and* equals `aspectToResolution()` exactly — 1920x1080
 * for landscape, 1080x1920 for portrait. Anything else is refused rather than
 * scaled, so the library holds only clips a render could have chosen for
 * itself.
 *
 * `matchesVideoAspect` is imported rather than re-implemented so this rule can
 * never drift from the render path's. For the three aspects that exist today
 * the equality check already implies the orientation check; both are kept, in
 * the same order, so the two call sites read as one rule.
 */
export function acceptsRendition(
  width: unknown,
  height: unknown,
  aspect: VideoAspectValue,
): boolean {
  const [wantWidth, wantHeight] = aspectToResolution(aspect);
  const actualWidth = Number(width);
  const actualHeight = Number(height);

  if (!matchesVideoAspect(actualWidth, actualHeight, aspect)) return false;
  return actualWidth === wantWidth && actualHeight === wantHeight;
}

/**
 * The cache filename for a URL.
 *
 * **This must stay byte-identical to `material/download.ts`** — the query
 * string is stripped before hashing there, so it is stripped here. If the two
 * ever disagree, every clip this pull fetched is invisible to the render path,
 * which re-downloads all of it under a different name, and invisible to the
 * `vid-*.mp4` filters behind `/cache/stats` and `/cache/clear`.
 */
export function destinationFileFor(url: string): string {
  return `vid-${md5(url.split("?")[0]!)}.mp4`;
}

/**
 * A temp name for one in-flight download.
 *
 * Unique per call, which is what makes an in-flight dedup map unnecessary: two
 * concurrent downloads of one URL both complete and one rename wins with
 * identical bytes. A shared promise would instead share one `AbortSignal`, so
 * cancelling one caller would abort another's download.
 *
 * The `.part` suffix and the leading dot keep it out of any `*.mp4` walk, and
 * it lives in `storage/temp/downloads` rather than in `cache_videos`, so the
 * two `readdirSync` walkers behind `/cache/stats` and `/cache/clear` can
 * neither count nor delete a download in progress.
 */
export function tempFileNameFor(localFile: string): string {
  const stem = localFile.replace(/\.mp4$/i, "");
  return `.${stem}.${process.pid}.${randomBytes(8).toString("hex")}.part`;
}

/** Why a run may not start another download right now. */
export type BudgetVerdict = "ok" | "budget" | "disk";

/**
 * Whether another download may start.
 *
 * The budget is spent in **bytes actually written**, never in the `size` the
 * provider advertised: that field is discarded before it reaches any type this
 * code can see, so reserving against it would reserve zero on a warm cache and
 * a full budget on a cold one — the wrong answer in both directions.
 *
 * Checked before a download starts rather than during it, so a run can overrun
 * `maxBytes` by at most `concurrency × maxClipBytes` — with the defaults, four
 * downloads of at most 300 MB, so 1.2 GB past a budget that is measured in tens
 * of gigabytes. Stopping mid-stream instead would throw away a clip that is
 * already almost entirely paid for.
 */
export function checkBudget(state: {
  bytesWritten: number;
  maxBytes: number;
  freeBytes: number;
  minFreeBytes: number;
}): BudgetVerdict {
  if (state.bytesWritten >= state.maxBytes) return "budget";
  if (state.freeBytes < state.minFreeBytes) return "disk";
  return "ok";
}

/**
 * Parses `20GB`, `500mb`, `1024` into bytes.
 *
 * A byte budget typed as a bare integer is one keystroke away from being a
 * thousand times too large, and the failure mode of that mistake is a full
 * disk. Suffixes make the intent explicit and legible in shell history.
 */
export function parseByteSize(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|k|m|g|t)?$/i.exec(String(value).trim());
  if (!match) throw new Error(`not a byte size: ${JSON.stringify(value)}`);

  const amount = Number(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  const scale: Record<string, number> = {
    b: 1,
    k: 1024,
    kb: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4,
  };
  return Math.floor(amount * (scale[unit] ?? 1));
}

/**
 * Turns CLI arguments into `PullOptions`.
 *
 * Lives here rather than in the CLI so the flag names and the option names are
 * defined once, and so the parsing is testable without a process. Unknown flags
 * throw instead of being ignored: a mistyped `--per-tem 4` that silently pulls
 * the default would waste an hour and a large fraction of a rate limit before
 * anyone noticed.
 */
export function parsePullArgs(argv: string[]): PullOptions {
  const options: PullOptions = {};
  const terms: string[] = [];
  const aspects: VideoAspectValue[] = [];

  const next = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    return value;
  };
  const positiveInt = (raw: string, flag: string): number => {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} needs a positive integer`);
    return parsed;
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    switch (arg) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--per-term":
        options.perTerm = positiveInt(next(index, arg), arg);
        index++;
        break;
      case "--concurrency":
        options.concurrency = positiveInt(next(index, arg), arg);
        index++;
        break;
      case "--page-cap":
        options.pageCap = positiveInt(next(index, arg), arg);
        index++;
        break;
      case "--max-bytes":
        options.maxBytes = parseByteSize(next(index, arg));
        index++;
        break;
      case "--min-free-bytes":
        options.minFreeBytes = parseByteSize(next(index, arg));
        index++;
        break;
      case "--max-clip-bytes":
        options.maxClipBytes = parseByteSize(next(index, arg));
        index++;
        break;
      case "--term":
        terms.push(next(index, arg));
        index++;
        break;
      case "--terms":
        terms.push(...next(index, arg).split(",").map((term) => term.trim()).filter(Boolean));
        index++;
        break;
      case "--aspect": {
        const raw = next(index, arg).trim().toLowerCase();
        index++;
        if (raw === "both") {
          aspects.push(VideoAspect.portrait, VideoAspect.landscape);
        } else if (raw === "portrait" || raw === VideoAspect.portrait) {
          aspects.push(VideoAspect.portrait);
        } else if (raw === "landscape" || raw === VideoAspect.landscape) {
          aspects.push(VideoAspect.landscape);
        } else if (raw === "square" || raw === VideoAspect.square) {
          aspects.push(VideoAspect.square);
        } else {
          throw new Error(`--aspect must be portrait, landscape, square or both, got ${JSON.stringify(raw)}`);
        }
        break;
      }
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  if (terms.length > 0) options.terms = terms;
  if (aspects.length > 0) options.aspects = [...new Set(aspects)];
  return options;
}

// ---------------------------------------------------------------------------
// Pexels search
// ---------------------------------------------------------------------------

export interface PexelsVideoFile {
  id?: number;
  width?: number;
  height?: number;
  link?: string;
}

export interface PexelsVideo {
  id?: number;
  duration?: number;
  url?: string;
  /**
   * The contributor. Untyped because it is untrusted provider JSON; every
   * reader passes it through `creatorInfo`, which is the allow-list.
   */
  user?: unknown;
  video_files?: PexelsVideoFile[];
}

export interface SearchPageResult {
  /** The last HTTP status seen, including after retries. 0 means no response. */
  status: number;
  videos: PexelsVideo[];
}

/** `Retry-After` in milliseconds, clamped, or the caller's exponential step. */
function retryDelayMs(response: Response | undefined, attempt: number): number {
  const header = response?.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, BACKOFF_MAX_MS);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), BACKOFF_MAX_MS);
  }
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

/**
 * One page of Pexels video search.
 *
 * `page` is constructed here on purpose — see the header note about the
 * doubled `next_page` path — and `response.ok` is checked before the body is
 * parsed, which is the difference between "this term returned nothing" and
 * "this term was rate-limited". The render path's version does neither, and a
 * 404 with an empty body would reach `response.json()` and surface as `[]`.
 *
 * A 429 or a 5xx is retried with backoff, honouring `Retry-After`. A run of
 * ~126 terms across two orientations issues far more requests than a single
 * Pexels hourly allowance, so a sustained 429 is expected rather than
 * exceptional: after `MAX_ATTEMPTS` the status is returned and recorded as the
 * term's `last_status`, and the run moves on instead of dying.
 *
 * Exported because the provenance backfill has to re-issue *these* requests —
 * same endpoint, same orientation, same construction of `page`, same backoff —
 * to recover the URLs whose md5 named the files already on disk. A second
 * paginating client would only have to be kept in step with this one.
 */
export async function searchPexelsPage(params: {
  term: string;
  aspect: VideoAspectValue;
  page: number;
  perPage: number;
  signal?: AbortSignal;
}): Promise<SearchPageResult> {
  const { term, aspect, page, perPage, signal } = params;

  const query = new URLSearchParams({
    query: term,
    per_page: String(Math.min(perPage, PEXELS_MAX_PER_PAGE)),
    orientation: aspectOrientation(aspect),
    page: String(page),
  });
  const url = `${PEXELS_SEARCH_URL}?${query}`;

  let status = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) return { status, videos: [] };

    // Rotated per request, which is the whole point of a multi-key config: a
    // second key is a second hourly allowance for a run this size.
    const apiKey = rotateApiKey("pexels_api_keys", appConfig().pexels_api_keys);

    let response: Response | undefined;
    try {
      response = await providerFetch(url, {
        headers: { Authorization: apiKey, "User-Agent": BROWSER_USER_AGENT },
        timeoutMs: SEARCH_TIMEOUT_MS,
        signal,
      });
      status = response.status;

      if (response.ok) {
        const data = (await response.json()) as { videos?: PexelsVideo[] };
        if (!Array.isArray(data.videos)) {
          logger.error(`pexels page ${page} for ${JSON.stringify(term)} had no videos array`);
          return { status, videos: [] };
        }
        return { status, videos: data.videos };
      }

      // 4xx other than 429 will not improve by being asked again: a bad key, a
      // malformed query, a removed endpoint.
      if (status !== 429 && status < 500) {
        logger.error(
          `pexels search failed: term=${JSON.stringify(term)}, aspect=${aspect}, page=${page}, status=${status}`,
        );
        return { status, videos: [] };
      }
    } catch (error) {
      if (signal?.aborted) return { status, videos: [] };
      logger.warning(
        `pexels search error: term=${JSON.stringify(term)}, page=${page}, ` +
          describeProviderError(error, apiKey),
      );
    }

    if (attempt === MAX_ATTEMPTS - 1) break;
    const delay = retryDelayMs(response, attempt);
    logger.warning(
      `pexels search backing off ${delay}ms: term=${JSON.stringify(term)}, aspect=${aspect}, ` +
        `page=${page}, status=${status || "none"}, attempt=${attempt + 1}/${MAX_ATTEMPTS}`,
    );
    await sleep(delay);
  }

  logger.error(
    `pexels search gave up: term=${JSON.stringify(term)}, aspect=${aspect}, page=${page}, status=${status || "none"}`,
  );
  return { status, videos: [] };
}

/**
 * Selects up to `perTerm` clips for one term and orientation.
 *
 * Stops as soon as enough candidates exist, so `attempted` counts what was
 * actually looked at rather than everything a page happened to contain — the
 * counters then read as "of the N results we examined, A had a usable
 * rendition". The exact-resolution rule is the only filter, so
 * `attempted === accepted + rejected_resolution` always holds; a duration floor
 * is deliberately not applied, because the library wants whatever exists and
 * the render applies its own minimum when it selects.
 *
 * A candidate already on disk still counts toward the cap: the goal is N clips
 * per term in the library, not N fresh downloads.
 */
async function collectForTerm(params: {
  term: string;
  aspect: VideoAspectValue;
  perTerm: number;
  pageCap: number;
  destinationDir: string;
  claimed: Set<string>;
  signal?: AbortSignal;
}): Promise<{ result: FootageRunTermResult; candidates: PullCandidate[] }> {
  const { term, aspect, perTerm, pageCap, destinationDir, claimed, signal } = params;

  const result: FootageRunTermResult = {
    term,
    aspect,
    attempted: 0,
    accepted: 0,
    rejected_resolution: 0,
  };
  const candidates: PullCandidate[] = [];
  const perPage = Math.min(PEXELS_MAX_PER_PAGE, Math.max(20, perTerm * 2));

  for (let page = 1; page <= pageCap && candidates.length < perTerm; page++) {
    if (signal?.aborted) break;

    const { status, videos } = await searchPexelsPage({ term, aspect, page, perPage, signal });
    if (status) result.last_status = status;
    if (videos.length === 0) break;

    for (const video of videos) {
      if (candidates.length >= perTerm) break;
      result.attempted++;

      const file = (video.video_files ?? []).find(
        (candidate) => candidate.link && acceptsRendition(candidate.width, candidate.height, aspect),
      );
      if (!file?.link) {
        result.rejected_resolution++;
        continue;
      }

      result.accepted++;

      const localFile = destinationFileFor(file.link);
      // One asset reached by two terms is one file, so the second term neither
      // re-downloads it nor spends one of its slots pretending to.
      if (claimed.has(localFile)) continue;
      claimed.add(localFile);

      candidates.push({
        term,
        aspect,
        url: file.link,
        localFile,
        page,
        assetId: video.id === undefined ? "" : String(video.id),
        renditionId: file.id === undefined ? "" : String(file.id),
        sourcePage: safePublicUrl(video.url),
        // Same allow-list the render path applies to the same field, so the
        // two sources of a `footage_index` row cannot disagree about what a
        // creator is.
        creator: creatorInfo(video.user),
        width: Number(file.width) || 0,
        height: Number(file.height) || 0,
        duration: Math.trunc(Number(video.duration) || 0),
        existing: existsSync(join(destinationDir, localFile)),
      });
    }

    // A short page is the last page; asking for the next one wastes a request
    // against an allowance this run is already straining.
    if (videos.length < perPage) break;
  }

  return { result, candidates };
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/** A clip whose body exceeded `maxClipBytes`; the partial file is discarded. */
class ClipTooLargeError extends Error {
  constructor(limit: number) {
    super(`clip exceeded ${limit} bytes`);
    this.name = "ClipTooLargeError";
  }
}

/**
 * Streams a response body to a file and returns the bytes written.
 *
 * The shape is `material/download.ts`'s verified streaming path: write through
 * a sink with a bounded high-water mark rather than buffering the body, which
 * holds resident memory at the buffer size instead of at the clip size.
 */
async function streamToFile(
  response: Response,
  destination: string,
  maxClipBytes: number,
): Promise<number> {
  const body = response.body;
  if (!body) throw new Error("download failed: response had no body");

  const sink = Bun.file(destination).writer({ highWaterMark: DOWNLOAD_FLUSH_BYTES });
  let buffered = 0;
  let total = 0;

  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      // Throwing here cancels the body, so a runaway asset stops costing
      // bandwidth at the limit rather than at its full size.
      if (total > maxClipBytes) throw new ClipTooLargeError(maxClipBytes);

      const written = sink.write(chunk);
      buffered += typeof written === "number" ? written : await written;
      if (buffered >= DOWNLOAD_FLUSH_BYTES) {
        await sink.flush();
        buffered = 0;
      }
    }
    await sink.end();
  } catch (error) {
    try {
      sink.end();
    } catch {
      // Already closed.
    }
    throw error;
  }

  return total;
}

/**
 * Fetches one clip into the cache directory, or returns 0.
 *
 * Bytes land on a unique temp in `storage/temp/downloads`, are probed there,
 * and are renamed into place only once ffprobe agrees they decode. Both
 * directories are under `storage/`, so the rename is same-filesystem and cannot
 * fail with `EXDEV`; the final `vid-<hash>.mp4` name therefore only ever
 * appears as a complete, playable file.
 *
 * Returns the bytes written, which is what the budget is spent in — a failed
 * or discarded download returns 0 because nothing survived.
 */
async function downloadClip(params: {
  candidate: PullCandidate;
  destinationDir: string;
  tempDir: string;
  maxClipBytes: number;
  signal?: AbortSignal;
}): Promise<number> {
  const { candidate, destinationDir, tempDir, maxClipBytes, signal } = params;

  const destination = join(destinationDir, candidate.localFile);
  const tempPath = join(tempDir, tempFileNameFor(candidate.localFile));

  const response = await providerFetch(candidate.url, {
    headers: { "User-Agent": BROWSER_USER_AGENT },
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    signal,
  });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);

  try {
    await streamToFile(response, tempPath, maxClipBytes);

    if (!existsSync(tempPath)) throw new Error("download produced no file");
    const written = statSync(tempPath).size;
    if (written <= 0) throw new Error("download produced an empty file");

    if (!(await isValidVideo(tempPath))) {
      logger.warning(`discarding undecodable clip: ${candidate.localFile} (${candidate.url})`);
      return 0;
    }

    await rename(tempPath, destination);
    return written;
  } finally {
    // A no-op after a successful rename. Swallowed so a cleanup failure never
    // masks the real error, and so no temp survives the run either way.
    await unlink(tempPath).catch(() => {});
  }
}

/** Free bytes on the storage volume, or `Infinity` when it cannot be read. */
async function freeBytesOnStorage(): Promise<number> {
  try {
    const stats = await statfs(storageDir());
    return Number(stats.bavail) * Number(stats.bsize);
  } catch (error) {
    // A run must not stop because the filesystem would not answer; the byte
    // budget is still enforced, and this is the belt to that's braces.
    logger.warning(`could not read free disk space: ${errorName(error)}, detail=${errorMessage(error)}`);
    return Number.POSITIVE_INFINITY;
  }
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Records where one clip came from, and never fails the run for it.
 *
 * This is the whole reason the library had no attribution: `saveVideo` fires
 * `noteDownloadedMaterial` and this module deliberately does not use
 * `saveVideo`, so the hook never saw a single one of these downloads and
 * `footage index` then rebuilt the rows from the filesystem — which knows a
 * filename and nothing else. Everything the hook would have recorded is
 * already in hand here, in `PullCandidate`; it was simply thrown away.
 *
 * Unlike the hook this one is awaited. The hook cannot block because it sits
 * on the render path; the pull is off it by construction (see the module
 * header), it has already spent a network round trip and tens of megabytes on
 * this clip, and one more small write buys certainty that the provenance is
 * durable before the process can be killed.
 *
 * What it keeps from the hook is the part that matters: **a provenance write
 * is never allowed to cost a clip.** Every outcome is swallowed after a log
 * line, so the caller's `try` around `downloadClip` can never see this throw
 * and count a downloaded file as a failed download.
 *
 * Returns true when the row was written, which is only used for the run's
 * counters.
 */
async function recordCandidateProvenance(candidate: PullCandidate): Promise<boolean> {
  try {
    if (!isConnected()) return false;
    await recordClipProvenance({
      localFile: candidate.localFile,
      provider: "pexels",
      assetId: candidate.assetId,
      renditionId: candidate.renditionId,
      sourcePage: candidate.sourcePage ?? "",
      creator: candidate.creator ?? null,
      searchTerm: candidate.term,
    });
    return true;
  } catch (error) {
    // The clip is on disk and the indexer walks the directory, so the cost of
    // this is one clip with no attribution until the next pull or a
    // `footage backfill-provenance` — never a lost download.
    logger.warning(
      `could not record provenance for ${candidate.localFile}: ` +
        `${errorName(error)}, detail=${errorMessage(error)}`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Pulls footage into `storage/cache_videos` and records what happened.
 *
 * Terms are searched one at a time — the request rate is the scarce resource,
 * not the wall clock — and each term's candidates are then downloaded with
 * bounded parallelism. Stop conditions are re-checked before every download, so
 * a run ends on the budget, the disk floor or an abort rather than on whichever
 * of those first produced an exception.
 *
 * Every failure below the run level is recorded and survived: an undecodable
 * clip, a 429'd term, a connection reset. The run itself fails only if the
 * environment is wrong (no Pexels key, no Mongo for the record it must write).
 */
export async function pullFootage(options: PullOptions = {}): Promise<PullResult> {
  const {
    terms = allTerms(),
    aspects = [VideoAspect.portrait, VideoAspect.landscape],
    perTerm = DEFAULT_PER_TERM,
    maxBytes = Number.POSITIVE_INFINITY,
    minFreeBytes = DEFAULT_MIN_FREE_BYTES,
    maxClipBytes = DEFAULT_MAX_CLIP_BYTES,
    concurrency = DEFAULT_CONCURRENCY,
    pageCap = DEFAULT_PAGE_CAP,
    dryRun = false,
    signal,
  } = options;

  const startedAt = new Date();
  const runId = dryRun ? null : getUuid();
  const destinationDir = cacheVideosDir(!dryRun);
  const tempDir = dryRun ? "" : storageDir("temp/downloads", true);

  // Fail before spending anything if the run cannot record what it did. The
  // document is the only trace of a clip that was never downloaded, so a run
  // that could not write one is not worth starting.
  if (!dryRun && !isConnected()) {
    throw new Error("footage pull needs a mongodb connection to record the run");
  }

  const perTermResults: FootageRunTermResult[] = [];
  const candidates: PullCandidate[] = [];
  const claimed = new Set<string>();

  let bytesWritten = 0;
  let clipsAdded = 0;
  let clipsFailed = 0;
  let clipsSkippedExisting = 0;
  let provenanceWritten = 0;
  let provenanceFailed = 0;
  let stopReason: FootageRunStopReason = "complete";

  if (runId) {
    const opening: FootageRunDocument = {
      _id: runId,
      started_at: startedAt,
      per_term: [],
      bytes_written: 0,
      clips_added: 0,
      clips_failed: 0,
    };
    // Inserted up front, without `finished_at`: a run whose process is killed
    // then leaves exactly the trace the document type describes.
    await footageRunsCollection().insertOne(opening);
  }

  logger.info(
    `footage pull ${dryRun ? "(dry run) " : ""}starting: terms=${terms.length}, ` +
      `aspects=${aspects.join("/")}, per_term=${perTerm}, page_cap=${pageCap}, concurrency=${concurrency}, ` +
      `max_bytes=${Number.isFinite(maxBytes) ? maxBytes : "unlimited"}`,
  );

  try {
    outer: for (const term of terms) {
      for (const aspect of aspects) {
        if (signal?.aborted) {
          stopReason = "aborted";
          break outer;
        }

        const verdict = checkBudget({
          bytesWritten,
          maxBytes,
          freeBytes: dryRun ? Number.POSITIVE_INFINITY : await freeBytesOnStorage(),
          minFreeBytes,
        });
        if (verdict !== "ok") {
          stopReason = verdict;
          break outer;
        }

        const { result, candidates: found } = await collectForTerm({
          term,
          aspect,
          perTerm,
          pageCap,
          destinationDir,
          claimed,
          signal,
        });
        perTermResults.push(result);
        candidates.push(...found);

        logger.info(
          `pull ${JSON.stringify(term)} ${aspect}: attempted=${result.attempted}, ` +
            `accepted=${result.accepted}, rejected_resolution=${result.rejected_resolution}, ` +
            `selected=${found.length}${result.last_status ? `, last_status=${result.last_status}` : ""}`,
        );

        if (dryRun) continue;

        const fresh: PullCandidate[] = [];
        for (const candidate of found) {
          if (!candidate.existing) {
            fresh.push(candidate);
            continue;
          }
          clipsSkippedExisting++;
          logger.debug(`already cached, skipping: ${candidate.localFile}`);
          // Recorded for the same reason the download hook records a cache
          // hit: the file is already on disk, so its row is real, and on a
          // warm cache these are the majority. Skipping them would leave most
          // of the library with no attribution however often the pull re-runs.
          if (await recordCandidateProvenance(candidate)) provenanceWritten++;
          else provenanceFailed++;
        }

        // Bounded parallelism over one term's clips: workers share a cursor and
        // each re-checks the stop conditions, so the budget is honoured by the
        // download that is about to start rather than by the loop that queued
        // it.
        let cursor = 0;
        let stopped: FootageRunStopReason | undefined;

        const worker = async (): Promise<void> => {
          for (;;) {
            const index = cursor++;
            const candidate = fresh[index];
            if (!candidate || stopped) return;

            if (signal?.aborted) {
              stopped = "aborted";
              return;
            }
            const check = checkBudget({
              bytesWritten,
              maxBytes,
              freeBytes: await freeBytesOnStorage(),
              minFreeBytes,
            });
            if (check !== "ok") {
              stopped = check;
              return;
            }

            try {
              const written = await downloadClip({
                candidate,
                destinationDir,
                tempDir,
                maxClipBytes,
                signal,
              });
              if (written > 0) {
                bytesWritten += written;
                clipsAdded++;
                // After the rename, so a row is only ever written for a file
                // that exists and decodes. Cannot throw — see the function.
                if (await recordCandidateProvenance(candidate)) provenanceWritten++;
                else provenanceFailed++;
                logger.info(
                  `pulled ${candidate.localFile}: term=${JSON.stringify(candidate.term)}, ` +
                    `${candidate.width}x${candidate.height}, ${written} bytes`,
                );
              } else {
                clipsFailed++;
              }
            } catch (error) {
              clipsFailed++;
              logger.warning(
                `pull download failed: ${candidate.localFile}, ` +
                  describeProviderError(error, candidate.url),
              );
            }
          }
        };

        await Promise.all(
          Array.from({ length: Math.max(1, Math.min(concurrency, fresh.length || 1)) }, worker),
        );

        if (stopped) {
          stopReason = stopped;
          break outer;
        }
      }
    }
  } catch (error) {
    stopReason = "error";
    logger.error(`footage pull failed: ${errorName(error)}, detail=${errorMessage(error)}`);
  }

  const finishedAt = new Date();
  const result: PullResult = {
    runId,
    dryRun,
    startedAt,
    finishedAt,
    stopReason,
    perTerm: perTermResults,
    bytesWritten,
    clipsAdded,
    clipsFailed,
    clipsSkippedExisting,
    provenanceWritten,
    provenanceFailed,
    candidates,
  };

  if (runId) {
    try {
      await footageRunsCollection().updateOne(
        { _id: runId },
        {
          $set: {
            finished_at: finishedAt,
            stop_reason: stopReason,
            per_term: perTermResults,
            bytes_written: bytesWritten,
            clips_added: clipsAdded,
            clips_failed: clipsFailed,
          },
        },
      );
    } catch (error) {
      // The clips are on disk and the indexer walks the directory, so a lost
      // record costs diagnosis, not footage. Reported, never thrown.
      logger.error(
        `could not finalise footage run ${runId}: ${errorName(error)}, detail=${errorMessage(error)}`,
      );
    }
  }

  logger.success(
    `footage pull ${dryRun ? "(dry run) " : ""}finished: stop_reason=${stopReason}, ` +
      `selected=${candidates.length}, added=${clipsAdded}, failed=${clipsFailed}, ` +
      `already_cached=${clipsSkippedExisting}, bytes_written=${bytesWritten}, ` +
      `provenance_written=${provenanceWritten}, provenance_failed=${provenanceFailed}`,
  );

  return result;
}

/**
 * A human-readable dry-run listing.
 *
 * `--dry-run` exists to answer "what would this fetch, and how much of it do I
 * already have" before an hour of downloads, so the answer is a table rather
 * than a log line, and it is built here so the CLI does not re-derive it.
 */
export function formatDryRun(result: PullResult): string {
  const lines: string[] = [];
  for (const candidate of result.candidates) {
    lines.push(
      [
        candidate.existing ? "have" : "pull",
        candidate.localFile,
        `${candidate.width}x${candidate.height}`,
        `${candidate.duration}s`,
        `p${candidate.page}`,
        `${candidate.aspect} ${JSON.stringify(candidate.term)}`,
      ].join("  "),
    );
  }

  // A term that returned little because it was throttled looks exactly like a
  // term that returned little because Pexels has little, so the two are
  // separated here rather than left for a reader to guess at.
  const throttled = result.perTerm.filter((term) => term.last_status === 429);
  const empty = result.perTerm.filter((term) => term.accepted === 0 && term.last_status !== 429);

  lines.push(
    `${result.candidates.length} clips selected across ${result.perTerm.length} term/aspect pairs; ` +
      `${result.candidates.filter((candidate) => candidate.existing).length} already cached; ` +
      `${throttled.length} rate-limited; ${empty.length} with no usable rendition; ` +
      `stop_reason=${result.stopReason}`,
  );
  return lines.join("\n");
}
