/**
 * Long-form narration chunking, cue offsetting and manifest reuse.
 * Everything here is pure: no network, no ffmpeg, no database.
 */

import { describe, expect, test } from "bun:test";
import {
  buildChunkCues,
  chunkForTts,
  commonFormatTarget,
  findReusableEntry,
  formatsMatch,
  hashChunkInput,
  offsetChunkCues,
  parseChunkManifest,
  type ChunkManifestEntry,
} from "../src/services/voice/longform.ts";
import type { SubtitleCue } from "../src/services/subtitle/srt.ts";
import type { TtsCue } from "../src/services/voice/types.ts";

/** Whitespace at the seams is the only thing chunking may drop. */
function stripWhitespace(value: string): string {
  return value.replace(/\s+/g, "");
}

/** Asserts chunks are contiguous slices of the script that begin and end on a word. */
function expectWordAlignedSlices(source: string, chunks: string[]): void {
  let cursor = 0;
  for (const chunk of chunks) {
    const at = source.indexOf(chunk, cursor);
    expect(at).toBeGreaterThanOrEqual(0);
    const before = at > 0 ? source[at - 1]! : " ";
    const after = at + chunk.length < source.length ? source[at + chunk.length]! : " ";
    expect(/\s/.test(before)).toBe(true);
    expect(/\s/.test(after)).toBe(true);
    cursor = at + chunk.length;
  }
}

