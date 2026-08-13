/**
 * Builds the silent picture track that carries the narration.
 * Ported from `combine_videos` in python-version/app/services/video.py.
 */

import { dirname, join } from "node:path";
import { OUTPUT_FPS, renderClip } from "./clip.ts";
import { concatVideoClips, deleteFiles } from "./concat.ts";
import { probe } from "./probe.ts";
import { pickSlideSide } from "./transitions.ts";
import { logger, errorMessage } from "../../utils/logger.ts";
import { normalizeClipSpeed } from "../../utils/misc.ts";
import {
  VideoConcatMode,
  aspectToResolution,
  type VideoAspectValue,
  type VideoConcatModeValue,
  type VideoTransitionModeValue,
} from "../../models/schema.ts";

/**
 * Small slack added to the picture track.
 *
 * Frame-rate rounding during concat can leave the video a few tens of
 * milliseconds shorter than the narration, which shows up as a black frame or a
 * silent tail with no picture.
 */
const VIDEO_DURATION_SAFETY_MARGIN = 0.1;

const MIN_MATERIAL_DIMENSION = 480;

/**
 * Tolerance below the nominal minimum.
 *
 * Messaging apps and some encoders round frame sizes down — WhatsApp emits
 * 478x850 for 9:16 — and rejecting those outright made whole tasks fail with
 * "no valid materials found" while still blocking genuinely low-res footage.
 */
const MIN_DIMENSION_TOLERANCE = 10;

export function isMaterialResolutionAcceptable(width: number, height: number): boolean {
  const minDimension = MIN_MATERIAL_DIMENSION - MIN_DIMENSION_TOLERANCE;
  return width >= minDimension && height >= minDimension;
}

export function getRequiredVideoDuration(audioDuration: number): number {
  return Math.max(0, Number(audioDuration) + VIDEO_DURATION_SAFETY_MARGIN);
}

export interface SubClippedItem {
  filePath: string;
  startTime: number;
  endTime: number;
  width: number;
  height: number;
  duration: number;
  sourceFilePath: string;
}

/**
 * Reorders clips so each source appears once before any source repeats.
 *
 * Stock footage is often one long video sliced into several clips. Shuffling
 * the flat list lets several slices of the same source land near each other,
 * which viewers read as repeated material. Taking each source's longest slice
 * first also avoids picking a ragged tail fragment while usable footage remains.
 * Shorter slices stay available as a fallback so a thin material set can still
 * cover the narration.
 */
export function prioritizeUniqueSourceClips(
  items: SubClippedItem[],
  concatMode: VideoConcatModeValue,
  random: () => number = Math.random,
): SubClippedItem[] {
  if (items.length === 0) return [];
  if (concatMode !== VideoConcatMode.random) return items;

  const grouped = new Map<string, SubClippedItem[]>();
  for (const item of items) {
    const bucket = grouped.get(item.sourceFilePath);
    if (bucket) bucket.push(item);
    else grouped.set(item.sourceFilePath, [item]);
  }

  const primary: SubClippedItem[] = [];
  const overflow: SubClippedItem[] = [];

  for (const bucket of grouped.values()) {
    let longest = bucket[0]!;
    for (const item of bucket) {
      if (item.duration > longest.duration) longest = item;
    }
    primary.push(longest);
    overflow.push(...bucket.filter((item) => item !== longest));
  }

  shuffleInPlace(primary, random);
  shuffleInPlace(overflow, random);

  logger.info(
    `prioritized unique video materials, sources: ${grouped.size}, ` +
      `primary clips: ${primary.length}, fallback clips: ${overflow.length}`,
  );

  return [...primary, ...overflow];
}

export function shuffleInPlace<T>(items: T[], random: () => number = Math.random): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

export interface CombineVideosOptions {
  combinedVideoPath: string;
  videoPaths: string[];
  audioFile: string;
  videoAspect?: VideoAspectValue;
  videoConcatMode?: VideoConcatModeValue;
  videoTransitionMode?: VideoTransitionModeValue;
  maxClipDuration?: number;
  threads?: number;
  clipSpeed?: number;
  fps?: number;
  signal?: AbortSignal;
  random?: () => number;
}

