/**
 * Stock-video search across Pexels, Pixabay and Coverr.
 * Ported from python-version/app/services/material.py.
 */

import { appConfig } from "../../config/settings.ts";
import { logger } from "../../utils/logger.ts";
import { rotateApiKey } from "../../utils/misc.ts";
import {
  BROWSER_USER_AGENT,
  describeProviderError,
  isCloudflareChallenge,
  providerFetch,
  safePublicUrl,
} from "./http.ts";
import {
  VideoAspect,
  aspectOrientation,
  aspectToResolution,
  type MaterialInfo,
  type VideoAspectValue,
} from "../../models/schema.ts";

export type MaterialProvider = "pexels" | "pixabay" | "coverr";

/** Normalises the differently shaped creator objects each provider returns. */
export function creatorInfo(value: unknown): { id?: string; name?: string; profile_page?: string } | null {
  if (typeof value === "string" && value.trim()) return { name: value.trim() };
  if (!value || typeof value !== "object") return null;

  const source = value as Record<string, unknown>;
  const creator: { id?: string; name?: string; profile_page?: string } = {};

  if (source.id !== undefined && source.id !== null) creator.id = String(source.id);
  const name = source.name ?? source.username;
  if (name) creator.name = String(name);

  const page = safePublicUrl(source.url ?? source.profile_url ?? source.profile_page);
  if (page) creator.profile_page = page;

  return Object.keys(creator).length > 0 ? creator : null;
}

/**
 * Whether a remote asset matches the requested orientation.
 *
 * Provider response fields are inconsistent, so width and height are preferred;
 * Coverr sometimes omits them and only exposes an `is_vertical` flag. An asset
 * whose orientation cannot be established is skipped rather than guessed —
 * mixing a landscape clip into a portrait video produces obvious black bars.
 */
export function matchesVideoAspect(
  width: unknown,
  height: unknown,
  videoAspect: VideoAspectValue,
  isVertical?: unknown,
): boolean {
  const normalizedWidth = Math.trunc(Number(width)) || 0;
  const normalizedHeight = Math.trunc(Number(height)) || 0;

  if (normalizedWidth > 0 && normalizedHeight > 0) {
    if (videoAspect === VideoAspect.portrait) return normalizedHeight > normalizedWidth;
    if (videoAspect === VideoAspect.landscape) return normalizedWidth > normalizedHeight;
    return normalizedWidth === normalizedHeight;
  }

  if (typeof isVertical === "boolean" && videoAspect !== VideoAspect.square) {
    return isVertical === (videoAspect === VideoAspect.portrait);
  }
  return false;
}

/**
 * Re-checks cached results against the requested orientation.
 *
 * Cache entries written before an orientation fix could still hold mismatched
 * assets. Filtering at the single cache entry point makes the fix take effect
 * immediately and guards against a provider missing a remote filter.
 */
export function filterMaterialsByAspect(
  items: MaterialInfo[],
  videoAspect: VideoAspectValue,
): MaterialInfo[] {
  // Pixabay and Coverr rarely carry native square footage, so 1:1 keeps the
  // existing behaviour of accepting candidates and cropping at render time.
  if (videoAspect === VideoAspect.square) return [...items];

  return items.filter((item) => {
    const rendition = item.source_info?.rendition;
    return matchesVideoAspect(rendition?.width, rendition?.height, videoAspect);
  });
}

