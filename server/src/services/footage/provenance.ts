/**
 * Provenance for the footage library: the write, and the recovery of it.
 *
 * Two things live here because they are the same rule seen from two ends.
 *
 * `recordClipProvenance` is the write. `hook.ts` already performs exactly this
 * job for the render path, and its semantics are load-bearing rather than
 * incidental — a row that has never been described must be created at version
 * 0 with a null description so the indexer sees work whichever of the two
 * fields it tests, and a term arriving for a row that is already `indexed`
 * must mark it `stale` rather than re-describe it, because a new search term
 * changes the Qdrant payload and nothing else (design §4.5). Those rules are
 * implemented once, here, and `hook.ts` keeps its own copy only because it is
 * on the render path and cannot afford to import this module's neighbours.
 *
 * `backfillProvenance` is the recovery. The pull downloads with its own client
 * — deliberately, to stay off the render path — so `saveVideo` never ran and
 * the hook never fired, and `footage index` then built 1,512 rows from the
 * filesystem, which knows a filename and nothing else. Those clips are Pexels
 * clips held under Pexels terms and the library could not attribute one of
 * them.
 *
 * The recovery works only because the filename is not arbitrary: it is
 * `vid-<md5(url without query)>.mp4`. The hash is one-way, so the URL cannot
 * be read back out of it — but it *can* be guessed, by re-running the searches
 * the pull ran and hashing every rendition URL they return. A hit names the
 * row. A miss means the clip has slid out of the pages the search returns
 * today, which is expected for a library pulled days ago and is reported as a
 * remainder rather than as an error.
 *
 * Two things this must not do:
 *
 *  1. **Never call `searchWithCache`.** Its key carries no page number
 *     (`material/cache.ts`), so writing through it would overwrite the render
 *     path's 24-hour entry for every term this touches. It re-uses `pull.ts`'s
 *     own paginating client instead, backoff included.
 *  2. **Never race the indexer.** The caller takes the index lock, so a
 *     backfill and an `index` run cannot both be deciding what `state` a row
 *     is in.
 */

import type { Filter, UpdateFilter } from "mongodb";

import { footageIndexCollection } from "../../db/client.ts";
import type { FootageCreator, FootageIndexDocument } from "../../db/types.ts";
import { VideoAspect, type VideoAspectValue } from "../../models/schema.ts";
import { errorMessage, errorName, logger } from "../../utils/logger.ts";
import { creatorInfo } from "../material/search.ts";
import { safePublicUrl } from "../material/http.ts";
import { destinationFileFor, searchPexelsPage, type PexelsVideo } from "./pull.ts";
import { allTerms, pointIdFor } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Results per search request during a backfill.
 *
 * The recorded runs examined at most 19 results per term/orientation, so every
 * clip in the library came off page 1 at `per_page=20`. Asking for 80 makes
 * one request cover what four of those pages covered, which matters when the
 * whole sweep is 252 requests against a single hourly allowance.
 */
const DEFAULT_BACKFILL_PER_PAGE = 80;

/**
 * Pages per term/orientation.
 *
 * One page of 80 is already a superset of what the pull saw. A second page
 * buys only the clips whose ranking has drifted past position 80 since, at the
 * cost of doubling a request count that is already over the rate limit — so it
 * is opt-in via `--page-cap`.
 */
const DEFAULT_BACKFILL_PAGE_CAP = 1;

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

/** Everything worth storing about where one clip came from. */
export interface ClipProvenance {
  /** Basename only, e.g. `vid-d6e9….mp4`. Never an absolute path. */
  localFile: string;
  provider: string;
  assetId: string;
  renditionId: string;
  sourcePage: string;
  creator: FootageCreator | null;
  /** The term that reached this clip. Accumulated, never replaced. */
  searchTerm: string;
}

/**
 * The Mongo write one provenance record implies, as data.
 *
 * Separated from the write itself so the rule — which fields are set, when a
 * row is created, and the one case that marks a row `stale` — is a pure
 * function of the record and the row that is already there, and can therefore
 * be tested without a database.
 */
