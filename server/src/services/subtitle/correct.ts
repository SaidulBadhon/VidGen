/**
 * Realigns transcribed subtitles to the written script.
 * Ported from `correct()` in python-version/app/services/subtitle.py.
 *
 * Whisper transcribes what it hears, which drifts from the script in spelling,
 * punctuation and sentence boundaries. Since the script is the source of truth
 * for the words, only the timings from the transcription are kept.
 */

import { normalizeScriptForSubtitleMatching, similarity, splitStringByPunctuations } from "../../utils/text.ts";
import { logger } from "../../utils/logger.ts";
import type { SubtitleCue } from "./srt.ts";

export interface CorrectionResult {
  cues: SubtitleCue[];
  corrected: boolean;
}

/** Confidence needed to accept a merged run of cues as one script line. */
const MERGE_SIMILARITY_THRESHOLD = 0.8;

export function correctSubtitleCues(cues: SubtitleCue[], videoScript: string): CorrectionResult {
  const normalizedScript = normalizeScriptForSubtitleMatching(videoScript);
  const scriptLines = splitStringByPunctuations(normalizedScript);

  const result: SubtitleCue[] = [];
  let corrected = false;
  let scriptIndex = 0;
  let subtitleIndex = 0;

  while (scriptIndex < scriptLines.length && subtitleIndex < cues.length) {
    const scriptLine = scriptLines[scriptIndex]!.trim();
    const cue = cues[subtitleIndex]!;
    const subtitleLine = cue.text.trim();

    if (scriptLine === subtitleLine) {
      result.push({ ...cue, index: result.length + 1 });
      scriptIndex += 1;
      subtitleIndex += 1;
      continue;
    }

    // Whisper often splits one written sentence across several cues. Merge
    // forward for as long as doing so improves the match.
    let combined = subtitleLine;
    let endTime = cue.end;
    let nextIndex = subtitleIndex + 1;

    while (nextIndex < cues.length) {
      const nextText = cues[nextIndex]!.text.trim();
      if (similarity(scriptLine, `${combined} ${nextText}`) > similarity(scriptLine, combined)) {
        combined += ` ${nextText}`;
        endTime = cues[nextIndex]!.end;
        nextIndex += 1;
      } else {
        break;
      }
    }

    if (similarity(scriptLine, combined) > MERGE_SIMILARITY_THRESHOLD) {
      logger.warning(`Merged/Corrected - Script: ${scriptLine}, Subtitle: ${combined}`);
    } else {
      logger.warning(`Mismatch - Script: ${scriptLine}, Subtitle: ${combined}`);
    }

    // Either way the script text wins; only the timing comes from the audio.
    result.push({ index: result.length + 1, start: cue.start, end: endTime, text: scriptLine });
    corrected = true;

    scriptIndex += 1;
    subtitleIndex = nextIndex;
  }

  // Script lines the transcription never reached still deserve a caption.
  while (scriptIndex < scriptLines.length) {
    logger.warning(`Extra script line: ${scriptLines[scriptIndex]}`);
    const fallback = cues[subtitleIndex];
    result.push({
      index: result.length + 1,
      start: fallback?.start ?? 0,
      end: fallback?.end ?? 0,
      text: scriptLines[scriptIndex]!,
    });
    if (fallback) subtitleIndex += 1;
    scriptIndex += 1;
    corrected = true;
  }

  if (!corrected) logger.success("Subtitle is correct");
  return { cues: result, corrected };
}
