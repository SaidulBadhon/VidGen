/**
 * Smart segmentation: chapter-like titles, packing toward a target, LLM fallback.
 */

import { describe, expect, test } from "bun:test";

import {
  announcementLines,
  buildOutline,
  detectSmartSections,
  excludeSkippedBlocks,
  findSkipBlockIds,
  formatOpeningTitle,
  heuristicSections,
  looksLikeSectionTitle,
  looksLikeTocHeading,
  normalizeSections,
  planBookSegments,
  planSmartSegments,
  sectionNameFromTitle,
  speakableBookTitle,
  type SmartSection,
} from "../src/services/book/smartSegment.ts";
import { buildSegmentBoundariesPrompt } from "../src/services/llm/prompts.ts";
import { DEFAULT_SEGMENT_OPTIONS } from "../src/services/book/types.ts";
import type { Block, BlockKind, BookStructure, Chapter, SegmentOptions } from "../src/services/book/types.ts";

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

  return { title: "A Tale of Two Cities", author: "Charles Dickens", language: "en", chapters, blocks };
}

function withOptions(overrides: Partial<SegmentOptions>): SegmentOptions {
  return { ...DEFAULT_SEGMENT_OPTIONS, mode: "smart", ...overrides };
}

function words(count: number): string {
  return Array.from({ length: count }, () => "alpha").join(" ");
}

function timed(seconds: number): BlockSpec {
  return { text: words(Math.round(seconds * 2.7)) };
}

function paragraphs(count: number, seconds: number): BlockSpec[] {
  return Array.from({ length: count }, () => timed(seconds));
}

describe("looksLikeSectionTitle", () => {
  test("recognises published chapter and book headings", () => {
    expect(looksLikeSectionTitle("Chapter I")).toBe(true);
    expect(looksLikeSectionTitle("CHAPTER I. THE PERIOD")).toBe(true);
    expect(looksLikeSectionTitle("I. The Period")).toBe(true);
    expect(looksLikeSectionTitle("Book the First")).toBe(true);
    expect(looksLikeSectionTitle("Book the First—Recalled to Life")).toBe(true);
    expect(looksLikeSectionTitle("Prologue")).toBe(true);
  });

  test("does not treat ordinary prose as a title", () => {
    expect(looksLikeSectionTitle("I went to the store that morning.")).toBe(false);
    expect(
      looksLikeSectionTitle(
        "It was the best of times, it was the worst of times, it was the age of wisdom.",
      ),
    ).toBe(false);
    expect(looksLikeSectionTitle("")).toBe(false);
  });
});

describe("buildOutline", () => {
  test("collapses prose between headings and chapter-like markers", () => {
    const book = buildBook([
      {
        title: "charles-dickens_tale-of-two-cities",
        blocks: [
          timed(20),
          { text: "Book the First — Recalled to Life", kind: "heading" },
          timed(40),
          { text: "I. The Period" },
          timed(30),
          timed(30),
        ],
      },
    ]);
    const units = buildOutline(book, book.blocks, 150);

    expect(units.map((unit) => unit.kind)).toEqual(["marker", "heading", "prose", "marker", "prose"]);
    expect(units[1]!.title).toContain("Book the First");
    expect(units[3]!.title).toBe("I. The Period");
    expect(units[4]!.startBlockId).toBe("0:4");
  });
});

describe("normalizeSections", () => {
  test("drops unknown ids, de-duplicates, and always starts at the first block", () => {
    const book = buildBook([{ blocks: paragraphs(4, 10) }]);
    const normalized = normalizeSections(book.blocks, [
      { startBlockId: "missing", title: "Nope" },
      { startBlockId: "0:2", title: "Later" },
      { startBlockId: "0:2", title: "Duplicate" },
    ]);

    expect(normalized.map((section) => section.startBlockId)).toEqual(["0:0", "0:2"]);
    expect(normalized[1]!.title).toBe("Later");
  });
});

