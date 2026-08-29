/**
 * Material download orchestration.
 * Ported from `download_videos` in python-version/app/services/material.py.
 */

import { existsSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, isAbsolute, join } from "node:path";
import { rename, unlink } from "node:fs/promises";
import { appConfig } from "../../config/settings.ts";
import { noteDownloadedMaterial } from "../footage/hook.ts";
import { logger, errorMessage, errorName } from "../../utils/logger.ts";
import { md5 } from "../../utils/misc.ts";
import { cacheVideosDir, taskDir } from "../../utils/paths.ts";
import { isValidVideo } from "../video/probe.ts";
import { shuffleInPlace } from "../video/combine.ts";
import { patchScriptData } from "../taskArtifacts.ts";
import { BROWSER_USER_AGENT, describeProviderError, providerFetch, safePublicUrl } from "./http.ts";
import { searchWithCache } from "./cache.ts";
import { getProviderSearch, type SearchParams } from "./search.ts";
import { VideoConcatMode, type MaterialInfo, type VideoAspectValue, type VideoConcatModeValue } from "../../models/schema.ts";

/**
 * Lightweight provenance for a downloaded asset.
 *
 * `source_info` may come from cache or from an externally supplied
 * MaterialInfo, so it is rebuilt from an allow-list rather than copied: only
 * public pages, business identifiers and dimensions are kept, and only the
 * local filename — never a host path or Docker mount — is recorded.
 */
export function materialSourceRecord(item: MaterialInfo, localPath: string): Record<string, unknown> {
  const source = item.source_info ?? {};
  const record: Record<string, unknown> = {
    provider: String(item.provider || source.provider || ""),
    local_file: basename(localPath),
    duration: Math.trunc(item.duration),
  };

  if (typeof source.search_term === "string" && source.search_term.trim()) {
    record.search_term = source.search_term.trim();
  }
  if (source.asset_id !== null && source.asset_id !== undefined && source.asset_id !== "") {
    record.asset_id = String(source.asset_id);
  }
  const sourcePage = safePublicUrl(source.source_page);
  if (sourcePage) record.source_page = sourcePage;
  if (source.creator) record.creator = source.creator;

  const rendition = source.rendition;
  if (rendition) {
    const kept: Record<string, unknown> = {};
    if (rendition.id !== null && rendition.id !== undefined && rendition.id !== "") kept.id = String(rendition.id);
    if (rendition.width) kept.width = rendition.width;
    if (rendition.height) kept.height = rendition.height;
    if (Object.keys(kept).length > 0) record.rendition = kept;
  }

  return record;
}

/**
 * Probe results for files already on disk, remembered for the process lifetime.
 *
 * A cache hit used to be returned unprobed, so a single truncated write
 * poisoned that URL until someone cleared the cache. Probing every hit instead
 * would mean an ffprobe per use rather than per file — a book pool reuses the
 * same few hundred clips many times over — so the answer is memoised by path.
 *
 * Size and mtime ride along because the thing being remembered is a verdict on
 * *bytes*, not on a name: a file truncated underneath a running server (a
 * container killed mid-write, a full disk) would otherwise keep the verdict it
 * earned before it was damaged, which is the exact failure this probe exists to
 * catch. Comparing them costs a `stat` the cache-hit branch already performs.
 */
interface CachedVideoVerdict {
  size: number;
  mtimeMs: number;
  valid: boolean;
}

const cacheHitValidity = new Map<string, CachedVideoVerdict>();

async function isCachedVideoValid(videoPath: string, stats: { size: number; mtimeMs: number }): Promise<boolean> {
  const remembered = cacheHitValidity.get(videoPath);
  if (remembered && remembered.size === stats.size && remembered.mtimeMs === stats.mtimeMs) {
    return remembered.valid;
  }

  const valid = await isValidVideo(videoPath);
  cacheHitValidity.set(videoPath, { size: stats.size, mtimeMs: stats.mtimeMs, valid });
  return valid;
}