export interface ProvenanceUpdatePlan {
  id: string;
  set: Partial<FootageIndexDocument>;
  /** Absent when the plan does not create rows — see `upsert`. */
  setOnInsert?: Partial<FootageIndexDocument>;
  addToSet?: { search_terms: string };
  upsert: boolean;
  /** True when this write flips an already-indexed row to `stale`. */
  markedStale: boolean;
}

/** What the row looked like before the write. Only these two fields decide. */
export type ExistingProvenanceRow = Pick<FootageIndexDocument, "state" | "search_terms"> | null;

/**
 * Builds the update for one clip, matching `hook.ts` field for field.
 *
 * The three rules that are not obvious:
 *
 *  - **Only non-empty values are set.** A blank `asset_id` from a provider
 *    response that omitted the field would otherwise overwrite a good one.
 *  - **A new term on an `indexed` row marks it `stale`, and that write does
 *    not upsert.** The row was read as existing, so upserting would resurrect
 *    it as `stale` with nothing to be stale about if a cache clear removed it
 *    in between.
 *  - **A row created here is `stale` at version 0 with a null description.**
 *    `state` has no value meaning *new*, and version 0 matches no current
 *    constant, so the indexer sees work whichever field it tests.
 */
export function planProvenanceUpdate(
  provenance: ClipProvenance,
  existing: ExistingProvenanceRow,
  now: Date,
): ProvenanceUpdatePlan {
  const id = pointIdFor(provenance.localFile);
  const searchTerm = provenance.searchTerm.trim();

  const isNewTerm = searchTerm !== "" && !(existing?.search_terms ?? []).includes(searchTerm);
  const markedStale = existing?.state === "indexed" && isNewTerm;

  const set: Partial<FootageIndexDocument> = { updated_at: now };
  if (provenance.provider) set.provider = provenance.provider;
  if (provenance.assetId) set.asset_id = provenance.assetId;
  if (provenance.renditionId) set.rendition_id = provenance.renditionId;
  if (provenance.sourcePage) set.source_page = provenance.sourcePage;
  if (provenance.creator) set.creator = provenance.creator;
  if (markedStale) set.state = "stale";

  const addToSet = searchTerm ? { search_terms: searchTerm } : undefined;

  if (markedStale) {
    return { id, set, upsert: false, markedStale: true, ...(addToSet ? { addToSet } : {}) };
  }

  const setOnInsert: Partial<FootageIndexDocument> = {
    local_file: provenance.localFile,
    state: "stale",
    description: null,
    describe_version: 0,
    embed_version: 0,
    attempts: 0,
    created_at: now,
  };
  // Mongo rejects an update that writes one path from two operators, so a
  // default is only supplied when nothing else claims the field.
  if (!addToSet) setOnInsert.search_terms = [];
  if (!provenance.provider) setOnInsert.provider = "";

  return { id, set, setOnInsert, upsert: true, markedStale: false, ...(addToSet ? { addToSet } : {}) };
}

/** How the write ended, for the caller's counters. */
export type ProvenanceOutcome = "created" | "updated" | "marked_stale";

/**
 * Reads the row, plans the write, and performs it.
 *
 * Throws on a Mongo failure. Every caller is expected to decide for itself
 * what that costs — for the pull and the hook the answer is "nothing, log it",
 * because the file on disk is the durable work-list and a lost row costs one
 * later re-read, not one lost clip.
 */
export async function recordClipProvenance(
  provenance: ClipProvenance,
  options: { maxTimeMS?: number } = {},
): Promise<ProvenanceOutcome> {
  const { maxTimeMS } = options;
  const collection = footageIndexCollection();

  const id = pointIdFor(provenance.localFile);
  const existing = await collection.findOne(
    { _id: id },
    {
      projection: { state: 1, search_terms: 1 },
      ...(maxTimeMS === undefined ? {} : { maxTimeMS }),
    },
  );

  const plan = planProvenanceUpdate(provenance, existing, new Date());
  // Assembled from the plan rather than declared inline, because which
  // operators appear is exactly what the plan decides.
  const update: UpdateFilter<FootageIndexDocument> = { $set: plan.set };
  if (plan.setOnInsert) update.$setOnInsert = plan.setOnInsert;
  if (plan.addToSet) update.$addToSet = plan.addToSet;

  const result = await collection.updateOne({ _id: plan.id }, update, {
    ...(plan.upsert ? { upsert: true } : {}),
    ...(maxTimeMS === undefined ? {} : { maxTimeMS }),
  });

  if (plan.markedStale) return "marked_stale";
  return result.upsertedCount > 0 ? "created" : "updated";
}

