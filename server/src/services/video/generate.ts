/**
 * Final composition: picture + narration + background music + subtitles.
 * Ported from `generate_video` in python-version/app/services/video.py.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { codecQualityArgs, encodeWithCodecFallback, getConfiguredVideoCodec } from "./codec.ts";
import { num, runFfmpeg, type RunOptions } from "./ffmpeg.ts";
import { probe } from "./probe.ts";
import { OUTPUT_FPS } from "./clip.ts";
import { deleteFiles } from "./concat.ts";
import { renderCueImage, resolveBackgroundColor, type SubtitleStyle } from "./textRender.ts";
import { readSrtFile, type SubtitleCue } from "../subtitle/srt.ts";
import { shouldUseBgm } from "../bgm.ts";
import { logger, errorMessage } from "../../utils/logger.ts";
import { fontDir } from "../../utils/paths.ts";
import { aspectToResolution, type VideoParams } from "../../models/schema.ts";

export const AUDIO_CODEC = "aac";

/**
 * Docker's ffmpeg/AAC combination is prone to audible artefacts at the default
 * bitrate, so it is raised explicitly rather than left to the encoder.
 */
export const AUDIO_BITRATE = "192k";

/** Music fades over the final seconds of the video. */
const BGM_FADE_OUT_SECONDS = 3;

/**
 * Cap on subtitle images passed as ffmpeg inputs in one pass.
 *
 * Each cue is a separate input and therefore an open file descriptor; macOS
 * defaults to a 256-descriptor limit. Longer videos are composited in several
 * passes instead of risking an EMFILE failure at the very last stage.
 */
const MAX_OVERLAY_INPUTS = 64;

export interface GenerateVideoOptions {
  videoPath: string;
  audioPath: string;
  subtitlePath: string;
  outputFile: string;
  params: VideoParams;
  /**
   * Music chosen by the task layer.
   * `undefined` keeps the normal random/custom lookup, `""` disables music for
   * this render, and a path uses a provider-generated, duration-matched track.
   */
  bgmFileOverride?: string;
  /** Resolved local background music when no override applies. */
  bgmFile?: string;
  signal?: AbortSignal;
}

export interface GenerateVideoResult {
  outputFile: string;
  /**
   * Whether background music was mixed successfully. False only when music was
   * requested and failed; the video is still produced without it so the task
   * layer can surface a degradation warning instead of failing the whole run.
   */
  bgmMixSucceeded: boolean;
}

export interface CueOverlay {
  imagePath: string;
  width: number;
  height: number;
  x: number;
  y: number;
  start: number;
  end: number;
}

/** Vertical placement for a cue, matching the Python position rules. */
export function resolveSubtitleY(
  position: string,
  customPosition: number,
  videoHeight: number,
  cueHeight: number,
): number {
  if (position === "bottom") return videoHeight * 0.95 - cueHeight;
  if (position === "top") return videoHeight * 0.05;
  if (position === "custom") {
    // Keep the plate fully on screen whatever percentage was requested.
    const margin = 10;
    const maxY = videoHeight - cueHeight - margin;
    const minY = margin;
    const customY = (videoHeight - cueHeight) * (customPosition / 100);
    return Math.max(minY, Math.min(customY, maxY));
  }
  return (videoHeight - cueHeight) / 2;
}

