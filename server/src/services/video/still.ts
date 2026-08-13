/**
 * Single-pass render of a still image plus narration into a segment video.
 *
 * An audiobook segment is one cover frame held for the length of its narration.
 * The short-video pipeline would reach that through combine → generate, paying
 * for a clip-per-material concat and a subtitle pass on top; here the whole
 * segment — scale, pad, optional burned-in captions, audio — is expressed as one
 * ffmpeg invocation so a fifteen-minute chapter is encoded exactly once.
 */

import { buildFitFilter } from "./clip.ts";
import { codecQualityArgs, encodeWithCodecFallback, getConfiguredVideoCodec } from "./codec.ts";
import { escapeFilterValue, num, runFfmpeg, type RunOptions } from "./ffmpeg.ts";
import { AUDIO_BITRATE, AUDIO_CODEC } from "./generate.ts";
import { probe } from "./probe.ts";
import { logger } from "../../utils/logger.ts";

/**
 * Frame rate for a held still.
 *
 * Nothing moves, so the picture only needs enough frames to keep seeking and
 * playback well behaved; 1 fps is legal but confuses several players and
 * browsers, and 5 costs almost nothing once the encoder skips every duplicate.
 */
export const STILL_FRAMERATE = 5;

/** Fallback when the narration carries no readable sample rate. */
const DEFAULT_AUDIO_RATE = 44100;

export interface StillSegmentOptions {
  imagePath: string;
  audioPath: string;
  outputFile: string;
  /** Target frame size, normally from aspectToResolution(). */
  width: number;
  height: number;
  /**
   * ASS file to burn in. Requires libass — callers must check supportsAssBurn()
   * first, since a build without it fails the whole encode.
   */
  assPath?: string;
  /** Directory fontconfig should scan for the ASS font, normally fontDir(). */
  fontsDir?: string;
  /** Output frame rate; defaults to STILL_FRAMERATE. */
  fps?: number;
  threads?: number;
  signal?: AbortSignal;
}

export interface StillSegmentResult {
  outputFile: string;
  /** Encoded length, taken from the narration. */
  duration: number;
  /** Whether captions were burned into the picture. */
  burnedSubtitles: boolean;
}

/**
 * Builds a `subtitles=` filter for an ASS file.
 *
 * Both values are file paths inside a filter argument, where `:` separates
 * options, `,` separates filters and `\` escapes — all of which occur in real
 * paths, so neither may be interpolated raw.
 */
export function buildSubtitlesFilter(assPath: string, fontsDir?: string): string {
  const options = [`filename=${escapeFilterValue(assPath)}`];
  if (fontsDir) options.push(`fontsdir=${escapeFilterValue(fontsDir)}`);
  return `subtitles=${options.join(":")}`;
}

/**
 * Video filter chain for a still segment.
 *
 * Captions are appended to the same chain rather than run as a second pass, so
 * burning them in costs no extra encode. They come after the fit so libass
 * draws against the final frame size, which is what the ASS PlayRes describes.
 */
export function buildStillFilterGraph(
  width: number,
  height: number,
  assPath?: string,
  fontsDir?: string,
): string {
  const fit = buildFitFilter(width, height);
  return assPath ? `${fit},${buildSubtitlesFilter(assPath, fontsDir)}` : fit;
}

export interface StillArgsInput {
  imagePath: string;
  audioPath: string;
  outputFile: string;
  width: number;
  height: number;
  /** Probed narration length. 0 leaves the cut to -shortest alone. */
  duration: number;
  audioSampleRate: number;
  fps: number;
  threads: number;
  assPath?: string;
  fontsDir?: string;
}

/** Full ffmpeg argument list for one still segment. Pure, for testability. */
export function buildStillArgs(input: StillArgsInput, codec: string): string[] {
  const args = [
    "-y",
    // A looped still has no inherent frame rate; without an input rate ffmpeg
    // assumes 25 and decodes far more frames than the segment needs.
    "-loop",
    "1",
    "-framerate",
    String(input.fps),
    "-i",
    input.imagePath,
    "-i",
    input.audioPath,
    // Explicit maps: the image input carries no audio and the narration no
    // picture, so ffmpeg's default stream selection has nothing to guess from.
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-vf",
    buildStillFilterGraph(input.width, input.height, input.assPath, input.fontsDir),
    "-c:v",
    codec,
    ...codecQualityArgs(codec),
  ];

  // -tune is an x264 option; the hardware encoders in the codec whitelist
  // reject or ignore it, so it is only added for the software path.
  if (codec === "libx264") args.push("-tune", "stillimage");

  args.push(
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(input.fps),
    "-c:a",
    AUDIO_CODEC,
    "-b:a",
    AUDIO_BITRATE,
    "-ar",
    String(input.audioSampleRate),
    "-threads",
    String(input.threads),
  );

  // The looped image never ends, so the length comes from the narration. An
  // explicit -t is used rather than -shortest alone because -shortest cuts at
  // the last *muxed* frame and can drop the final fraction of a second.
  if (input.duration > 0) args.push("-t", num(input.duration, 3));
  args.push("-shortest", "-movflags", "+faststart", input.outputFile);

  return args;
}

/** Renders one still + narration segment in a single ffmpeg pass. */
export async function renderStillSegment(options: StillSegmentOptions): Promise<StillSegmentResult> {
  const { imagePath, audioPath, outputFile, width, height, assPath, fontsDir, signal } = options;

  const audioInfo = await probe(audioPath);
  const duration = audioInfo.duration > 0 ? audioInfo.duration : 0;
  if (duration <= 0) {
    logger.warning(`narration has no readable duration: ${audioPath}; falling back to -shortest`);
  }

  const input: StillArgsInput = {
    imagePath,
    audioPath,
    outputFile,
    width,
    height,
    duration,
    // Reuse the narration's rate so no resample separates Docker from desktop.
    audioSampleRate: audioInfo.audioSampleRate || DEFAULT_AUDIO_RATE,
    fps: options.fps && options.fps > 0 ? options.fps : STILL_FRAMERATE,
    threads: options.threads && options.threads > 0 ? options.threads : 2,
    assPath,
    fontsDir,
  };

  logger.info(`rendering still segment: ${width}x${height}, ${num(duration, 2)}s => ${outputFile}`);

  await encodeWithCodecFallback(
    (codec) => buildStillArgs(input, codec),
    (args) => runFfmpeg(args, { signal } satisfies RunOptions),
    getConfiguredVideoCodec(),
  );

  return { outputFile, duration, burnedSubtitles: Boolean(assPath) };
}