// ---------------------------------------------------------------------------
// Matching a search result back to a file on disk
// ---------------------------------------------------------------------------

/** One rendition whose filename matched a row the backfill is looking for. */
export interface RenditionMatch {
  localFile: string;
  assetId: string;
  renditionId: string;
  sourcePage: string;
  creator: FootageCreator | null;
}

/**
 * Every rendition in `videos` whose cache filename is one of `wanted`.
 *
 * Deliberately checks *all* renditions, not just the one the pull's
 * exact-resolution rule would accept. The filename is derived from the
 * rendition URL, so a hit is proof of identity and cannot be a false positive;
 * ignoring the resolution rule only widens what can be recovered — a clip
 * fetched under a different orientation, or by the render path, is matched
 * just the same. `rendition_id` stays exact because the match is per
 * rendition, not per asset.
 *
 * Pure: no network, no database, no filesystem.
 */
export function matchRenditions(
  videos: PexelsVideo[],
  wanted: ReadonlySet<string>,
): RenditionMatch[] {
  const matches: RenditionMatch[] = [];

  for (const video of videos) {
    for (const file of video.video_files ?? []) {
      if (!file.link) continue;
      const localFile = destinationFileFor(file.link);
      if (!wanted.has(localFile)) continue;

      matches.push({
        localFile,
        assetId: video.id === undefined || video.id === null ? "" : String(video.id),
        renditionId: file.id === undefined || file.id === null ? "" : String(file.id),
        sourcePage: safePublicUrl(video.url) ?? "",
        creator: creatorInfo(video.user),
      });
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// The backfill
// ---------------------------------------------------------------------------

export interface BackfillOptions {
  /** Terms to re-search. Defaults to every seed term, in `terms.json` order. */
  terms?: string[];
  /** Orientations. Defaults to portrait and landscape, as the pull did. */
  aspects?: VideoAspectValue[];
  /** Results per request. Capped at 80 by the provider. */
  perPage?: number;
  /** Pages per term/orientation. */
  pageCap?: number;
  /** Report what would be filled and write nothing. */
  dryRun?: boolean;
  signal?: AbortSignal;
}

export interface BackfillResult {
  dryRun: boolean;
  /** Rows in `footage_index` when the run started. */
  rowsTotal: number;
  /** Of those, how many had no provider — the rows this run is for. */
  rowsMissingBefore: number;
  /**
   * Distinct rows this run wrote provenance for — or, on a dry run, would
   * have. A row whose write threw is not counted here; it is in
   * `writeFailures` and in `rowsMissingAfter`.
   */
  rowsMatched: number;
  /**
   * Rows still without a provider. Counted from Mongo after a real run;
   * projected as `rowsMissingBefore - rowsMatched` on a dry run, which is what
   * `projected` says.
   */
  rowsMissingAfter: number;
  projected: boolean;
  /** Term/orientation pairs searched, and requests issued. */
  pairsSearched: number;
  pagesFetched: number;
  /** Pairs whose last status was 429: a thin result here is not a real miss. */
  throttled: number;
  /** Pairs that ended on any other non-200 status. */
  errored: number;
  /** Writes that threw. Never fatal, always reported. */
  writeFailures: number;
  aborted: boolean;
  elapsedMs: number;
}

/**
 * Fills in provenance for rows that have none.
 *
 * Targets only rows whose `provider` is empty: a row that already knows where
 * it came from needs nothing, and re-writing it would spend a write to
 * re-assert what is there. A row can still gain several terms in one run —
 * the second term to reach a file is added with `$addToSet`, exactly as the
 * hook would have done had it seen both searches.
 *
 * Stops early once every targeted row has been matched, which on a library
 * pulled with the same terms happens long before the term list runs out.
 */
export async function backfillProvenance(options: BackfillOptions = {}): Promise<BackfillResult> {
  const {
    terms = allTerms(),
    aspects = [VideoAspect.portrait, VideoAspect.landscape],
    perPage = DEFAULT_BACKFILL_PER_PAGE,
    pageCap = DEFAULT_BACKFILL_PAGE_CAP,
    dryRun = false,
    signal,
  } = options;

  const startedAt = Date.now();
  const collection = footageIndexCollection();

  const rowsTotal = await collection.countDocuments({});
  // The rows this run is for. `provider: ""` is what a row built from the
  // filesystem carries — present, but saying nothing — and `$in: [null]` is
  // Mongo's idiom for "null or missing", so all three cases are one predicate.
  // Built loose and cast once, as `routes/v1/footage.ts` does: the document
  // type declares `provider: string`, and these rows are the proof that a
  // stored document can be emptier than the type that reads it.
  const missingFilter = { provider: { $in: ["", null] } } as unknown as Filter<FootageIndexDocument>;
  const targets = new Set(
    (await collection.find(missingFilter, { projection: { local_file: 1 } }).toArray())
      .map((row) => row.local_file)
      .filter((file): file is string => typeof file === "string" && file.length > 0),
  );
  const rowsMissingBefore = targets.size;

  const filled = new Set<string>();
  const appliedPairs = new Set<string>();

  let pairsSearched = 0;
  let pagesFetched = 0;
  let throttled = 0;
  let errored = 0;
  let writeFailures = 0;
  let aborted = false;

  logger.info(
    `footage backfill-provenance ${dryRun ? "(dry run) " : ""}starting: ` +
      `rows=${rowsTotal}, without_provenance=${rowsMissingBefore}, terms=${terms.length}, ` +
      `aspects=${aspects.join("/")}, per_page=${perPage}, page_cap=${pageCap}`,
  );

  outer: for (const term of terms) {
    for (const aspect of aspects) {
      if (signal?.aborted) {
        aborted = true;
        break outer;
      }
      // Nothing left to recover; the remaining requests would buy nothing and
      // cost the whole rate limit.
      if (filled.size >= targets.size) break outer;

      pairsSearched++;
      let lastStatus = 0;

      for (let page = 1; page <= pageCap; page++) {
        if (signal?.aborted) {
          aborted = true;
          break outer;
        }

        const { status, videos } = await searchPexelsPage({ term, aspect, page, perPage, signal });
        pagesFetched++;
        if (status) lastStatus = status;
        if (videos.length === 0) break;

        for (const match of matchRenditions(videos, targets)) {
          // One file reached by two terms is one row with two terms, and the
          // same (file, term) pair seen on two pages is one write.
          const pair = `${match.localFile} ${term}`;
          if (appliedPairs.has(pair)) continue;
          appliedPairs.add(pair);

          if (dryRun) {
            filled.add(match.localFile);
            continue;
          }

          try {
            await recordClipProvenance({
              localFile: match.localFile,
              provider: "pexels",
              assetId: match.assetId,
              renditionId: match.renditionId,
              sourcePage: match.sourcePage,
              creator: match.creator,
              searchTerm: term,
            });
            // Counted only once the write returned, so `rowsMatched` cannot
            // claim a row that a failed write left exactly as it was.
            filled.add(match.localFile);
          } catch (error) {
            writeFailures++;
            logger.warning(
              `backfill write failed: ${match.localFile}, ` +
                `${errorName(error)}, detail=${errorMessage(error)}`,
            );
          }
        }

        // A short page is the last page.
        if (videos.length < perPage) break;
      }

      // A pair that never got a clean answer is not evidence that its clips
      // are gone, so it is bucketed separately from the remainder. Status 0
      // means no response survived the retries at all, which is a failure to
      // report rather than a silence to absorb.
      if (lastStatus === 429) throttled++;
      else if (lastStatus !== 200) errored++;
    }
  }

  // Measured, not derived: the count that matters is what Mongo holds now, and
  // a write that silently did nothing would be invisible in a subtraction.
  const rowsMissingAfter = dryRun
    ? rowsMissingBefore - filled.size
    : await collection.countDocuments(missingFilter);

  const result: BackfillResult = {
    dryRun,
    rowsTotal,
    rowsMissingBefore,
    rowsMatched: filled.size,
    rowsMissingAfter,
    projected: dryRun,
    pairsSearched,
    pagesFetched,
    throttled,
    errored,
    writeFailures,
    aborted,
    elapsedMs: Date.now() - startedAt,
  };

  logger.success(
    `footage backfill-provenance ${dryRun ? "(dry run) " : ""}finished: ` +
      `matched=${result.rowsMatched}/${result.rowsMissingBefore}, ` +
      `still_missing=${result.rowsMissingAfter}, requests=${result.pagesFetched}, ` +
      `throttled=${result.throttled}, write_failures=${result.writeFailures}`,
  );

  return result;
}

/**
 * The operator report.
 *
 * The distinction it exists to make is between the two reasons a row can be
 * left unfilled: the clip no longer surfaces in the search that once returned
 * it — expected, and not a failure — versus the search never having a fair
 * chance because it was rate-limited. Those need different next steps, and the
 * remainder count alone cannot tell them apart.
 */
export function formatBackfill(result: BackfillResult): string {
  const lines: string[] = [];

  lines.push(
    `\nfootage backfill-provenance${result.dryRun ? " (dry run — nothing was written)" : ""}`,
  );
  lines.push(`  rows in index          ${result.rowsTotal}`);
  lines.push(`  without provenance     ${result.rowsMissingBefore} before this run`);
  lines.push(
    `  matched                ${result.rowsMatched}` +
      `${result.dryRun ? " (would be filled)" : " (filled)"}`,
  );
  lines.push(
    `  still without          ${result.rowsMissingAfter}` +
      `${result.projected ? " (projected)" : " (counted in mongo)"}`,
  );
  lines.push(
    `  searches               ${result.pagesFetched} request(s) over ${result.pairsSearched} term/orientation pair(s)`,
  );
  lines.push(`  rate-limited           ${result.throttled} pair(s)`);
  if (result.errored > 0) lines.push(`  other failures         ${result.errored} pair(s)`);
  if (result.writeFailures > 0) lines.push(`  write failures         ${result.writeFailures}`);
  if (result.aborted) lines.push("  run stopped early (abort, or the index lock was lost)");
  lines.push(`  elapsed                ${(result.elapsedMs / 1000).toFixed(1)}s`);

  if (result.rowsMissingAfter > 0) {
    lines.push(
      `\n${result.rowsMissingAfter} clip(s) were not matched. A clip whose URL no longer ` +
        "surfaces in the pages the search returns today cannot be recovered this way, " +
        "which is expected for a library pulled some time ago — it is not an error.",
    );
    if (result.throttled > 0) {
      lines.push(
        `${result.throttled} term/orientation pair(s) were rate-limited, so some of that ` +
          "remainder is unmeasured rather than unrecoverable; re-running later will pick them up.",
      );
    }
  }

  if (!result.dryRun && result.rowsMatched > 0) {
    lines.push(
      "\nRows that were already indexed are now `stale`: the new search term changes the " +
        "Qdrant payload and nothing else. Run `footage index` to re-upsert those payloads — " +
        "it is the payload-only path, so it pays for no describe and no embedding.",
    );
  }

  return lines.join("\n");
}

/**
 * Turns CLI arguments into `BackfillOptions`.
 *
 * Unknown flags throw rather than being ignored, for the same reason
 * `parsePullArgs` does it: a mistyped flag that silently ran the default would
 * spend the whole hourly allowance before anyone noticed.
 */
export function parseBackfillArgs(argv: string[]): BackfillOptions {
  const options: BackfillOptions = {};
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
      case "--per-page":
        options.perPage = positiveInt(next(index, arg), arg);
        index++;
        break;
      case "--page-cap":
        options.pageCap = positiveInt(next(index, arg), arg);
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
          throw new Error(
            `--aspect must be portrait, landscape, square or both, got ${JSON.stringify(raw)}`,
          );
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
