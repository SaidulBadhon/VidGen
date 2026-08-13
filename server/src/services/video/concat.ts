/**
 * Joins rendered clips with the ffmpeg concat demuxer.
 * Ported from `concat_video_clips_with_ffmpeg` in
 * python-version/app/services/video.py.
 */

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { codecQualityArgs, encodeWithCodecFallback, getConfiguredVideoCodec } from "./codec.ts";
import { num, runFfmpeg, type RunOptions } from "./ffmpeg.ts";
import { logger, errorMessage } from "../../utils/logger.ts";
import { OUTPUT_FPS } from "./clip.ts";

/**
 * Formats one entry of a concat list file.
 *
 * The demuxer wraps paths in single quotes, so an embedded quote must be
 * escaped. Windows backslashes are normalised to forward slashes because the
 * parser would otherwise read them as escapes.
 */
export function formatConcatPath(filePath: string): string {
  const absolute = filePath.startsWith("/") ? filePath : join(process.cwd(), filePath);
  return absolute.replace(/\\/g, "/").replace(/'/g, "'\\''");
}

export interface ConcatOptions {
  clipFiles: string[];
  outputFile: string;
  outputDir: string;
  threads?: number;
  /** Trims the joined video, normally to the narration length. */
  maxDuration?: number;
  fps?: number;
  signal?: AbortSignal;
}

export async function concatVideoClips(options: ConcatOptions): Promise<string> {
  const { clipFiles, outputFile, outputDir, threads = 2, maxDuration, fps = OUTPUT_FPS, signal } = options;

  if (clipFiles.length === 0) {
    throw new Error("no clips to concatenate");
  }

  const listFile = join(outputDir, "ffmpeg-concat-list.txt");
  const listBody = clipFiles.map((file) => `file '${formatConcatPath(file)}'`).join("\n") + "\n";
  await Bun.write(listFile, listBody);

  const runOptions: RunOptions = { signal };
  const durationArgs = maxDuration && maxDuration > 0 ? ["-t", num(maxDuration, 3)] : [];

  try {
    // Every clip was rendered with identical codec, resolution, pixel format
    // and frame rate, so a stream copy is the intended use of this demuxer. It
    // avoids a whole extra encode generation before the final mux.
    try {
      await runFfmpeg(
        [
          "-y",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          listFile,
          "-c",
          "copy",
          ...durationArgs,
          outputFile,
        ],
        runOptions,
      );
      logger.debug(`concatenated ${clipFiles.length} clips with stream copy`);
      return outputFile;
    } catch (error) {
      // A mismatch in encoder-emitted stream parameters is the realistic
      // failure here; re-encoding always works and matches the Python path.
      logger.warning(
        `concat stream copy failed, falling back to re-encode: ${errorMessage(error)}`,
      );
    }

    await encodeWithCodecFallback(
      (codec) => [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listFile,
        "-c:v",
        codec,
        ...codecQualityArgs(codec),
        "-threads",
        String(threads || 2),
        "-pix_fmt",
        "yuv420p",
        "-r",
        num(fps, 3),
        ...durationArgs,
        outputFile,
      ],
      (args) => runFfmpeg(args, runOptions),
      getConfiguredVideoCodec(),
    );

    return outputFile;
  } finally {
    await unlink(listFile).catch(() => {});
  }
}

/**
 * Removes temporary files, tolerating repeats and missing entries.
 *
 * When clips are looped to cover the narration the same path appears several
 * times in the concat list, so deletion must be idempotent.
 */
export async function deleteFiles(files: string[] | string): Promise<void> {
  const list = typeof files === "string" ? [files] : files;
  const unique = [...new Set(list.filter(Boolean))];

  await Promise.all(
    unique.map(async (file) => {
      try {
        await unlink(file);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Already gone is a normal outcome for cleanup and not worth logging.
        if (code === "ENOENT") return;
        logger.warning(`failed to delete temporary file ${file}: ${errorMessage(error)}`);
      }
    }),
  );
}