describe("planSmartSegments", () => {
  const options = withOptions({ targetDurationSeconds: 100, maxDurationSeconds: 180 });

  test("packs consecutive short sections toward the target instead of slicing by the clock", () => {
    const book = buildBook([
      { title: "Chapter I", blocks: [{ text: "I. The Period", kind: "heading" }, timed(50)] },
      { title: "Chapter II", blocks: [{ text: "II. The Mail", kind: "heading" }, timed(50)] },
      { title: "Chapter III", blocks: [{ text: "III. The Night Shadows", kind: "heading" }, timed(50)] },
    ]);
    const sections: SmartSection[] = [
      { startBlockId: "0:0", title: "I. The Period" },
      { startBlockId: "1:0", title: "II. The Mail" },
      { startBlockId: "2:0", title: "III. The Night Shadows" },
    ];
    const segments = planSmartSegments(book, book.blocks, options, sections);

    expect(segments).toHaveLength(2);
    expect(segments[0]!.title).toBe("A Tale of Two Cities — Charles Dickens — I. The Period");
    expect(segments[0]!.blockIds).toEqual(["0:0", "0:1", "1:0", "1:1"]);
    expect(segments[1]!.title).toBe("III. The Night Shadows");
  });

  test("keeps a short section whole rather than splitting it to hit the target", () => {
    const book = buildBook([{ blocks: [{ text: "Prologue", kind: "heading" }, timed(40)] }]);
    const segments = planSmartSegments(
      book,
      book.blocks,
      options,
      [{ startBlockId: "0:0", title: "Prologue" }],
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]!.title).toBe("A Tale of Two Cities — Charles Dickens — Prologue");
    expect(segments[0]!.blockIds).toEqual(["0:0", "0:1"]);
  });

  test("duration-splits a single section that exceeds the maximum", () => {
    const book = buildBook([{ blocks: [{ text: "A Long Chapter", kind: "heading" }, ...paragraphs(12, 20)] }]);
    const segments = planSmartSegments(
      book,
      book.blocks,
      withOptions({ targetDurationSeconds: 55, maxDurationSeconds: 100 }),
      [{ startBlockId: "0:0", title: "A Long Chapter" }],
    );

    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0]!.title).toBe("A Tale of Two Cities — Charles Dickens — A Long Chapter");
    expect(segments[1]!.title).toBe("A Long Chapter (part 2)");
    expect(segments.flatMap((segment) => segment.blockIds)).toEqual(book.blocks.map((block) => block.id));
    for (const segment of segments) {
      expect(segment.estimatedDuration).toBeLessThanOrEqual(100);
    }
  });

  test("carries a heading that is not itself a section start into the next run", () => {
    const book = buildBook([
      {
        blocks: [
          { text: "Chapter I", kind: "heading" },
          timed(120),
          { text: "A later heading", kind: "heading" },
          timed(40),
        ],
      },
    ]);
    const segments = planSmartSegments(book, book.blocks, options, [
      { startBlockId: "0:0", title: "Chapter I" },
      { startBlockId: "0:3", title: "Continuation" },
    ]);

    expect(segments).toHaveLength(2);
    expect(segments[0]!.blockIds).toEqual(["0:0", "0:1"]);
    expect(segments[1]!.blockIds).toEqual(["0:2", "0:3"]);
    expect(segments[1]!.title).toBe("A later heading");
  });

  test("keeps every block exactly once, in reading order", () => {
    const book = buildBook([{ blocks: paragraphs(5, 10) }, { blocks: paragraphs(5, 10) }]);
    const segments = planSmartSegments(
      book,
      [...book.blocks].reverse(),
      options,
      [
        { startBlockId: "0:0", title: "One" },
        { startBlockId: "1:0", title: "Two" },
      ],
    );

    expect(segments.flatMap((segment) => segment.blockIds)).toEqual(book.blocks.map((block) => block.id));
  });
});

describe("detectSmartSections", () => {
  test("uses the proposer's starts when they refer to real blocks", async () => {
    const book = buildBook([
      { blocks: [{ text: "I. The Period" }, ...paragraphs(2, 10)] },
      { blocks: [{ text: "II. The Mail" }, ...paragraphs(2, 10)] },
    ]);
    const { sections } = await detectSmartSections(book, book.blocks, withOptions({}), async () => [
      { startBlockId: "0:0", title: "I. The Period" },
      { startBlockId: "1:0", title: "II. The Mail" },
    ]);

    expect(sections.map((section) => section.title)).toEqual(["I. The Period", "II. The Mail"]);
  });

  test("falls back to heading and chapter-like markers when the proposer is silent", async () => {
    const book = buildBook([
      {
        title: "Book the First",
        blocks: [
          { text: "Book the First", kind: "heading" },
          timed(20),
          { text: "I. The Period" },
          timed(20),
        ],
      },
    ]);
    const { sections } = await detectSmartSections(book, book.blocks, withOptions({}), async () => []);

    expect(heuristicSections(buildOutline(book, book.blocks, 150)).length).toBeGreaterThan(1);
    expect(sections.map((section) => section.startBlockId)).toContain("0:2");
    expect(sections.find((section) => section.startBlockId === "0:2")?.title).toBe("I. The Period");
  });
});

