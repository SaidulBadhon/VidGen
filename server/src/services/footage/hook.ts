/**
 * The download-time provenance hook (design §4.4).
 *
 * `vid-<md5(url)>.mp4` is a one-way hash of a URL that is stored nowhere else,
 * so once a clip is on disk the only moment its origin is still known is the
 * moment it was saved. This records that — which search term reached it, which
 * asset and rendition it came from, whose work it is — into `footage_index`,
 * where the indexer later attaches a description and a vector to the same row.
 *
 * Three properties are load-bearing, in this order:
 *
 *  1. **It never affects the render.** `noteDownloadedMaterial` is synchronous,
 *     returns nothing, throws nothing, and does not await the write. The call
 *     sites are a serial `for` loop over as many as ~360 clips for one book
 *     pool; with `serverSelectionTimeoutMS: 10_000` a degraded Mongo would add
 *     an hour to a render if this blocked, so it does not block.
 *  2. **It is an optimisation, not a durability mechanism.** The filesystem is
 *     the work-list: `footage index` walks the cache directory and picks up
 *     anything this missed. So every failure here is swallowed after a debug
 *     line, and the flag that disables it costs nothing but freshness.
 *  3. **It only ever speaks about the shared cache directory.** A render
 *     configured with `material_directory` writes clips the library does not
 *     own, and the indexer would never find those files again.
 */

import { basename, dirname } from "node:path";

import { footageIndexCollection, isConnected } from "../../db/client.ts";
import type { FootageCreator, FootageIndexDocument } from "../../db/types.ts";
import { getSettings } from "../../config/settings.ts";
import { logger, errorMessage, errorName } from "../../utils/logger.ts";
import { cacheVideosDir } from "../../utils/paths.ts";
import { safePublicUrl } from "../material/http.ts";
import { pointIdFor } from "./types.ts";
import type { MaterialInfo } from "../../models/schema.ts";

/**
 * How long the write is given before it is abandoned.
 *
 * The work is unawaited, so this bounds nothing the render can feel; what it
 * bounds is how long a degraded Mongo can leave hundreds of these pending, and
 * how long the log stays silent about it.
 */
const HOOK_TIMEOUT_MS = 3_000;

/**
 * Whether a saved material belongs to the shared footage cache.
 *
 * The comparison is deliberately `dirname(savedPath)` against
 * `cacheVideosDir(false)`, **not** the configured `material_directory`: that
 * setting resolves to `""` for the default case, which is what the live
 * settings document holds, so testing it would make this guard false for every
 * normal download and the hook would silently never fire. `saveVideo` builds
 * the path as `join(directory, "vid-….mp4")`, so its dirname is exactly the
 * directory it chose — the cache directory when nothing overrides it.
 *
 * `create = false` because a guard must not have the side effect of creating
 * the directory it is asking about.
 */
export function isCacheVideoPath(savedPath: string): boolean {
  if (!savedPath) return false;
  return dirname(savedPath) === cacheVideosDir(false);
}

/** Provenance lifted off the material, with the fields worth storing kept. */
interface MaterialProvenance {
  searchTerm: string;
  provider: string;
  assetId: string;
  renditionId: string;
  sourcePage: string;
  creator: FootageCreator | null;
}

/**
 * Rebuilds provenance from an allow-list rather than copying `source_info`.
 *
 * `source_info` can arrive from the search cache or from a caller-supplied
 * `MaterialInfo`, so it is untrusted: the URL is passed through
 * `safePublicUrl` for the same reason `materialSourceRecord` does it — a
 * signed or private-network URL must never be persisted.
 */
function readProvenance(item: MaterialInfo): MaterialProvenance {
  const source = item.source_info ?? {};

  const creatorSource = source.creator;
  let creator: FootageCreator | null = null;
  if (creatorSource) {
    const kept: FootageCreator = {};
    if (creatorSource.id) kept.id = String(creatorSource.id);
    if (creatorSource.name) kept.name = String(creatorSource.name);
    const profile = safePublicUrl(creatorSource.profile_page);
    if (profile) kept.profile_page = profile;
    if (Object.keys(kept).length > 0) creator = kept;
  }

  const assetId = source.asset_id;
  const renditionId = source.rendition?.id;

  return {
    searchTerm: typeof source.search_term === "string" ? source.search_term.trim() : "",
    provider: String(item.provider || source.provider || "").trim(),
    assetId: assetId === null || assetId === undefined ? "" : String(assetId).trim(),
    renditionId: renditionId === null || renditionId === undefined ? "" : String(renditionId).trim(),
    sourcePage: safePublicUrl(source.source_page) ?? "",
    creator,
  };
}

