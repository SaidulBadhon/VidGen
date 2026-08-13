/**
 * Subtitle generation entry point.
 * Ported from `generate_subtitle` in python-version/app/services/task.py and
 * `create`/`correct` in python-version/app/services/subtitle.py.
 */

import { existsSync } from "node:fs";
import { appConfig } from "../../config/settings.ts";
import { logger } from "../../utils/logger.ts";
import { createSubtitleCues } from "../voice/subtitles.ts";
import type { TtsCue } from "../voice/types.ts";
import { correctSubtitleCues } from "./correct.ts";
import { readSrtFile, writeSrtFile, type SubtitleCue } from "./srt.ts";
import { transcribe } from "./whisper.ts";

export * from "./srt.ts";
export { correctSubtitleCues } from "./correct.ts";
export { transcribe, resolveWhisperBinary, TranscriptionUnavailableError } from "./whisper.ts";

export interface GenerateSubtitleOptions {
  subtitlePath: string;
  videoScript: string;
  /** Word boundaries from TTS; absent for custom audio. */
  ttsCues?: TtsCue[];
  audioFile: string;
  subtitleEnabled: boolean;
}

/**
 * Produces the subtitle file for a task, or "" when there is nothing usable.
 *
 * The provider is a deliberate choice, not a fallback chain: an Edge failure
 * must not silently start a multi-gigabyte Whisper model download the user
 * never asked for. A video with no subtitles is the better outcome.
 */
export async function generateSubtitle(options: GenerateSubtitleOptions): Promise<string> {
  const { subtitlePath, videoScript, ttsCues, audioFile, subtitleEnabled } = options;

  if (!subtitleEnabled) return "";

  const provider = String(appConfig().subtitle_provider ?? "").trim().toLowerCase();
  logger.info(`generating subtitle, provider: ${provider || "(disabled)"}`);

  if (!provider) {
    logger.info("subtitle provider is empty, skip subtitle generation");
    return "";
  }

  let cues: SubtitleCue[] = [];

  if (provider === "edge") {
    if (!ttsCues || ttsCues.length === 0) {
      // Custom audio never goes through TTS, so there is no timeline to align
      // against. Only Whisper can transcribe an arbitrary file.
      logger.warning(`subtitle maker is missing, skip subtitle generation for provider: ${provider}`);
      return "";
    }

    cues = createSubtitleCues(ttsCues, videoScript);
    if (cues.length === 0) {
      logger.warning(
        "edge subtitle generation did not produce a subtitle file; " +
          "skip subtitles without falling back to whisper",
      );
      return "";
    }
  } else if (provider === "whisper") {
    cues = await transcribe(audioFile);
    if (cues.length === 0) {
      logger.warning("whisper produced no subtitles");
      return "";
    }
    logger.info("correcting subtitle");
    cues = correctSubtitleCues(cues, videoScript).cues;
  } else {
    logger.warning(`unsupported subtitle provider: ${provider}`);
    return "";
  }

  if (cues.length === 0) {
    logger.warning(`subtitle file is invalid: ${subtitlePath}`);
    return "";
  }

  await writeSrtFile(subtitlePath, cues);
  const written = await readSrtFile(subtitlePath);
  if (written.length === 0 || !existsSync(subtitlePath)) {
    logger.warning(`subtitle file is invalid: ${subtitlePath}`);
    return "";
  }

  const duration = Math.max(...written.map((cue) => cue.end), 0);
  logger.info(`completed, subtitle file created: ${subtitlePath}, duration: ${duration.toFixed(2)}`);
  return subtitlePath;
}