/** Rasterises every cue and works out where each one sits in the frame. */
export async function buildCueOverlays(
  cues: SubtitleCue[],
  params: VideoParams,
  outputDir: string,
): Promise<CueOverlay[]> {
  const [videoWidth, videoHeight] = aspectToResolution(params.video_aspect);
  const fontName = params.font_name || "MicrosoftYaHeiBold.ttc";
  const style: SubtitleStyle = {
    fontPath: join(fontDir(), fontName),
    fontSize: params.font_size,
    textForeColor: params.text_fore_color,
    strokeColor: params.stroke_color,
    strokeWidth: params.stroke_width,
    textBackgroundColor: params.text_background_color,
    roundedSubtitleBackground: params.rounded_subtitle_background,
  };

  const overlays: CueOverlay[] = [];
  for (let index = 0; index < cues.length; index++) {
    const cue = cues[index]!;
    // Multi-line cues arrive with newlines from the SRT; the wrapper re-flows
    // them against the real font, so they are flattened to a single string.
    const text = cue.text.replace(/\s*\n\s*/g, " ").trim();
    if (!text) continue;

    const image = renderCueImage(text, videoWidth, style);
    const imagePath = join(outputDir, `subtitle-cue-${String(index).padStart(4, "0")}.png`);
    await Bun.write(imagePath, image.buffer);

    overlays.push({
      imagePath,
      width: image.width,
      height: image.height,
      x: Math.round((videoWidth - image.width) / 2),
      y: Math.round(resolveSubtitleY(params.subtitle_position, params.custom_position, videoHeight, image.height)),
      start: cue.start,
      end: cue.end,
    });
  }

  return overlays;
}

/** Builds the overlay chain for a batch of cues, given the first input index. */
export function buildOverlayChain(
  overlays: CueOverlay[],
  firstInputIndex: number,
  baseLabel = "0:v",
): { chains: string[]; outputLabel: string } {
  const chains: string[] = [];
  let currentLabel = baseLabel;

  overlays.forEach((overlay, position) => {
    const inputIndex = firstInputIndex + position;
    const nextLabel = `sub${position}`;
    chains.push(
      `[${currentLabel}][${inputIndex}:v]overlay=` +
        `x=${overlay.x}:y=${overlay.y}:` +
        `enable='between(t,${num(overlay.start, 3)},${num(overlay.end, 3)})'` +
        `[${nextLabel}]`,
    );
    currentLabel = nextLabel;
  });

  return { chains, outputLabel: currentLabel };
}

export async function generateVideo(options: GenerateVideoOptions): Promise<GenerateVideoResult> {
  const { videoPath, audioPath, subtitlePath, outputFile, params, bgmFileOverride, bgmFile, signal } =
    options;

  const [videoWidth, videoHeight] = aspectToResolution(params.video_aspect);
  logger.info(`generating video: ${videoWidth} x ${videoHeight}`);
  logger.info(`  ① video: ${videoPath}`);
  logger.info(`  ② audio: ${audioPath}`);
  logger.info(`  ③ subtitle: ${subtitlePath}`);
  logger.info(`  ④ output: ${outputFile}`);

  const outputDir = join(outputFile, "..");
  const videoInfo = await probe(videoPath);
  const audioInfo = await probe(audioPath);
  const videoDuration = videoInfo.duration;

  // Reuse the narration's sample rate so Docker and desktop runs do not differ
  // through an extra resample; 44100 is the conventional fallback.
  const outputAudioRate = audioInfo.audioSampleRate || 44100;

  // --- Subtitles -----------------------------------------------------------
  let overlays: CueOverlay[] = [];
  if (params.subtitle_enabled && subtitlePath && existsSync(subtitlePath)) {
    const fontName = params.font_name || "MicrosoftYaHeiBold.ttc";
    logger.info(`  ⑤ font: ${join(fontDir(), fontName)}`);
    const cues = await readSrtFile(subtitlePath);
    overlays = await buildCueOverlays(cues, params, outputDir);
    logger.info(`rendered ${overlays.length} subtitle cues`);
  }

  // --- Background music ----------------------------------------------------
  const bgmEnabled = shouldUseBgm(params.bgm_type, params.bgm_volume);
  if (!bgmEnabled && params.bgm_type) {
    logger.info(
      `skipping background music because volume is not positive: ` +
        `type=${params.bgm_type}, volume=${params.bgm_volume}`,
    );
  }

  // An override that is an empty string means "no music for this render"; the
  // provider path uses it to disable music after a generation failure.
  const resolvedBgm = bgmEnabled ? (bgmFileOverride !== undefined ? bgmFileOverride : (bgmFile ?? "")) : "";
  // Only locally resolved music needs looping — a provider track is already
  // matched to the video length.
  const shouldLoopBgm = bgmFileOverride === undefined;

  let bgmMixSucceeded = true;
  let result: GenerateVideoResult;

  try {
    result = await encodeInPasses({
      videoPath,
      audioPath,
      outputFile,
      outputDir,
      overlays,
      params,
      videoDuration,
      outputAudioRate,
      bgmFile: resolvedBgm,
      loopBgm: shouldLoopBgm,
      signal,
    });
  } catch (error) {
    if (!resolvedBgm) throw error;

    // Music can fail for reasons the render itself would survive — a corrupt
    // file, an unsupported codec. Retry once without it so the user still gets
    // a finished video, and report the degradation.
    logger.exception(
      `failed to mix background music: type=${params.bgm_type}, file=${resolvedBgm}`,
      error,
    );
    bgmMixSucceeded = false;
    result = await encodeInPasses({
      videoPath,
      audioPath,
      outputFile,
      outputDir,
      overlays,
      params,
      videoDuration,
      outputAudioRate,
      bgmFile: "",
      loopBgm: false,
      signal,
    });
  } finally {
    await deleteFiles(overlays.map((overlay) => overlay.imagePath));
  }

  return { ...result, bgmMixSucceeded };
}

