/**
 * Turns TTS word-boundary events into script-aligned subtitles.
 * Ported from `create_subtitle` and friends in python-version/app/services/voice.py.
 *
 * Engines report timing per word or short phrase. Rendering that directly gives
 * "金钱 / 是 / 一种 / 社会 / 工具", which is unreadable as a subtitle, so cues are
 * accumulated until they match a punctuation-delimited line of the script and
 * emitted as one caption spanning the first cue's start to the last cue's end.
 */

import { normalizeScriptForSubtitleMatching, splitStringByPunctuations } from "../../utils/text.ts";
import { logger } from "../../utils/logger.ts";
import type { SubtitleCue } from "../subtitle/srt.ts";
import type { TtsCue } from "./types.ts";

/**
 * Removes bracket characters the TTS engine will not speak.
 *
 * This cannot live only in the generation step: users paste scripts by hand and
 * the API accepts arbitrary text. If these survive into matching, the aggregator
 * waits forever for a cue that never arrives and the subtitle file comes out
 * empty.
 */
export function formatTextForSubtitles(text: string): string {
  const cleaned = String(text ?? "")
    .replace(/[[\]]/g, " ")
    .replace(/[()]/g, " ")
    .replace(/[{}]/g, " ");
  return normalizeScriptForSubtitleMatching(cleaned);
}

/**
 * Arabic diacritics and the Tatweel elongation mark.
 *
 * Edge TTS may echo these back even when the script has none; they carry no
 * meaning but break exact string matching.
 */
const ARABIC_DIACRITICS = /[ؐ-ًؚ-ٰٟـۖ-ۭ]/g;

/**
 * Normalises Arabic letter forms so a cue can still match its script line.
 * Only used as a last-resort comparison; the displayed text is never changed.
 */
function normalizeArabic(text: string): string {
  let value = text.replace(ARABIC_DIACRITICS, "");
  const substitutions: [string, string][] = [
    ["أإآٱ", "ا"],
    ["ىئ", "ي"],
    ["ة", "ه"],
    ["ؤ", "و"],
  ];
  for (const [sources, replacement] of substitutions) {
    for (const char of sources) value = value.split(char).join(replacement);
  }
  return value;
}

/**
 * Everything that is not a letter or a digit, in any script.
 *
 * This must be Unicode-aware: JavaScript's `\W` is ASCII-only, so it would
 * strip every CJK character and reduce both sides of the comparison to an empty
 * string — making the very first cue "match" the whole line and destroying the
 * subtitle timing for Chinese, Japanese and Korean.
 */
const NON_WORD = /[^\p{L}\p{N}]+/gu;

/**
 * Matches accumulated cue text against the next script line.
 *
 * Three passes, loosest last: exact, punctuation-and-underscore stripped, then
 * Arabic-normalised. This tolerates the punctuation TTS engines drop or split
 * out, and the loose word boundaries CJK produces.
 */
export function matchScriptLine(scriptLines: string[], currentText: string, subIndex: number): string {
  if (scriptLines.length <= subIndex) return "";

  const targetLine = scriptLines[subIndex]!;
  if (currentText === targetLine) return targetLine.trim();

  const strip = (value: string) => value.replace(NON_WORD, "");
  if (strip(currentText) === strip(targetLine)) return targetLine.trim();

  const currentArabic = strip(normalizeArabic(currentText));
  const targetArabic = strip(normalizeArabic(targetLine));
  if (currentArabic && currentArabic === targetArabic) return targetLine.trim();

  return "";
}

/** Decodes the XML entities Edge TTS returns inside cue text. */
function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Aggregates fine-grained cues into script-line captions. */
export function buildSubtitleCuesFromTtsCues(ttsCues: TtsCue[], scriptLines: string[]): SubtitleCue[] {
  const result: SubtitleCue[] = [];
  let subIndex = 0;
  let currentText = "";
  let currentStart: number | null = null;

  for (const cue of ttsCues) {
    const cueText = unescapeXml(cue.content);
    if (currentStart === null) currentStart = cue.start;
    currentText += cueText;

    const matchedText = matchScriptLine(scriptLines, currentText, subIndex);
    if (!matchedText) continue;

    subIndex += 1;
    result.push({ index: subIndex, start: currentStart, end: cue.end, text: matchedText });
    currentText = "";
    currentStart = null;
  }

  if (currentText.trim()) {
    logger.warning(`tts cues still have unmatched text after aggregation: ${currentText}`);
  }

  return result;
}

/**
 * Builds the subtitle cue list for a script.
 *
 * Returns an empty array when the aggregation does not cover every script line:
 * a partial subtitle track would drift out of sync with the narration, and the
 * caller treats "no subtitles" as the safer outcome.
 */
export function createSubtitleCues(ttsCues: TtsCue[], text: string): SubtitleCue[] {
  const formatted = formatTextForSubtitles(text);
  const scriptLines = splitStringByPunctuations(formatted);

  const cues = buildSubtitleCuesFromTtsCues(ttsCues, scriptLines);
  if (cues.length !== scriptLines.length) {
    logger.warning(
      `failed, sub_items len: ${cues.length}, script_lines len: ${scriptLines.length}`,
    );
    return [];
  }
  return cues;
}
