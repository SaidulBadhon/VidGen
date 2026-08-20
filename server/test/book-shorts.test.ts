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
