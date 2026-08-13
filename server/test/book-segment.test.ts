/**
 * Segment planning: duration targets, chapter boundaries and the block invariant.
 *
 * The invariant under test throughout is that a segment is a run of WHOLE blocks.
 * Everything else here — targets, ceilings, headings — only moves the joins around.
 */

import { describe, expect, test } from "bun:test";

import { countWords, estimateSpokenSeconds, planSegments } from "../src/services/book/segment.ts";
import { DEFAULT_SEGMENT_OPTIONS } from "../src/services/book/types.ts";
import type { Block, BlockKind, BookStructure, Chapter, SegmentOptions, SegmentPlan } from "../src/services/book/types.ts";

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

  return { title: "Test Book", author: "A Tester", language: "en", chapters, blocks };
}

function withOptions(overrides: Partial<SegmentOptions>): SegmentOptions {
  return { ...DEFAULT_SEGMENT_OPTIONS, ...overrides };
}

/**
 * `count` punctuation-free Latin words.
 *
 * The estimator charges those at 2.7 words/second, so 27 words is ten seconds of
 * narration at the default rate — which is what every duration below is built from.
 */
function words(count: number): string {
  return Array.from({ length: count }, () => "alpha").join(" ");
}

/** A block of `seconds` seconds of Latin narration at the default rate. */
function timed(seconds: number): BlockSpec {
  return { text: words(Math.round(seconds * 2.7)) };
}

function paragraphs(count: number, seconds: number): BlockSpec[] {
  return Array.from({ length: count }, () => timed(seconds));
}

function allBlockIds(segments: SegmentPlan[]): string[] {
  return segments.flatMap((segment) => segment.blockIds);
}

// ---------------------------------------------------------------------------

describe("estimateSpokenSeconds", () => {
  test("charges Latin text at the calibrated word rate", () => {
    expect(estimateSpokenSeconds(words(27), 150)).toBeCloseTo(10, 5);
  });

  test("charges CJK per character, which a word count cannot do", () => {
    // 420 CJK characters is ~100 seconds of narration but only one whitespace
    // "word": deriving duration from the word count would be off by two orders of
    // magnitude and every CJK segment would come out far too long.
    const cjk = "中".repeat(420);

    expect(countWords(cjk)).toBe(1);
    expect(estimateSpokenSeconds(cjk, 150)).toBeCloseTo(100, 5);
  });

  test("treats a higher words-per-minute as faster, and so shorter", () => {
    const text = words(270);
    expect(estimateSpokenSeconds(text, 300)).toBeCloseTo(estimateSpokenSeconds(text, 150) / 2, 5);
  });

  test("returns zero for empty text and falls back on a nonsense rate", () => {
    expect(estimateSpokenSeconds("   ", 150)).toBe(0);
    expect(estimateSpokenSeconds(words(27), 0)).toBeCloseTo(10, 5);
  });
});

