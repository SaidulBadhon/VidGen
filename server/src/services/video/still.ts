/**
 * Single-pass render of a still image plus narration into a segment video.
 *
 * An audiobook segment is one cover frame held for the length of its narration.
 * The short-video pipeline would reach that through combine → generate, paying
 * for a clip-per-material concat and a subtitle pass on top; here the whole
 * segment — scale, pad, optional burned-in captions, audio — is expressed as one
 * ffmpeg invocation so a fifteen-minute chapter is encoded exactly once.
 *
 * The body can also be a looping motion bed with a title card dissolved over its
 * opening (`bedPath` / `cardPath`). Both are extra *video* inputs spliced into
 * that same single invocation: nothing is concatenated and nothing about the
 * audio half of the graph moves. Both properties are load-bearing. A card
 * prepended with a concat drops the narration and exits 0, and the body's t=0
 * must stay the narration's t=0 — subtitle cues are written before this code
 * runs and are narration-relative, so anything that shifts the narration
 * desynchronises every cue in the chapter.
 */

import { buildFitFilter } from "./clip.ts";
import { codecQualityArgs, encodeWithCodecFallback, getConfiguredVideoCodec } from "./codec.ts";
import { escapeFilterValue, num, runFfmpeg, type RunOptions } from "./ffmpeg.ts";
import { AUDIO_BITRATE, AUDIO_CODEC, BGM_FADE_OUT_SECONDS } from "./generate.ts";
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

/**
 * Seconds the card spends dissolving into the body, taken from the tail of its
 * own visible window.
 *
 * Matches `card.fadeOutSeconds` in resource/hyperframes/classic/template.json.
 * The card composition deliberately paints the same ground as the bed, so the
 * dissolve reads as the type leaving rather than as one shot cutting to
 * another — which only works if the fade here and the card's own exit
 * animation agree on how long the handoff takes.
 */
const CARD_FADE_SECONDS = 1.4;

/** Encoder settings for a body that actually moves. See bedQualityArgs(). */
export interface BedEncodeProfile {
  /** Frame rate the bed was authored at; also the default output rate. */
  fps: number;
  crf: number;
  preset: string;
}

/**
 * Profile used when a bed arrives without one.
 *
 * These are T0's measured numbers, not a guess: 15 fps / crf 26 / veryfast on a
 * real 815.951s chapter produced 60.1 MB in 264s of encode. There is no safe
 * "no profile" case — falling through to the still defaults below would apply
 * `-preset medium -crf 23` to 12k moving frames, which is the expensive half of
 * the very thing this profile exists to avoid.
 */
export const DEFAULT_BED_ENCODE: BedEncodeProfile = { fps: 15, crf: 26, preset: "veryfast" };

export interface StillSegmentOptions {
  /**
   * Held picture for the body. Optional only when `bedPath` is set, and even
   * then it stays the documented fallback — the bed is refused outright when
   * the narration length is unknown (see buildStillArgs), so a caller that
   * passes both always gets a segment out.
   */
  imagePath?: string;
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
  /**
   * Resolved background music track, mixed under the narration when set.
   * Callers must resolve it through the bgm service first — this takes a path.
   */
  bgmPath?: string;
  /** Music gain, 0..1. Ignored without `bgmPath`. */
  bgmVolume?: number;
  /**
   * Output frame rate; defaults to the bed profile's rate when a bed is in use
   * and to STILL_FRAMERATE otherwise. See resolveStillFps().
   */
  fps?: number;
  /**
   * Looping motion bed, already rendered at `width`x`height`, replacing the
   * held still as the body. Refused when the narration length is unknown.
   */
  bedPath?: string;
  /**
   * Card composited over the opening of the body, normally sitting under the
   * spoken title announcement. An overlay, never a prepended clip.
   */
  cardPath?: string;
  /**
   * Seconds the card stays visible, including its fade. Required for the card
   * to be used at all: without a window there is nothing to bound the overlay
   * with, and an unbounded card hides the entire chapter behind a title.
   */
  cardDuration?: number;
  /** Encode profile for the body when a bed is used. Defaults to DEFAULT_BED_ENCODE. */
  bedEncode?: BedEncodeProfile;
  threads?: number;
  signal?: AbortSignal;
}

