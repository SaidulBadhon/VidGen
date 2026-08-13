/**
 * Book API integration logic that needs no database, ffmpeg or network.
 *
 * The interesting cases are the ones where two landed workstreams meet: the
 * request schemas that translate the API's snake_case into the segmenter's
 * options, the aggregation that derives a book's progress from its children
 * rather than storing it, the merge that lets a reviewer's override beat the
 * structural pass, and the two guards — revision and per-book concurrency —
 * that make a fan-out of independent tasks safe.
 */

import { describe, expect, test } from "bun:test";

import {
  bookDecisionOverrideSchema,
  bookPaginationSchema,
  bookRenderRequestSchema,
  bookSegmentOptionsSchema,
  bookUploadOptionsSchema,
  renderParamsToDocument,
  segmentOptionsFromDocument,
  segmentOptionsToDocument,
  videoParamsForBookRender,
} from "../src/models/bookSchema.ts";
import {
  aggregateSegmentProgress,
  decisionDocId,
  overridesToDecisions,
  parseDecisionDocId,
  parseSegmentDocId,
  resolveBookDecisions,
  segmentDocId,
} from "../src/db/books.ts";
import {
  BookConcurrencyGate,
  buildSegmentUpserts,
  segmentBlocks,
  segmentNarrationText,
  shouldCommitSegmentResult,
} from "../src/tasks/bookPipeline.ts";
import { detectImageFormat } from "../src/routes/v1/book.ts";
import { DEFAULT_SEGMENT_OPTIONS } from "../src/services/book/types.ts";
import type { Block, BookStructure } from "../src/services/book/types.ts";
import type { BookDecisionDocument, BookSegmentState } from "../src/db/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function block(id: string, text: string, overrides: Partial<Block> = {}): Block {
  return {
    id,
    kind: "paragraph",
    text,
    chapterId: "ch-0",
    order: Number(id.split(":")[1] ?? 0),
    ...overrides,
  };
}

/**
 * A book whose second block is a bare page number.
 *
 * That is enough to exercise the merge: the structural pass drops it, and a
 * reviewer insisting it is prose has to win.
 */
function smallBook(): BookStructure {
  const blocks: Block[] = [
    block("0:0", "Chapter One", { kind: "heading", level: 1, order: 0 }),
    block("0:1", "17", { order: 1 }),
    block("0:2", "The harbour was quiet that morning.", { order: 2 }),
    block("0:3", "She counted the boats twice before leaving.", { order: 3 }),
  ];

  return {
    title: "A Quiet Harbour",
    author: "R. Nyström",
    language: "en",
    chapters: [
      { id: "ch-0", title: "Chapter One", level: 1, order: 0, blockIds: blocks.map((b) => b.id) },
    ],
    blocks,
  };
}

function override(blockId: string, keep: boolean): BookDecisionDocument {
  return {
    _id: decisionDocId("book-1", blockId),
    book_id: "book-1",
    block_id: blockId,
    keep,
    reason: keep ? "Kept by a reviewer." : "Dropped by a reviewer.",
    rule: "user_override",
    confidence: 1,
    source: "user",
    updated_at: new Date(),
  };
}