describe("countWords", () => {
  test("counts whitespace-delimited words", () => {
    expect(countWords("  one  two\nthree ")).toBe(3);
    expect(countWords("   ")).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("planSegments basics", () => {
  test("returns nothing for an empty block list", () => {
    const book = buildBook([{ blocks: paragraphs(3, 10) }]);
    expect(planSegments(book, [], DEFAULT_SEGMENT_OPTIONS)).toEqual([]);
  });

  test("gives contiguous 0-based indices", () => {
    const book = buildBook([{ blocks: paragraphs(20, 10) }]);
    const segments = planSegments(book, book.blocks, withOptions({ targetDurationSeconds: 55, maxDurationSeconds: 100 }));

    expect(segments.length).toBeGreaterThan(1);
    expect(segments.map((segment) => segment.index)).toEqual(segments.map((_, index) => index));
  });

  test("keeps every block exactly once, in reading order", () => {
    const book = buildBook([{ blocks: paragraphs(10, 10) }, { blocks: paragraphs(10, 10) }]);
    // Reversed on the way in to prove the plan sorts by reading order itself.
    const segments = planSegments(
      book,
      [...book.blocks].reverse(),
      withOptions({ targetDurationSeconds: 55, maxDurationSeconds: 100 }),
    );

    expect(allBlockIds(segments)).toEqual(book.blocks.map((block) => block.id));
  });

  test("reports the whitespace word count of its blocks", () => {
    const book = buildBook([{ blocks: paragraphs(2, 10) }]);
    const segments = planSegments(book, book.blocks, DEFAULT_SEGMENT_OPTIONS);

    expect(segments).toHaveLength(1);
    expect(segments[0]!.wordCount).toBe(54);
  });
});

describe("duration mode", () => {
  const options = withOptions({ mode: "duration", targetDurationSeconds: 55, maxDurationSeconds: 100 });

  test("closes a segment once the estimate reaches the target", () => {
    const book = buildBook([{ blocks: paragraphs(20, 10) }]);
    const segments = planSegments(book, book.blocks, options);

    expect(segments.map((segment) => segment.blockIds.length)).toEqual([6, 6, 6, 2]);
    for (const segment of segments.slice(0, 3)) {
      expect(segment.estimatedDuration).toBeGreaterThanOrEqual(options.targetDurationSeconds);
    }
  });

  test("never lets a segment exceed the ceiling", () => {
    const book = buildBook([{ blocks: paragraphs(30, 17) }]);
    const segments = planSegments(book, book.blocks, options);

    for (const segment of segments) {
      expect(segment.estimatedDuration).toBeLessThanOrEqual(options.maxDurationSeconds);
    }
  });

  test("takes a chapter boundary once past the preferred split point", () => {
    const book = buildBook([{ blocks: [timed(80)] }, { blocks: [timed(30)] }]);
    const segments = planSegments(
      book,
      book.blocks,
      withOptions({ targetDurationSeconds: 100, maxDurationSeconds: 200 }),
    );

    expect(segments).toHaveLength(2);
    expect(segments[0]!.chapterIds).toEqual(["ch-0"]);
    expect(segments[1]!.chapterIds).toEqual(["ch-1"]);
  });

  test("runs through a chapter boundary that arrives too early to be worth taking", () => {
    const book = buildBook([{ blocks: [timed(40)] }, { blocks: [timed(30)] }]);
    const segments = planSegments(
      book,
      book.blocks,
      withOptions({ targetDurationSeconds: 100, maxDurationSeconds: 200 }),
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]!.chapterIds).toEqual(["ch-0", "ch-1"]);
  });
});

describe("chapter mode", () => {
  const options = withOptions({ mode: "chapter" });

  test("gives one segment per chapter when chapters fit under the ceiling", () => {
    const book = buildBook([
      { blocks: [{ text: "Chapter One", kind: "heading" }, timed(60)] },
      { blocks: [{ text: "Chapter Two", kind: "heading" }, timed(90)] },
      { blocks: [{ text: "Chapter Three", kind: "heading" }, timed(45)] },
    ]);
    const segments = planSegments(book, book.blocks, options);

    expect(segments).toHaveLength(3);
    expect(segments.map((segment) => segment.chapterIds)).toEqual([["ch-0"], ["ch-1"], ["ch-2"]]);
    expect(segments.map((segment) => segment.title)).toEqual(["Chapter One", "Chapter Two", "Chapter Three"]);
  });

  test("does not split a short chapter merely because it passed the target", () => {
    // The target is what duration mode aims at; chapter mode only obeys the ceiling.
    const book = buildBook([{ blocks: paragraphs(6, 10) }]);
    const segments = planSegments(
      book,
      book.blocks,
      withOptions({ mode: "chapter", targetDurationSeconds: 15, maxDurationSeconds: 200 }),
    );

    expect(segments).toHaveLength(1);
  });

  test("splits a chapter that runs past the ceiling", () => {
    const book = buildBook([{ blocks: paragraphs(10, 10) }]);
    const segments = planSegments(
      book,
      book.blocks,
      withOptions({ mode: "chapter", targetDurationSeconds: 15, maxDurationSeconds: 25 }),
    );

    expect(segments.map((segment) => segment.blockIds.length)).toEqual([2, 2, 2, 2, 2]);
    for (const segment of segments) {
      expect(segment.chapterIds).toEqual(["ch-0"]);
      expect(segment.estimatedDuration).toBeLessThanOrEqual(25);
    }
  });
});

describe("headings", () => {
  test("carries a trailing heading forward so it starts the next segment", () => {
    const book = buildBook([{ blocks: [timed(30), { text: "Section Two", kind: "heading" }, timed(80)] }]);
    const segments = planSegments(
      book,
      book.blocks,
      withOptions({ targetDurationSeconds: 55, maxDurationSeconds: 100 }),
    );

    expect(segments).toHaveLength(2);
    expect(segments[0]!.blockIds).toEqual(["0:0"]);
    expect(segments[1]!.blockIds).toEqual(["0:1", "0:2"]);
  });

  test("never ends a segment on a heading unless the segment is only headings", () => {
    const book = buildBook([
      { blocks: [{ text: "Chapter One", kind: "heading" }, ...paragraphs(4, 20)] },
      { blocks: [{ text: "Chapter Two", kind: "heading" }, ...paragraphs(5, 20)] },
      { blocks: [{ text: "Chapter Three", kind: "heading" }, ...paragraphs(3, 20)] },
    ]);
    const segments = planSegments(
      book,
      book.blocks,
      withOptions({ targetDurationSeconds: 45, maxDurationSeconds: 70 }),
    );
    const byId = new Map(book.blocks.map((block) => [block.id, block]));

    for (const segment of segments) {
      const kinds = segment.blockIds.map((id) => byId.get(id)!.kind);
      if (kinds.every((kind) => kind === "heading")) continue;
      expect(kinds[kinds.length - 1]).not.toBe("heading");
    }
  });

  test("titles a segment with the heading that starts it", () => {
    const book = buildBook([{ title: "Chapter One", blocks: [{ text: "The Harbour", kind: "heading" }, timed(20)] }]);
    const segments = planSegments(book, book.blocks, DEFAULT_SEGMENT_OPTIONS);

    expect(segments[0]!.title).toBe("The Harbour");
  });

  test("falls back to the chapter title with a part number", () => {
    const book = buildBook([{ title: "Chapter One", blocks: paragraphs(4, 10) }]);
    const segments = planSegments(
      book,
      book.blocks,
      withOptions({ targetDurationSeconds: 15, maxDurationSeconds: 100 }),
    );

    expect(segments.map((segment) => segment.title)).toEqual(["Chapter One (part 1)", "Chapter One (part 2)"]);
  });

  test("numbers later parts of a chapter that opened with a heading", () => {
    const book = buildBook([
      { title: "Chapter One", blocks: [{ text: "The Harbour", kind: "heading" }, ...paragraphs(4, 10)] },
    ]);
    const segments = planSegments(
      book,
      book.blocks,
      withOptions({ targetDurationSeconds: 15, maxDurationSeconds: 100 }),
    );

    expect(segments[0]!.title).toBe("The Harbour");
    expect(segments[1]!.title).toBe("Chapter One (part 2)");
  });
});

describe("oversized blocks", () => {
  test("keeps an indivisible block whole in its own oversized segment", () => {
    // The ceiling is soft by necessity: a block longer than the maximum cannot be
    // honoured without splitting it, and never splitting a block wins.
    const book = buildBook([{ blocks: [timed(300)] }]);
    const segments = planSegments(
      book,
      book.blocks,
      withOptions({ targetDurationSeconds: 30, maxDurationSeconds: 60 }),
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]!.blockIds).toEqual(["0:0"]);
    expect(segments[0]!.estimatedDuration).toBeGreaterThan(60);
  });

  test("closes the segment before an oversized block rather than absorbing it", () => {
    const book = buildBook([{ blocks: [timed(30), timed(300)] }]);
    const segments = planSegments(
      book,
      book.blocks,
      withOptions({ targetDurationSeconds: 25, maxDurationSeconds: 60 }),
    );

    expect(segments.map((segment) => segment.blockIds)).toEqual([["0:0"], ["0:1"]]);
  });

  test("dropping a segment's last block always brings it back under the ceiling", () => {
    // The exact invariant that survives the soft ceiling, checked across a book of
    // wildly uneven blocks.
    const book = buildBook([
      { blocks: [timed(5), timed(200), timed(12), timed(40), timed(3)] },
      { blocks: [timed(90), timed(7), timed(150)] },
    ]);
    const options = withOptions({ targetDurationSeconds: 55, maxDurationSeconds: 100 });
    const segments = planSegments(book, book.blocks, options);
    const byId = new Map(book.blocks.map((block) => [block.id, block]));

    for (const segment of segments) {
      const withoutLast = segment.blockIds
        .slice(0, -1)
        .reduce((sum, id) => sum + estimateSpokenSeconds(byId.get(id)!.text, options.wordsPerMinute), 0);
      expect(withoutLast).toBeLessThanOrEqual(options.maxDurationSeconds);
    }
  });
});

describe("CJK narration length", () => {
  test("splits CJK chapters on real narration time, not on word count", () => {
    // Each block is ~100 seconds of Chinese but a single whitespace "word". A
    // word-count estimate would have made this one short segment.
    const book = buildBook([{ blocks: Array.from({ length: 3 }, () => ({ text: "中".repeat(420) })) }]);
    const segments = planSegments(
      book,
      book.blocks,
      withOptions({ targetDurationSeconds: 90, maxDurationSeconds: 150 }),
    );

    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      expect(segment.wordCount).toBe(1);
      expect(segment.estimatedDuration).toBeGreaterThan(90);
      expect(segment.estimatedDuration).toBeLessThan(115);
    }
  });
});
