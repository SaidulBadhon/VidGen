/**
 * 24-hour cache for stock-material searches.
 *
 * The Python version maintained a sharded directory of JSON files with its own
 * format version, expiry sweep and lock table. MongoDB does the same job with a
 * TTL index, so expiry is the database's problem and only the stampede guard
 * remains here.
 */

import { materialCacheCollection } from "../../db/client.ts";
import { logger, errorMessage, errorName } from "../../utils/logger.ts";
import { sha256 } from "../../utils/misc.ts";
import { filterMaterialsByAspect, type MaterialProvider, type SearchParams } from "./search.ts";
import type { CachedMaterial } from "../../db/types.ts";
import type { MaterialInfo, VideoAspectValue } from "../../models/schema.ts";

export const MATERIAL_SEARCH_CACHE_TTL_SECONDS = 24 * 60 * 60;

/** Bump to invalidate every cached entry after a shape change. */
const CACHE_FORMAT_VERSION = 2;

function cacheKey(
  provider: string,
  searchTerm: string,
  minimumDuration: number,
  videoAspect: string,
): string {
  return sha256(
    [CACHE_FORMAT_VERSION, provider, searchTerm.trim().toLowerCase(), minimumDuration, videoAspect].join("|"),
  );
}

function toCached(item: MaterialInfo): CachedMaterial {
  return {
    provider: item.provider,
    url: item.url,
    duration: item.duration,
    source_info: item.source_info ?? null,
  };
}

function fromCached(item: CachedMaterial, searchTerm: string): MaterialInfo {
  return {
    provider: item.provider,
    url: item.url,
    duration: item.duration,
    // Restore the search term from the cache key so a provider that failed to
    // set it still yields consistent task provenance records.
    source_info: item.source_info ? { ...item.source_info, search_term: searchTerm } : null,
  };
}

/** In-flight searches, so concurrent tasks share one remote request. */
const inFlight = new Map<string, Promise<MaterialInfo[]>>();

export interface CachedSearchOptions extends SearchParams {
  provider: MaterialProvider;
  search: (params: SearchParams) => Promise<MaterialInfo[]>;
}

/**
 * Runs a provider search through the cache.
 *
 * An empty remote result is never cached: the provider functions use an empty
 * list for both "no results" and "request failed", and caching a transient
 * outage for a day would be far worse than retrying.
 */
export async function searchWithCache(options: CachedSearchOptions): Promise<MaterialInfo[]> {
  const { provider, search, searchTerm, minimumDuration, videoAspect } = options;
  const key = cacheKey(provider, searchTerm, minimumDuration, videoAspect);

  const cached = await loadMatchingCache(key, searchTerm, videoAspect, provider);
  if (cached) return cached;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = (async () => {
    // Re-check after acquiring the slot: another task may have just populated it.
    const fresh = await loadMatchingCache(key, searchTerm, videoAspect, provider);
    if (fresh) return fresh;

    const items = await search({ searchTerm, minimumDuration, videoAspect, signal: options.signal });

    // Providers normally set the term, but test doubles and older code paths
    // may not; correcting here keeps first-search and cache-hit records equal.
    for (const item of items) {
      if (item.source_info) item.source_info = { ...item.source_info, search_term: searchTerm };
    }

    if (items.length > 0) {
      await saveCache(key, provider, searchTerm, minimumDuration, videoAspect, items).catch((error) => {
        logger.warning(
          `material search cache write failed, use remote results: provider=${provider}, ` +
            `error=${errorName(error)}, detail=${errorMessage(error)}`,
        );
      });
    }
    return items;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, request);
  return request;
}

async function loadMatchingCache(
  key: string,
  searchTerm: string,
  videoAspect: VideoAspectValue,
  provider: string,
): Promise<MaterialInfo[] | null> {
  let items: MaterialInfo[];
  try {
    const document = await materialCacheCollection().findOne({ _id: key });
    if (!document) return null;
    // The TTL index removes entries lazily, so a just-expired document can
    // still be returned; check the timestamp too.
    if (document.expires_at.getTime() <= Date.now()) return null;
    items = document.items.map((item) => fromCached(item, searchTerm));
  } catch (error) {
    // The cache is an optimisation; any failure must fall through to a live
    // search rather than blocking material downloads.
    logger.warning(
      `material search cache read failed, continue with remote search: provider=${provider}, ` +
        `error=${errorName(error)}, detail=${errorMessage(error)}`,
    );
    return null;
  }

  const filtered = filterMaterialsByAspect(items, videoAspect);
  const ignored = items.length - filtered.length;
  if (ignored > 0) {
    // Even if some entries remain usable, refresh the whole candidate set —
    // otherwise the same few clips get reused for the rest of the TTL.
    logger.info(
      `material search cache contains mismatched orientations, refresh from provider: ` +
        `provider=${provider}, term=${JSON.stringify(searchTerm)}, ignored=${ignored}`,
    );
    return null;
  }

  return filtered;
}

async function saveCache(
  key: string,
  provider: string,
  searchTerm: string,
  minimumDuration: number,
  videoAspect: string,
  items: MaterialInfo[],
): Promise<void> {
  const now = new Date();
  await materialCacheCollection().updateOne(
    { _id: key },
    {
      $set: {
        provider,
        search_term: searchTerm,
        minimum_duration: minimumDuration,
        video_aspect: videoAspect,
        format_version: CACHE_FORMAT_VERSION,
        items: items.map(toCached),
        created_at: now,
        expires_at: new Date(now.getTime() + MATERIAL_SEARCH_CACHE_TTL_SECONDS * 1000),
      },
    },
    { upsert: true },
  );
}

/** Removes every cached search. Exposed through the cache-management UI. */
export async function clearMaterialSearchCache(): Promise<number> {
  const result = await materialCacheCollection().deleteMany({});
  return result.deletedCount ?? 0;
}

export async function getMaterialSearchCacheStats(): Promise<{ entries: number; assets: number }> {
  const collection = materialCacheCollection();
  const entries = await collection.countDocuments({});
  const aggregation = await collection
    .aggregate<{ assets: number }>([{ $group: { _id: null, assets: { $sum: { $size: "$items" } } } }])
    .toArray();
  return { entries, assets: aggregation[0]?.assets ?? 0 };
}