export interface StillSegmentResult {
  outputFile: string;
  /** Encoded length, taken from the narration. */
  duration: number;
  /** Whether captions were burned into the picture. */
  burnedSubtitles: boolean;
  /** Whether music was mixed under the narration. */
  mixedBgm: boolean;
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
  /** Held picture. Optional only when `bedPath` is set and usable. */
  imagePath?: string;
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
  /** Background music path; absent leaves the narration as the only audio. */
  bgmPath?: string;
  bgmVolume?: number;
  /** Looping motion bed replacing the held still. See buildStillArgs(). */
  bedPath?: string;
  /** Card overlaid on the opening; ignored without a positive `cardDuration`. */
  cardPath?: string;
  cardDuration?: number;
  bedEncode?: BedEncodeProfile;
}

/**
 * Output frame rate for the body.
 *
 * An explicit request always wins, so the caller keeps the last word. Failing
 * that a bed takes its own profile's rate: STILL_FRAMERATE is 5 fps, which is
 * invisible on a picture where nothing moves and a visible strobe on one where
 * everything does. A held still keeps the cheap default, including when a bed
 * was offered and refused — paying 15 fps for 12k duplicate frames buys nothing.
 */
export function resolveStillFps(fps?: number, bedEncode?: BedEncodeProfile): number {
  if (fps && fps > 0) return fps;
  if (bedEncode && bedEncode.fps > 0) return bedEncode.fps;
  return STILL_FRAMERATE;
}

/**
 * Quality flags for a body that moves.
 *
 * codecQualityArgs() is tuned for a held still, where `-preset medium -crf 23`
 * is nearly free because the encoder drops every duplicate frame. Against real
 * motion that trade inverts, which is why a bed carries its own profile rather
 * than sharing the still's.
 *
 * `-crf` and `-preset` are x264 spellings — the hardware encoders in the codec
 * whitelist reject them — so anything other than libx264 keeps the
 * encoder-specific flags codecQualityArgs() already knows how to emit.
 */
export function bedQualityArgs(codec: string, bedEncode?: BedEncodeProfile): string[] {
  if (codec !== "libx264") return codecQualityArgs(codec);
  const profile = bedEncode ?? DEFAULT_BED_ENCODE;
  return ["-preset", profile.preset, "-crf", String(profile.crf)];
}

/**
 * Chains that dissolve the card into the body underneath it.
 *
 * The card is an ordinary opaque H.264 file — H.264 carries no alpha — so it is
 * lifted into yuva420p purely to give `fade` an alpha channel to drive. That is
 * what reveals the body as the card leaves; a plain `fade=t=out` without
 * `alpha=1` would fade the card to black instead and punch a black hole through
 * the opening of the chapter.
 *
 * `enable=` gates the overlay rather than trimming the card, so the moment the
 * window closes the filter is bypassed and `baseLabel` passes through
 * untouched. That is what keeps an 8s card from costing anything across the
 * other 800s, and it is also why the card's own EOF is harmless: overlay's
 * default eof_action would repeat its last frame forever, but by then the
 * filter is already disabled.
 *
 * Captions ride at the end of the overlay chain rather than before it, so
 * libass draws on top of the card instead of underneath it — burning them
 * under an opaque card would blank the first seconds of every chapter's cues.
 */
export function buildCardOverlayChains(
  cardIndex: number,
  cardDuration: number,
  baseLabel: string,
  captions = "",
): string[] {
  // A card shorter than the fade would otherwise start already dissolving,
  // and a negative `st` makes fade emit from the first frame.
  const fade = Math.min(CARD_FADE_SECONDS, cardDuration);
  const tail = captions ? `,${captions}` : "";
  return [
    `[${cardIndex}:v]format=yuva420p,fade=t=out:st=${num(cardDuration - fade, 3)}:d=${num(fade, 3)}:alpha=1[card]`,
    `[${baseLabel}][card]overlay=0:0:enable='between(t,0,${num(cardDuration, 3)})'${tail}[v]`,
  ];
}

/**
 * Audio filter chains that put music under the narration.
 *
 * Reads inputs 1 and 2 — the narration and the music in `buildStillArgs`'
 * fixed order — and is split out only so the mix can be tested on its own.
 * Those two indices are why an optional card input is appended last rather
 * than inserted: a card at index 1 would renumber the narration and point this
 * mix at a video stream.
 *
 * Deliberately identical to the short-video mix in generate.ts — same gain,
 * same tail fade, same `normalize=0` sum — so a chapter and a clip made from
 * the same track sound the same. `duration=first` ends the mix with the
 * narration, which is what stops an endlessly looped track from running on.
 */