describe("planBookSegments", () => {
  test("leaves duration mode on the deterministic planner", async () => {
    const book = buildBook([{ blocks: paragraphs(20, 10) }]);
    const segments = await planBookSegments(
      book,
      book.blocks,
      withOptions({ mode: "duration", targetDurationSeconds: 55, maxDurationSeconds: 100 }),
    );

    expect(segments.map((segment) => segment.blockIds.length)).toEqual([6, 6, 6, 2]);
  });

  test("smart mode titles videos from detected chapters, not filename parts", async () => {
    const book = buildBook([
      {
        title: "charles-dickens_tale-of-two-cities",
        blocks: [
          timed(20),
          { text: "I. The Period" },
          timed(40),
          { text: "II. The Mail" },
          timed(40),
        ],
      },
    ]);
    const segments = await planBookSegments(
      book,
      book.blocks,
      withOptions({ targetDurationSeconds: 50, maxDurationSeconds: 180 }),
      async () => [
        { startBlockId: "0:1", title: "I. The Period" },
        { startBlockId: "0:3", title: "II. The Mail" },
      ],
    );

    expect(segments.map((segment) => segment.title)).toEqual([
      "A Tale of Two Cities — Charles Dickens — I. The Period",
      "II. The Mail",
    ]);
    expect(segments.some((segment) => /part \d+/i.test(segment.title))).toBe(false);
  });
});

describe("looksLikeTocHeading", () => {
  test("recognises contents headings", () => {
    expect(looksLikeTocHeading("Contents")).toBe(true);
    expect(looksLikeTocHeading("TABLE OF CONTENTS")).toBe(true);
    expect(looksLikeTocHeading("Table of Contents.")).toBe(true);
    expect(looksLikeTocHeading("I. The Period")).toBe(false);
  });
});

describe("findSkipBlockIds", () => {
  test("drops a contents listing and keeps the real chapter that follows", () => {
    const book = buildBook([
      {
        blocks: [
          { text: "A Tale of Two Cities", kind: "heading" },
          { text: "Charles Dickens" },
          { text: "Contents", kind: "heading" },
          { text: "I. The Period" },
          { text: "II. The Mail" },
          { text: "III. The Night Shadows" },
          { text: "IV. The Preparation" },
          { text: "I. The Period", kind: "heading" },
          timed(120),
          { text: "II. The Mail", kind: "heading" },
          timed(120),
        ],
      },
    ]);
    const skip = new Set(findSkipBlockIds(buildOutline(book, book.blocks, 150)));

    expect(skip.has("0:2")).toBe(true);
    expect(skip.has("0:3")).toBe(true);
    expect(skip.has("0:4")).toBe(true);
    expect(skip.has("0:5")).toBe(true);
    expect(skip.has("0:6")).toBe(true);
    expect(skip.has("0:0")).toBe(false);
    expect(skip.has("0:1")).toBe(false);
    expect(skip.has("0:7")).toBe(false);
    expect(skip.has("0:9")).toBe(false);
  });
});