export interface SearchParams {
  searchTerm: string;
  minimumDuration: number;
  videoAspect: VideoAspectValue;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Pexels
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Provider response handling
//
// Pixabay checked its status codes; Pexels and Coverr did not, and went
// straight from `providerFetch` to `response.json()`. A 429 therefore produced
// a body with no `videos`/`hits` key, logged "unsupported response" and
// returned `[]` — indistinguishable from "this term genuinely has no footage".
// A rate-limited render silently lost a term's clips with nothing in the log
// naming the cause. A 1,000-clip pull hit that limit six times in ten minutes,
// so it is a routine condition, not an edge case.
// ---------------------------------------------------------------------------

/** One retry only: render latency is bounded, and a sustained 429 will not clear. */
export const PROVIDER_RETRY_ATTEMPTS = 2;
const PROVIDER_RETRY_BASE_MS = 1_500;
const PROVIDER_RETRY_MAX_MS = 3_000;

/** `Retry-After` in seconds when the provider sends a usable one, else backoff. */
export function providerRetryDelayMs(response: Response | undefined): number {
  const header = Number(response?.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) {
    return Math.min(header * 1000, PROVIDER_RETRY_MAX_MS);
  }
  return PROVIDER_RETRY_BASE_MS;
}

/**
 * Fetches a provider search and parses JSON, or returns null having logged why.
 *
 * Null always means "no usable answer", and the caller returns `[]` — but the
 * reason is now in the log. A 429 or 5xx is retried once; any other 4xx is a
 * bad key or a bad query and will not improve by being asked again.
 */
export async function fetchProviderJson<T>(
  provider: string,
  url: string,
  init: Parameters<typeof providerFetch>[1],
  // Injected so the retry ladder is testable without a network, the way
  // `downloadVideosByScriptOrder` injects `searchVideos`.
  fetcher: typeof providerFetch = providerFetch,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<T | null> {
  for (let attempt = 0; attempt < PROVIDER_RETRY_ATTEMPTS; attempt++) {
    const response = await fetcher(url, init);
    const status = response.status;
    const contentType = response.headers.get("content-type") ?? "unknown";

    if (response.ok) {
      try {
        return (await response.json()) as T;
      } catch {
        logger.error(
          `${provider} returned an unexpected non-JSON response: status=${status}, content_type=${contentType}`,
        );
        return null;
      }
    }

    const retryable = status === 429 || status >= 500;
    if (!retryable) {
      logger.error(`${provider} search request failed: status=${status}, content_type=${contentType}`);
      return null;
    }

    if (attempt === PROVIDER_RETRY_ATTEMPTS - 1) {
      logger.error(
        `${provider} search gave up after ${PROVIDER_RETRY_ATTEMPTS} attempt(s): status=${status}` +
          (status === 429 ? `, retry_after=${response.headers.get("retry-after") ?? "unknown"}` : ""),
      );
      return null;
    }

    const delay = providerRetryDelayMs(response);
    logger.warning(
      `${provider} search backing off ${delay}ms: status=${status}, attempt=${attempt + 1}/${PROVIDER_RETRY_ATTEMPTS}`,
    );
    await sleep(delay);
  }
  return null;
}

export async function searchVideosPexels(params: SearchParams): Promise<MaterialInfo[]> {
  const { searchTerm, minimumDuration, videoAspect, signal } = params;
  const [videoWidth, videoHeight] = aspectToResolution(videoAspect);
  const apiKey = rotateApiKey("pexels_api_keys", appConfig().pexels_api_keys);

  const query = new URLSearchParams({
    query: searchTerm,
    per_page: "20",
    orientation: aspectOrientation(videoAspect),
  });
  logger.info(`searching videos on pexels: term=${JSON.stringify(searchTerm)}`);

  try {
    const data = await fetchProviderJson<{
      videos?: {
        id?: number;
        duration?: number;
        url?: string;
        user?: unknown;
        video_files?: { id?: number; width?: number; height?: number; link?: string }[];
      }[];
    }>("pexels", `https://api.pexels.com/v1/videos/search?${query}`, {
      headers: { Authorization: apiKey, "User-Agent": BROWSER_USER_AGENT },
      timeoutMs: 60_000,
      signal,
    });

    if (!data) return [];

    if (!data.videos) {
      logger.error("pexels video search returned an unsupported response");
      return [];
    }

    const items: MaterialInfo[] = [];
    for (const video of data.videos) {
      const duration = Number(video.duration ?? 0);
      if (duration < minimumDuration) continue;

      // Pick the rendition that exactly matches the target resolution.
      for (const file of video.video_files ?? []) {
        const width = Number(file.width);
        const height = Number(file.height);
        if (!matchesVideoAspect(width, height, videoAspect)) continue;
        if (width !== videoWidth || height !== videoHeight) continue;
        if (!file.link) continue;

        items.push({
          provider: "pexels",
          url: file.link,
          duration,
          source_info: {
            provider: "pexels",
            search_term: searchTerm,
            asset_id: video.id !== undefined ? String(video.id) : null,
            source_page: safePublicUrl(video.url),
            creator: creatorInfo(video.user),
            rendition: { id: file.id !== undefined ? String(file.id) : null, width, height },
          },
        });
        break;
      }
    }
    return items;
  } catch (error) {
    logger.error(`pexels video search failed: ${describeProviderError(error, apiKey)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pixabay
// ---------------------------------------------------------------------------

export async function searchVideosPixabay(params: SearchParams): Promise<MaterialInfo[]> {
  const { searchTerm, minimumDuration, videoAspect, signal } = params;
  const [videoWidth] = aspectToResolution(videoAspect);
  const apiKey = rotateApiKey("pixabay_api_keys", appConfig().pixabay_api_keys);

  const query = new URLSearchParams({
    q: searchTerm,
    video_type: "all",
    per_page: "50",
    key: apiKey,
  });
  logger.info(`searching videos on pixabay: term=${JSON.stringify(searchTerm)}`);

  try {
    const response = await providerFetch(`https://pixabay.com/api/videos/?${query}`, {
      timeoutMs: 60_000,
      signal,
    });

    const status = response.status;
    const contentType = response.headers.get("content-type") ?? "unknown";

    if (await isCloudflareChallenge(response)) {
      logger.error(
        `pixabay search was blocked by a Cloudflare challenge: status=${status}, ` +
          `cf_ray=${response.headers.get("cf-ray") ?? "unknown"}. ` +
          "Check the server network or proxy, or use Pexels/Coverr instead.",
      );
      return [];
    }
    if (status === 429) {
      logger.error(
        `pixabay API rate limit exceeded: status=429, retry_after=${response.headers.get("retry-after") ?? "unknown"}`,
      );
      return [];
    }
    if (status >= 400) {
      logger.error(`pixabay search request failed: status=${status}, content_type=${contentType}`);
      return [];
    }

    let data: { hits?: Record<string, unknown>[] };
    try {
      data = (await response.json()) as { hits?: Record<string, unknown>[] };
    } catch {
      logger.error(`pixabay returned an unexpected non-JSON response: status=${status}, content_type=${contentType}`);
      return [];
    }

    if (!data.hits) {
      logger.error("pixabay video search returned an unsupported response");
      return [];
    }

    const items: MaterialInfo[] = [];
    for (const hit of data.hits) {
      const duration = Number(hit.duration ?? 0);
      if (duration < minimumDuration) continue;

      const renditions = (hit.videos ?? {}) as Record<string, { width?: number; height?: number; url?: string }>;
      for (const [renditionId, rendition] of Object.entries(renditions)) {
        const width = Number(rendition?.width);
        const height = Number(rendition?.height);
        if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
        if (!rendition?.url) continue;

        // Pixabay rarely has native square footage; 1:1 accepts anything wide
        // enough and crops later, while portrait/landscape must match exactly.
        const orientationMatches =
          videoAspect === VideoAspect.square || matchesVideoAspect(width, height, videoAspect);
        if (!orientationMatches || width < videoWidth) continue;

        items.push({
          provider: "pixabay",
          url: rendition.url,
          duration,
          source_info: {
            provider: "pixabay",
            search_term: searchTerm,
            asset_id: hit.id !== undefined ? String(hit.id) : null,
            source_page: safePublicUrl(hit.pageURL),
            creator: creatorInfo({ id: hit.user_id, name: hit.user }),
            rendition: { id: renditionId, width, height },
          },
        });
        break;
      }
    }
    return items;
  } catch (error) {
    logger.error(`pixabay search request failed: ${describeProviderError(error, apiKey)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Coverr
// ---------------------------------------------------------------------------

/**
 * Coverr (https://coverr.co) free HD/4K stock video, under the Coverr licence.
 *
 * Notes from the official API docs:
 *  - Bearer authentication
 *  - `GET /videos?query=…` returns `{"hits": [...]}`
 *  - `urls=true` includes direct MP4 links in the search response
 *  - `filter=is_vertical:true|false` filters orientation server-side, which
 *    matters because filtering popular results locally often leaves nothing
 *  - `duration` arrives as either a number or a string
 *
 * `urls.mp4_download` is used as the download address: per Coverr's docs a GET
 * on that URL is itself counted as a download event, so no extra stats call is
 * needed.
 */
export async function searchVideosCoverr(params: SearchParams): Promise<MaterialInfo[]> {
  const { searchTerm, minimumDuration, videoAspect, signal } = params;
  const apiKey = rotateApiKey("coverr_api_keys", appConfig().coverr_api_keys);

  const query = new URLSearchParams({
    query: searchTerm,
    page_size: "20",
    urls: "true",
    sort: "popular",
  });
  if (videoAspect === VideoAspect.portrait) query.set("filter", "is_vertical:true");
  else if (videoAspect === VideoAspect.landscape) query.set("filter", "is_vertical:false");

  logger.info(`searching videos on coverr: term=${JSON.stringify(searchTerm)}`);

  try {
    const data = await fetchProviderJson<{ hits?: Record<string, unknown>[] }>(
      "coverr",
      `https://api.coverr.co/videos?${query}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeoutMs: 60_000,
        signal,
      },
    );

    if (!data) return [];
    if (!Array.isArray(data.hits)) {
      logger.error("coverr video search returned an unsupported response");
      return [];
    }

    const items: MaterialInfo[] = [];
    for (const hit of data.hits) {
      const duration = Math.trunc(Number(hit.duration ?? 0));
      if (!Number.isFinite(duration) || duration < minimumDuration) continue;

      const videoId = hit.id;
      const downloadUrl = (hit.urls as { mp4_download?: string } | undefined)?.mp4_download;
      if (!videoId || !downloadUrl) continue;

      if (
        videoAspect !== VideoAspect.square &&
        !matchesVideoAspect(hit.max_width, hit.max_height, videoAspect, hit.is_vertical)
      ) {
        continue;
      }

      items.push({
        provider: "coverr",
        url: downloadUrl,
        duration,
        source_info: {
          provider: "coverr",
          search_term: searchTerm,
          asset_id: String(videoId),
          source_page: safePublicUrl(hit.canonical_url ?? hit.url),
          creator: creatorInfo(hit.creator ?? hit.author),
          rendition: {
            id: "mp4_download",
            width: Number(hit.max_width) || null,
            height: Number(hit.max_height) || null,
          },
        },
      });
    }
    return items;
  } catch (error) {
    logger.error(`coverr video search failed: ${describeProviderError(error, apiKey)}`);
    return [];
  }
}

export function getProviderSearch(source: string): {
  provider: MaterialProvider;
  search: (params: SearchParams) => Promise<MaterialInfo[]>;
} {
  if (source === "pixabay") return { provider: "pixabay", search: searchVideosPixabay };
  if (source === "coverr") return { provider: "coverr", search: searchVideosCoverr };
  return { provider: "pexels", search: searchVideosPexels };
}