export function buildStillAudioChains(bgmVolume: number, duration: number): string[] {
  const chains: string[] = [];

  // An unknown narration length has no meaningful point to fade from, and
  // fading a segment shorter than the fade itself would just start it quiet.
  const fade =
    duration > BGM_FADE_OUT_SECONDS
      ? `,afade=t=out:st=${num(duration - BGM_FADE_OUT_SECONDS, 3)}:d=${BGM_FADE_OUT_SECONDS}`
      : "";

  chains.push(`[2:a]volume=${num(bgmVolume)}${fade}[bgm]`);
  chains.push("[1:a][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]");
  return chains;
}

/** Full ffmpeg argument list for one still segment. Pure, for testability. */
export function buildStillArgs(input: StillArgsInput, codec: string): string[] {
  // A bed loops forever, so the only thing that ever ends the video half of the
  // graph is -t. -t is omitted when the probe found no narration length (see
  // below), and -shortest against an endlessly looping *video* is the classic
  // non-terminating encode: ffmpeg runs until something kills it, and in this
  // pipeline that means a BookConcurrencyGate slot held for good. So an unknown
  // duration refuses the bed and falls back to the still, which -shortest can
  // legitimately bound because the still's own loop is trimmed by the narration.
  const useBed = Boolean(input.bedPath) && input.duration > 0;
  // Without a window there is nothing to bound the overlay with, and an
  // enable= expression over an unknown span would leave the card covering the
  // whole chapter.
  const useCard = Boolean(input.cardPath) && (input.cardDuration ?? 0) > 0;

  if (!useBed && !input.imagePath) {
    throw new Error("buildStillArgs needs an imagePath: the bed is unusable and there is no still to fall back to");
  }

  const args = ["-y"];

  if (useBed) {
    // A different argument shape, not a path swap. -loop/-framerate describe a
    // single image being held; a bed is a real video whose own frame rate must
    // be respected, and -stream_loop is how a *file* is repeated. Applying
    // -framerate here would retime the bed's motion instead of the encode.
    args.push("-stream_loop", "-1", "-i", input.bedPath!);
  } else {
    // A looped still has no inherent frame rate; without an input rate ffmpeg
    // assumes 25 and decodes far more frames than the segment needs.
    args.push("-loop", "1", "-framerate", String(input.fps), "-i", input.imagePath!);
  }

  // The narration is always input 1, whatever else is attached. Every audio
  // reference below — the direct map, buildStillAudioChains' [1:a] — is written
  // against that index, and the card is appended *after* the audio inputs for
  // exactly this reason: inserting it earlier would renumber the narration and
  // silently re-map the mix onto a video stream.
  args.push("-i", input.audioPath);

  if (input.bgmPath) {
    // A library track is minutes long and a chapter is not, so it repeats until
    // the mix is trimmed to the narration. -stream_loop precedes its own input.
    args.push("-stream_loop", "-1", "-i", input.bgmPath);
  }

  const cardIndex = input.bgmPath ? 3 : 2;
  if (useCard) args.push("-i", input.cardPath!);

  const captions = input.assPath ? buildSubtitlesFilter(input.assPath, input.fontsDir) : "";

  // A bed is rendered at the target frame size already, so the fit is a no-op
  // that still rescales and re-pads every frame — T0 measured it at ~7% of the
  // body encode on a real chapter. The still path keeps it: its picture is a
  // book cover of arbitrary size.
  const bodyFilters = useBed
    ? captions
    : buildStillFilterGraph(input.width, input.height, input.assPath, input.fontsDir);

  // Chains and the map they feed. "0:v:0" means the picture needs no graph at
  // all, which is the bed-without-captions case.
  const videoChains: string[] = [];
  let videoMap = "0:v:0";
  let simpleFilter = bodyFilters;

  if (useCard) {
    // The fit runs before the overlay so the card composites against a frame
    // that is already the output size; on the bed path there is no fit and the
    // card lands directly on input 0.
    let baseLabel = "0:v";
    if (!useBed) {
      videoChains.push(`[0:v]${buildFitFilter(input.width, input.height)}[body]`);
      baseLabel = "body";
    }
    videoChains.push(...buildCardOverlayChains(cardIndex, input.cardDuration!, baseLabel, captions));
    videoMap = "[v]";
    simpleFilter = "";
  }

  // -vf and -filter_complex cannot describe the same output, so once music or a
  // card needs a graph the picture moves into it too.
  if (input.bgmPath || useCard) {
    if (simpleFilter) {
      videoChains.push(`[0:v]${simpleFilter}[v]`);
      videoMap = "[v]";
    }
    const audioChains = input.bgmPath ? buildStillAudioChains(input.bgmVolume ?? 0, input.duration) : [];
    args.push(
      "-filter_complex",
      [...videoChains, ...audioChains].join(";"),
      "-map",
      videoMap,
      "-map",
      input.bgmPath ? "[aout]" : "1:a:0",
    );
  } else {
    // Explicit maps: the picture input carries no audio and the narration no
    // picture, so ffmpeg's default stream selection has nothing to guess from.
    args.push("-map", videoMap, "-map", "1:a:0");
    if (simpleFilter) args.push("-vf", simpleFilter);
  }

  args.push("-c:v", codec, ...(useBed ? bedQualityArgs(codec, input.bedEncode) : codecQualityArgs(codec)));

  // -tune is an x264 option; the hardware encoders in the codec whitelist
  // reject or ignore it, so it is only added for the software path. It is also
  // wrong for a bed: stillimage biases the encoder towards a picture that never
  // changes, which is the opposite of what a moving body is.
  if (codec === "libx264" && !useBed) args.push("-tune", "stillimage");

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
  //
  // This is the audio half of the graph and it is identical in every shape
  // above: same narration map, same BGM mix, same -t, same -shortest, same
  // probed sample rate. A bed or a card changes what the viewer sees and
  // nothing about what they hear. An earlier design that touched this path
  // shipped chapter videos with no narration at all, exit code 0.
  if (input.duration > 0) args.push("-t", num(input.duration, 3));
  args.push("-shortest", "-movflags", "+faststart", input.outputFile);

  return args;
}

