/**
 * Renders one material subclip to a normalised temp file.
 *
 * Replaces the per-clip MoviePy work inside `combine_videos`: trim, speed
 * change, fit to the output frame, and an optional transition. Every clip comes
 * out at the same resolution, pixel format and frame rate, which is what lets
 * the concat demuxer stitch them without re-encoding decisions per clip.
 */

import { codecQualityArgs, encodeWithCodecFallback, getConfiguredVideoCodec } from "./codec.ts";
import { num, runFfmpeg, type RunOptions } from "./ffmpeg.ts";
import { probe } from "./probe.ts";
import {
  buildTransitionGraph,
  pickSlideSide,
  resolveTransition,
  type SlideSide,
} from "./transitions.ts";
import type { VideoTransitionModeValue } from "../../models/schema.ts";

/** Output frame rate for every generated clip and final video. */
export const OUTPUT_FPS = 30;

export interface RenderClipOptions {
  sourcePath: string;
  outputPath: string;
  /** Seek position in the source, in seconds. */
  startTime: number;
  /** End position in the source, in seconds. */
  endTime: number;
  width: number;
  height: number;
  /** Playback speed already normalised to [0.5, 2.0]. */
  speed?: number;
  /** Hard cap on the rendered clip's duration. */
  maxClipDuration: number;
  transition?: VideoTransitionModeValue;
  /** Fixed side for slide transitions; random when omitted. */
  slideSide?: SlideSide;
  threads?: number;
  fps?: number;
  signal?: AbortSignal;
}

export interface RenderedClip {
  filePath: string;
  duration: number;
  codec: string;
}

/**
 * Fits the source into the output frame.
 *
 * `force_original_aspect_ratio=decrease` plus a centred pad reproduces both
 * MoviePy branches at once: an exact-ratio source scales to fill with no
 * padding, and any other ratio is scaled to fit and centred on black.
 */
export function buildFitFilter(width: number, height: number): string {
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "setsar=1",
  ].join(",");
}

/** Assembles the `-filter_complex` graph for one clip. Exported for tests. */
export function buildClipFilterGraph(options: {
  width: number;
  height: number;
  speed: number;
  duration: number;
  fps: number;
  transition: VideoTransitionModeValue;
  slideSide: SlideSide;
}): { filterComplex: string; outputLabel: string } {
  const { width, height, speed, duration, fps, transition, slideSide } = options;

  const resolved = resolveTransition(transition);
  const graph = buildTransitionGraph(resolved, { width, height, duration, fps, side: slideSide });

  const main: string[] = [];
  if (speed !== 1) {
    // setpts rescales presentation timestamps, so a factor of 2 halves the
    // clip's duration — the same contract as MoviePy's with_speed_scaled.
    main.push(`setpts=PTS/${num(speed)}`);
  }
  main.push(buildFitFilter(width, height));
  if (graph.preUpscale) {
    main.push(`scale=${width * 2}:${height * 2}:flags=bicubic`);
  }
  main.push(...graph.chainSuffix);
  main.push(`fps=${num(fps, 3)}`);

  const chains: string[] = [...graph.extraChains];

  if (graph.overlay) {
    chains.push(`[0:v]${main.join(",")}[clipv]`);
    chains.push(
      `[${graph.overlay.baseLabel}][clipv]overlay=x='${graph.overlay.x}':y='${graph.overlay.y}':shortest=1[out]`,
    );
  } else {
    chains.push(`[0:v]${main.join(",")}[out]`);
  }

  return { filterComplex: chains.join(";"), outputLabel: "out" };
}

export async function renderClip(options: RenderClipOptions): Promise<RenderedClip> {
  const {
    sourcePath,
    outputPath,
    startTime,
    endTime,
    width,
    height,
    speed = 1,
    maxClipDuration,
    transition = null,
    slideSide = pickSlideSide(),
    threads = 2,
    fps = OUTPUT_FPS,
    signal,
  } = options;

  const sourceDuration = Math.max(endTime - startTime, 0);
  // Speed is applied to source time, so the rendered length shrinks or grows
  // accordingly; the cap is the final safety net the Python version also kept.
  const renderedDuration = Math.min(sourceDuration / (speed || 1), maxClipDuration);

  const { filterComplex, outputLabel } = buildClipFilterGraph({
    width,
    height,
    speed,
    duration: renderedDuration,
    fps,
    transition,
    slideSide,
  });

  const runOptions: RunOptions = { signal };

  const codec = await encodeWithCodecFallback(
    (selectedCodec) => [
      "-y",
      "-ss",
      num(startTime, 3),
      "-to",
      num(endTime, 3),
      "-i",
      sourcePath,
      "-an",
      "-filter_complex",
      filterComplex,
      "-map",
      `[${outputLabel}]`,
      "-t",
      num(renderedDuration, 3),
      "-r",
      num(fps, 3),
      "-c:v",
      selectedCodec,
      ...codecQualityArgs(selectedCodec),
      "-pix_fmt",
      "yuv420p",
      "-threads",
      String(threads || 2),
      outputPath,
    ],
    (args) => runFfmpeg(args, runOptions),
    getConfiguredVideoCodec(),
  );

  const info = await probe(outputPath);
  return { filePath: outputPath, duration: info.duration, codec };
}