/** Flush the sink at least this often, so a large clip is never fully resident. */
const DOWNLOAD_FLUSH_BYTES = 8 * 1024 * 1024;

/**
 * Streams a response body to a file.
 *
 * The previous `Bun.write(path, await response.arrayBuffer())` held the whole
 * clip in memory first; at the concurrency the render uses, and with clips
 * measured up to 211 MB, that is a multi-gigabyte spike alongside a running
 * ffmpeg. Writing through a sink keeps resident memory at the buffer size.
 */
async function streamToFile(response: Response, destination: string): Promise<void> {
  const body = response.body;
  if (!body) throw new Error("download failed: response had no body");

  const sink = Bun.file(destination).writer({ highWaterMark: DOWNLOAD_FLUSH_BYTES });
  let buffered = 0;

  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      const written = sink.write(chunk);
      buffered += typeof written === "number" ? written : await written;
      if (buffered >= DOWNLOAD_FLUSH_BYTES) {
        await sink.flush();
        buffered = 0;
      }
    }
    await sink.end();
  } catch (error) {
    // Close the descriptor on the way out; the caller removes the partial file.
    try {
      sink.end();
    } catch {
      // Already closed.
    }
    throw error;
  }
}

/**
 * Downloads a material and confirms it decodes.
 *
 * Providers occasionally serve truncated files or an error page under a .mp4
 * name; both would otherwise fail much later, mid-render.
 *
 * The bytes land on a unique temp in the destination directory and are probed
 * there, so the final `vid-<hash>.mp4` name only ever appears as a complete,
 * playable file — one rename, no window in which another caller can read a
 * half-written clip. The temp is unique rather than shared, which is what makes
 * an in-flight dedup map unnecessary: two callers racing on one URL both
 * finish and one rename wins with identical bytes. A shared promise would
 * instead share one `AbortSignal`, so cancelling one task would abort a
 * different render's download.
 *
 * The temp lives in the destination directory, never `tmpdir()`, because
 * `material_directory` may be any absolute path and a rename across devices
 * fails with `EXDEV`.
 */
