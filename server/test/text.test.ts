/**
 * Script/subtitle text helpers.
 * Cases ported from python-version/test/services/test_subtitle.py and the
 * utils tests.
 */

import { describe, expect, test } from "bun:test";
import {
  levenshteinDistance,
  normalizeScriptForSubtitleMatching,
  parseSrtTimestamp,
  resolveUiLanguage,
  similarity,
  splitStringByPunctuations,
  strContainsPunctuation,
  textToSrt,
  timeConvertSecondsToHmsm,
} from "../src/utils/text.ts";
import { normalizeClipSpeed, parseExtension, redactSecrets } from "../src/utils/misc.ts";

describe("timeConvertSecondsToHmsm", () => {
  test("formats SRT timestamps", () => {
    expect(timeConvertSecondsToHmsm(0)).toBe("00:00:00,000");
    expect(timeConvertSecondsToHmsm(1.5)).toBe("00:00:01,500");
    expect(timeConvertSecondsToHmsm(61.25)).toBe("00:01:01,250");
    expect(timeConvertSecondsToHmsm(3661.007)).toBe("01:01:01,007");
  });

  test("round-trips through the parser", () => {
    expect(parseSrtTimestamp(timeConvertSecondsToHmsm(125.42))).toBeCloseTo(125.42, 2);
  });
});

describe("textToSrt", () => {
  test("renders a cue block", () => {
    expect(textToSrt(2, "hello", 1, 2.5)).toBe("2\n00:00:01,000 --> 00:00:02,500\nhello\n");
  });
});

describe("splitStringByPunctuations", () => {
  test("splits on sentence punctuation", () => {
    expect(splitStringByPunctuations("Hello world. How are you?")).toEqual(["Hello world", "How are you"]);
  });

  test("splits CJK on full-width punctuation", () => {
    expect(splitStringByPunctuations("春天的花海，如诗如画。万物复苏。")).toEqual([
      "春天的花海",
      "如诗如画",
      "万物复苏",
    ]);
  });

  test("keeps decimal points intact", () => {
    // "2.5% fee" must not become "2" and "5% fee".
    expect(splitStringByPunctuations("charged at 2.5% fee")).toEqual(["charged at 2.5% fee"]);
  });

  test("keeps thousands separators intact", () => {
    // TTS reports "1,000" as one token; splitting would break script matching.
    expect(splitStringByPunctuations("it lasted 1,000 years")).toEqual(["it lasted 1,000 years"]);
  });

  test("treats newlines as boundaries and drops empties", () => {
    expect(splitStringByPunctuations("one\n\ntwo")).toEqual(["one", "two"]);
  });
});

describe("strContainsPunctuation", () => {
  test("detects multi-character punctuation", () => {
    expect(strContainsPunctuation("wait...")).toBe(true);
    expect(strContainsPunctuation("hello")).toBe(false);
    expect(strContainsPunctuation("مرحبا،")).toBe(true);
  });
});

describe("normalizeScriptForSubtitleMatching", () => {
  test("removes markdown rules and underscores", () => {
    const input = "First line\n---\n_emphasis_ here\n***\nLast line";
    expect(normalizeScriptForSubtitleMatching(input)).toBe("First line\nemphasis here\nLast line");
  });

  test("leaves plain text alone", () => {
    expect(normalizeScriptForSubtitleMatching("Just a sentence.")).toBe("Just a sentence.");
  });
});

describe("similarity", () => {
  test("scores identical strings as 1", () => {
    expect(similarity("hello", "hello")).toBe(1);
  });

  test("is case-insensitive", () => {
    expect(similarity("Hello", "hello")).toBe(1);
  });

  test("computes edit distance", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
    expect(similarity("kitten", "sitting")).toBeCloseTo(1 - 3 / 7, 5);
  });

  test("handles empty input", () => {
    expect(similarity("", "")).toBe(1);
  });
});

describe("resolveUiLanguage", () => {
  const supported = ["en", "zh", "pt"];

  test("prefers the saved language", () => {
    expect(resolveUiLanguage("zh", "en-US", supported)).toBe("zh");
  });

  test("falls back to the browser locale's base code", () => {
    expect(resolveUiLanguage(null, "pt-BR", supported)).toBe("pt");
  });

  test("falls back to the default", () => {
    expect(resolveUiLanguage(null, "fr-FR", supported)).toBe("en");
  });

  test("survives an empty catalogue", () => {
    expect(resolveUiLanguage(null, null, [], "en")).toBe("en");
  });
});

describe("normalizeClipSpeed", () => {
  test("clamps to the supported range", () => {
    expect(normalizeClipSpeed(0.1)).toBe(0.5);
    expect(normalizeClipSpeed(5)).toBe(2.0);
    expect(normalizeClipSpeed(1.25)).toBe(1.25);
  });

  test("rejects non-playable values", () => {
    // NaN slips past ordinary comparisons and would poison every duration.
    expect(normalizeClipSpeed(Number.NaN)).toBe(1.0);
    expect(normalizeClipSpeed(Number.POSITIVE_INFINITY)).toBe(1.0);
    expect(normalizeClipSpeed(0)).toBe(1.0);
    expect(normalizeClipSpeed(-2)).toBe(1.0);
    expect(normalizeClipSpeed("abc")).toBe(1.0);
    expect(normalizeClipSpeed(null)).toBe(1.0);
  });
});

describe("parseExtension", () => {
  test("lowercases and strips the dot", () => {
    expect(parseExtension("clip.MP4")).toBe("mp4");
    expect(parseExtension("/a/b/photo.JPEG")).toBe("jpeg");
    expect(parseExtension("noext")).toBe("");
  });
});

describe("redactSecrets", () => {
  test("removes raw and url-encoded secrets", () => {
    const message = "GET https://api.example.com?key=abc/def failed";
    expect(redactSecrets(message, "abc/def")).toBe("GET https://api.example.com?key=*** failed");
    expect(redactSecrets("value abc%2Fdef here", "abc/def")).toBe("value *** here");
  });
});
