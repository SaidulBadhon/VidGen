/**
 * Final composition: picture + narration + background music + subtitles.
 * Ported from `generate_video` in python-version/app/services/video.py.
 */

import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { codecQualityArgs, encodeWithCodecFallback, getConfiguredVideoCodec } from "./codec.ts";
import { num, runFfmpeg, type RunOptions } from "./ffmpeg.ts";
import { probe } from "./probe.ts";
import { OUTPUT_FPS } from "./clip.ts";
import { deleteFiles } from "./concat.ts";
import { supportsAssBurn } from "./capabilities.ts";
import { buildSubtitlesFilter } from "./still.ts";
import { muxSoftSubtitles } from "./softSubs.ts";
import { renderCueImage, resolveBackgroundColor, type SubtitleStyle } from "./textRender.ts";
import { readSrtFile, type SubtitleCue } from "../subtitle/srt.ts";
import { assRenderOptionsFromParams, writeAssFile } from "../subtitle/ass.ts";
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
export const MAX_OVERLAY_INPUTS = 64;

// ---------------------------------------------------------------------------
// Subtitle strategy
// ---------------------------------------------------------------------------

/** What the caller asked for; unset lets the cue count decide. */
export type SubtitleRenderMode = "burn" | "soft" | "none";

/** How captions are actually put on screen for this render. */
export type SubtitleStrategy = "overlay" | "ass" | "soft" | "none";

/** Burn-in was asked for but this ffmpeg has no libass, so captions are soft. */
export const SUBTITLE_BURN_UNAVAILABLE_WARNING = "subtitle_burn_unavailable";

/** Captions were produced but could not be embedded; the video is still fine. */
export const SUBTITLE_SOFT_MUX_FAILED_WARNING = "subtitle_soft_mux_failed";

export interface SubtitleStrategyInput {
  cueCount: number;
  requested?: SubtitleRenderMode | null;
  /** Result of supportsAssBurn(); only consulted for a burn request. */
  assAvailable: boolean;
}

interface StrategyDecision {
  strategy: SubtitleStrategy;
  warningCode: string | null;
}

function decideSubtitleStrategy(input: SubtitleStrategyInput): StrategyDecision {
  const { cueCount, requested, assAvailable } = input;
  const longForm = cueCount > MAX_OVERLAY_INPUTS;

  if (requested === "none") return { strategy: "none", warningCode: null };
  if (requested === "soft") return { strategy: "soft", warningCode: null };

  if (requested === "burn") {
    if (assAvailable) return { strategy: "ass", warningCode: null };
    // The overlay path still burns captions correctly, it just cannot do so
    // for long content without re-encoding the whole video once per batch.
    if (longForm) return { strategy: "soft", warningCode: SUBTITLE_BURN_UNAVAILABLE_WARNING };
    return { strategy: "overlay", warningCode: null };
  }

  // Unspecified: shorts keep the pixel-exact overlay renderer they have always
  // used, long content takes the single-pass route.
  return { strategy: longForm ? "soft" : "overlay", warningCode: null };
}

/** Picks the caption pipeline for a render. */
export function resolveSubtitleStrategy(input: SubtitleStrategyInput): SubtitleStrategy {
  return decideSubtitleStrategy(input).strategy;
}

/**
 * Degradation the task layer should report, or null.
 *
 * Returned as a bare code because `TaskWarning` also carries the video index,
 * which only the pipeline loop knows.
 */
