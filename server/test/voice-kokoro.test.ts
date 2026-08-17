import { describe, expect, test } from "bun:test";

import { buildKokoroCues, parseKokoroVoiceName } from "../src/services/voice/kokoro.ts";
import { getKokoroVoices, inferTtsServerFromVoice, isKokoroVoice } from "../src/services/voice/voices.ts";
import { createSubtitleCues } from "../src/services/voice/subtitles.ts";
import { defaultSettings } from "../src/config/schema.ts";

describe("kokoro voice catalogue", () => {
  test("lists voices as kokoro:<id>-<Gender> with the flagship voice first", () => {
    const voices = getKokoroVoices();
    expect(voices.length).toBe(28);
    expect(voices[0]).toBe("kokoro:af_heart-Female");
    for (const voice of voices) {
      expect(voice).toMatch(/^kokoro:[ab][fm]_[a-z]+-(Female|Male)$/);
      expect(isKokoroVoice(voice)).toBe(true);
      expect(inferTtsServerFromVoice(voice)).toBe("kokoro");
    }
  });

  test("parseKokoroVoiceName strips the prefix and display gender", () => {
    expect(parseKokoroVoiceName("kokoro:af_heart-Female")).toBe("af_heart");
    expect(parseKokoroVoiceName("kokoro:bm_george-Male")).toBe("bm_george");
    expect(parseKokoroVoiceName("kokoro:af_sky")).toBe("af_sky");
    expect(parseKokoroVoiceName("en-US-AriaNeural-Female")).toBe("");
    expect(parseKokoroVoiceName("")).toBe("");
  });

  test("kokoro settings default to the q8 model", () => {
    expect(defaultSettings().kokoro.dtype).toBe("q8");
  });
});

describe("buildKokoroCues", () => {
  test("offsets each chunk by the measured duration of the chunks before it", () => {
    const cues = buildKokoroCues([
      { text: "First sentence.", durationSeconds: 2 },
      { text: "Second sentence.", durationSeconds: 3 },
    ]);
    expect(cues.length).toBe(2);
    expect(cues[0]).toEqual({ start: 0, end: 2, content: "First sentence" });
    expect(cues[1]).toEqual({ start: 2, end: 5, content: "Second sentence" });
  });

  test("splits a multi-clause sentence proportionally inside its chunk", () => {
    const cues = buildKokoroCues([{ text: "Aa, bbbbbbaa.", durationSeconds: 6 }]);
    expect(cues.length).toBe(2);
    expect(cues[0]!.start).toBe(0);
    // "Aa" is 2 of 10 letters, so it gets 20% of the sentence's real time.
    expect(cues[0]!.end).toBeCloseTo(1.2, 5);
    expect(cues[1]!.end).toBe(6);
  });

  test("produces cues the subtitle aggregator can match to the script", () => {
    const script = "Money is a tool, nothing more. Use it well.";
    const cues = buildKokoroCues([
      // Kokoro's splitter keeps sentence punctuation with the sentence.
      { text: "Money is a tool, nothing more.", durationSeconds: 3.4 },
      { text: "Use it well.", durationSeconds: 1.1 },
    ]);
    const subtitles = createSubtitleCues(cues, script);
    expect(subtitles.length).toBe(3);
    expect(subtitles.map((cue) => cue.text)).toEqual(["Money is a tool", "nothing more", "Use it well"]);
    expect(subtitles[0]!.start).toBe(0);
    expect(subtitles[2]!.start).toBeCloseTo(3.4, 5);
    expect(subtitles[2]!.end).toBeCloseTo(4.5, 5);
  });

  test("returns no cues for no chunks", () => {
    expect(buildKokoroCues([])).toEqual([]);
  });
});
