/**
 * Per-clip transition effects as ffmpeg filter graphs.
 * Ported from python-version/app/services/utils/video_effects.py.
 *
 * Each effect is described declaratively so the clip renderer can assemble one
 * `-filter_complex` graph, rather than each effect spawning its own pass.
 */

import { num } from "./ffmpeg.ts";
import type { VideoTransitionModeValue } from "../../models/schema.ts";

/** Fade and slide run for one second, matching the Python effects. */
export const TRANSITION_DURATION = 1;

/** Ken Burns zoom range. Kept at 20% so short clips still read as moving. */
const ZOOM_MAX_SCALE = 1.2;

export type SlideSide = "left" | "right" | "top" | "bottom";

export const SLIDE_SIDES: readonly SlideSide[] = ["left", "right", "top", "bottom"];

export interface TransitionContext {
  width: number;
  height: number;
  /** Final clip duration in seconds, after any speed change. */
  duration: number;
  fps: number;
  /** Chosen once per clip, as the Python version does. */
  side: SlideSide;
}

export interface TransitionGraph {
  /** Standalone chains, e.g. the black background a slide composites onto. */
  extraChains: string[];
  /** Filters appended to the clip's own chain. */
  chainSuffix: string[];
  /** When set, the clip chain is overlaid onto `baseLabel` at these offsets. */
  overlay?: { baseLabel: string; x: string; y: string };
  /**
   * Render the clip at 2x before the effect.
   *
   * zoompan truncates its crop origin to whole pixels. On a slow centre zoom
   * that origin advances by well under a pixel per frame, so rounding shows up
   * as irregular micro-judder — the same problem the Python version solved with
   * sub-pixel PIL sampling. Cropping from a 2x frame and letting zoompan scale
   * the result down halves the step and smooths it away. It costs 4x the pixels,
   * which is why only the zoom effects ask for it.
   */
  preUpscale?: boolean;
}

const EMPTY_GRAPH: TransitionGraph = { extraChains: [], chainSuffix: [] };

export function isTransitionMode(value: unknown): value is VideoTransitionModeValue {
  return (
    value === null ||
    value === undefined ||
    ["Shuffle", "FadeIn", "FadeOut", "SlideIn", "SlideOut", "ZoomIn", "ZoomOut"].includes(String(value))
  );
}

/**
 * Picks a concrete effect, resolving `Shuffle` to one of the six.
 * Returns null when no transition applies.
 */
export function resolveTransition(
  mode: VideoTransitionModeValue | undefined,
  random: () => number = Math.random,
): Exclude<VideoTransitionModeValue, null | "Shuffle"> | null {
  if (!mode) return null;
  if (mode !== "Shuffle") return mode;

  const options = ["FadeIn", "FadeOut", "SlideIn", "SlideOut", "ZoomIn", "ZoomOut"] as const;
  return options[Math.floor(random() * options.length)] ?? "FadeIn";
}

export function pickSlideSide(random: () => number = Math.random): SlideSide {
  return SLIDE_SIDES[Math.floor(random() * SLIDE_SIDES.length)] ?? "left";
}

/** Builds the filter graph for one resolved transition. */
export function buildTransitionGraph(
  transition: Exclude<VideoTransitionModeValue, null | "Shuffle"> | null,
  context: TransitionContext,
): TransitionGraph {
  if (!transition) return EMPTY_GRAPH;

  const { width, height, duration, fps, side } = context;
  const d = Math.max(duration, 0.001);

  switch (transition) {
    case "FadeIn":
      return {
        extraChains: [],
        chainSuffix: [`fade=t=in:st=0:d=${num(Math.min(TRANSITION_DURATION, d))}`],
      };

    case "FadeOut": {
      const start = Math.max(d - TRANSITION_DURATION, 0);
      return {
        extraChains: [],
        chainSuffix: [`fade=t=out:st=${num(start)}:d=${num(Math.min(TRANSITION_DURATION, d))}`],
      };
    }

    case "SlideIn": {
      // Matches the Python position(): offset starts a full frame off-screen
      // and reaches 0 after one second, then holds.
      const t = TRANSITION_DURATION;
      const progress = `min(max(t/${num(t)},0),1)`;
      const x =
        side === "left"
          ? `${-width}+${width}*${progress}`
          : side === "right"
            ? `${width}-${width}*${progress}`
            : "0";
      const y =
        side === "top"
          ? `${-height}+${height}*${progress}`
          : side === "bottom"
            ? `${height}-${height}*${progress}`
            : "0";

      return {
        extraChains: [`color=c=black:s=${width}x${height}:r=${num(fps, 3)}:d=${num(d)}[slidebg]`],
        chainSuffix: [],
        overlay: { baseLabel: "slidebg", x, y },
      };
    }

    case "SlideOut": {
      const transitionStart = Math.max(d - TRANSITION_DURATION, 0);
      const progress = `min(max((t-${num(transitionStart)})/${num(TRANSITION_DURATION)},0),1)`;
      const x =
        side === "left"
          ? `-${width}*${progress}`
          : side === "right"
            ? `${width}*${progress}`
            : "0";
      const y =
        side === "top"
          ? `-${height}*${progress}`
          : side === "bottom"
            ? `${height}*${progress}`
            : "0";

      return {
        extraChains: [`color=c=black:s=${width}x${height}:r=${num(fps, 3)}:d=${num(d)}[slidebg]`],
        chainSuffix: [],
        overlay: { baseLabel: "slidebg", x, y },
      };
    }

    case "ZoomIn":
    case "ZoomOut": {
      // The zoom spans the whole clip, not one second: a brief zoom that then
      // freezes looks wrong on static or low-motion stock footage.
      const totalFrames = Math.max(Math.round(d * fps), 1);
      const z =
        transition === "ZoomIn"
          ? `min(1+${num(ZOOM_MAX_SCALE - 1)}*on/${totalFrames},${num(ZOOM_MAX_SCALE)})`
          : `max(${num(ZOOM_MAX_SCALE)}-${num(ZOOM_MAX_SCALE - 1)}*on/${totalFrames},1)`;

      return {
        extraChains: [],
        chainSuffix: [
          [
            `zoompan=z='${z}'`,
            `x='iw/2-(iw/zoom/2)'`,
            `y='ih/2-(ih/zoom/2)'`,
            `d=1`,
            `s=${width}x${height}`,
            `fps=${num(fps, 3)}`,
          ].join(":"),
        ],
        preUpscale: true,
      };
    }

    default:
      return EMPTY_GRAPH;
  }
}
