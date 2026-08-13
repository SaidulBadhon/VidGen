/**
 * Muxes an SRT into a finished video as a soft subtitle track.
 *
 * Soft subtitles are the only caption path that works on every ffmpeg build:
 * burning in needs libass, which a Homebrew ffmpeg routinely lacks, while
 * `mov_text` ships with the muxer itself. The picture is copied rather than
 * re-encoded, so a fifteen-minute chapter gains captions for the cost of a
 * remux instead of a second generation of compression.
 *
 * A sidecar `.srt` is written alongside the video as well: `mov_text` carries no
 * styling, and every platform that matters — YouTube above all — prefers an
 * uploaded caption file to an embedded track.
 */

import { existsSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { runFfmpeg, type RunOptions } from "./ffmpeg.ts";
import { logger } from "../../utils/logger.ts";

/** Container-level subtitle codec for MP4. */
const MP4_SUBTITLE_CODEC = "mov_text";

const DEFAULT_LANGUAGE = "und";
const DEFAULT_TITLE = "Subtitles";

/**
 * ISO 639-1 → 639-2/B, for the languages the app's voices cover.
 *
 * MP4 stores a three-letter code; the pipeline works in BCP-47-ish tags such as
 * "en-US" or "zh-CN". Anything unrecognised becomes "und", which players treat
 * as "unspecified" rather than mislabelling the track.
 */
const ISO_639_2: Record<string, string> = {
  ar: "ara",
  de: "deu",
  en: "eng",
  es: "spa",
  fr: "fra",
  hi: "hin",
  id: "ind",
  it: "ita",
  ja: "jpn",
  ko: "kor",
  nl: "nld",
  pl: "pol",
  pt: "por",
  ru: "rus",
  th: "tha",
  tr: "tur",
  vi: "vie",
  zh: "zho",
};

export function toIso639_2(tag: string | null | undefined): string {
  const normalized = String(tag ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return DEFAULT_LANGUAGE;

  // Already a three-letter code, e.g. a caller passing "eng" straight through.
  if (/^[a-z]{3}$/.test(normalized)) return normalized;

  return ISO_639_2[normalized.split("-")[0]!] ?? DEFAULT_LANGUAGE;
}

/** Sidecar caption path for a video, e.g. `final-1.mp4` → `final-1.srt`. */
export function sidecarSubtitlePath(videoFile: string): string {
  return join(dirname(videoFile), `${basename(videoFile, extname(videoFile))}.srt`);
}

export interface SoftSubtitleArgsInput {
  videoPath: string;
  subtitlePath: string;
  outputFile: string;
  language: string;
  title: string;
}

/**
 * ffmpeg arguments for the remux. Pure, for testability.
 *
 * The SRT is a second input with explicit maps rather than an extra option on
 * the video input. Audio is mapped optionally (`0:a?`) so a silent render still
 * muxes. `-shortest` is deliberately absent: on a stream copy it would truncate
 * the video at whichever stream ends first, which for captions is arbitrary.
 */
export function buildSoftSubtitleArgs(input: SoftSubtitleArgsInput): string[] {
  return [
    "-y",
    "-i",
    input.videoPath,
    "-i",
    input.subtitlePath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-map",
    "1:0",
    "-c",
    "copy",
    "-c:s",
    MP4_SUBTITLE_CODEC,
    "-metadata:s:s:0",
    `language=${input.language}`,
    "-metadata:s:s:0",
    `title=${input.title}`,
    // Marked default so a player shows captions without the viewer hunting for
    // the track, but still forced off by the player's own subtitle setting.
    "-disposition:s:0",
    "default",
    "-movflags",
    "+faststart",
    input.outputFile,
  ];
}

export interface SoftSubtitleOptions {
  videoPath: string;
  /** SRT to embed; also the source of the sidecar copy. */
  subtitlePath: string;
  outputFile: string;
  /** Language tag, e.g. "en-US". Stored as ISO 639-2. */
  language?: string | null;
  /** Track title shown in a player's subtitle menu. */
  title?: string;
  /** Sidecar destination; null skips it, undefined derives it from the output. */
  sidecarPath?: string | null;
  signal?: AbortSignal;
}

export interface SoftSubtitleResult {
  outputFile: string;
  /** Where the uploadable caption file landed, or null when not written. */
  sidecarPath: string | null;
  language: string;
}

/** Copies the video, embeds the SRT as a soft track, and writes the sidecar. */
export async function muxSoftSubtitles(options: SoftSubtitleOptions): Promise<SoftSubtitleResult> {
  const { videoPath, subtitlePath, outputFile, signal } = options;

  if (!existsSync(subtitlePath)) {
    throw new Error(`subtitle file not found: ${subtitlePath}`);
  }
  // ffmpeg cannot read and write the same file, and the failure surfaces as a
  // truncated output rather than an error, so it is refused up front.
  if (resolve(videoPath) === resolve(outputFile)) {
    throw new Error(`soft subtitle mux needs a distinct output file: ${outputFile}`);
  }

  const language = toIso639_2(options.language);
  const args = buildSoftSubtitleArgs({
    videoPath,
    subtitlePath,
    outputFile,
    language,
    title: options.title || DEFAULT_TITLE,
  });

  await runFfmpeg(args, { signal } satisfies RunOptions);

  let sidecarPath: string | null = null;
  if (options.sidecarPath !== null) {
    sidecarPath = options.sidecarPath ?? sidecarSubtitlePath(outputFile);
    if (resolve(sidecarPath) !== resolve(subtitlePath)) {
      await Bun.write(sidecarPath, Bun.file(subtitlePath));
    }
  }

  logger.info(`muxed soft subtitles (${language}) into ${outputFile}`);
  return { outputFile, sidecarPath, language };
}
