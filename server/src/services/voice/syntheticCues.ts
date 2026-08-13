/**
 * Timing for engines that report no word boundaries.
 * Ported from `populate_legacy_submaker_with_full_text`.
 */

import { splitStringByPunctuations } from "../../utils/text.ts";
import type { TtsCue } from "./types.ts";

/**
 * Splits the script into sentences and spreads the audio duration across them
 * in proportion to their length.
 *
 * Gemini, SiliconFlow, ElevenLabs and friends return audio with no timing. A
 * single cue covering the whole track could never match the script line by
 * line, which would push subtitles onto the Whisper fallback and download a
 * multi-gigabyte model the user never asked for. Approximate timings keep the
 * normal path working.
 */
export function buildProportionalCues(text: string, audioDurationSeconds: number): TtsCue[] {
  const normalized = String(text ?? "").trim();
  if (!normalized) return [];

  const duration = Math.max(audioDurationSeconds, 0.001);
  const sentences = splitStringByPunctuations(normalized);
  const lines = sentences.length > 0 ? sentences : [normalized];

  const totalChars = lines.reduce((sum, sentence) => sum + sentence.length, 0);
  if (totalChars <= 0) {
    return [{ start: 0, end: duration, content: normalized }];
  }

  const cues: TtsCue[] = [];
  let currentOffset = 0;

  lines.forEach((sentence, index) => {
    const cleaned = sentence.trim();
    if (!cleaned) return;

    // The final sentence absorbs whatever is left so rounding never leaves the
    // subtitle track ending before the audio does.
    const end =
      index === lines.length - 1
        ? duration
        : Math.min(currentOffset + duration * (cleaned.length / totalChars), duration);

    cues.push({ start: currentOffset, end, content: cleaned });
    currentOffset = end;
  });

  return cues;
}
