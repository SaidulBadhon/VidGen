/**
 * Script/subtitle text helpers.
 * Ported from python-version/app/utils/utils.py.
 */

import { PUNCTUATIONS } from "../models/const.ts";
import { logger } from "./logger.ts";

/** Single-character punctuation set used when splitting a script into lines. */
const PUNCTUATION_CHARS: ReadonlySet<string> = new Set<string>(
  PUNCTUATIONS.filter((p) => p.length === 1),
);

/** Formats seconds as the `HH:MM:SS,mmm` timestamp SRT expects. */
export function timeConvertSecondsToHmsm(seconds: number): string {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const remainder = total % 3600;
  const minutes = Math.floor(remainder / 60);
  const milliseconds = Math.floor(total * 1000) % 1000;
  const secs = Math.floor(remainder % 60);

  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(milliseconds, 3)}`;
}

/** Parses `HH:MM:SS,mmm` back into seconds. */
export function parseSrtTimestamp(value: string): number {
  const match = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(value.trim());
  if (!match) return 0;
  const [, h, m, s, ms] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

/** Renders one SRT cue block. */
export function textToSrt(idx: number, msg: string, startTime: number, endTime: number): string {
  return `${idx}\n${timeConvertSecondsToHmsm(startTime)} --> ${timeConvertSecondsToHmsm(endTime)}\n${msg}\n`;
}

/** True when the word contains any sentence-boundary punctuation. */
export function strContainsPunctuation(word: string): boolean {
  return PUNCTUATIONS.some((p) => word.includes(p));
}

/**
 * Splits a script into subtitle-sized lines at punctuation and newlines.
 *
 * Decimal points and thousands separators inside numbers are deliberately not
 * treated as boundaries: TTS word-boundary events return "2.5" and "1,000" as
 * single units, and splitting them would break the later line-by-line match
 * against the script.
 */
export function splitStringByPunctuations(s: string): string[] {
  const result: string[] = [];
  let txt = "";

  for (let i = 0; i < s.length; i++) {
    const char = s[i]!;

    if (char === "\n") {
      result.push(txt.trim());
      txt = "";
      continue;
    }

    const previousChar = i > 0 ? s[i - 1]! : "";
    const nextChar = i < s.length - 1 ? s[i + 1]! : "";
    const isDigit = (c: string) => c.length === 1 && c >= "0" && c <= "9";

    if ((char === "." || char === ",") && isDigit(previousChar) && isDigit(nextChar)) {
      txt += char;
      continue;
    }

    if (!PUNCTUATION_CHARS.has(char)) {
      txt += char;
    } else {
      result.push(txt.trim());
      txt = "";
    }
  }

  result.push(txt.trim());
  return result.filter(Boolean);
}

/**
 * Strips markup a narrator never speaks before subtitle alignment.
 *
 * Hand-written scripts sometimes carry Markdown rules or emphasis. Those
 * characters never appear in TTS or Whisper output, so leaving them in makes
 * the script produce more lines than the subtitles do — which ends up emitting
 * `00:00:00,000 --> 00:00:00,000` cues that editors refuse to import.
 */
export function normalizeScriptForSubtitleMatching(videoScript: string): string {
  const source = videoScript ?? "";
  const underscoreCount = (source.match(/_/g) ?? []).length;
  const withoutUnderscores = source.replace(/_/g, "");

  let removedSeparatorLines = 0;
  const cleanedLines: string[] = [];
  for (const rawLine of withoutUnderscores.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^[-*_]{3,}$/.test(line)) {
      removedSeparatorLines += 1;
      continue;
    }
    cleanedLines.push(line);
  }

  const normalized = cleanedLines.join("\n").trim();
  if (underscoreCount || removedSeparatorLines) {
    logger.debug(
      "normalized script for subtitle matching, " +
        `removed underscores: ${underscoreCount}, ` +
        `removed markdown separator lines: ${removedSeparatorLines}`,
    );
  }
  return normalized;
}

/** Levenshtein distance, used by the subtitle corrector. */
export function levenshteinDistance(a: string, b: string): number {
  if (a.length < b.length) return levenshteinDistance(b, a);
  if (b.length === 0) return a.length;

  let previousRow = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 0; i < a.length; i++) {
    const currentRow = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const insertions = previousRow[j + 1]! + 1;
      const deletions = currentRow[j]! + 1;
      const substitutions = previousRow[j]! + (a[i] !== b[j] ? 1 : 0);
      currentRow.push(Math.min(insertions, deletions, substitutions));
    }
    previousRow = currentRow;
  }

  return previousRow[previousRow.length - 1]!;
}

/** Case-insensitive similarity in [0, 1]. */
export function similarity(a: string, b: string): number {
  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) return 1;
  return 1 - levenshteinDistance(a.toLowerCase(), b.toLowerCase()) / maxLength;
}

/**
 * Picks the UI language from saved setting, then browser locale, then default.
 *
 * Browsers send region-qualified locales (`zh-CN`, `pt-BR`) while the locale
 * files use base codes, so an exact match is tried before the base code.
 */
export function resolveUiLanguage(
  savedLanguage: string | null | undefined,
  browserLocale: string | null | undefined,
  supportedLanguages: Iterable<string>,
  defaultLanguage = "en",
): string {
  const supported = [...supportedLanguages].map((language) => String(language).trim()).filter(Boolean);
  const byLower = new Map(supported.map((language) => [language.toLowerCase(), language]));

  const match = (value: string | null | undefined): string | undefined => {
    const normalized = String(value ?? "")
      .trim()
      .replace(/_/g, "-")
      .toLowerCase();
    if (!normalized) return undefined;
    return byLower.get(normalized) ?? byLower.get(normalized.split("-")[0]!);
  };

  return (
    match(savedLanguage) ??
    match(browserLocale) ??
    match(defaultLanguage) ??
    supported[0] ??
    defaultLanguage
  );
}
