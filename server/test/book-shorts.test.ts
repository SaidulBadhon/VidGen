/**
 * Hook-short packing, script clamping, and request schemas.
 *
 * The LLM is not called here: a 400-page book is split into passages first, and
 * a malformed model payload must not invent block ids or a two-minute script.
 */

import { describe, expect, test } from "bun:test";

import {
  bookShortPatchSchema,
  bookShortsPlanRequestSchema,
  bookShortsRenderRequestSchema,
  shortsPlanToOptions,
  shortsRenderParamsToDocument,
} from "../src/models/bookSchema.ts";
import { DEFAULT_SEGMENT_OPTIONS } from "../src/services/book/types.ts";
import {
  capPlannedShorts,
  clampShortScript,
  DEFAULT_MAX_SHORTS,
  DEFAULT_SHORT_DURATION_SECONDS,
  DEFAULT_SHORT_OPTIONS,
  dedupePlannedShorts,
  finalizeProposedShorts,
  numberPlannedShorts,
  packShortChunks,
  parseBookShortRequestId,
  passageLinesForPrompt,
  selectShortChunks,
  targetScriptWords,
  bookIsReadyForShorts,
  type PlannedShort,
  type ShortChunk,
} from "../src/services/book/shorts.ts";
import { buildBookShortPublishPrompt, buildBookSegmentPublishPrompt, buildBookShortsPrompt, fallbackBookSegmentPublish } from "../src/services/llm/prompts.ts";
import { clipSegmentExcerpt, youtubeListingIsStub } from "../src/services/book/publish.ts";
import type { Block, BlockKind, BookStructure, Chapter } from "../src/services/book/types.ts";

interface BlockSpec {
  text: string;
  kind?: BlockKind;
}

interface ChapterSpec {
  title?: string;
  blocks: BlockSpec[];
}

function buildBook(specs: ChapterSpec[]): BookStructure {
  const chapters: Chapter[] = [];
  const blocks: Block[] = [];
  let order = 0;

  specs.forEach((spec, chapterIndex) => {
    const chapterId = `ch-${chapterIndex}`;
    const blockIds = spec.blocks.map((blockSpec, blockIndex) => {
      const id = `${chapterIndex}:${blockIndex}`;
      blocks.push({
        id,
        kind: blockSpec.kind ?? "paragraph",
        text: blockSpec.text,
        chapterId,
        order: order++,
      });
      return id;
    });

    chapters.push({
      id: chapterId,
      title: spec.title ?? `Chapter ${chapterIndex + 1}`,
      level: 1,
      order: chapterIndex,
      blockIds,
    });
  });

  return { title: "Me Before You", author: "Jojo Moyes", language: "en", chapters, blocks };
}

function words(count: number): string {
  return Array.from({ length: count }, () => "alpha").join(" ");
}

function planned(overrides: Partial<PlannedShort> = {}): PlannedShort {
  return {
    index: 0,
    title: "A list she should not have seen",
    hook: "She said yes. Then she saw the list.",
    script: "She said yes. Then she saw the list. The rest of the story is worse.",
    chapterTitle: "Chapter 1",
    startBlockId: "0:0",
    blockIds: ["0:0"],
    estimatedDuration: 12,
    ...overrides,
  };
}

function chunkFrom(structure: BookStructure, chapterIndex = 0): ShortChunk {
  const chapter = structure.chapters[chapterIndex]!;
  const blocks = structure.blocks.filter((block) => block.chapterId === chapter.id);
  const packed = packShortChunks(structure, blocks, { targetWords: 10_000, maxWords: 20_000 });
  return packed[0]!;
}

