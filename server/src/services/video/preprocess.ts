/**
 * Prepares user-supplied local materials for the render pipeline.
 * Ported from `preprocess_video` in python-version/app/services/video.py.
 */

import { join } from "node:path";
import { codecQualityArgs, encodeWithCodecFallback, getConfiguredVideoCodec } from "./codec.ts";
import { num, runFfmpeg } from "./ffmpeg.ts";
import { probe } from "./probe.ts";
import { isMaterialResolutionAcceptable } from "./combine.ts";
import { OUTPUT_FPS } from "./clip.ts";
import { resolvePathWithinDirectory } from "../../utils/fileSecurity.ts";
import { localVideosDir } from "../../utils/paths.ts";
import { parseExtension } from "../../utils/misc.ts";
import { logger, errorMessage } from "../../utils/logger.ts";
import { FILE_TYPE_IMAGES } from "../../models/const.ts";
import type { MaterialInfo } from "../../models/schema.ts";

/** Total zoom applied to a still image, per second of its clip duration. */
const IMAGE_ZOOM_PER_SECOND = 0.03;

/**
 * Validates local materials and converts stills into short moving clips.
 *
 * Paths arrive as API parameters, so each one is confined to the local
 * materials directory: bare filenames are accepted, historical absolute paths
 * still resolve, but nothing may escape into the rest of the filesystem.
 */
export async function preprocessVideos(
  materials: MaterialInfo[] | null | undefined,
  clipDuration = 4,
): Promise<MaterialInfo[]> {
  if (!materials || materials.length === 0) return [];

  const baseDir = localVideosDir(true);
  const valid: MaterialInfo[] = [];

  for (const material of materials) {
    if (!material.url) continue;

    let sourcePath: string;
    try {
      sourcePath = resolvePathWithinDirectory(baseDir, material.url);
    } catch (error) {
      logger.warning(
        `skip unsafe local material: ${material.url}, local_videos_dir: ${baseDir}, error: ${errorMessage(error)}`,
      );
      continue;
    }

    let info;
    try {
      info = await probe(sourcePath);
    } catch (error) {
      logger.warning(`skip unreadable local material: ${material.url}, error: ${errorMessage(error)}`);
      continue;
    }

    if (!isMaterialResolutionAcceptable(info.width, info.height)) {
      logger.warning(
        `low resolution material: ${info.width}x${info.height}, minimum 480x480 required (tolerance 10px)`,
      );
      continue;
    }

    const extension = parseExtension(sourcePath);
    if ((FILE_TYPE_IMAGES as readonly string[]).includes(extension)) {
      try {
        logger.info(`processing image: ${sourcePath}`);
        const videoFile = `${sourcePath}.mp4`;
        await renderImageClip(sourcePath, videoFile, info.width, info.height, clipDuration);
        valid.push({ ...material, url: videoFile });
        logger.success(`image processed: ${videoFile}`);
      } catch (error) {
        logger.warning(`failed to convert image material: ${material.url}, error: ${errorMessage(error)}`);
      }
      continue;
    }

    // Store the resolved absolute path so combine_videos can open the file
    // without repeating the containment check.
    valid.push({ ...material, url: sourcePath });
  }

  return valid;
}

/**
 * Turns a still into a slowly zooming clip.
 *
 * A static frame in an otherwise moving video reads as a stall, so the same
 * gentle Ken Burns push the Python version applied is reproduced here.
 */
async function renderImageClip(
  imagePath: string,
  outputPath: string,
  width: number,
  height: number,
  clipDuration: number,
): Promise<void> {
  const duration = Math.max(clipDuration, 0.5);
  const totalFrames = Math.max(Math.round(duration * OUTPUT_FPS), 1);
  const maxZoom = 1 + clipDuration * IMAGE_ZOOM_PER_SECOND;

  // Even dimensions are required by yuv420p; odd-sized stills would otherwise
  // fail at the encoder rather than here.
  const evenWidth = width % 2 === 0 ? width : width - 1;
  const evenHeight = height % 2 === 0 ? height : height - 1;

  const filter = [
    `scale=${evenWidth * 2}:${evenHeight * 2}:flags=bicubic`,
    [
      `zoompan=z='min(1+${num(maxZoom - 1)}*on/${totalFrames},${num(maxZoom)})'`,
      `x='iw/2-(iw/zoom/2)'`,
      `y='ih/2-(ih/zoom/2)'`,
      `d=1`,
      `s=${evenWidth}x${evenHeight}`,
      `fps=${OUTPUT_FPS}`,
    ].join(":"),
  ].join(",");

  await encodeWithCodecFallback(
    (codec) => [
      "-y",
      "-loop",
      "1",
      "-t",
      num(duration, 3),
      "-i",
      imagePath,
      "-vf",
      filter,
      "-c:v",
      codec,
      ...codecQualityArgs(codec),
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(OUTPUT_FPS),
      outputPath,
    ],
    (args) => runFfmpeg(args),
    getConfiguredVideoCodec(),
  );
}

/** Lists usable files in the local materials directory. */
export function localMaterialPath(filename: string): string {
  return join(localVideosDir(true), filename);
}