export function subtitleStrategyWarningCode(input: SubtitleStrategyInput): string | null {
  return decideSubtitleStrategy(input).warningCode;
}

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
  /**
   * Caption pipeline override. Left unset, shorts render exactly as before and
   * long-form falls back to a soft track instead of multi-pass compositing.
   */
  subtitleRenderMode?: SubtitleRenderMode | null;
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
  /** Which caption pipeline ran, for logging and diagnostics. */
  subtitleStrategy: SubtitleStrategy;
  /** Warning codes for the task layer to pair with a video index. */
  warningCodes: string[];
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
  const subtitlesRequested = Boolean(params.subtitle_enabled && subtitlePath && existsSync(subtitlePath));
  let cues: SubtitleCue[] = [];
  if (subtitlesRequested) {
    const fontName = params.font_name || "MicrosoftYaHeiBold.ttc";
    logger.info(`  ⑤ font: ${join(fontDir(), fontName)}`);
    cues = await readSrtFile(subtitlePath);
  }

  const strategyInput: SubtitleStrategyInput = {
    cueCount: cues.length,
    requested: options.subtitleRenderMode ?? null,
    // Only a burn request depends on libass, so no other render pays for the
    // probe — which keeps the short-video path free of an extra spawn.
    assAvailable: options.subtitleRenderMode === "burn" ? await supportsAssBurn() : false,
  };
  const strategy = subtitlesRequested ? resolveSubtitleStrategy(strategyInput) : "none";
  const warningCodes: string[] = [];

  const strategyWarning = subtitlesRequested ? subtitleStrategyWarningCode(strategyInput) : null;
  if (strategyWarning) {
    warningCodes.push(strategyWarning);
    logger.warning(
      `burned-in subtitles were requested but this ffmpeg has no libass ` +
        `(no "subtitles" filter); ${cues.length} cues will be muxed as a soft track instead`,
    );
  }

  let overlays: CueOverlay[] = [];
  let assPath: string | undefined;

  if (strategy === "overlay") {
    overlays = await buildCueOverlays(cues, params, outputDir);
    logger.info(`rendered ${overlays.length} subtitle cues`);
  } else if (strategy === "ass") {
    assPath = join(outputDir, `${basename(outputFile, extname(outputFile))}.ass`);
    await writeAssFile(assPath, cues, assRenderOptionsFromParams(params));
    logger.info(`burning ${cues.length} subtitle cues with libass: ${assPath}`);
  } else if (strategy === "soft") {
    logger.info(`muxing ${cues.length} subtitle cues as a soft subtitle track`);
  }

  // A soft track is added by remuxing the finished picture, so the composite
  // writes to a scratch file and the mux produces the real output.
  const softIntermediate =
    strategy === "soft"
      ? join(outputDir, `${basename(outputFile, extname(outputFile))}-nosubs${extname(outputFile) || ".mp4"}`)
      : "";
  const composeTarget = softIntermediate || outputFile;

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

  try {
    await encodeInPasses({
      videoPath,
      audioPath,
      outputFile: composeTarget,
      outputDir,
      overlays,
      assPath,
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
    await encodeInPasses({
      videoPath,
      audioPath,
      outputFile: composeTarget,
      outputDir,
      overlays,
      assPath,
      params,
      videoDuration,
      outputAudioRate,
      bgmFile: "",
      loopBgm: false,
      signal,
    });
  } finally {
    await deleteFiles([...overlays.map((overlay) => overlay.imagePath), ...(assPath ? [assPath] : [])]);
  }

  if (softIntermediate) {
    try {
      await muxSoftSubtitles({
        videoPath: softIntermediate,
        subtitlePath,
        outputFile,
        language: params.video_language,
        signal,
      });
      await deleteFiles([softIntermediate]);
    } catch (error) {
      // The picture and narration are already encoded; losing a whole long-form
      // render over a remux would be far worse than shipping it uncaptioned.
      logger.exception(`failed to mux soft subtitles into ${outputFile}`, error);
      warningCodes.push(SUBTITLE_SOFT_MUX_FAILED_WARNING);
      await rename(softIntermediate, outputFile);
    }
  }

  return { outputFile, bgmMixSucceeded, subtitleStrategy: strategy, warningCodes };
}

interface EncodeOptions {
  videoPath: string;
  audioPath: string;
  outputFile: string;
  outputDir: string;
  overlays: CueOverlay[];
  /** ASS file burned in by libass, used instead of PNG overlays. */
  assPath?: string;
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
async function encodeInPasses(options: EncodeOptions): Promise<void> {
  const { overlays, outputDir, outputFile } = options;

  if (overlays.length <= MAX_OVERLAY_INPUTS) {
    await encodeOnce({
      ...options,
      overlays,
      isFinalPass: true,
      sourceVideo: options.videoPath,
      target: outputFile,
    });
    return;
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
    assPath,
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
  const { chains: overlayChains, outputLabel } = buildOverlayChain(overlays, firstOverlayInput);
  chains.push(...overlayChains);

  let videoLabel = outputLabel;
  let videoIsFiltered = overlays.length > 0;

  // libass reads every cue from one file, so burning in adds a single filter to
  // the graph that is already being built rather than a pass of its own.
  if (assPath) {
    chains.push(`[${videoLabel}]${buildSubtitlesFilter(assPath, fontDir())}[assv]`);
    videoLabel = "assv";
    videoIsFiltered = true;
  }

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
    mapArgs.push("-map", videoIsFiltered ? `[${videoLabel}]` : "0:v");
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