interface EncodeOptions {
  videoPath: string;
  audioPath: string;
  outputFile: string;
  outputDir: string;
  overlays: CueOverlay[];
  params: VideoParams;
  videoDuration: number;
  outputAudioRate: number;
  bgmFile: string;
  loopBgm: boolean;
  signal?: AbortSignal;
}

/**
 * Runs the composite, splitting the subtitle overlays across passes when there
 * are more cues than we are willing to open at once.
 */
async function encodeInPasses(options: EncodeOptions): Promise<GenerateVideoResult> {
  const { overlays, outputDir, outputFile } = options;

  if (overlays.length <= MAX_OVERLAY_INPUTS) {
    await encodeOnce({
      ...options,
      overlays,
      isFinalPass: true,
      sourceVideo: options.videoPath,
      target: outputFile,
    });
    return { outputFile, bgmMixSucceeded: true };
  }

  logger.info(
    `compositing ${overlays.length} subtitle cues across multiple passes ` +
      `(limit ${MAX_OVERLAY_INPUTS} per pass)`,
  );

  const batches: CueOverlay[][] = [];
  for (let start = 0; start < overlays.length; start += MAX_OVERLAY_INPUTS) {
    batches.push(overlays.slice(start, start + MAX_OVERLAY_INPUTS));
  }

  const intermediates: string[] = [];
  let sourceVideo = options.videoPath;

  try {
    for (let index = 0; index < batches.length; index++) {
      const isFinalPass = index === batches.length - 1;
      const target = isFinalPass ? outputFile : join(outputDir, `subtitle-pass-${index}.mp4`);

      await encodeOnce({
        ...options,
        overlays: batches[index]!,
        isFinalPass,
        sourceVideo,
        target,
      });

      if (!isFinalPass) {
        intermediates.push(target);
        sourceVideo = target;
      }
    }
  } finally {
    await deleteFiles(intermediates);
  }

  return { outputFile, bgmMixSucceeded: true };
}

/**
 * Single ffmpeg composite pass.
 *
 * Audio is only muxed on the final pass; intermediate subtitle passes carry
 * picture alone so the narration is never re-encoded more than once.
 */
