/**
 * Service-layer logic that needs no network or database.
 * Cases ported from python-version/test/services/.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_VOICE_NAME, defaultSettings, settingsSchema } from "../src/config/schema.ts";
import { __setSettingsForTest, resolveContentLanguage, resolveVoiceName } from "../src/config/settings.ts";
import { decodeLinuxRouteGateway } from "../src/config/runtime.ts";
import { resolvePathWithinDirectory, sanitizeOutputName, sanitizeUploadFilename, UnsafePathError } from "../src/utils/fileSecurity.ts";
import { parseByteRange } from "../src/http/staticFiles.ts";
import { sanitizeBgmFilename, shouldUseBgm, BgmUploadError } from "../src/services/bgm.ts";
import { parseSrtContent, formatSrt } from "../src/services/subtitle/srt.ts";
import { correctSubtitleCues } from "../src/services/subtitle/correct.ts";
import { createSubtitleCues, matchScriptLine, formatTextForSubtitles } from "../src/services/voice/subtitles.ts";
import { buildProportionalCues } from "../src/services/voice/syntheticCues.ts";
import { convertRateToPercent, generateSecMsGec } from "../src/services/voice/edgeTts.ts";
import { estimateNoVoiceDuration } from "../src/services/voice/index.ts";
import {
  isNoVoice,
  isAzureV2Voice,
  parseVoiceName,
  inferTtsServerFromVoice,
  listVoicesForServer,
} from "../src/services/voice/voices.ts";
import { detectAudioMime } from "../src/services/voice/preview.ts";
import { voicePreviewRequestSchema } from "../src/models/schema.ts";
import { matchesVideoAspect, filterMaterialsByAspect } from "../src/services/material/search.ts";
import { materialSourceRecord } from "../src/services/material/download.ts";
import { safePublicUrl } from "../src/services/material/http.ts";
import { normalizeHashtags, fallbackSocialMetadata, buildScriptPrompt, languageLabel } from "../src/services/llm/prompts.ts";
import { extractJson, formatScriptResponse, stripCodeFence } from "../src/services/llm/index.ts";
import { bookProjectFolderName, bookSegmentFileStem, bookSegmentFolderName, rewriteFileStem, rewritePathPrefix, rewriteSegmentFilePath } from "../src/utils/paths.ts";
import { isOwnerAlive, parseOwner, PROCESS_OWNER_ID } from "../src/tasks/owner.ts";

beforeAll(() => {
  __setSettingsForTest(defaultSettings());
});

// ---------------------------------------------------------------------------

describe("settings schema", () => {
  test("produces a complete object from an empty document", () => {
    const settings = defaultSettings();
    expect(settings.app.llm_provider).toBe("gemini");
    expect(settings.app.video_source).toBe("pexels");
    expect(settings.app.max_concurrent_tasks).toBe(5);
    expect(settings.whisper.provider).toBe("whisper-cpp");
    expect(settings.ui.font_name).toBe("MicrosoftYaHeiBold.ttc");
    expect(settings.ui.language).toBe("");
    expect(settings.ui.tts_server).toBe("azure-tts-v1");
    expect(settings.ui.voice_name).toBe("");
  });

  test("backfills fields missing from a stored document", () => {
    // An upgrade must not need a migration step.
    const parsed = settingsSchema.parse({ app: { llm_provider: "openai" } });
    expect(parsed.app.llm_provider).toBe("openai");
    expect(parsed.app.max_queued_tasks).toBe(100);
    expect(parsed.elevenlabs.model_id).toBe("eleven_multilingual_v2");
  });

  test("normalises a single API key into a list", () => {
    const parsed = settingsSchema.parse({ app: { pexels_api_keys: "solo-key" } });
    expect(parsed.app.pexels_api_keys).toEqual(["solo-key"]);
  });

  test("rejects an unsupported enum value", () => {
    expect(() => settingsSchema.parse({ app: { video_source: "youtube" } })).toThrow();
  });
});

describe("decodeLinuxRouteGateway", () => {
  test("decodes the little-endian hex gateway", () => {
    expect(decodeLinuxRouteGateway("010011AC")).toBe("172.17.0.1");
  });

  test("rejects a malformed field", () => {
    expect(() => decodeLinuxRouteGateway("0100")).toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("resolvePathWithinDirectory", () => {
  let base: string;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "vidgen-sec-"));
    writeFileSync(join(base, "clip.mp4"), "data");
    mkdirSync(join(base, "nested"));
    writeFileSync(join(base, "nested", "inner.mp4"), "data");
  });

  test("accepts a bare filename", () => {
    expect(resolvePathWithinDirectory(base, "clip.mp4")).toContain("clip.mp4");
  });

  test("accepts a nested relative path", () => {
    expect(resolvePathWithinDirectory(base, "nested/inner.mp4")).toContain("inner.mp4");
  });

  test("rejects traversal", () => {
    expect(() => resolvePathWithinDirectory(base, "../../etc/passwd")).toThrow(UnsafePathError);
  });

  test("rejects an absolute path outside the base", () => {
    expect(() => resolvePathWithinDirectory(base, "/etc/passwd")).toThrow(UnsafePathError);
  });

  test("rejects a symlink that escapes the base", () => {
    // A symlink is why containment is checked on the resolved real path.
    const outside = mkdtempSync(join(tmpdir(), "vidgen-out-"));
    writeFileSync(join(outside, "secret.mp4"), "data");
    symlinkSync(join(outside, "secret.mp4"), join(base, "escape.mp4"));
    expect(() => resolvePathWithinDirectory(base, "escape.mp4")).toThrow(UnsafePathError);
  });

  test("reports a missing file distinctly", () => {
    expect(() => resolvePathWithinDirectory(base, "nope.mp4")).toThrow("file does not exist");
  });

  test("rejects an empty path", () => {
    expect(() => resolvePathWithinDirectory(base, "")).toThrow(UnsafePathError);
  });
});

describe("sanitizeUploadFilename", () => {
  test("keeps only the final segment", () => {
    expect(sanitizeUploadFilename("a/b/c.mp4")).toBe("c.mp4");
    expect(sanitizeUploadFilename("..\\..\\evil.mp4")).toBe("evil.mp4");
  });

  test("rejects empty and dot names", () => {
    expect(() => sanitizeUploadFilename("")).toThrow(UnsafePathError);
    expect(() => sanitizeUploadFilename("..")).toThrow(UnsafePathError);
  });
});

describe("sanitizeOutputName", () => {
  test("keeps a readable chapter title", () => {
    expect(sanitizeOutputName("I. The Period")).toBe("I. The Period");
    expect(sanitizeOutputName("A Tale of Two Cities")).toBe("A Tale of Two Cities");
  });

  test("strips path separators and reserved characters", () => {
    expect(sanitizeOutputName("Book/The First: Recalled?")).toBe("Book The First Recalled");
    expect(sanitizeOutputName("../escape")).toBe("escape");
  });

  test("falls back when the title is empty or only dots", () => {
    expect(sanitizeOutputName("   ", "book")).toBe("book");
    expect(sanitizeOutputName("...", "untitled")).toBe("untitled");
  });

  test("does not emit a Windows device name", () => {
    expect(sanitizeOutputName("CON")).toBe("untitled CON");
  });
});

describe("book output folders", () => {
  test("names the project after the book title", () => {
    expect(bookProjectFolderName("A Tale of Two Cities", "abc123def")).toBe("A Tale of Two Cities");
  });

  test("falls back to the book id when the title is empty", () => {
    expect(bookProjectFolderName("   ", "abc123def")).toBe("abc123de");
  });

  test("names each video folder with a padded index and the segment title", () => {
    expect(bookSegmentFolderName(0, "I. The Period")).toBe("001 I. The Period");
    expect(bookSegmentFolderName(11, "Book the Second")).toBe("012 Book the Second");
  });

  test("uses the chapter title as the file stem inside that folder", () => {
    expect(bookSegmentFileStem("I. The Period", 0)).toBe("I. The Period");
  });

  test("rewrites stored paths when the book folder moves", () => {
    const fromDir = "/storage/tasks/Me Before You - PDFDrive.com";
    const toDir = "/storage/tasks/Me Before You";
    expect(rewritePathPrefix(`${fromDir}/001 Chapter I/Chapter I.mp4`, fromDir, toDir)).toBe(
      `${toDir}/001 Chapter I/Chapter I.mp4`,
    );
    expect(rewritePathPrefix(fromDir, fromDir, toDir)).toBe(toDir);
    expect(rewritePathPrefix("/storage/tasks/other/file.mp4", fromDir, toDir)).toBe(
      "/storage/tasks/other/file.mp4",
    );
    expect(rewritePathPrefix(null, fromDir, toDir)).toBeNull();
  });

  test("rewrites the file stem when a segment is renamed", () => {
    const dir = "/storage/tasks/Me Before You/001 Chapter I";
    expect(rewriteFileStem(`${dir}/Chapter I.mp4`, "Chapter I", "The Airport")).toBe(
      `${dir}/The Airport.mp4`,
    );
    expect(rewriteFileStem(`${dir}/subtitle.ass`, "Chapter I", "The Airport")).toBe(
      `${dir}/subtitle.ass`,
    );
  });

  test("rewrites a stored segment path after both the folder and the stem move", () => {
    const fromDir = "/storage/tasks/Me Before You/001 Chapter I";
    const toDir = "/storage/tasks/Me Before You/001 The Airport";
    expect(
      rewriteSegmentFilePath(`${fromDir}/Chapter I.mp4`, fromDir, toDir, "Chapter I", "The Airport"),
    ).toBe(`${toDir}/The Airport.mp4`);
    expect(rewriteSegmentFilePath(null, fromDir, toDir, "Chapter I", "The Airport")).toBeNull();
  });
});

describe("parseByteRange", () => {
  test("returns the whole file without a Range header", () => {
    expect(parseByteRange(null, 1000)).toEqual({ start: 0, end: 999 });
  });

  test("parses an explicit range", () => {
    expect(parseByteRange("bytes=0-499", 1000)).toEqual({ start: 0, end: 499 });
    expect(parseByteRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
  });

  test("parses a suffix range", () => {
    expect(parseByteRange("bytes=-200", 1000)).toEqual({ start: 800, end: 999 });
  });

  test("clamps an over-long end", () => {
    expect(parseByteRange("bytes=0-5000", 1000)).toEqual({ start: 0, end: 999 });
  });

  test("rejects malformed, multi-part and out-of-bounds ranges", () => {
    // Serving one part with a mismatched Content-Range is worse than a 416.
    expect(parseByteRange("bytes=0-100,200-300", 1000)).toBe("unsatisfiable");
    expect(parseByteRange("items=0-100", 1000)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=2000-3000", 1000)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=-", 1000)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=0-499", 0)).toBe("unsatisfiable");
  });
});

// ---------------------------------------------------------------------------

describe("shouldUseBgm", () => {
  test("requires both a source and a positive volume", () => {
    expect(shouldUseBgm("random", 0.2)).toBe(true);
    expect(shouldUseBgm("random", 0)).toBe(false);
    expect(shouldUseBgm("", 0.5)).toBe(false);
    expect(shouldUseBgm(null, 0.5)).toBe(false);
    expect(shouldUseBgm("sonilo", -1)).toBe(false);
    expect(shouldUseBgm("sonilo", Number.NaN)).toBe(false);
  });
});

describe("sanitizeBgmFilename", () => {
  test("accepts supported audio formats", () => {
    expect(sanitizeBgmFilename("track.mp3")).toBe("track.mp3");
    expect(sanitizeBgmFilename("a/b/track.FLAC")).toBe("track.FLAC");
  });

  test("rejects unsupported formats", () => {
    expect(() => sanitizeBgmFilename("movie.mp4")).toThrow(BgmUploadError);
  });

  test("rejects Windows reserved device names", () => {
    // CON.mp3 cannot exist as an ordinary file on Windows.
    expect(() => sanitizeBgmFilename("CON.mp3")).toThrow(BgmUploadError);
    expect(() => sanitizeBgmFilename("lpt1.wav")).toThrow(BgmUploadError);
  });

  test("rejects internal staging names", () => {
    expect(() => sanitizeBgmFilename(".bgm-upload-abc.mp3")).toThrow(BgmUploadError);
  });
});

// ---------------------------------------------------------------------------

describe("SRT round-trip", () => {
  const srt = `1
00:00:00,100 --> 00:00:02,000
First line

2
00:00:02,100 --> 00:00:04,000
Second line
`;

  test("parses cues", () => {
    const cues = parseSrtContent(srt);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ start: 0.1, end: 2, text: "First line" });
  });

  test("keeps a final cue with no trailing blank line", () => {
    const cues = parseSrtContent("1\n00:00:00,000 --> 00:00:01,000\nOnly");
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("Only");
  });

  test("formats back to equivalent text", () => {
    expect(parseSrtContent(formatSrt(parseSrtContent(srt)))).toEqual(parseSrtContent(srt));
  });
});

describe("matchScriptLine", () => {
  const lines = ["Hello world", "春天的花海"];

  test("matches exactly", () => {
    expect(matchScriptLine(lines, "Hello world", 0)).toBe("Hello world");
  });

  test("matches after stripping punctuation", () => {
    expect(matchScriptLine(lines, "Hello, world!", 0)).toBe("Hello world");
  });

  test("matches CJK, which ASCII \\W would have destroyed", () => {
    // JavaScript's \W is ASCII-only; using it stripped every CJK character and
    // made the first cue match the whole line.
    expect(matchScriptLine(lines, "春天的花海", 1)).toBe("春天的花海");
    expect(matchScriptLine(lines, "春天", 1)).toBe("");
  });

  test("returns empty past the end of the script", () => {
    expect(matchScriptLine(lines, "anything", 5)).toBe("");
  });
});

describe("createSubtitleCues", () => {
  test("aggregates word cues into script lines", () => {
    const cues = createSubtitleCues(
      [
        { start: 0.0, end: 0.5, content: "Hello" },
        { start: 0.5, end: 1.0, content: " world" },
        { start: 1.2, end: 1.6, content: "Good" },
        { start: 1.6, end: 2.0, content: " bye" },
      ],
      "Hello world. Good bye.",
    );

    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ start: 0, end: 1, text: "Hello world" });
    expect(cues[1]).toMatchObject({ start: 1.2, end: 2, text: "Good bye" });
  });

  test("returns nothing when coverage is incomplete", () => {
    // A partial track would drift out of sync, so no subtitles is safer.
    expect(createSubtitleCues([{ start: 0, end: 1, content: "Hello world" }], "Hello world. Missing line.")).toEqual([]);
  });
});

describe("formatTextForSubtitles", () => {
  test("removes brackets the narrator never speaks", () => {
    expect(formatTextForSubtitles("Hello [pause] (aside) {note}")).toBe("Hello  pause   aside   note");
  });
});

describe("buildProportionalCues", () => {
  test("spreads duration across sentences by length", () => {
    const cues = buildProportionalCues("Short. A much longer sentence here.", 10);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.start).toBe(0);
    // The final cue always absorbs the remainder so timing never falls short.
    expect(cues[cues.length - 1]!.end).toBe(10);
    expect(cues[1]!.end - cues[1]!.start).toBeGreaterThan(cues[0]!.end - cues[0]!.start);
  });

  test("returns nothing for empty text", () => {
    expect(buildProportionalCues("", 10)).toEqual([]);
  });
});

describe("correctSubtitleCues", () => {
  test("leaves a matching transcription untouched", () => {
    const cues = [
      { index: 1, start: 0, end: 1, text: "Hello world" },
      { index: 2, start: 1, end: 2, text: "Good bye" },
    ];
    const result = correctSubtitleCues(cues, "Hello world. Good bye.");
    expect(result.corrected).toBe(false);
    expect(result.cues.map((cue) => cue.text)).toEqual(["Hello world", "Good bye"]);
  });

  test("merges split cues and restores the script wording", () => {
    const cues = [
      { index: 1, start: 0, end: 0.6, text: "Hello" },
      { index: 2, start: 0.6, end: 1.2, text: "wrld" },
      { index: 3, start: 1.3, end: 2, text: "Good bye" },
    ];
    const result = correctSubtitleCues(cues, "Hello world. Good bye.");
    expect(result.corrected).toBe(true);
    expect(result.cues[0]).toMatchObject({ start: 0, end: 1.2, text: "Hello world" });
  });
});

// ---------------------------------------------------------------------------

describe("voice helpers", () => {
  test("strips the display gender suffix", () => {
    expect(parseVoiceName("zh-CN-XiaoyiNeural-Female")).toBe("zh-CN-XiaoyiNeural");
    expect(parseVoiceName("zh-CN-XiaoxiaoMultilingualNeural-V2-Female")).toBe(
      "zh-CN-XiaoxiaoMultilingualNeural-V2",
    );
  });

  test("detects Azure V2 voices", () => {
    expect(isAzureV2Voice("zh-CN-XiaoxiaoMultilingualNeural-V2-Female")).toBe(
      "zh-CN-XiaoxiaoMultilingualNeural",
    );
    expect(isAzureV2Voice("zh-CN-XiaoyiNeural-Female")).toBe("");
  });

  test("treats only the explicit sentinel as no-voice", () => {
    // An empty voice is far more likely to be a broken config than intent.
    expect(isNoVoice("no-voice")).toBe(true);
    expect(isNoVoice("none")).toBe(true);
    expect(isNoVoice("")).toBe(false);
    expect(isNoVoice(null)).toBe(false);
  });

  test("infers the TTS server from the voice", () => {
    expect(inferTtsServerFromVoice("elevenlabs:abc:Rachel")).toBe("elevenlabs");
    expect(inferTtsServerFromVoice("gemini:Zephyr-Female")).toBe("gemini");
    expect(inferTtsServerFromVoice("en-US-AriaNeural-Female")).toBe("azure-tts-v1");
  });

  test("azure catalogue is limited to Bangla and English", async () => {
    const v1 = await listVoicesForServer("azure-tts-v1");
    expect(v1.length).toBeGreaterThan(0);
    expect(v1.every((voice) => voice.startsWith("bn-") || voice.startsWith("en-"))).toBe(true);
    expect(v1.some((voice) => voice.startsWith("bn-"))).toBe(true);
    expect(v1.some((voice) => voice.startsWith("en-"))).toBe(true);

    const v2 = await listVoicesForServer("azure-tts-v2");
    expect(v2.length).toBeGreaterThan(0);
    expect(v2.every((voice) => voice.startsWith("bn-") || voice.startsWith("en-"))).toBe(true);
  });

  test("formats the speech rate as a signed percentage", () => {
    // "0%" without a sign is rejected by the service.
    expect(convertRateToPercent(1.0)).toBe("+0%");
    expect(convertRateToPercent(1.004)).toBe("+0%");
    expect(convertRateToPercent(1.2)).toBe("+20%");
    expect(convertRateToPercent(0.8)).toBe("-20%");
    expect(convertRateToPercent(0)).toBe("+0%");
    expect(convertRateToPercent(null)).toBe("+0%");
  });

  test("generates a stable anti-abuse token", () => {
    const token = generateSecMsGec(1786000000);
    expect(token).toMatch(/^[0-9A-F]{64}$/);
    // Rounded to a 5-minute window, so nearby times agree.
    expect(generateSecMsGec(1786000100)).toBe(token);
  });

  test("estimates a usable no-voice duration", () => {
    expect(estimateNoVoiceDuration("")).toBe(3.0);
    expect(estimateNoVoiceDuration("hi")).toBe(3.0);
    const long = estimateNoVoiceDuration("Artificial intelligence is reshaping how ordinary people work today.");
    expect(long).toBeGreaterThan(3.0);
    expect(estimateNoVoiceDuration("春天的花海如诗如画般展现在眼前万物复苏")).toBeGreaterThan(3.0);
  });
});

describe("voice preview", () => {
  test("sniffs WAV even when the filename says mp3", () => {
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(detectAudioMime("preview.mp3", wav)).toBe("audio/wav");
  });

  test("sniffs mp3 from a frame sync or ID3 tag", () => {
    expect(detectAudioMime("preview.mp3", new Uint8Array([0x49, 0x44, 0x33, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(
      "audio/mpeg",
    );
    expect(detectAudioMime("preview.bin", new Uint8Array([0xff, 0xfb, 0, 0]))).toBe("audio/mpeg");
  });

  test("falls back to the file extension", () => {
    expect(detectAudioMime("preview.ogg", new Uint8Array([0, 1, 2, 3]))).toBe("audio/ogg");
    expect(detectAudioMime("preview.mp3", new Uint8Array([0, 1, 2, 3]))).toBe("audio/mpeg");
  });

  test("rejects an empty voice name and overlong text", () => {
    expect(() => voicePreviewRequestSchema.parse({ voice_name: "", text: "hello" })).toThrow();
    expect(() => voicePreviewRequestSchema.parse({ voice_name: "en-US-AriaNeural-Female", text: "x".repeat(8001) })).toThrow();
    expect(voicePreviewRequestSchema.parse({ voice_name: "en-US-AriaNeural-Female", text: "hello" })).toMatchObject({
      voice_name: "en-US-AriaNeural-Female",
      voice_rate: 1,
      voice_volume: 1,
      text: "hello",
    });
  });
});

// ---------------------------------------------------------------------------

describe("matchesVideoAspect", () => {
  test("uses dimensions when available", () => {
    expect(matchesVideoAspect(1080, 1920, "9:16")).toBe(true);
    expect(matchesVideoAspect(1920, 1080, "9:16")).toBe(false);
    expect(matchesVideoAspect(1920, 1080, "16:9")).toBe(true);
    expect(matchesVideoAspect(1080, 1080, "1:1")).toBe(true);
  });

  test("falls back to an explicit vertical flag", () => {
    expect(matchesVideoAspect(null, null, "9:16", true)).toBe(true);
    expect(matchesVideoAspect(null, null, "9:16", false)).toBe(false);
  });

  test("skips assets whose orientation cannot be established", () => {
    expect(matchesVideoAspect(null, null, "9:16")).toBe(false);
    expect(matchesVideoAspect("abc", "def", "16:9")).toBe(false);
  });
});

describe("filterMaterialsByAspect", () => {
  const items = [
    { provider: "pexels", url: "a", duration: 5, source_info: { rendition: { width: 1080, height: 1920 } } },
    { provider: "pexels", url: "b", duration: 5, source_info: { rendition: { width: 1920, height: 1080 } } },
    { provider: "pexels", url: "c", duration: 5, source_info: null },
  ];

  test("keeps only matching orientations", () => {
    expect(filterMaterialsByAspect(items, "9:16").map((item) => item.url)).toEqual(["a"]);
  });

  test("passes everything through for square output", () => {
    // Providers rarely have native 1:1 footage; cropping happens at render time.
    expect(filterMaterialsByAspect(items, "1:1")).toHaveLength(3);
  });
});

describe("safePublicUrl", () => {
  test("strips query strings that may hold credentials", () => {
    expect(safePublicUrl("https://example.com/v/1?token=secret")).toBe("https://example.com/v/1");
  });

  test("rejects credentials embedded in the URL", () => {
    expect(safePublicUrl("https://user:pass@example.com/v")).toBeNull();
  });

  test("rejects non-http schemes and junk", () => {
    expect(safePublicUrl("file:///etc/passwd")).toBeNull();
    expect(safePublicUrl("not a url")).toBeNull();
    expect(safePublicUrl(null)).toBeNull();
  });
});

describe("materialSourceRecord", () => {
  test("keeps only allow-listed public fields", () => {
    const record = materialSourceRecord(
      {
        provider: "pexels",
        url: "https://cdn.example.com/signed?sig=abc",
        duration: 12.7,
        source_info: {
          provider: "pexels",
          search_term: " nature ",
          asset_id: 42 as unknown as string,
          source_page: "https://www.pexels.com/video/42?utm=x",
          creator: { id: "7", name: "Ada" },
          rendition: { id: "hd", width: 1080, height: 1920 },
        },
      },
      "/host/private/path/vid-abc.mp4",
    );

    // The signed download URL and the host path must never be persisted.
    expect(record.local_file).toBe("vid-abc.mp4");
    expect(JSON.stringify(record)).not.toContain("/host/private");
    expect(JSON.stringify(record)).not.toContain("sig=abc");
    expect(record.source_page).toBe("https://www.pexels.com/video/42");
    expect(record.search_term).toBe("nature");
    expect(record.duration).toBe(12);
  });
});

// ---------------------------------------------------------------------------

describe("llm helpers", () => {
  test("strips a markdown code fence", () => {
    expect(stripCodeFence('```json\n["a","b"]\n```')).toBe('["a","b"]');
    expect(stripCodeFence('["a"]')).toBe('["a"]');
  });

  test("recovers JSON wrapped in prose", () => {
    expect(extractJson<string[]>('Here you go: ["a","b"] hope that helps', "[")).toEqual(["a", "b"]);
    expect(extractJson<{ a: number }>('{"a":1}', "{")).toEqual({ a: 1 });
    expect(extractJson("no json here", "[")).toBeNull();
  });

  test("cleans markup the TTS engine would read aloud", () => {
    expect(formatScriptResponse("**Bold** and #heading and [stage] and (aside)")).toBe(
      "Bold and heading and  and",
    );
  });

  test("preserves paragraph breaks", () => {
    // The Python version stripped newlines, which silently defeated
    // paragraph_number by collapsing every script into one paragraph.
    expect(formatScriptResponse("First para.\n\nSecond para.")).toBe("First para.\n\nSecond para.");
  });

  test("normalises hashtags", () => {
    expect(normalizeHashtags(["du lich", "#Travel", "travel", ""], 5)).toEqual(["#dulich", "#Travel"]);
    expect(normalizeHashtags("one two", 1)).toEqual(["#one"]);
    expect(normalizeHashtags(null, 3)).toEqual([]);
  });

  test("produces usable fallback metadata", () => {
    const metadata = fallbackSocialMetadata("A day in Shanghai", "Some script.", "tiktok");
    expect(metadata.title).toBe("A day in Shanghai");
    expect(metadata.hashtags).toHaveLength(5);
  });

  test("always includes the run context in the prompt", () => {
    // Overriding the system prompt must not drop the subject or paragraph count.
    const prompt = buildScriptPrompt({
      videoSubject: "Bees",
      paragraphNumber: 3,
      customSystemPrompt: "CUSTOM RULES",
    });
    expect(prompt).toContain("CUSTOM RULES");
    expect(prompt).toContain("video subject: Bees");
    expect(prompt).toContain("number of paragraphs: 3");
  });

  test("clamps an out-of-range paragraph count", () => {
    expect(buildScriptPrompt({ videoSubject: "x", paragraphNumber: 99 })).toContain("number of paragraphs: 10");
    expect(buildScriptPrompt({ videoSubject: "x", paragraphNumber: 0 })).toContain("number of paragraphs: 1");
  });

  test("forces the requested script language", () => {
    const prompt = buildScriptPrompt({ videoSubject: "Bees", language: "bn" });
    expect(prompt).toContain("write the entire script in Bengali");
    expect(prompt).toContain("language: Bengali");
    expect(prompt).not.toContain("respond in the same language as the video subject");
  });
});

describe("resolveContentLanguage", () => {
  afterEach(() => {
    __setSettingsForTest(defaultSettings());
  });

  test("prefers an explicit request over the stored preference", () => {
    __setSettingsForTest(settingsSchema.parse({ ui: { language: "en" } }));
    expect(resolveContentLanguage("bn")).toBe("bn");
  });

  test("falls back to the stored preference", () => {
    __setSettingsForTest(settingsSchema.parse({ ui: { language: "bn" } }));
    expect(resolveContentLanguage("")).toBe("bn");
    expect(resolveContentLanguage("auto")).toBe("bn");
    expect(resolveContentLanguage(undefined)).toBe("bn");
  });

  test("returns empty when neither is set", () => {
    __setSettingsForTest(defaultSettings());
    expect(resolveContentLanguage("")).toBe("");
  });

  test("names known language codes for prompts", () => {
    expect(languageLabel("bn")).toBe("Bengali");
    expect(languageLabel("en")).toBe("English");
    expect(languageLabel("unknown")).toBe("unknown");
  });
});

describe("resolveVoiceName", () => {
  afterEach(() => {
    __setSettingsForTest(defaultSettings());
  });

  test("prefers an explicit request over the stored preference", () => {
    __setSettingsForTest(settingsSchema.parse({ ui: { voice_name: "en-US-JennyNeural-Female" } }));
    expect(resolveVoiceName("kokoro:af_heart-Female")).toBe("kokoro:af_heart-Female");
  });

  test("keeps the explicit no-voice sentinel", () => {
    __setSettingsForTest(settingsSchema.parse({ ui: { voice_name: "en-US-JennyNeural-Female" } }));
    expect(resolveVoiceName("no-voice")).toBe("no-voice");
  });

  test("falls back to the stored preference", () => {
    __setSettingsForTest(settingsSchema.parse({ ui: { voice_name: "en-US-JennyNeural-Female" } }));
    expect(resolveVoiceName("")).toBe("en-US-JennyNeural-Female");
    expect(resolveVoiceName(undefined)).toBe("en-US-JennyNeural-Female");
  });

  test("falls back to the bundled default when nothing is stored", () => {
    __setSettingsForTest(defaultSettings());
    expect(resolveVoiceName("")).toBe(DEFAULT_VOICE_NAME);
  });
});

// ---------------------------------------------------------------------------

describe("task ownership", () => {
  test("parses the owner stamp", () => {
    expect(parseOwner("host:1234:abcd")).toEqual({ hostname: "host", pid: 1234 });
    expect(parseOwner("garbage")).toBeNull();
    expect(parseOwner(null)).toBeNull();
  });

  test("treats another host as alive", () => {
    // Deleting files a live node is still reading is the worse failure.
    expect(isOwnerAlive("some-other-host:999999:abcd")).toBe(true);
  });

  test("treats this process's own stamp as dead", () => {
    // Live work is tracked in memory, so a record reaching this check is stale.
    expect(isOwnerAlive(PROCESS_OWNER_ID)).toBe(false);
  });

  test("treats an unknown owner as dead", () => {
    expect(isOwnerAlive(null)).toBe(false);
    expect(isOwnerAlive("")).toBe(false);
  });
});