describe("chunkForTts", () => {
  test("returns nothing for blank text", () => {
    expect(chunkForTts("", 100)).toEqual([]);
    expect(chunkForTts("   \n\n \t ", 100)).toEqual([]);
  });

  test("keeps a script that already fits as one chunk", () => {
    const text = "A short line of narration.";
    expect(chunkForTts(text, 100)).toEqual([text]);
  });

  test("rejects a meaningless limit", () => {
    expect(() => chunkForTts("text", 0)).toThrow("invalid maxChars");
    expect(() => chunkForTts("text", Number.NaN)).toThrow("invalid maxChars");
  });

  test("splits on paragraph boundaries before anything else", () => {
    const text = "First paragraph here.\n\nSecond paragraph here.";
    expect(chunkForTts(text, 30)).toEqual(["First paragraph here.", "Second paragraph here."]);
  });

  test("packs consecutive paragraphs up to the limit", () => {
    // A book of one-line paragraphs must not become one request per line.
    const text = "One.\n\nTwo.\n\nThree.\n\nFour.";
    expect(chunkForTts(text, 13)).toEqual(["One.\n\nTwo.", "Three.\n\nFour."]);
  });

  test("falls back to sentence boundaries inside a long paragraph", () => {
    const text = "Alpha runs first. Beta runs second. Gamma runs third.";
    const chunks = chunkForTts(text, 24);
    expect(chunks).toEqual(["Alpha runs first.", "Beta runs second.", "Gamma runs third."]);
  });

  test("preserves the terminating punctuation of every sentence", () => {
    const text = "Is this a question? It is! Ellipsis follows… And a full stop.";
    const chunks = chunkForTts(text, 20);
    expect(chunks.every((chunk) => /[?!….]$/.test(chunk))).toBe(true);
    expect(stripWhitespace(chunks.join(""))).toBe(stripWhitespace(text));
  });

  test("does not treat a decimal point as a sentence boundary", () => {
    const text = "The value is 3.14 exactly. The other one is 1,000 units.";
    const chunks = chunkForTts(text, 30);
    expect(chunks).toEqual(["The value is 3.14 exactly.", "The other one is 1,000 units."]);
  });

  test("falls back to clause boundaries for a single huge sentence", () => {
    const text =
      "This one sentence keeps going; it adds another clause, and then a third clause: finally it stops.";
    const chunks = chunkForTts(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(40);
    expect(chunks[0]).toBe("This one sentence keeps going;");
    expect(stripWhitespace(chunks.join(""))).toBe(stripWhitespace(text));
  });

  test("hard splits a clause-free run without breaking a word", () => {
    const text = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike";
    const chunks = chunkForTts(text, 20);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(20);
    expectWordAlignedSlices(text, chunks);
    expect(stripWhitespace(chunks.join(""))).toBe(stripWhitespace(text));
  });

  test("cuts a single word longer than the limit rather than exceeding it", () => {
    const text = "x".repeat(25);
    expect(chunkForTts(text, 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });

  test("splits CJK sentences on their own punctuation", () => {
    const text = "这是第一句话。这是第二句话！这是第三句话？";
    expect(chunkForTts(text, 10)).toEqual(["这是第一句话。", "这是第二句话！", "这是第三句话？"]);
  });

  test("uses CJK clause punctuation when a CJK sentence is still too long", () => {
    const text = "甲乙丙丁戊己庚辛；壬癸子丑寅卯辰巳：午未申酉戌亥。";
    const chunks = chunkForTts(text, 12);
    expect(chunks).toEqual(["甲乙丙丁戊己庚辛；", "壬癸子丑寅卯辰巳：", "午未申酉戌亥。"]);
  });

  test("hard splits CJK text that has no punctuation at all", () => {
    const text = "甲乙丙丁戊己庚辛壬癸子丑";
    expect(chunkForTts(text, 5)).toEqual(["甲乙丙丁戊", "己庚辛壬癸", "子丑"]);
  });

  test("never emits an empty or whitespace-only chunk", () => {
    const text = "One.\n\n\n\n   \n\n Two.   \n\n\n\t\n Three.";
    const chunks = chunkForTts(text, 8);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(chunk.trim()).toBe(chunk.trim() && chunk);
    for (const chunk of chunks) expect(chunk.trim().length).toBeGreaterThan(0);
  });

  test("respects the limit across a long mixed script", () => {
    const paragraph =
      "Narration keeps going for a while; it has clauses, sentences, and pauses. " +
      "It also has a second sentence that runs on and on without saying much at all. " +
      "第三句是中文。\n\n";
    const text = paragraph.repeat(8);
    const chunks = chunkForTts(text, 120);
    expect(chunks.length).toBeGreaterThan(8);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120);
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
    expect(stripWhitespace(chunks.join(""))).toBe(stripWhitespace(text));
  });
});

describe("buildChunkCues", () => {
  test("converts engine cues into script-aligned subtitle cues", () => {
    const ttsCues: TtsCue[] = [
      { start: 0, end: 0.5, content: "Hello" },
      { start: 0.5, end: 1.0, content: " there" },
      { start: 1.0, end: 1.5, content: "Second" },
      { start: 1.5, end: 2.0, content: " line" },
    ];

    const cues = buildChunkCues(ttsCues, "Hello there. Second line.", 2);

    // TtsCue.content becomes SubtitleCue.text, and index is added.
    expect(cues).toEqual([
      { index: 1, start: 0, end: 1.0, text: "Hello there" },
      { index: 2, start: 1.0, end: 2.0, text: "Second line" },
    ]);
    expect(cues[0]).not.toHaveProperty("content");
  });

  test("falls back to proportional timing when the engine cues do not align", () => {
    const ttsCues: TtsCue[] = [{ start: 0, end: 4, content: "nothing like the script" }];

    const cues = buildChunkCues(ttsCues, "Hello there. Second line.", 4);

    expect(cues.map((cue) => cue.text)).toEqual(["Hello there", "Second line"]);
    expect(cues[0]!.start).toBe(0);
    expect(cues[1]!.end).toBeCloseTo(4, 6);
  });

  test("returns nothing for an empty chunk", () => {
    expect(buildChunkCues([], "   ", 1)).toEqual([]);
  });
});

describe("offsetChunkCues", () => {
  test("shifts later chunks and renumbers contiguously from 1", () => {
    const cues = offsetChunkCues([
      {
        duration: 10.5,
        cues: [
          { index: 1, start: 0, end: 4, text: "one" },
          { index: 2, start: 4, end: 10.5, text: "two" },
        ],
      },
      { duration: 6, cues: [{ index: 1, start: 0.25, end: 6, text: "three" }] },
    ]);

    expect(cues.map((cue) => cue.index)).toEqual([1, 2, 3]);
    expect(cues[2]!.start).toBeCloseTo(10.75, 9);
    expect(cues[2]!.end).toBeCloseTo(16.5, 9);
    expect(cues[2]!.text).toBe("three");
  });

  test("returns nothing for no chunks", () => {
    expect(offsetChunkCues([])).toEqual([]);
  });

  test("does not accumulate drift across fifty fractional chunks", () => {
    // Rounding each chunk (the single-clip pipeline does Math.ceil) would put
    // the last cue 32s late here, which is what this guards against.
    const duration = 7.331;
    const chunks = Array.from({ length: 50 }, () => ({
      duration,
      cues: [{ index: 1, start: 0.25, end: duration, text: "line" }],
    }));

    const cues = offsetChunkCues(chunks);
    const expected = 49 * duration + 0.25;

    expect(cues).toHaveLength(50);
    expect(cues[49]!.index).toBe(50);
    expect(Math.abs(cues[49]!.start - expected)).toBeLessThan(1e-9);
    expect(Math.abs(cues[49]!.start - (49 * 8 + 0.25))).toBeGreaterThan(30);
  });
});

describe("hashChunkInput", () => {
  const base = {
    text: "Narration for one chunk.",
    voiceName: "en-US-JennyNeural",
    voiceRate: 1.0,
    voiceVolume: 1.0,
    provider: "azure-tts-v1",
  };

  test("is stable when nothing changed", () => {
    expect(hashChunkInput(base)).toBe(hashChunkInput({ ...base }));
  });

  test("changes when the text changes", () => {
    expect(hashChunkInput({ ...base, text: "Narration for one chunk!" })).not.toBe(hashChunkInput(base));
  });

  test("changes when the voice changes", () => {
    expect(hashChunkInput({ ...base, voiceName: "en-US-GuyNeural" })).not.toBe(hashChunkInput(base));
  });

  test("changes when the rate, volume or provider changes", () => {
    expect(hashChunkInput({ ...base, voiceRate: 1.2 })).not.toBe(hashChunkInput(base));
    expect(hashChunkInput({ ...base, voiceVolume: 0.8 })).not.toBe(hashChunkInput(base));
    expect(hashChunkInput({ ...base, provider: "elevenlabs" })).not.toBe(hashChunkInput(base));
  });

  test("does not collide when field boundaries move", () => {
    expect(hashChunkInput({ ...base, voiceName: "a", text: `b ${base.text}` })).not.toBe(
      hashChunkInput({ ...base, voiceName: "a b", text: base.text }),
    );
  });
});

describe("parseChunkManifest", () => {
  const entry: ChunkManifestEntry = {
    index: 0,
    hash: "abc",
    file: "chunk-0000.mp3",
    duration: 12.25,
    codec: "mp3",
    sampleRate: 24000,
    channels: 1,
    cues: [{ index: 1, start: 0, end: 12.25, text: "line" }],
  };

  test("accepts a manifest it wrote itself", () => {
    const raw = JSON.parse(JSON.stringify({ version: 1, chunks: [entry] }));
    expect(parseChunkManifest(raw)).toEqual({ version: 1, chunks: [entry] });
  });

  test("rejects a manifest from another format version", () => {
    expect(parseChunkManifest({ version: 99, chunks: [entry] })).toBeNull();
  });

  test("rejects anything that is not a manifest", () => {
    expect(parseChunkManifest(null)).toBeNull();
    expect(parseChunkManifest("chunks")).toBeNull();
    expect(parseChunkManifest({ version: 1 })).toBeNull();
  });

  test("drops entries a half-written run left behind", () => {
    const manifest = parseChunkManifest({
      version: 1,
      chunks: [
        entry,
        { ...entry, index: 1, duration: 0 },
        { ...entry, index: 2, file: "../escape.mp3" },
        { ...entry, index: 3, cues: [{ index: 1, start: 0, end: 1 }] },
        { ...entry, index: 4, hash: "" },
      ],
    });
    expect(manifest?.chunks.map((chunk) => chunk.index)).toEqual([0]);
  });

  test("reuses an entry only at the same position with the same hash", () => {
    const manifest = { version: 1, chunks: [entry, { ...entry, index: 1, hash: "def" }] };
    expect(findReusableEntry(manifest, 0, "abc")).toEqual(entry);
    expect(findReusableEntry(manifest, 0, "changed")).toBeNull();
    expect(findReusableEntry(manifest, 1, "abc")).toBeNull();
    expect(findReusableEntry(null, 0, "abc")).toBeNull();
  });
});

describe("chunk audio formats", () => {
  const mono = { codec: "mp3", sampleRate: 24000, channels: 1 };

  test("matches only when codec, rate and channels all agree", () => {
    expect(formatsMatch([])).toBe(true);
    expect(formatsMatch([mono, { ...mono }])).toBe(true);
    expect(formatsMatch([mono, { ...mono, channels: 2 }])).toBe(false);
    expect(formatsMatch([mono, { ...mono, sampleRate: 44100 }])).toBe(false);
    expect(formatsMatch([mono, { ...mono, codec: "aac" }])).toBe(false);
  });

  test("normalises upwards so no chunk loses a channel or bandwidth", () => {
    expect(commonFormatTarget([mono, { codec: "aac", sampleRate: 44100, channels: 2 }])).toEqual({
      codec: "mp3",
      sampleRate: 44100,
      channels: 2,
    });
  });

  test("falls back to a usable target when a probe reported nothing", () => {
    expect(commonFormatTarget([{ codec: "", sampleRate: 0, channels: 0 }])).toEqual({
      codec: "mp3",
      sampleRate: 44100,
      channels: 1,
    });
  });
});

describe("cue types", () => {
  test("offset cues are ready for the SRT writer", () => {
    const cues: SubtitleCue[] = offsetChunkCues([
      { duration: 3, cues: [{ index: 1, start: 0, end: 3, text: "only" }] },
    ]);
    expect(cues[0]).toEqual({ index: 1, start: 0, end: 3, text: "only" });
  });
});