describe("packShortChunks", () => {
  test("keeps a short chapter whole", () => {
    const book = buildBook([
      { title: "One", blocks: [{ text: words(40) }, { text: words(50) }] },
      { title: "Two", blocks: [{ text: words(30) }] },
    ]);
    const chunks = packShortChunks(book, book.blocks, { targetWords: 200, maxWords: 400 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.chapterTitle).toBe("One");
    expect(chunks[1]?.chapterTitle).toBe("Two");
    expect(chunks[0]?.startBlockId).toBe("0:0");
    expect(chunks[0]?.endBlockId).toBe("0:1");
  });

  test("splits a chapter that exceeds the max word budget on a block boundary", () => {
    const book = buildBook([
      {
        title: "Long",
        blocks: [{ text: words(80) }, { text: words(80) }, { text: words(80) }],
      },
    ]);
    const chunks = packShortChunks(book, book.blocks, { targetWords: 80, maxWords: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((entry) => entry.blocks.length > 0)).toBe(true);
    expect(chunks.flatMap((entry) => entry.blocks.map((block) => block.id))).toEqual(["0:0", "0:1", "0:2"]);
  });

  test("returns nothing for an empty kept list", () => {
    const book = buildBook([{ title: "Empty", blocks: [{ text: "hello" }] }]);
    expect(packShortChunks(book, [])).toEqual([]);
  });
});

describe("selectShortChunks", () => {
  test("returns every chunk when there are fewer than the cap", () => {
    const book = buildBook([
      { title: "A", blocks: [{ text: words(20) }] },
      { title: "B", blocks: [{ text: words(20) }] },
    ]);
    const chunks = packShortChunks(book, book.blocks, { targetWords: 10, maxWords: 30 });
    expect(selectShortChunks(chunks, 12)).toHaveLength(chunks.length);
  });

  test("spreads across the book and drops the ending tenth", () => {
    const chapters = Array.from({ length: 20 }, (_, index) => ({
      title: `Chapter ${index + 1}`,
      blocks: [{ text: words(20) }],
    }));
    const book = buildBook(chapters);
    const chunks = packShortChunks(book, book.blocks, { targetWords: 10, maxWords: 30 });
    const picked = selectShortChunks(chunks, 5);
    expect(picked).toHaveLength(5);
    expect(picked[0]?.startBlockId).toBe(chunks[0]?.startBlockId);
    expect(picked.some((entry) => entry.chapterTitle === "Chapter 20")).toBe(false);
  });
});

describe("finalizeProposedShorts", () => {
  test("drops invented block ids and empty scripts", () => {
    const book = buildBook([{ title: "One", blocks: [{ text: words(40) }, { text: "The harbour was quiet." }] }]);
    const chunk = chunkFrom(book);
    const planned = finalizeProposedShorts(
      {
        shorts: [
          { title: "Quiet harbour", hook: "The harbour was quiet.", script: "The harbour was quiet that morning.", start_block_id: "0:1" },
          { title: "Invented", hook: "Nope", script: "Should not land.", start_block_id: "9:9" },
          { title: "Empty script", hook: "Hi", script: "   ", start_block_id: "0:0" },
        ],
      },
      chunk,
      DEFAULT_SHORT_OPTIONS,
    );
    expect(planned).toHaveLength(1);
    expect(planned[0]?.startBlockId).toBe("0:1");
    expect(planned[0]?.blockIds).toEqual(chunk.blocks.map((block) => block.id));
  });

  test("returns an empty list when the window has nothing hook-worthy", () => {
    const book = buildBook([{ title: "One", blocks: [{ text: words(20) }] }]);
    expect(finalizeProposedShorts({ shorts: [] }, chunkFrom(book), DEFAULT_SHORT_OPTIONS)).toEqual([]);
    expect(finalizeProposedShorts(null, chunkFrom(book), DEFAULT_SHORT_OPTIONS)).toEqual([]);
  });

  test("grounds a missing id at the chunk start rather than inventing one", () => {
    const book = buildBook([{ title: "One", blocks: [{ text: words(20) }] }]);
    const chunk = chunkFrom(book);
    const planned = finalizeProposedShorts(
      [{ title: "A beat", hook: "Listen", script: "Listen to this.", start_block_id: "" }],
      chunk,
      DEFAULT_SHORT_OPTIONS,
    );
    expect(planned[0]?.startBlockId).toBe(chunk.startBlockId);
  });
});

describe("clampShortScript", () => {
  test("leaves a script under the budget alone", () => {
    expect(clampShortScript("One two three.", 10)).toBe("One two three.");
  });

  test("trims to the last whole sentence inside the word budget", () => {
    const script = "First sentence is short. Second sentence adds more words than allowed here.";
    const clamped = clampShortScript(script, 5);
    expect(clamped).toBe("First sentence is short.");
    expect(clamped.endsWith(".")).toBe(true);
  });
});

describe("dedupe and cap", () => {
  test("drops later shorts that reuse a title", () => {
    const unique = dedupePlannedShorts([
      planned({ title: "Same", startBlockId: "0:0" }),
      planned({ title: "Same", startBlockId: "1:0" }),
      planned({ title: "Other", startBlockId: "2:0" }),
    ]);
    expect(unique.map((short) => short.startBlockId)).toEqual(["0:0", "2:0"]);
  });

  test("caps in reading order and reindexes", () => {
    const capped = capPlannedShorts(
      numberPlannedShorts([
        planned({ title: "A", startBlockId: "0:0" }),
        planned({ title: "B", startBlockId: "1:0" }),
        planned({ title: "C", startBlockId: "2:0" }),
      ]),
      2,
    );
    expect(capped).toHaveLength(2);
    expect(capped.map((short) => short.index)).toEqual([0, 1]);
    expect(capped.map((short) => short.title)).toEqual(["A", "B"]);
  });
});

describe("targetScriptWords", () => {
  test("is about 150 words for a 60s short at 150 wpm", () => {
    expect(targetScriptWords(DEFAULT_SHORT_OPTIONS)).toBe(150);
  });
});

describe("passageLinesForPrompt", () => {
  test("quotes block ids the model must copy", () => {
    const book = buildBook([{ title: "One", blocks: [{ text: "Hello there." }] }]);
    const lines = passageLinesForPrompt(chunkFrom(book));
    expect(lines[0]?.blockId).toBe("0:0");
    expect(lines[0]?.text).toContain("Hello");
  });
});

describe("buildBookShortsPrompt", () => {
  test("forbids invented ids and ending spoilers", () => {
    const prompt = buildBookShortsPrompt({
      bookTitle: "Me Before You",
      author: "Jojo Moyes",
      language: "en",
      chapterTitle: "Chapter 1",
      targetSeconds: 60,
      targetWords: 150,
      chunkIndex: 1,
      chunkCount: 8,
      lines: [{ blockId: "0:2", kind: "paragraph", text: "The harbour was quiet." }],
    });
    expect(prompt).toContain("0:2");
    expect(prompt).toContain("Do not spoil");
    expect(prompt).toContain("start_block_id");
  });
});

describe("buildBookShortPublishPrompt", () => {
  test("asks for a YouTube listing grounded in the book and teaser", () => {
    const prompt = buildBookShortPublishPrompt({
      bookTitle: "Me Before You",
      author: "Jojo Moyes",
      language: "en",
      chapterTitle: "Chapter 1",
      title: "She said yes. Then she saw the list.",
      hook: "She said yes. Then she saw the list.",
      script: "She said yes. Then she saw the list. Will Traynor is about to change her life.",
    });
    expect(prompt).toContain("youtube_title");
    expect(prompt).toContain("Me Before You");
    expect(prompt).toContain("Jojo Moyes");
    expect(prompt).toContain("without spoiling later chapters");
    expect(prompt).toContain("800-2500");
    expect(prompt).toContain("English");
  });
});

describe("buildBookSegmentPublishPrompt", () => {
  test("asks for a chapter description and forbids Shorts hashtags", () => {
    const prompt = buildBookSegmentPublishPrompt({
      bookTitle: "Me Before You",
      author: "Jojo Moyes",
      language: "en",
      chapterTitle: "Chapter 1",
      excerpt: "The harbour was quiet.",
    });
    expect(prompt).not.toContain("youtube_title");
    expect(prompt).toContain("Do not write a title");
    expect(prompt).toContain("Chapter 1");
    expect(prompt).toContain("Me Before You");
    expect(prompt).toContain("without spoiling later chapters");
    expect(prompt).toContain("1000-3500");
    expect(prompt).toContain("do not use #shorts");
  });
});

describe("clipSegmentExcerpt", () => {
  test("joins blocks and stops at the character budget", () => {
    expect(clipSegmentExcerpt(["The harbour was quiet.", "  Louisa  walked.  "])).toBe(
      "The harbour was quiet.\n\nLouisa walked.",
    );
    const clipped = clipSegmentExcerpt(["abcdefghij", "more"], 8);
    expect(clipped).toBe("abcdefgh…");
  });
});

describe("youtubeListingIsStub", () => {
  test("treats the book-aware fallback as a stub that should be rewritten", () => {
    const listing = fallbackBookSegmentPublish({
      bookTitle: "Me Before You",
      author: "Jojo Moyes",
      chapterTitle: "Prologue",
    });
    expect(youtubeListingIsStub(listing.description)).toBe(true);
    expect(fallbackBookSegmentPublish({
      bookTitle: "Me Before You",
      author: "Jojo Moyes",
      chapterTitle: "Chapter 4",
      episode: 4,
    }).youtubeTitle).toBe("Me Before You - Chapter 4 | Episode 4");
    expect(youtubeListingIsStub("")).toBe(true);
    expect(youtubeListingIsStub("A".repeat(200))).toBe(false);
  });
});

describe("parseBookShortRequestId", () => {
  test("reads a render task id and ignores the plan prefix", () => {
    expect(parseBookShortRequestId("book-short:abc123:4")).toEqual({ bookId: "abc123", index: 4 });
    expect(parseBookShortRequestId("book-shorts-plan:abc123:2")).toBeNull();
    expect(parseBookShortRequestId("book:abc123:4")).toBeNull();
  });
});

describe("bookShortsPlanRequestSchema", () => {
  test("fills shorts defaults", () => {
    const parsed = bookShortsPlanRequestSchema.parse({});
    expect(parsed.target_duration_seconds).toBe(DEFAULT_SHORT_DURATION_SECONDS);
    expect(parsed.max_shorts).toBe(DEFAULT_MAX_SHORTS);
    expect(parsed.words_per_minute).toBe(DEFAULT_SEGMENT_OPTIONS.wordsPerMinute);
  });

  test("rejects an out-of-range duration or count", () => {
    expect(() => bookShortsPlanRequestSchema.parse({ target_duration_seconds: 5 })).toThrow();
    expect(() => bookShortsPlanRequestSchema.parse({ max_shorts: 0 })).toThrow();
    expect(() => bookShortsPlanRequestSchema.parse({ max_shorts: 99 })).toThrow();
  });

  test("round-trips into ShortOptions", () => {
    expect(shortsPlanToOptions(bookShortsPlanRequestSchema.parse({ max_shorts: 8, words_per_minute: 170 }))).toEqual({
      targetDurationSeconds: 60,
      maxShorts: 8,
      wordsPerMinute: 170,
    });
  });
});

describe("bookShortPatchSchema", () => {
  test("requires at least one of title, hook, script", () => {
    expect(() => bookShortPatchSchema.parse({})).toThrow();
    expect(bookShortPatchSchema.parse({ title: "New title" }).title).toBe("New title");
  });

  test("accepts a YouTube listing without touching the spoken script", () => {
    const parsed = bookShortPatchSchema.parse({
      youtube_title: "She said yes | Me Before You",
      description: "A teaser from Me Before You.\n\n#shorts",
      tags: ["#Me Before You", "Jojo Moyes", "audiobook", "audiobook"],
    });
    expect(parsed.youtube_title).toBe("She said yes | Me Before You");
    expect(parsed.tags).toEqual(["Me Before You", "Jojo Moyes", "audiobook"]);
    expect(parsed.script).toBeUndefined();
  });
});

describe("bookShortsRenderRequestSchema", () => {
  test("defaults to 9:16 stock footage with captions-ready fields", () => {
    const parsed = bookShortsRenderRequestSchema.parse({ voice_name: "en-US-AriaNeural-Female" });
    expect(parsed.video_aspect).toBe("9:16");
    expect(parsed.video_source).toBe("pexels");
    expect(parsed.bgm_type).toBe("random");
    const stored = shortsRenderParamsToDocument(parsed);
    expect(stored.video_source).toBe("pexels");
    expect(stored.video_aspect).toBe("9:16");
  });

  test("requires a voice", () => {
    expect(() => bookShortsRenderRequestSchema.parse({})).toThrow();
  });
});

describe("segment re-plan isolation", () => {
  test("shorts packing does not depend on audiobook segment rows", () => {
    // A re-plan replaces book_segments only. These helpers read BookStructure
    // and kept blocks, so dropping a chapter video cannot wipe a teaser script.
    const book = buildBook([{ title: "One", blocks: [{ text: words(40) }] }]);
    const chunks = packShortChunks(book, book.blocks);
    expect(chunks).toHaveLength(1);
    expect("book_segments" in chunks[0]!).toBe(false);
  });

  test("planning is allowed once the book is ready, even mid audiobook render", () => {
    expect(bookIsReadyForShorts("ready")).toBe(true);
    expect(bookIsReadyForShorts("rendering")).toBe(true);
    expect(bookIsReadyForShorts("extracting")).toBe(false);
    expect(bookIsReadyForShorts("ocr")).toBe(false);
    expect(bookIsReadyForShorts("failed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Templated shorts
// ---------------------------------------------------------------------------

/**
 * The re-plumb, not the encode.
 *
 * A templated short renders its PICTURE with HyperFrames, but HyperFrames does
 * no TTS — so the narration and the cues still come from `runPipeline`, stopped
 * one stage early. Swapping the whole pipeline out instead would leave
 * `audio_path` and `subtitle_path` null on every templated short while exiting
 * 0, which is the failure these tests exist to make impossible. Nothing here
 * spawns Chrome or ffmpeg: what is being checked is which path a short takes
 * and what it records afterwards.
 */

import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join as joinPath } from "node:path";

import {
  declaredCompositionVariables,
  narrationFileForTask,
  readCompositionFrame,
  renderShortVideo,
  retimeComposition,
  shortCompletionPatch,
  shortCompositionVariables,
  type ShortRenderDeps,
} from "../src/tasks/bookShortsPipeline.ts";
import { videoParamsForBookShort } from "../src/models/bookSchema.ts";
import type { BookShortVideoParams } from "../src/models/bookSchema.ts";
import { __setTemplatesRootForTest } from "../src/services/video/templates.ts";
import type { CompositionRenderOptions } from "../src/services/video/hyperframes.ts";
import type { SoftSubtitleOptions } from "../src/services/video/softSubs.ts";
import type { StillSegmentOptions } from "../src/services/video/still.ts";
import type { RunPipelineOptions } from "../src/tasks/pipeline.ts";
import { taskDir } from "../src/utils/paths.ts";

/** Length the fake probe reports for the narration, in seconds. */
const NARRATION_SECONDS = 41.28;
const STOCK_VIDEO = "/storage/tasks/stock/final-1.mp4";

const TEMPLATE_HTML = `<!doctype html>
<html
  lang="en"
  data-composition-variables='[
    {"id":"bookTitle","type":"string"},
    {"id":"chapterTitle","type":"string"},
    {"id":"hookText","type":"string"},
    {"id":"accent","type":"color"}
  ]'
>
  <body>
    <div
      id="root"
      data-composition-id="short"
      data-start="0"
      data-width="1080"
      data-height="1920"
      data-duration="24"
      data-no-timeline
    >
      <div id="short-scene" class="clip" data-start="0" data-duration="24" data-track-index="0"></div>
    </div>
  </body>
</html>
`;

const createdTaskDirs: string[] = [];
const createdTempRoots: string[] = [];

afterEach(() => {
  __setTemplatesRootForTest();
  for (const dir of createdTaskDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const dir of createdTempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A one-template tree holding only a `short` part, pointed at by the registry.
 *
 * Returns its `index.html`, which stands in for the checked-in `resource/` copy:
 * a render must retime a throwaway working copy and leave this one alone.
 */
function installFixtureTemplate(): string {
  const root = mkdtempSync(joinPath(osTmpdir(), "vidgen-short-templates-"));
  createdTempRoots.push(root);

  const dir = joinPath(root, "fixture");
  mkdirSync(joinPath(dir, "short"), { recursive: true });
  writeFileSync(
    joinPath(dir, "template.json"),
    JSON.stringify({
      id: "fixture",
      label: "Fixture",
      description: "A short-only template used by the tests.",
      parts: ["short"],
      defaultAccent: "#7AA2F7",
      bedEncode: { fps: 15, crf: 26, preset: "veryfast" },
    }),
  );
  const entry = joinPath(dir, "short", "index.html");
  writeFileSync(entry, TEMPLATE_HTML);

  __setTemplatesRootForTest(root);
  return entry;
}

/** A task directory carrying the narration and cues `runPipeline` would have written. */
function seedNarration(taskId: string): { directory: string; audioFile: string; subtitleFile: string } {
  const directory = taskDir(taskId);
  createdTaskDirs.push(directory);

  const audioFile = joinPath(directory, "audio.mp3");
  const subtitleFile = joinPath(directory, "subtitle.srt");
  writeFileSync(audioFile, "not really audio, and never decoded: probe is faked");
  writeFileSync(
    subtitleFile,
    "1\n00:00:00,000 --> 00:00:02,400\nShe said yes.\n\n2\n00:00:02,400 --> 00:00:05,000\nThen she saw the list.\n",
  );

  return { directory, audioFile, subtitleFile };
}

function shortParams(templateId: string): BookShortVideoParams {
  return videoParamsForBookShort({
    title: "A list she should not have seen",
    script: "She said yes. Then she saw the list.",
    language: "en",
    hook: "She said yes. Then she saw the list.",
    chapter_title: "Chapter 1",
    params: {
      voice_name: "en-US-AriaNeural-Female",
      voice_rate: 1,
      voice_volume: 1,
      video_aspect: "9:16",
      video_source: "pexels",
      // No music: getBgmFile() would otherwise draw from the real library.
      bgm_type: "",
      bgm_file: "",
      bgm_volume: 0,
      font_name: "MicrosoftYaHeiBold.ttc",
      font_size: 60,
      template_id: templateId,
      n_threads: 2,
    },
  });
}

interface Recorder {
  pipeline: RunPipelineOptions[];
  compositions: CompositionRenderOptions[];
  stills: StillSegmentOptions[];
  muxes: SoftSubtitleOptions[];
  /** The working copy the composition was actually rendered from. */
  renderedHtml: string | null;
}

function fakeDeps(
  subtitleFile: string,
  overrides: Partial<ShortRenderDeps> = {},
): { deps: ShortRenderDeps; recorder: Recorder } {
  const recorder: Recorder = {
    pipeline: [],
    compositions: [],
    stills: [],
    muxes: [],
    renderedHtml: null,
  };

  const deps: ShortRenderDeps = {
    runPipeline: async (options) => {
      recorder.pipeline.push(options);
      if (options.stopAt === "subtitle") return { subtitle_path: subtitleFile };
      return {
        videos: [STOCK_VIDEO],
        combined_videos: [STOCK_VIDEO],
        audio_file: joinPath(taskDir(options.taskId), "audio.mp3"),
        audio_duration: NARRATION_SECONDS,
        subtitle_path: subtitleFile,
      };
    },
    hyperframesAvailable: async () => true,
    renderComposition: async (options) => {
      recorder.compositions.push(options);
      // Read inside the call: the working copy is deleted on the way out.
      recorder.renderedHtml = readFileSync(joinPath(options.templateDir, "index.html"), "utf8");
      return { outputFile: options.outputFile, duration: NARRATION_SECONDS, cached: false };
    },
    renderStillSegment: async (options) => {
      recorder.stills.push(options);
      return {
        outputFile: options.outputFile,
        duration: NARRATION_SECONDS,
        burnedSubtitles: Boolean(options.assPath),
        mixedBgm: Boolean(options.bgmPath),
      };
    },
    probe: async () => ({
      duration: NARRATION_SECONDS,
      width: 0,
      height: 0,
      fps: 0,
      hasVideo: false,
      hasAudio: true,
      audioSampleRate: 24000,
    }),
    // This host's ffmpeg has no libass (see T0), so exercise the soft-track
    // fallback rather than the ASS write.
    supportsAssBurn: async () => false,
    muxSoftSubtitles: async (options) => {
      recorder.muxes.push(options);
      return { outputFile: options.outputFile, sidecarPath: null, language: "eng" };
    },
    ...overrides,
  };

  return { deps, recorder };
}

describe("readCompositionFrame", () => {
  test("reads the compile-time frame off the root element", () => {
    const frame = readCompositionFrame(TEMPLATE_HTML);
    expect(frame).toEqual({ duration: 24, width: 1080, height: 1920, durationLiteral: "24" });
  });

  test("returns null for markup with no usable root", () => {
    expect(readCompositionFrame("<div></div>")).toBeNull();
    expect(readCompositionFrame('<div id="root" data-width="1080" data-height="1920"></div>')).toBeNull();
  });
});

describe("retimeComposition", () => {
  test("retimes the root and every element that spans it", () => {
    // Patching only the root would leave the scene ending at 24s and the tail of
    // a 41s short showing a blank frame.
    const retimed = retimeComposition(TEMPLATE_HTML, NARRATION_SECONDS)!;
    expect(retimed.split('data-duration="41.28"')).toHaveLength(3);
    expect(retimed).not.toContain('data-duration="24"');
    expect(readCompositionFrame(retimed)?.duration).toBe(NARRATION_SECONDS);
  });

  test("refuses markup it cannot retime, and a length it cannot use", () => {
    expect(retimeComposition("<div></div>", 30)).toBeNull();
    expect(retimeComposition(TEMPLATE_HTML, 0)).toBeNull();
  });
});

describe("shortCompositionVariables", () => {
  test("sends only what the composition declares", () => {
    expect(declaredCompositionVariables(TEMPLATE_HTML)).toEqual([
      "bookTitle",
      "chapterTitle",
      "hookText",
      "accent",
    ]);

    const variables = shortCompositionVariables({
      bookTitle: "Me Before You",
      params: shortParams("fixture"),
      accent: "#7aa2f7",
      declared: ["bookTitle", "accent"],
    });
    expect(variables).toEqual({ bookTitle: "Me Before You", accent: "#7aa2f7" });
  });

  test("prefers the book title and the hook over the short's own subject", () => {
    const variables = shortCompositionVariables({
      bookTitle: "Me Before You",
      params: shortParams("fixture"),
      accent: "#7aa2f7",
    });
    expect(variables.bookTitle).toBe("Me Before You");
    expect(variables.chapterTitle).toBe("Chapter 1");
    expect(variables.hookText).toBe("She said yes. Then she saw the list.");
  });
});

describe("renderShortVideo", () => {
  test("a templated short still records its narration and its cues", async () => {
    const shippedComposition = installFixtureTemplate();
    const taskId = "tpl-records-audio-and-subs";
    const { audioFile, subtitleFile, directory } = seedNarration(taskId);
    const { deps, recorder } = fakeDeps(subtitleFile);

    const outcome = await renderShortVideo(
      {
        taskId,
        bookTitle: "Me Before You",
        params: shortParams("fixture"),
        signal: new AbortController().signal,
      },
      deps,
    );

    // The bug this whole task exists to avoid: a picture-only branch that exits
    // 0 with both of these null.
    const patch = shortCompletionPatch(outcome);
    expect(patch.audio_path).toBe(audioFile);
    expect(patch.subtitle_path).toBe(subtitleFile);
    expect(patch.video_path).toBe(joinPath(directory, "final-1.mp4"));
    expect(patch.error).toBeNull();
    expect(outcome.templated).toBe(true);
    expect(outcome.audioDuration).toBe(NARRATION_SECONDS);

    // TTS and cues still come from the pipeline, one stage early.
    expect(recorder.pipeline.map((options) => options.stopAt)).toEqual(["subtitle"]);

    // The composition is compiled to the probed narration length, from a
    // working copy — resource/ is never touched.
    expect(recorder.compositions).toHaveLength(1);
    expect(recorder.compositions[0]?.templateDir).not.toContain("resource");
    expect(recorder.compositions[0]?.width).toBe(1080);
    expect(recorder.compositions[0]?.height).toBe(1920);
    expect(recorder.renderedHtml).toContain('data-duration="41.28"');
    expect(recorder.renderedHtml).not.toContain('data-duration="24"');
    // The shipped composition is checked in and shared by every concurrent
    // render; retiming it in place would make two shorts race over its length.
    expect(readFileSync(shippedComposition, "utf8")).toBe(TEMPLATE_HTML);

    // The composition is the bed, and the narration is the audio.
    expect(recorder.stills).toHaveLength(1);
    expect(recorder.stills[0]?.bedPath).toBe(recorder.compositions[0]!.outputFile);
    expect(recorder.stills[0]?.audioPath).toBe(audioFile);
    expect(recorder.stills[0]?.imagePath).toBeUndefined();

    // No libass on this host, so the cues ride as a soft track rather than
    // vanishing.
    expect(recorder.muxes.map((options) => options.subtitlePath)).toEqual([subtitleFile]);
  });

  test("an untemplated short takes stopAt: \"video\" exactly as before", async () => {
    installFixtureTemplate();
    const taskId = "untemplated-stock-path";
    const { subtitleFile } = seedNarration(taskId);
    const { deps, recorder } = fakeDeps(subtitleFile);

    const outcome = await renderShortVideo(
      {
        taskId,
        bookTitle: "Me Before You",
        params: shortParams(""),
        signal: new AbortController().signal,
      },
      deps,
    );

    expect(recorder.pipeline.map((options) => options.stopAt)).toEqual(["video"]);
    expect(recorder.compositions).toHaveLength(0);
    expect(recorder.stills).toHaveLength(0);
    expect(outcome.templated).toBe(false);
    expect(shortCompletionPatch(outcome)).toEqual({
      state: "complete",
      video_path: STOCK_VIDEO,
      audio_path: joinPath(taskDir(taskId), "audio.mp3"),
      subtitle_path: subtitleFile,
      error: null,
    });
  });

  test("an unavailable hyperframes falls back to stock footage and still completes", async () => {
    installFixtureTemplate();
    const taskId = "hyperframes-unavailable";
    const { subtitleFile } = seedNarration(taskId);
    const { deps, recorder } = fakeDeps(subtitleFile, { hyperframesAvailable: async () => false });

    const outcome = await renderShortVideo(
      {
        taskId,
        bookTitle: "Me Before You",
        params: shortParams("fixture"),
        signal: new AbortController().signal,
      },
      deps,
    );

    // Refused before anything was paid for: no composition, and the pipeline
    // ran once, straight through.
    expect(recorder.compositions).toHaveLength(0);
    expect(recorder.pipeline.map((options) => options.stopAt)).toEqual(["video"]);
    expect(outcome.error).toBeNull();
    expect(outcome.templated).toBe(false);
    expect(shortCompletionPatch(outcome).video_path).toBe(STOCK_VIDEO);
    expect(shortCompletionPatch(outcome).audio_path).not.toBeNull();
    expect(shortCompletionPatch(outcome).subtitle_path).not.toBeNull();
  });

  test("an unknown template falls back without ever asking about hyperframes", async () => {
    installFixtureTemplate();
    const taskId = "unknown-template";
    const { subtitleFile } = seedNarration(taskId);
    let asked = false;
    const { deps, recorder } = fakeDeps(subtitleFile, {
      hyperframesAvailable: async () => {
        asked = true;
        return true;
      },
    });

    const outcome = await renderShortVideo(
      {
        taskId,
        bookTitle: "Me Before You",
        params: shortParams("deleted-last-week"),
        signal: new AbortController().signal,
      },
      deps,
    );

    expect(asked).toBe(false);
    expect(recorder.pipeline.map((options) => options.stopAt)).toEqual(["video"]);
    expect(outcome.error).toBeNull();
  });

  test("a composition render that blows up degrades to stock footage", async () => {
    installFixtureTemplate();
    const taskId = "composition-render-failed";
    const { subtitleFile } = seedNarration(taskId);
    const { deps, recorder } = fakeDeps(subtitleFile, {
      renderComposition: async () => {
        throw new Error("chrome died mid-frame");
      },
    });

    const outcome = await renderShortVideo(
      {
        taskId,
        bookTitle: "Me Before You",
        params: shortParams("fixture"),
        signal: new AbortController().signal,
      },
      deps,
    );

    // Narration first, then the retry as an ordinary stock short.
    expect(recorder.pipeline.map((options) => options.stopAt)).toEqual(["subtitle", "video"]);
    expect(recorder.stills).toHaveLength(0);
    expect(outcome.error).toBeNull();
    expect(outcome.templated).toBe(false);
    expect(shortCompletionPatch(outcome).audio_path).not.toBeNull();
    expect(shortCompletionPatch(outcome).subtitle_path).not.toBeNull();
  });

  test("a failed narration fails the short rather than silently degrading", async () => {
    installFixtureTemplate();
    const taskId = "narration-failed";
    const { subtitleFile } = seedNarration(taskId);
    const { deps, recorder } = fakeDeps(subtitleFile, {
      runPipeline: async (options) => ({ state: 3, failed_stage: "audio", error: "TTS refused the voice" }),
    });

    const outcome = await renderShortVideo(
      {
        taskId,
        bookTitle: "Me Before You",
        params: shortParams("fixture"),
        signal: new AbortController().signal,
      },
      deps,
    );

    expect(outcome.error).toBe("TTS refused the voice");
    expect(outcome.videoPath).toBeNull();
    expect(recorder.compositions).toHaveLength(0);
  });
});

describe("narrationFileForTask", () => {
  test("locates the file runPipeline wrote, because the subtitle stop does not return it", () => {
    const taskId = "narration-lookup";
    const { audioFile } = seedNarration(taskId);
    expect(narrationFileForTask(taskId, shortParams("fixture"))).toBe(audioFile);
  });
});