async function encodeOnce(
  options: EncodeOptions & { isFinalPass: boolean; sourceVideo: string; target: string },
): Promise<void> {
  const {
    sourceVideo,
    audioPath,
    target,
    overlays,
    params,
    videoDuration,
    outputAudioRate,
    bgmFile,
    loopBgm,
    isFinalPass,
    signal,
  } = options;

  const inputArgs: string[] = ["-y", "-i", sourceVideo];
  let nextInputIndex = 1;

  let audioInputIndex = -1;
  let bgmInputIndex = -1;

  if (isFinalPass) {
    inputArgs.push("-i", audioPath);
    audioInputIndex = nextInputIndex++;

    if (bgmFile) {
      // Local music is usually shorter than the video, so it repeats until the
      // mix is trimmed to the narration length.
      if (loopBgm) inputArgs.push("-stream_loop", "-1");
      inputArgs.push("-i", bgmFile);
      bgmInputIndex = nextInputIndex++;
    }
  }

  const firstOverlayInput = nextInputIndex;
  for (const overlay of overlays) {
    inputArgs.push("-i", overlay.imagePath);
    nextInputIndex++;
  }

  const chains: string[] = [];
  const { chains: overlayChains, outputLabel: videoLabel } = buildOverlayChain(
    overlays,
    firstOverlayInput,
  );
  chains.push(...overlayChains);

  let audioLabel = "";
  if (isFinalPass) {
    chains.push(`[${audioInputIndex}:a]volume=${num(params.voice_volume)}[voice]`);

    if (bgmInputIndex >= 0) {
      const fadeStart = Math.max(videoDuration - BGM_FADE_OUT_SECONDS, 0);
      chains.push(
        `[${bgmInputIndex}:a]volume=${num(params.bgm_volume)},` +
          `afade=t=out:st=${num(fadeStart, 3)}:d=${BGM_FADE_OUT_SECONDS}[bgm]`,
      );
      // normalize=0 sums the streams instead of dividing by the input count,
      // matching MoviePy's CompositeAudioClip; the default would quietly halve
      // the narration as soon as music was added.
      chains.push(
        `[voice][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`,
      );
      audioLabel = "aout";
    } else {
      audioLabel = "voice";
    }
  }

  const mapArgs: string[] = [];
  if (chains.length > 0) {
    mapArgs.push("-filter_complex", chains.join(";"));
    mapArgs.push("-map", overlays.length > 0 ? `[${videoLabel}]` : "0:v");
    if (audioLabel) mapArgs.push("-map", `[${audioLabel}]`);
  } else {
    mapArgs.push("-map", "0:v");
    if (isFinalPass && audioInputIndex >= 0) mapArgs.push("-map", `${audioInputIndex}:a`);
  }

  const audioArgs = isFinalPass
    ? ["-c:a", AUDIO_CODEC, "-b:a", AUDIO_BITRATE, "-ar", String(outputAudioRate)]
    : ["-an"];

  await encodeWithCodecFallback(
    (codec) => [
      ...inputArgs,
      ...mapArgs,
      "-c:v",
      codec,
      ...codecQualityArgs(codec),
      "-pix_fmt",
      "yuv420p",
      "-r",
      num(OUTPUT_FPS, 3),
      ...audioArgs,
      "-threads",
      String(params.n_threads || 2),
      // The picture track is already trimmed to the narration; -shortest keeps
      // a looped music input from extending the output.
      "-shortest",
      "-movflags",
      "+faststart",
      target,
    ],
    (args) => runFfmpeg(args, { signal } satisfies RunOptions),
    getConfiguredVideoCodec(),
  );
}

/**
 * Warns when subtitle text and its plate are the same colour.
 * Ported from `subtitle_colors_are_indistinguishable`.
 */
export function subtitleColorsAreIndistinguishable(params: VideoParams): boolean {
  if (!params.subtitle_enabled || !params.text_background_color) return false;

  const normalize = (value: boolean | string): string => {
    if (typeof value === "boolean") return value ? "#000000" : "";
    return String(value ?? "").trim().toLowerCase();
  };

  const textColor = normalize(params.text_fore_color);
  const backgroundColor = normalize(resolveBackgroundColor(params.text_background_color) ?? "");
  return Boolean(textColor && textColor === backgroundColor);
}

export { errorMessage };