/**
 * Records that a render downloaded (or re-used) a clip.
 *
 * Fires for cache hits as well as fresh downloads: `saveVideo` returns the same
 * path either way, and most clips in a warm cache are hits — skipping them
 * would leave the majority of the library with no provenance at all.
 *
 * Returns `void` rather than a promise so that "never blocks the caller" is a
 * property of the signature and not of every call site remembering not to
 * await it.
 */
export function noteDownloadedMaterial(item: MaterialInfo, savedPath: string): void {
  try {
    if (!isCacheVideoPath(savedPath)) return;
    if (!getSettings().footage_index.auto_index) return;
    if (!isConnected()) return;

    // Unawaited on purpose; `recordProvenance` resolves rather than rejects, so
    // there is no unhandled rejection to leak either.
    void recordProvenance(item, savedPath);
  } catch (error) {
    // Reading settings before startup, or any other surprise in the guard,
    // must not reach a render that has just downloaded a usable clip.
    logger.debug(`footage hook skipped: ${errorName(error)}, detail=${errorMessage(error)}`);
  }
}

/** Runs the write under a timeout and swallows every outcome but the log. */
async function recordProvenance(item: MaterialInfo, savedPath: string): Promise<void> {
  const localFile = basename(savedPath);

  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), HOOK_TIMEOUT_MS);
    });

    try {
      const outcome = await Promise.race([writeProvenance(item, localFile), deadline]);
      if (outcome === "timeout") {
        logger.debug(`footage hook timed out after ${HOOK_TIMEOUT_MS}ms: ${localFile}`);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (error) {
    // Never a render failure: the cache directory is the durable work-list, so
    // a lost row costs one later describe, not one lost clip.
    logger.debug(
      `footage hook write failed: ${localFile}, error=${errorName(error)}, detail=${errorMessage(error)}`,
    );
  }
}

/**
 * Upserts the row for one cached clip.
 *
 * Terms accumulate with `$addToSet`: one file reached by three searches is one
 * row with three terms, and the arrival of a term the row has not seen before
 * is exactly what makes an already-`indexed` row `stale` — the cheap
 * payload-only re-upsert of design §4.5, with no re-describe and no re-embed.
 */
async function writeProvenance(item: MaterialInfo, localFile: string): Promise<"written"> {
  const collection = footageIndexCollection();
  const id = pointIdFor(localFile);
  const provenance = readProvenance(item);
  const now = new Date();

  const existing = await collection.findOne(
    { _id: id },
    { projection: { state: 1, search_terms: 1 }, maxTimeMS: HOOK_TIMEOUT_MS },
  );

  const isNewTerm =
    provenance.searchTerm !== "" && !(existing?.search_terms ?? []).includes(provenance.searchTerm);
  // A term that arrives for a clip which is already described and embedded
  // changes the payload only, so it is marked stale rather than re-indexed.
  const markStale = existing?.state === "indexed" && isNewTerm;

  const set: Partial<FootageIndexDocument> = { updated_at: now };
  if (provenance.provider) set.provider = provenance.provider;
  if (provenance.assetId) set.asset_id = provenance.assetId;
  if (provenance.renditionId) set.rendition_id = provenance.renditionId;
  if (provenance.sourcePage) set.source_page = provenance.sourcePage;
  if (provenance.creator) set.creator = provenance.creator;
  if (markStale) set.state = "stale";

  const addToSet = provenance.searchTerm ? { search_terms: provenance.searchTerm } : undefined;

  if (markStale) {
    // The row was read as `indexed`, so it exists. Not upserting closes the
    // window where a cache clear between the read and this write would
    // resurrect it as a row with a `stale` state and nothing to be stale about.
    await collection.updateOne(
      { _id: id },
      addToSet ? { $set: set, $addToSet: addToSet } : { $set: set },
      { maxTimeMS: HOOK_TIMEOUT_MS },
    );
    return "written";
  }

  // A row created here has never been through the pipeline: version 0 matches
  // no current describe/embed constant and `description` is null, so the
  // indexer sees work regardless of which of the two it tests. `state` cannot
  // say "new" — the type has three values and none of them mean that — so it
  // says `stale`, the one that means "the payload is not current".
  const setOnInsert: Partial<FootageIndexDocument> = {
    local_file: localFile,
    state: "stale",
    description: null,
    describe_version: 0,
    embed_version: 0,
    attempts: 0,
    created_at: now,
  };
  // Mongo rejects an update that writes the same path from two operators, so
  // the required fields are defaulted here only when nothing else claims them:
  // `$addToSet` already creates `search_terms` when there is a term to add.
  if (!addToSet) setOnInsert.search_terms = [];
  if (!provenance.provider) setOnInsert.provider = "";

  await collection.updateOne(
    { _id: id },
    addToSet ? { $set: set, $setOnInsert: setOnInsert, $addToSet: addToSet } : { $set: set, $setOnInsert: setOnInsert },
    { upsert: true, maxTimeMS: HOOK_TIMEOUT_MS },
  );
  return "written";
}
