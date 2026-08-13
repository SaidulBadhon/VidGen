/**
 * Shared helpers for the AI background-music providers.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { unlink } from "node:fs/promises";
import { logger, errorMessage } from "../../utils/logger.ts";
import { runFfmpeg } from "../video/ffmpeg.ts";

export class MusicProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MusicProviderError";
  }
}

/**
 * Builds a silent, 1280px-max H.264 proxy of the video.
 *
 * These services only analyse pacing and content, so uploading a full-quality
 * master costs upload time and bandwidth for no gain in the generated music.
 */
export async function createVideoProxy(
  videoPath: string,
  maxProxyBytes: number,
  providerName: string,
): Promise<string> {
  const proxyPath = join(dirname(resolve(videoPath)), `.${providerName}-proxy-${crypto.randomUUID().slice(0, 8)}.mp4`);

  try {
    await runFfmpeg(
      [
        "-y",
        "-i",
        videoPath,
        "-vf",
        "scale=w=1280:h=1280:force_original_aspect_ratio=decrease:force_divisible_by=2",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "30",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        proxyPath,
      ],
      { timeoutMs: 600_000 },
    );
  } catch (error) {
    await unlink(proxyPath).catch(() => {});
    throw new MusicProviderError(`failed to generate ${providerName} video proxy: ${errorMessage(error)}`);
  }

  const size = existsSync(proxyPath) ? statSync(proxyPath).size : 0;
  if (size <= 0 || size > maxProxyBytes) {
    await unlink(proxyPath).catch(() => {});
    throw new MusicProviderError(
      `${providerName} video proxy is empty or exceeds the ${Math.round(maxProxyBytes / 1024 / 1024)} MB limit`,
    );
  }

  logger.info(`${providerName} video proxy prepared: source=${videoPath}, size=${size} bytes`);
  return proxyPath;
}

export async function removeFile(filePath: string): Promise<void> {
  await unlink(filePath).catch(() => {});
}