export async function saveVideo(videoUrl: string, saveDir = "", signal?: AbortSignal): Promise<string> {
  const directory = saveDir || cacheVideosDir(true);
  const urlHash = md5(videoUrl.split("?")[0]!);
  const videoPath = join(directory, `vid-${urlHash}.mp4`);

  const cached = existsSync(videoPath) ? statSync(videoPath) : undefined;
  if (cached && cached.size > 0) {
    if (await isCachedVideoValid(videoPath, cached)) {
      logger.info(`video already exists: ${videoPath}`);
      return videoPath;
    }
    // Something outside this process truncated it — a killed container, a full
    // disk. Re-downloading over it through the atomic path below is the only
    // way that URL ever recovers; nothing is deleted, so a render holding the
    // old file keeps reading it.
    logger.warning(`cached video failed validation, downloading again: ${videoPath}`);
  }

  const response = await providerFetch(videoUrl, {
    headers: { "User-Agent": BROWSER_USER_AGENT },
    timeoutMs: 240_000,
    signal,
  });
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status}`);
  }

  const tempPath = join(directory, `.vid-${urlHash}.${process.pid}.${randomBytes(8).toString("hex")}.part`);

  try {
    await streamToFile(response, tempPath);

    if (existsSync(tempPath) && statSync(tempPath).size > 0 && (await isValidVideo(tempPath))) {
      await rename(tempPath, videoPath);
      // Just probed, so a later hit in this process need not probe it again.
      const written = statSync(videoPath);
      cacheHitValidity.set(videoPath, { size: written.size, mtimeMs: written.mtimeMs, valid: true });
      return videoPath;
    }

    logger.warning(`invalid video file: ${videoPath}`);
    return "";
  } finally {
    // A no-op after a successful rename; the catch keeps a cleanup failure from
    // masking the real error on the way out.
    await unlink(tempPath).catch(() => {});
  }
}

/** Resolves where downloaded materials are stored for this task. */
function resolveMaterialDirectory(taskId: string): string {
  const configured = String(appConfig().material_directory ?? "").trim();
  if (configured === "task") return taskDir(taskId);
  if (configured && isAbsolute(configured) && existsSync(configured)) return configured;
  return "";
}

async function persistMaterialSources(taskId: string, sources: Record<string, unknown>[]): Promise<void> {
  try {
    const saved = await patchScriptData(taskId, { material_sources: sources });
    if (saved) logger.info(`saved material source records: task_id=${taskId}, count=${sources.length}`);
  } catch (error) {
    // Provenance is a nice-to-have; it must never change what the download
    // function returns or interrupt the render.
    logger.warning(
      `failed to persist material source records: task_id=${taskId}, ` +
        `error=${errorName(error)}, detail=${errorMessage(error)}`,
    );
  }
}

export interface DownloadVideosOptions {
  taskId: string;
  searchTerms: string[];
  source?: string;
  videoAspect?: VideoAspectValue;
  videoConcatMode?: VideoConcatModeValue;
  audioDuration?: number;
  maxClipDuration?: number;
  matchScriptOrder?: boolean;
  signal?: AbortSignal;
  random?: () => number;
}

export async function downloadVideos(options: DownloadVideosOptions): Promise<string[]> {
  const {
    taskId,
    searchTerms,
    source = "pexels",
    videoAspect = "9:16",
    videoConcatMode = VideoConcatMode.random,
    audioDuration = 0,
    maxClipDuration = 5,
    matchScriptOrder = false,
    signal,
    random = Math.random,
  } = options;

  const { provider, search } = getProviderSearch(source);
  const searchVideos = (params: SearchParams) => searchWithCache({ provider, search, ...params });
  const materialDirectory = resolveMaterialDirectory(taskId);

  if (matchScriptOrder) {
    return downloadVideosByScriptOrder({
      taskId,
      searchTerms,
      searchVideos,
      videoAspect,
      audioDuration,
      maxClipDuration,
      materialDirectory,
      signal,
    });
  }

  const validItems: MaterialInfo[] = [];
  const seenUrls = new Set<string>();
  let foundDuration = 0;

  for (const searchTerm of searchTerms) {
    const items = await searchVideos({ searchTerm, minimumDuration: maxClipDuration, videoAspect, signal });
    logger.info(`found ${items.length} videos for '${searchTerm}'`);

    for (const item of items) {
      if (seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);
      validItems.push(item);
      foundDuration += item.duration;
    }
  }

  logger.info(
    `found total videos: ${validItems.length}, required duration: ${audioDuration} seconds, ` +
      `found duration: ${foundDuration} seconds`,
  );

  if (videoConcatMode === VideoConcatMode.random) shuffleInPlace(validItems, random);

  const videoPaths: string[] = [];
  const materialSources: Record<string, unknown>[] = [];
  let totalDuration = 0;

  for (const item of validItems) {
    try {
      logger.info(`downloading ${item.provider} video: asset_id=${item.source_info?.asset_id ?? "unknown"}`);
      const savedPath = await saveVideo(item.url, materialDirectory, signal);
      if (!savedPath) continue;

      logger.info(`video saved: ${savedPath}`);
      videoPaths.push(savedPath);
      // Fire-and-forget provenance for the footage library. Synchronous, throws
      // nothing and awaits nothing, so it cannot slow or fail this loop.
      noteDownloadedMaterial(item, savedPath);
      try {
        materialSources.push(materialSourceRecord(item, savedPath));
      } catch (error) {
        logger.warning(
          `failed to prepare material source record: provider=${item.provider}, ` +
            `error=${errorName(error)}, detail=${errorMessage(error)}`,
        );
      }

      totalDuration += Math.min(maxClipDuration, item.duration);
      if (totalDuration > audioDuration) {
        logger.info(`total duration of downloaded videos: ${totalDuration} seconds, skip downloading more`);
        break;
      }
    } catch (error) {
      logger.error(
        `failed to download material video: provider=${item.provider}, ${describeProviderError(error, item.url)}`,
      );
    }
  }

  logger.success(`downloaded ${videoPaths.length} videos`);
  await persistMaterialSources(taskId, materialSources);
  return videoPaths;
}

/**
 * Downloads materials in the script's narrative order.
 *
 * The default path merges every term's candidates into one list, so a term that
 * returns many results can monopolise the timeline and push later topics off
 * the end. Here candidates are grouped per term and taken round-robin — one
 * from each term per pass — which keeps material order close to the narration
 * without rewriting the render engine.
 */
async function downloadVideosByScriptOrder(options: {
  taskId: string;
  searchTerms: string[];
  searchVideos: (params: SearchParams) => Promise<MaterialInfo[]>;
  videoAspect: VideoAspectValue;
  audioDuration: number;
  maxClipDuration: number;
  materialDirectory: string;
  signal?: AbortSignal;
}): Promise<string[]> {
  const { taskId, searchTerms, searchVideos, videoAspect, audioDuration, maxClipDuration, materialDirectory, signal } =
    options;

  logger.info("downloading videos with script-order material matching");

  const candidateGroups: { searchTerm: string; items: MaterialInfo[] }[] = [];
  const seenUrls = new Set<string>();
  let foundDuration = 0;

  for (const searchTerm of searchTerms) {
    const items = await searchVideos({ searchTerm, minimumDuration: maxClipDuration, videoAspect, signal });
    logger.info(`found ${items.length} videos for '${searchTerm}'`);

    const termItems: MaterialInfo[] = [];
    for (const item of items) {
      if (seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);
      termItems.push(item);
      foundDuration += item.duration;
    }
    if (termItems.length > 0) candidateGroups.push({ searchTerm, items: termItems });
  }

  logger.info(
    `found total ordered video candidates: ${candidateGroups.reduce((sum, group) => sum + group.items.length, 0)}, ` +
      `required duration: ${audioDuration} seconds, found duration: ${foundDuration} seconds`,
  );

  const videoPaths: string[] = [];
  const materialSources: Record<string, unknown>[] = [];
  let totalDuration = 0;
  let candidateIndex = 0;

  outer: while (candidateGroups.length > 0 && totalDuration <= audioDuration) {
    let hasCandidate = false;

    for (const group of candidateGroups) {
      const item = group.items[candidateIndex];
      if (!item) continue;
      hasCandidate = true;

      try {
        logger.info(
          `downloading ordered ${item.provider} video for ${JSON.stringify(group.searchTerm)}: ` +
            `asset_id=${item.source_info?.asset_id ?? "unknown"}`,
        );
        const savedPath = await saveVideo(item.url, materialDirectory, signal);
        if (!savedPath) continue;

        logger.info(`video saved: ${savedPath}`);
        videoPaths.push(savedPath);
        noteDownloadedMaterial(item, savedPath);
        try {
          materialSources.push(materialSourceRecord(item, savedPath));
        } catch (error) {
          logger.warning(
            `failed to prepare ordered material source record: provider=${item.provider}, ` +
              `error=${errorName(error)}, detail=${errorMessage(error)}`,
          );
        }

        totalDuration += Math.min(maxClipDuration, item.duration);
        if (totalDuration > audioDuration) {
          logger.info(`total duration of downloaded videos: ${totalDuration} seconds, skip downloading more`);
          break outer;
        }
      } catch (error) {
        logger.error(
          `failed to download ordered material video: provider=${item.provider}, ` +
            describeProviderError(error, item.url),
        );
      }
    }

    if (!hasCandidate) break;
    candidateIndex += 1;
  }

  logger.success(`downloaded ${videoPaths.length} ordered videos`);
  await persistMaterialSources(taskId, materialSources);
  return videoPaths;
}
