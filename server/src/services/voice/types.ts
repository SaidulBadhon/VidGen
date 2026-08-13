/** Shared types for text-to-speech adapters. */

/**
 * One timed fragment reported by a TTS engine.
 *
 * Word-boundary events are what let the app build subtitles that line up with
 * the narration without transcribing the audio again.
 */
export interface TtsCue {
  /** Seconds from the start of the audio. */
  start: number;
  end: number;
  content: string;
}

export interface TtsResult {
  /** Path the synthesised audio was written to. */
  audioFile: string;
  /** Empty when the engine reports no timing information. */
  cues: TtsCue[];
  /** Duration in seconds, when the engine reports it. */
  duration?: number;
}

export interface TtsRequest {
  text: string;
  voiceName: string;
  voiceRate: number;
  voiceFile: string;
  voiceVolume?: number;
  signal?: AbortSignal;
}

export type TtsAdapter = (request: TtsRequest) => Promise<TtsResult | null>;

/** 100-nanosecond ticks, the unit Microsoft speech services report offsets in. */
export const TICKS_PER_SECOND = 10_000_000;

export function ticksToSeconds(ticks: number): number {
  return ticks / TICKS_PER_SECOND;
}