describe("planSmartSegments unread material", () => {
  const options = withOptions({ targetDurationSeconds: 100, maxDurationSeconds: 180 });

  test("does not narrate the table of contents", () => {
    const book = buildBook([
      {
        blocks: [
          { text: "Contents", kind: "heading" },
          { text: "I. The Period" },
          { text: "II. The Mail" },
          { text: "III. The Night Shadows" },
          { text: "IV. The Preparation" },
          { text: "I. The Period", kind: "heading" },
          timed(120),
          { text: "II. The Mail", kind: "heading" },
          timed(120),
        ],
      },
    ]);
    const units = buildOutline(book, book.blocks, 150);
    const skip = findSkipBlockIds(units);
    const segments = planSmartSegments(
      book,
      book.blocks,
      options,
      [
        { startBlockId: "0:5", title: "I. The Period" },
        { startBlockId: "0:7", title: "II. The Mail" },
      ],
      skip,
    );

    const ids = segments.flatMap((segment) => segment.blockIds);
    expect(ids).not.toContain("0:0");
    expect(ids).not.toContain("0:1");
    expect(ids).not.toContain("0:2");
    expect(ids[0]).toBe("0:5");
    expect(segments[0]!.title).toBe("A Tale of Two Cities — Charles Dickens — I. The Period");
    expect(segments[1]!.title).toBe("II. The Mail");
  });

  test("keeps title and author lines before the first chapter when they are not a contents list", () => {
    const book = buildBook([
      {
        blocks: [
          { text: "A Tale of Two Cities", kind: "heading" },
          { text: "Charles Dickens" },
          { text: "I. The Period", kind: "heading" },
          timed(80),
        ],
      },
    ]);
    const segments = planSmartSegments(book, book.blocks, options, [
      { startBlockId: "0:2", title: "I. The Period" },
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0]!.blockIds).toEqual(["0:0", "0:1", "0:2", "0:3"]);
  });
});

describe("opening titles and announcements", () => {
  const book = buildBook([{ blocks: [{ text: "I. The Period", kind: "heading" }, timed(40)] }]);

  test("speakableBookTitle ignores filename stems", () => {
    expect(speakableBookTitle("A Tale of Two Cities")).toBe("A Tale of Two Cities");
    expect(speakableBookTitle("charles-dickens_tale-of-two-cities")).toBe("");
  });

  test("formatOpeningTitle puts book, author, then chapter on the first video", () => {
    expect(formatOpeningTitle(book, "I. The Period")).toBe(
      "A Tale of Two Cities — Charles Dickens — I. The Period",
    );
  });

  test("sectionNameFromTitle strips the book and author prefix", () => {
    expect(
      sectionNameFromTitle("A Tale of Two Cities — Charles Dickens — I. The Period", book),
    ).toBe("I. The Period");
  });

  test("first video announces book, author, and chapter when those lines are missing", () => {
    expect(
      announcementLines(book, { index: 0, title: "A Tale of Two Cities — Charles Dickens — I. The Period" }, [
        book.blocks[1]!,
      ]),
    ).toEqual(["A Tale of Two Cities", "Charles Dickens", "I. The Period"]);
  });

  test("does not re-read a heading that is already the first block", () => {
    expect(
      announcementLines(book, { index: 0, title: "A Tale of Two Cities — Charles Dickens — I. The Period" }, [
        book.blocks[0]!,
      ]),
    ).toEqual(["A Tale of Two Cities", "Charles Dickens"]);
  });

  test("later videos announce only the chapter name", () => {
    expect(announcementLines(book, { index: 1, title: "II. The Mail" }, [])).toEqual(["II. The Mail"]);
  });
});

describe("buildSegmentBoundariesPrompt", () => {
  test("tells the model to skip the table of contents and not start at the first outline id", () => {
    const prompt = buildSegmentBoundariesPrompt({
      bookTitle: "A Tale of Two Cities",
      author: "Charles Dickens",
      targetSeconds: 900,
      maxSeconds: 1500,
      totalSeconds: 3600,
      units: [
        { index: 0, startBlockId: "0:0", kind: "heading", seconds: 2, title: "Contents" },
        { index: 1, startBlockId: "0:5", kind: "marker", seconds: 2, title: "I. The Period" },
      ],
    });

    expect(prompt).toContain("skip_block_ids");
    expect(prompt).toContain("table of contents");
    expect(prompt).not.toContain("The first section should start at the first outline id");
  });
});

describe("excludeSkippedBlocks", () => {
  test("keeps real prose even when the model marked it skip", () => {
    const book = buildBook([{ blocks: [timed(80), { text: "I. The Period" }] }]);
    const kept = excludeSkippedBlocks(book.blocks, ["0:0"]);
    expect(kept.map((block) => block.id)).toEqual(["0:0", "0:1"]);
  });
});