/** Renders one still + narration segment in a single ffmpeg pass. */
export async function renderStillSegment(options: StillSegmentOptions): Promise<StillSegmentResult> {
  const { imagePath, audioPath, outputFile, width, height, assPath, fontsDir, signal } = options;
  const { bedPath, cardPath, bedEncode } = options;
  // A track with no gain would be mixed in inaudibly and still cost a decode of
  // the whole file, so it is treated as no music at all.
  const bgmVolume = Number(options.bgmVolume ?? 0);
  const bgmPath = options.bgmPath && bgmVolume > 0 ? options.bgmPath : undefined;
  const cardDuration = Number(options.cardDuration ?? 0);

  if (!imagePath && !bedPath) {
    throw new Error("renderStillSegment needs an imagePath or a bedPath");
  }

  const audioInfo = await probe(audioPath);
  const duration = audioInfo.duration > 0 ? audioInfo.duration : 0;
  if (duration <= 0) {
    logger.warning(`narration has no readable duration: ${audioPath}; falling back to -shortest`);
  }

  // Mirrors buildStillArgs' own refusal, restated here so the reason is logged
  // once and so the missing-fallback case fails before ffmpeg is spawned rather
  // than from inside the codec-fallback retry.
  const useBed = Boolean(bedPath) && duration > 0;
  if (bedPath && !useBed) {
    logger.warning(
      `refusing the motion bed for ${outputFile}: an unbounded -t against a looping bed never terminates; ` +
        `falling back to the still`,
    );
    if (!imagePath) {
      throw new Error("renderStillSegment: the bed is unusable without a duration and no still to fall back to");
    }
  }
  if (cardPath && cardDuration <= 0) {
    logger.warning(`ignoring the card for ${outputFile}: cardDuration must be positive to bound the overlay`);
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
    // The bed profile only gets a vote while the bed is actually in play; a
    // refused bed must not leave the fallback still encoding at 15 fps.
    fps: resolveStillFps(options.fps, useBed ? (bedEncode ?? DEFAULT_BED_ENCODE) : undefined),
    threads: options.threads && options.threads > 0 ? options.threads : 2,
    assPath,
    fontsDir,
    bgmPath,
    bgmVolume,
    bedPath,
    cardPath,
    cardDuration,
    bedEncode,
  };

  logger.info(
    `rendering ${useBed ? "bed" : "still"} segment: ${width}x${height}, ${num(duration, 2)}s` +
      `${cardPath && cardDuration > 0 ? `, card over the first ${num(cardDuration, 2)}s` : ""}` +
      `${bgmPath ? `, music at ${num(bgmVolume)}` : ""} => ${outputFile}`,
  );

  await encodeWithCodecFallback(
    (codec) => buildStillArgs(input, codec),
    (args) => runFfmpeg(args, { signal } satisfies RunOptions),
    getConfiguredVideoCodec(),
  );

  return { outputFile, duration, burnedSubtitles: Boolean(assPath), mixedBgm: Boolean(bgmPath) };
}