function segments(...states: BookSegmentState[]): { state: BookSegmentState }[] {
  return states.map((state) => ({ state }));
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

describe("bookSegmentOptionsSchema", () => {
  test("fills every field from the shared segmentation defaults", () => {
    const options = bookSegmentOptionsSchema.parse({});
    expect(options.mode).toBe(DEFAULT_SEGMENT_OPTIONS.mode);
    expect(options.target_duration_seconds).toBe(DEFAULT_SEGMENT_OPTIONS.targetDurationSeconds);
    expect(options.max_duration_seconds).toBe(DEFAULT_SEGMENT_OPTIONS.maxDurationSeconds);
    expect(options.words_per_minute).toBe(DEFAULT_SEGMENT_OPTIONS.wordsPerMinute);
  });

  test("uses snake_case field names", () => {
    const options = bookSegmentOptionsSchema.parse({
      mode: "chapter",
      target_duration_seconds: 600,
      max_duration_seconds: 1200,
      words_per_minute: 170,
    });
    expect(options).toEqual({
      mode: "chapter",
      target_duration_seconds: 600,
      max_duration_seconds: 1200,
      words_per_minute: 170,
    });
  });

  test("rejects a maximum below the target", () => {
    // The maximum would close every segment on the first block past it, which
    // no reading of "target 15 minutes" can mean.
    expect(() =>
      bookSegmentOptionsSchema.parse({ target_duration_seconds: 900, max_duration_seconds: 300 }),
    ).toThrow();
  });

  test("rejects an unknown mode and out-of-range durations", () => {
    expect(() => bookSegmentOptionsSchema.parse({ mode: "paragraph" })).toThrow();
    expect(() => bookSegmentOptionsSchema.parse({ target_duration_seconds: 5 })).toThrow();
    expect(() => bookSegmentOptionsSchema.parse({ words_per_minute: 5000 })).toThrow();
  });

  test("round-trips through the stored document shape", () => {
    const parsed = bookSegmentOptionsSchema.parse({ mode: "chapter", words_per_minute: 140 });
    const options = segmentOptionsFromDocument(segmentOptionsToDocument(parsed));

    expect(options).toEqual({
      mode: "chapter",
      targetDurationSeconds: parsed.target_duration_seconds,
      maxDurationSeconds: parsed.max_duration_seconds,
      wordsPerMinute: 140,
    });
  });
});

describe("bookUploadOptionsSchema", () => {
  test("coerces the strings a multipart form delivers", () => {
    const parsed = bookUploadOptionsSchema.parse({
      mode: "duration",
      target_duration_seconds: "600",
      words_per_minute: "170",
    });
    expect(parsed.target_duration_seconds).toBe(600);
    expect(parsed.words_per_minute).toBe(170);
  });

  test("ignores the file field the form also carries", () => {
    const parsed = bookUploadOptionsSchema.parse({ file: "book.epub", mode: "chapter" });
    expect(parsed).toEqual({ mode: "chapter" });
  });

  test("leaves omitted fields undefined so defaults still apply", () => {
    expect(bookUploadOptionsSchema.parse({})).toEqual({});
  });
});

describe("bookDecisionOverrideSchema", () => {
  test("accepts only a boolean keep", () => {
    expect(bookDecisionOverrideSchema.parse({ keep: false })).toEqual({ keep: false });
    expect(() => bookDecisionOverrideSchema.parse({ keep: "no" })).toThrow();
    expect(() => bookDecisionOverrideSchema.parse({})).toThrow();
  });

  test("drops a client-supplied reason rather than trusting it", () => {
    // reason/rule/confidence describe why the *server* decided something; a
    // client-written reason would put unverifiable text in front of the next
    // reviewer.
    const parsed = bookDecisionOverrideSchema.parse({ keep: true, reason: "because I said so", rule: "x" });
    expect(parsed).toEqual({ keep: true });
  });
});

describe("bookPaginationSchema", () => {
  test("defaults to the first page", () => {
    expect(bookPaginationSchema.parse({})).toEqual({ page: 1, page_size: 50 });
  });

  test("coerces query strings", () => {
    expect(bookPaginationSchema.parse({ page: "3", page_size: "20" })).toEqual({ page: 3, page_size: 20 });
  });

  test("rejects a page below one and a page size past the cap", () => {
    expect(() => bookPaginationSchema.parse({ page: 0 })).toThrow();
    expect(() => bookPaginationSchema.parse({ page_size: 5000 })).toThrow();
  });
});

describe("bookRenderRequestSchema", () => {
  test("requires a voice and defaults the rest", () => {
    expect(() => bookRenderRequestSchema.parse({})).toThrow();

    const parsed = bookRenderRequestSchema.parse({ voice_name: "en-US-JennyNeural" });
    expect(parsed.voice_rate).toBe(1);
    expect(parsed.voice_volume).toBe(1);
    expect(parsed.subtitle_render_mode).toBe("soft");
    // Long-form is watched on a desktop far more often than a phone, unlike the
    // short-video pipeline's portrait default.
    expect(parsed.video_aspect).toBe("16:9");
    expect(parsed.font_name).toBe("MicrosoftYaHeiBold.ttc");
    expect(parsed.n_threads).toBe(2);
  });

  test("rejects an unsupported subtitle mode or aspect", () => {
    const base = { voice_name: "en-US-JennyNeural" };
    expect(() => bookRenderRequestSchema.parse({ ...base, subtitle_render_mode: "karaoke" })).toThrow();
    expect(() => bookRenderRequestSchema.parse({ ...base, video_aspect: "4:3" })).toThrow();
    expect(() => bookRenderRequestSchema.parse({ ...base, voice_rate: 9 })).toThrow();
  });

  test("keeps the styling vocabulary the ASS writer already understands", () => {
    const params = renderParamsToDocument(
      bookRenderRequestSchema.parse({
        voice_name: "en-US-JennyNeural",
        video_aspect: "9:16",
        font_size: 48,
        text_fore_color: "#FFEE00",
        text_background_color: "#101010",
        subtitle_position: "custom",
        custom_position: 60,
      }),
    );

    const videoParams = videoParamsForBookRender(params);
    expect(videoParams.video_aspect).toBe("9:16");
    expect(videoParams.font_size).toBe(48);
    expect(videoParams.text_fore_color).toBe("#FFEE00");
    expect(videoParams.text_background_color).toBe("#101010");
    expect(videoParams.subtitle_position).toBe("custom");
    expect(videoParams.custom_position).toBe(60);
  });

  test("accepts a subset of segments for a partial render", () => {
    const parsed = bookRenderRequestSchema.parse({ voice_name: "v", segment_indexes: [0, 4, 9] });
    expect(parsed.segment_indexes).toEqual([0, 4, 9]);
    expect(() => bookRenderRequestSchema.parse({ voice_name: "v", segment_indexes: [-1] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Composite ids
// ---------------------------------------------------------------------------

describe("composite ids", () => {
  test("builds and parses a segment id", () => {
    const id = segmentDocId("9b1c-book", 12);
    expect(id).toBe("9b1c-book:12");
    expect(parseSegmentDocId(id)).toEqual({ bookId: "9b1c-book", index: 12 });
  });

  test("parses a decision id whose block id contains its own colon", () => {
    // Block ids are `${chapterIndex}:${blockIndex}`, so splitting on every
    // colon would lose the block entirely.
    const id = decisionDocId("9b1c-book", "3:17");
    expect(id).toBe("9b1c-book:3:17");
    expect(parseDecisionDocId(id)).toEqual({ bookId: "9b1c-book", blockId: "3:17" });
  });

  test("rejects ids with no separator or no payload", () => {
    expect(parseSegmentDocId("no-colon")).toBeNull();
    expect(parseSegmentDocId(":12")).toBeNull();
    expect(parseSegmentDocId("book:")).toBeNull();
    expect(parseDecisionDocId("no-colon")).toBeNull();
  });

  test("rejects a segment id whose index is not a non-negative integer", () => {
    expect(parseSegmentDocId("book:abc")).toBeNull();
    expect(parseSegmentDocId("book:-1")).toBeNull();
    expect(parseSegmentDocId("book:1.5")).toBeNull();
  });

  test("keeps a uuid book id intact", () => {
    const bookId = "f81d4fae-7dec-11d0-a765-00a0c91e6bf6";
    expect(parseSegmentDocId(segmentDocId(bookId, 0))).toEqual({ bookId, index: 0 });
    expect(parseDecisionDocId(decisionDocId(bookId, "0:0"))).toEqual({ bookId, blockId: "0:0" });
  });
});

// ---------------------------------------------------------------------------
// Progress aggregation
// ---------------------------------------------------------------------------

describe("aggregateSegmentProgress", () => {
  test("reports an unplanned book as ready at zero", () => {
    expect(aggregateSegmentProgress([])).toMatchObject({ total: 0, progress: 0, state: "ready" });
  });

  test("counts every state", () => {
    const progress = aggregateSegmentProgress(
      segments("pending", "queued", "rendering", "complete", "failed", "complete"),
    );

    expect(progress.total).toBe(6);
    expect(progress.pending).toBe(1);
    expect(progress.queued).toBe(1);
    expect(progress.rendering).toBe(1);
    expect(progress.complete).toBe(2);
    expect(progress.failed).toBe(1);
    expect(progress.progress).toBe(33);
  });

  test("is rendering while anything is queued or in flight", () => {
    expect(aggregateSegmentProgress(segments("complete", "queued")).state).toBe("rendering");
    expect(aggregateSegmentProgress(segments("failed", "rendering")).state).toBe("rendering");
  });

  test("is complete only when every segment completed", () => {
    expect(aggregateSegmentProgress(segments("complete", "complete")).state).toBe("complete");
    expect(aggregateSegmentProgress(segments("complete", "complete")).progress).toBe(100);
  });

  test("is failed only when every segment failed", () => {
    const progress = aggregateSegmentProgress(segments("failed", "failed", "failed"));
    expect(progress.state).toBe("failed");
    expect(progress.progress).toBe(0);
  });

  test("reports a partly failed book as ready, not failed", () => {
    // The failures are visible per segment; the book as a whole is still
    // something the user can act on by retrying, so condemning it would be
    // both wrong and unhelpful.
    const progress = aggregateSegmentProgress(segments("complete", "failed"));
    expect(progress.state).toBe("ready");
    expect(progress.progress).toBe(50);
  });

  test("leaves a book with unrendered segments in ready", () => {
    expect(aggregateSegmentProgress(segments("pending", "pending")).state).toBe("ready");
    expect(aggregateSegmentProgress(segments("complete", "pending")).state).toBe("ready");
  });

  test("ignores a state the schema never produces", () => {
    const progress = aggregateSegmentProgress([{ state: "bogus" as BookSegmentState }]);
    expect(progress.total).toBe(1);
    expect(progress.complete).toBe(0);
    expect(progress.state).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// Decision merge
// ---------------------------------------------------------------------------

describe("resolveBookDecisions", () => {
  test("classifies structurally when there are no overrides", () => {
    const decisions = resolveBookDecisions(smallBook(), []);
    const byId = new Map(decisions.map((decision) => [decision.blockId, decision]));

    expect(decisions).toHaveLength(4);
    expect(byId.get("0:1")?.keep).toBe(false);
    expect(byId.get("0:1")?.rule).toBe("page_number");
    expect(byId.get("0:2")?.keep).toBe(true);
    expect(byId.get("0:2")?.source).toBe("structural");
  });

  test("lets a user override beat the structural decision", () => {
    const decisions = resolveBookDecisions(smallBook(), [override("0:1", true)]);
    const restored = decisions.find((decision) => decision.blockId === "0:1");

    expect(restored?.keep).toBe(true);
    expect(restored?.source).toBe("user");
    expect(restored?.rule).toBe("user_override");
  });

  test("lets a user drop a block the structural pass kept", () => {
    const decisions = resolveBookDecisions(smallBook(), [override("0:3", false)]);
    expect(decisions.find((decision) => decision.blockId === "0:3")?.keep).toBe(false);
  });

  test("changes only the overridden block", () => {
    const decisions = resolveBookDecisions(smallBook(), [override("0:1", true)]);
    expect(decisions.filter((decision) => decision.source === "user")).toHaveLength(1);
    expect(decisions.find((decision) => decision.blockId === "0:2")?.source).toBe("structural");
  });

  test("preserves structural order so the review list does not reshuffle", () => {
    const decisions = resolveBookDecisions(smallBook(), [override("0:3", false), override("0:1", true)]);
    expect(decisions.map((decision) => decision.blockId)).toEqual(["0:0", "0:1", "0:2", "0:3"]);
  });

  test("maps stored override rows onto filter decisions", () => {
    const [decision] = overridesToDecisions([override("0:1", true)]);
    expect(decision).toEqual({
      blockId: "0:1",
      keep: true,
      reason: "Kept by a reviewer.",
      rule: "user_override",
      confidence: 1,
      source: "user",
    });
  });
});

// ---------------------------------------------------------------------------
// Narration assembly
// ---------------------------------------------------------------------------

describe("segment narration", () => {
  test("takes only the kept blocks of the requested segment, in reading order", () => {
    const structure = smallBook();
    const decisions = resolveBookDecisions(structure, []);
    const blocks = segmentBlocks(structure, decisions, ["0:3", "0:1", "0:2"]);

    expect(blocks.map((b) => b.id)).toEqual(["0:2", "0:3"]);
  });

  test("honours an override made after the segment was planned", () => {
    // Re-filtering at render time is what lets a reviewer's change take effect
    // without forcing a re-segmentation.
    const structure = smallBook();
    const decisions = resolveBookDecisions(structure, [override("0:2", false)]);
    const blocks = segmentBlocks(structure, decisions, ["0:1", "0:2", "0:3"]);

    expect(blocks.map((b) => b.id)).toEqual(["0:3"]);
  });

  test("separates blocks with a blank line so the chunker keeps paragraphs whole", () => {
    const structure = smallBook();
    const blocks = segmentBlocks(structure, resolveBookDecisions(structure, []), ["0:0", "0:2"]);
    expect(segmentNarrationText(blocks)).toBe(
      "Chapter One\n\nThe harbour was quiet that morning.",
    );
  });

  test("returns empty text when every block was filtered out", () => {
    const structure = smallBook();
    const decisions = resolveBookDecisions(structure, []);
    expect(segmentNarrationText(segmentBlocks(structure, decisions, ["0:1"]))).toBe("");
  });
});

describe("buildSegmentUpserts", () => {
  test("plans unrendered segments stamped with the book revision", () => {
    const structure = smallBook();
    const decisions = resolveBookDecisions(structure, []);
    const planned = buildSegmentUpserts("book-1", structure, decisions, DEFAULT_SEGMENT_OPTIONS, 7);

    expect(planned.length).toBeGreaterThan(0);
    for (const segment of planned) {
      expect(segment.book_id).toBe("book-1");
      expect(segment.state).toBe("pending");
      expect(segment.revision).toBe(7);
      expect(segment.task_id).toBeNull();
      expect(segment.video_path).toBeNull();
    }
    expect(planned.map((segment) => segment.index)).toEqual(planned.map((_, index) => index));
  });

  test("never plans a block the decisions dropped", () => {
    const structure = smallBook();
    const decisions = resolveBookDecisions(structure, []);
    const planned = buildSegmentUpserts("book-1", structure, decisions, DEFAULT_SEGMENT_OPTIONS, 1);

    expect(planned.flatMap((segment) => segment.block_ids)).not.toContain("0:1");
  });
});

// ---------------------------------------------------------------------------
// Revision guard
// ---------------------------------------------------------------------------

describe("shouldCommitSegmentResult", () => {
  test("commits when the book is unchanged", () => {
    expect(shouldCommitSegmentResult({ book: { revision: 3 }, expectedRevision: 3 })).toBe(true);
  });

  test("abandons when the book was re-planned underneath the render", () => {
    expect(shouldCommitSegmentResult({ book: { revision: 4 }, expectedRevision: 3 })).toBe(false);
  });

  test("abandons when the book was deleted", () => {
    expect(shouldCommitSegmentResult({ book: null, expectedRevision: 3 })).toBe(false);
    expect(shouldCommitSegmentResult({ book: undefined, expectedRevision: 3 })).toBe(false);
  });

  test("abandons on a revision that somehow went backwards", () => {
    // Equality rather than `>=`: any divergence means the plan is not the one
    // this render was built from.
    expect(shouldCommitSegmentResult({ book: { revision: 2 }, expectedRevision: 3 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-book concurrency gate
// ---------------------------------------------------------------------------

describe("BookConcurrencyGate", () => {
  test("admits up to the limit without waiting", async () => {
    const gate = new BookConcurrencyGate(2);

    await gate.acquire("book-1");
    await gate.acquire("book-1");

    expect(gate.activeCount("book-1")).toBe(2);
    expect(gate.waitingCount("book-1")).toBe(0);
  });

  test("holds the next segment back until one finishes", async () => {
    const gate = new BookConcurrencyGate(2);
    await gate.acquire("book-1");
    await gate.acquire("book-1");

    let admitted = false;
    const third = gate.acquire("book-1").then(() => {
      admitted = true;
    });

    await Bun.sleep(1);
    expect(admitted).toBe(false);
    expect(gate.waitingCount("book-1")).toBe(1);

    gate.release("book-1");
    await third;
    expect(admitted).toBe(true);
    // The slot transfers straight to the waiter, so the count never dips and a
    // fourth segment cannot slip in during the handover.
    expect(gate.activeCount("book-1")).toBe(2);
    expect(gate.waitingCount("book-1")).toBe(0);
  });

  test("never exceeds the limit under a burst", async () => {
    const gate = new BookConcurrencyGate(2);
    let running = 0;
    let peak = 0;

    const work = Array.from({ length: 8 }, async () => {
      await gate.acquire("book-1");
      running += 1;
      peak = Math.max(peak, running);
      await Bun.sleep(1);
      running -= 1;
      gate.release("book-1");
    });

    await Promise.all(work);
    expect(peak).toBe(2);
    expect(gate.activeCount("book-1")).toBe(0);
  });

  test("caps each book independently", async () => {
    // The cap exists so one book cannot occupy the whole global queue, not to
    // serialise books against each other.
    const gate = new BookConcurrencyGate(1);
    await gate.acquire("book-1");

    let secondAdmitted = false;
    void gate.acquire("book-2").then(() => {
      secondAdmitted = true;
    });

    await Bun.sleep(1);
    expect(secondAdmitted).toBe(true);
    expect(gate.activeCount("book-1")).toBe(1);
    expect(gate.activeCount("book-2")).toBe(1);
  });

  test("forgets a book once its last slot is freed", async () => {
    const gate = new BookConcurrencyGate(2);
    await gate.acquire("book-1");
    gate.release("book-1");
    expect(gate.activeCount("book-1")).toBe(0);
  });

  test("survives a release with nothing outstanding", () => {
    const gate = new BookConcurrencyGate(2);
    gate.release("book-1");
    expect(gate.activeCount("book-1")).toBe(0);
    expect(gate.waitingCount("book-1")).toBe(0);
  });

  test("hands slots to waiters in the order they queued", async () => {
    const gate = new BookConcurrencyGate(1);
    await gate.acquire("book-1");

    const order: number[] = [];
    const first = gate.acquire("book-1").then(() => order.push(1));
    const second = gate.acquire("book-1").then(() => order.push(2));

    gate.release("book-1");
    await first;
    gate.release("book-1");
    await second;

    expect(order).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Upload validation
// ---------------------------------------------------------------------------

describe("detectImageFormat", () => {
  test("recognises PNG, JPEG and WebP from their magic bytes", () => {
    expect(detectImageFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    expect(detectImageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");

    const webp = new Uint8Array(12);
    webp.set([...new TextEncoder().encode("RIFF")], 0);
    webp.set([...new TextEncoder().encode("WEBP")], 8);
    expect(detectImageFormat(webp)).toBe("webp");
  });

  test("rejects a file that only claims to be an image", () => {
    // The extension is the uploader's claim; ffmpeg reads what is actually
    // there, so the bytes decide.
    expect(detectImageFormat(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBeNull();
    expect(detectImageFormat(new Uint8Array([]))).toBeNull();
    expect(detectImageFormat(new TextEncoder().encode("<svg></svg>"))).toBeNull();
  });

  test("rejects a truncated header rather than reading past the end", () => {
    expect(detectImageFormat(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(detectImageFormat(new TextEncoder().encode("RIFF1234"))).toBeNull();
  });
});