export async function combineVideos(options: CombineVideosOptions): Promise<string> {
  const {
    combinedVideoPath,
    videoPaths,
    audioFile,
    videoAspect = "9:16",
    videoConcatMode = VideoConcatMode.random,
    videoTransitionMode = null,
    maxClipDuration = 5,
    threads = 2,
    clipSpeed = 1.0,
    fps = OUTPUT_FPS,
    signal,
    random = Math.random,
  } = options;

  const audioInfo = await probe(audioFile);
  const audioDuration = audioInfo.duration;
  logger.info(`audio duration: ${audioDuration} seconds`);
  logger.info(`maximum clip duration: ${maxClipDuration} seconds`);

  const requiredVideoDuration = getRequiredVideoDuration(audioDuration);
  logger.info(
    `required video duration: ${requiredVideoDuration.toFixed(2)} seconds ` +
      `(audio duration + ${VIDEO_DURATION_SAFETY_MARGIN.toFixed(2)}s safety margin)`,
  );

  const normalizedClipSpeed = normalizeClipSpeed(clipSpeed);
  if (normalizedClipSpeed !== 1.0) {
    logger.info(`clip playback speed: ${normalizedClipSpeed.toFixed(2)}x`);
  }

  // max_clip_duration bounds the clip's length in the finished video, not how
  // much source is read. Playing 1.5s of source at 0.5x yields 3s on screen, so
  // the source window must be scaled by the speed — otherwise the next clip
  // would start at the wrong offset and skip footage.
  const sourceClipDuration = maxClipDuration * normalizedClipSpeed;
  const outputDir = dirname(combinedVideoPath);
  const [videoWidth, videoHeight] = aspectToResolution(videoAspect);

  // 1. Slice every material into candidate windows.
  const subClippedItems: SubClippedItem[] = [];
  for (const videoPath of videoPaths) {
    let info;
    try {
      info = await probe(videoPath);
    } catch (error) {
      logger.warning(`skip unreadable material: ${videoPath}, error: ${errorMessage(error)}`);
      continue;
    }
    if (!info.hasVideo || info.duration <= 0) {
      logger.warning(`skip material without a usable video stream: ${videoPath}`);
      continue;
    }

    let startTime = 0;
    while (startTime < info.duration) {
      const endTime = Math.min(startTime + sourceClipDuration, info.duration);

      // Every valid window is kept: this preserves materials shorter than
      // max_clip_duration and the trailing remainder of longer ones.
      if (endTime > startTime) {
        subClippedItems.push({
          filePath: videoPath,
          startTime,
          endTime,
          width: info.width,
          height: info.height,
          duration: endTime - startTime,
          sourceFilePath: videoPath,
        });
      }

      startTime = endTime;
      if (videoConcatMode === VideoConcatMode.sequential) break;
    }
  }

  const orderedItems = prioritizeUniqueSourceClips(subClippedItems, videoConcatMode, random);
  logger.debug(`total subclipped items: ${orderedItems.length}`);

  // 2. Render clips until the picture covers the narration.
  const processedClips: { filePath: string; duration: number }[] = [];
  let videoDuration = 0;

  for (let index = 0; index < orderedItems.length; index++) {
    if (videoDuration >= requiredVideoDuration) break;
    const item = orderedItems[index]!;

    logger.debug(
      `processing clip ${index + 1}: ${item.width}x${item.height}, ` +
        `source: ${item.sourceFilePath.split("/").pop()}, ` +
        `current duration: ${videoDuration.toFixed(2)}s, ` +
        `remaining: ${(requiredVideoDuration - videoDuration).toFixed(2)}s`,
    );

    const clipFile = join(outputDir, `temp-clip-${index + 1}.mp4`);
    try {
      const rendered = await renderClip({
        sourcePath: item.filePath,
        outputPath: clipFile,
        startTime: item.startTime,
        endTime: item.endTime,
        width: videoWidth,
        height: videoHeight,
        speed: normalizedClipSpeed,
        maxClipDuration,
        transition: videoTransitionMode,
        slideSide: pickSlideSide(random),
        threads,
        fps,
        signal,
      });

      processedClips.push({ filePath: rendered.filePath, duration: rendered.duration });
      videoDuration += rendered.duration;
    } catch (error) {
      // One unusable material must not sink the task; the loop simply moves on
      // and the shortfall is covered by looping the clips that did work.
      logger.error(`failed to process clip: ${errorMessage(error)}`);
    }
  }

  // 3. Loop what we have if the materials could not fill the narration.
  if (videoDuration < requiredVideoDuration && processedClips.length > 0) {
    logger.warning(
      `video duration (${videoDuration.toFixed(2)}s) is shorter than required duration ` +
        `(${requiredVideoDuration.toFixed(2)}s), looping clips to match audio length.`,
    );
    const baseClips = [...processedClips];
    let cursor = 0;
    while (videoDuration < requiredVideoDuration) {
      const clip = baseClips[cursor % baseClips.length]!;
      processedClips.push(clip);
      videoDuration += clip.duration;
      cursor++;
      // Zero-duration clips would spin forever; bail out rather than hang.
      if (clip.duration <= 0) break;
    }
    logger.info(
      `video duration: ${videoDuration.toFixed(2)}s, audio duration: ${audioDuration.toFixed(2)}s, ` +
        `required duration: ${requiredVideoDuration.toFixed(2)}s, ` +
        `looped ${processedClips.length - baseClips.length} clips`,
    );
  }

  if (processedClips.length === 0) {
    logger.warning("no clips available for merging");
    throw new Error("no usable video materials could be rendered");
  }

  // 4. Join and trim to the narration.
  const clipFiles = processedClips.map((clip) => clip.filePath);
  logger.info(`concatenating ${clipFiles.length} clips with ffmpeg`);
  await concatVideoClips({
    clipFiles,
    outputFile: combinedVideoPath,
    outputDir,
    threads,
    maxDuration: audioDuration,
    fps,
    signal,
  });

  await deleteFiles(clipFiles);
  logger.info("video combining completed");
  return combinedVideoPath;
}
