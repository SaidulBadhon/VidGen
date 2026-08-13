/**
 * Material download orchestration.
 * Ported from `download_videos` in python-version/app/services/material.py.
 */

import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { unlink } from "node:fs/promises";
import { appConfig } from "../../config/settings.ts";
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
 * Downloads a material and confirms it decodes.
 *
 * Providers occasionally serve truncated files or an error page under a .mp4
 * name; both would otherwise fail much later, mid-render.
 */
export async function saveVideo(videoUrl: string, saveDir = "", signal?: AbortSignal): Promise<string> {
  const directory = saveDir || cacheVideosDir(true);
  const urlHash = md5(videoUrl.split("?")[0]!);
  const videoPath = join(directory, `vid-${urlHash}.mp4`);

  if (existsSync(videoPath) && statSync(videoPath).size > 0) {
    logger.info(`video already exists: ${videoPath}`);
    return videoPath;
  }

  const response = await providerFetch(videoUrl, {
    headers: { "User-Agent": BROWSER_USER_AGENT },
    timeoutMs: 240_000,
    signal,
  });
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status}`);
  }

  await Bun.write(videoPath, await response.arrayBuffer());

  if (existsSync(videoPath) && statSync(videoPath).size > 0 && (await isValidVideo(videoPath))) {
    return videoPath;
  }

  logger.warning(`invalid video file: ${videoPath}`);
  await unlink(videoPath).catch(() => {});
  return "";
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
