/**
 * Book state: Mongo documents for the small parts, the filesystem for the text.
 * Mirrors tasks/state.ts in style.
 *
 * The split is the whole design. A book's `BookStructure` is 0.7-1.5 MB of text
 * for a 400-page title and grows with the book, so it is written to
 * `storage/books/<bookId>/structure.json` and never to a document. What Mongo
 * holds is what has to be queried, updated concurrently or watched: the book
 * header, one row per planned segment, and one row per *user override* of a
 * filter decision.
 *
 * Structural decisions are deliberately not stored. Recomputing them from
 * structure.json costs milliseconds, keeps writes to a handful of documents
 * instead of the tens of thousands a whole book would produce, and means an
 * improvement to the rules applies to books that already exist.
 */

import { rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  bookBlockEditsCollection,
  bookDecisionsCollection,
  bookSegmentsCollection,
  booksCollection,
} from "./client.ts";
import type {
  BookBlockEditDocument,
  BookDecisionDocument,
  BookDocument,
  BookSegmentDocument,
  BookSegmentState,
  BookState,
} from "./types.ts";
import { classifyBlocks } from "../services/book/filter/structural.ts";
import { mergeDecisions } from "../services/book/filter/decisions.ts";
import type { BookStructure, FilterDecision } from "../services/book/types.ts";
import { booksDir, rewritePathPrefix } from "../utils/paths.ts";
import { logger, errorMessage } from "../utils/logger.ts";

// ---------------------------------------------------------------------------
// Composite ids (pure)
// ---------------------------------------------------------------------------

/**
 * Composite `_id` for a segment.
 *
 * A composite key rather than a generated id means a re-plan overwrites the
 * previous plan's rows in place, so a book can never accumulate two segment 3s.
 */
export function segmentDocId(bookId: string, index: number): string {
  return `${bookId}:${index}`;
}

/**
 * Composite `_id` for a decision override.
 *
 * Block ids are themselves `${chapterIndex}:${blockIndex}`, so both parsers
 * below split on the *first* colon only; splitting on every colon would turn
 * `uuid:3:17` into three fields and lose the block.
 */
export function decisionDocId(bookId: string, blockId: string): string {
  return `${bookId}:${blockId}`;
}

/** Composite `_id` for a block text edit. Same shape, different collection. */
export function blockEditDocId(bookId: string, blockId: string): string {
  return `${bookId}:${blockId}`;
}

function splitOnce(id: string): { bookId: string; rest: string } | null {
  const separator = String(id ?? "").indexOf(":");
  if (separator <= 0 || separator >= id.length - 1) return null;
  return { bookId: id.slice(0, separator), rest: id.slice(separator + 1) };
}

export function parseSegmentDocId(id: string): { bookId: string; index: number } | null {
  const parts = splitOnce(id);
  if (!parts) return null;

  const index = Number(parts.rest);
  if (!Number.isInteger(index) || index < 0) return null;
  return { bookId: parts.bookId, index };
}

export function parseDecisionDocId(id: string): { bookId: string; blockId: string } | null {
  const parts = splitOnce(id);
  return parts ? { bookId: parts.bookId, blockId: parts.rest } : null;
}

// ---------------------------------------------------------------------------
// Structure on disk
// ---------------------------------------------------------------------------

export function bookDir(bookId: string): string {
  return booksDir(bookId);
}

export function bookStructurePath(bookId: string): string {
  return join(booksDir(bookId), "structure.json");
}

/**
 * Writes the extracted structure, atomically.
 *
 * A partially written structure.json is worse than none at all: every later
 * read — the review UI, every segment render — would fail on it, and the book
 * would look corrupt rather than incomplete. Writing to a sibling and renaming
 * makes the swap a single filesystem operation.
 */
export async function writeBookStructure(bookId: string, structure: BookStructure): Promise<string> {
  const path = bookStructurePath(bookId);
  const tempPath = `${path}.tmp`;
  await Bun.write(tempPath, JSON.stringify(structure));
  await rename(tempPath, path);
  return path;
}

export async function readBookStructure(bookId: string): Promise<BookStructure | null> {
  const path = bookStructurePath(bookId);
  if (!existsSync(path)) return null;

  try {
    return (await Bun.file(path).json()) as BookStructure;
  } catch (error) {
    logger.error(`unreadable book structure: ${path}, error: ${errorMessage(error)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------

export type BookCreate = Omit<BookDocument, "created_at" | "updated_at" | "revision"> & {
  revision?: number;
};

export async function createBook(book: BookCreate): Promise<BookDocument> {
  const now = new Date();
  const document: BookDocument = {
    ...book,
    revision: book.revision ?? 1,
    created_at: now,
    updated_at: now,
  };
  await booksCollection().insertOne(document);
  return document;
}

export async function getBook(bookId: string): Promise<BookDocument | null> {
  return booksCollection().findOne({ _id: bookId });
}

export type BookPatch = Partial<Omit<BookDocument, "_id" | "created_at">>;

/** Updates only an existing book, so a deleted book is never resurrected. */
export async function patchBook(bookId: string, fields: BookPatch): Promise<boolean> {
  const update = stripUndefined(fields);
  if (Object.keys(update).length === 0) return false;

  const result = await booksCollection().updateOne(
    { _id: bookId },
    { $set: { ...update, updated_at: new Date() } },
  );
  return result.matchedCount > 0;
}

/**
 * Bumps the revision and returns the new value.
 *
 * `$inc` rather than read-modify-write: two reviewers toggling different blocks
 * at the same moment must both invalidate in-flight renders, and a lost update
 * here would let a stale task write its results.
 */
export async function bumpBookRevision(bookId: string, fields: BookPatch = {}): Promise<number | null> {
  const result = await booksCollection().findOneAndUpdate(
    { _id: bookId },
    { $inc: { revision: 1 }, $set: { ...stripUndefined(fields), updated_at: new Date() } },
    { returnDocument: "after" },
  );
  return result?.revision ?? null;
}

export async function listBooks(
  page = 1,
  pageSize = 10,
): Promise<{ books: BookDocument[]; total: number }> {
  const collection = booksCollection();
  const skip = Math.max(0, (page - 1) * pageSize);

  const [books, total] = await Promise.all([
    collection.find({}).sort({ created_at: -1 }).skip(skip).limit(pageSize).toArray(),
    collection.countDocuments({}),
  ]);

  return { books, total };
}

/** Removes the book and every child row. Files are the caller's business. */
export async function deleteBook(bookId: string): Promise<void> {
  await Promise.all([
    booksCollection().deleteOne({ _id: bookId }),
    bookSegmentsCollection().deleteMany({ book_id: bookId }),
    bookDecisionsCollection().deleteMany({ book_id: bookId }),
    bookBlockEditsCollection().deleteMany({ book_id: bookId }),
  ]);
}

/**
 * Removes structure.json, the cover and anything else under the book's dir.
 *
 * The path is joined rather than taken from `booksDir(bookId)`, which would
 * create the directory a moment before deleting it.
 */
export async function deleteBookFiles(bookId: string): Promise<void> {
  await rm(join(booksDir(), bookId), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

export type BookSegmentUpsert = Omit<BookSegmentDocument, "_id" | "updated_at">;

export async function upsertBookSegment(segment: BookSegmentUpsert): Promise<BookSegmentDocument> {
  const document: BookSegmentDocument = {
    _id: segmentDocId(segment.book_id, segment.index),
    ...segment,
    updated_at: new Date(),
  };

  const { _id, ...body } = document;
  await bookSegmentsCollection().replaceOne({ _id }, body, { upsert: true });
  return document;
}

export type BookSegmentPatch = Partial<Omit<BookSegmentDocument, "_id" | "book_id" | "index">>;

/** Patches an existing segment; false when the plan moved on and it is gone. */
export async function patchBookSegment(
  bookId: string,
  index: number,
  fields: BookSegmentPatch,
): Promise<boolean> {
  const update = stripUndefined(fields);
  if (Object.keys(update).length === 0) return false;

  const result = await bookSegmentsCollection().updateOne(
    { _id: segmentDocId(bookId, index) },
    { $set: { ...update, updated_at: new Date() } },
  );
  return result.matchedCount > 0;
}

export async function getBookSegment(bookId: string, index: number): Promise<BookSegmentDocument | null> {
  return bookSegmentsCollection().findOne({ _id: segmentDocId(bookId, index) });
}

export async function listBookSegments(bookId: string): Promise<BookSegmentDocument[]> {
  return bookSegmentsCollection().find({ book_id: bookId }).sort({ index: 1 }).toArray();
}

export async function deleteBookSegments(bookId: string): Promise<void> {
  await bookSegmentsCollection().deleteMany({ book_id: bookId });
}

/**
 * Points stored segment files at a new output folder after a book is renamed.
 *
 * The files themselves are the caller's to move; this only rewrites the
 * absolute paths already saved on each row so downloads keep resolving.
 */
export async function rewriteSegmentOutputPaths(
  bookId: string,
  fromDir: string,
  toDir: string,
): Promise<number> {
  if (fromDir === toDir) return 0;

  const segments = await listBookSegments(bookId);
  let updated = 0;
  for (const segment of segments) {
    const audio_path = rewritePathPrefix(segment.audio_path, fromDir, toDir);
    const video_path = rewritePathPrefix(segment.video_path, fromDir, toDir);
    const subtitle_path = rewritePathPrefix(segment.subtitle_path, fromDir, toDir);
    if (
      audio_path === segment.audio_path &&
      video_path === segment.video_path &&
      subtitle_path === segment.subtitle_path
    ) {
      continue;
    }
    await patchBookSegment(bookId, segment.index, { audio_path, video_path, subtitle_path });
    updated += 1;
  }
  return updated;
}

/** Replaces the whole plan in one pass, so no row of the old plan survives. */
export async function replaceBookSegments(
  bookId: string,
  segments: BookSegmentUpsert[],
): Promise<BookSegmentDocument[]> {
  await deleteBookSegments(bookId);
  if (segments.length === 0) return [];

  const now = new Date();
  const documents: BookSegmentDocument[] = segments.map((segment) => ({
    _id: segmentDocId(segment.book_id, segment.index),
    ...segment,
    updated_at: now,
  }));

  await bookSegmentsCollection().insertMany(documents);
  return documents;
}

// ---------------------------------------------------------------------------
// Decision overrides
// ---------------------------------------------------------------------------

export type BookDecisionUpsert = Omit<BookDecisionDocument, "_id" | "updated_at">;

export async function upsertDecisionOverride(
  override: BookDecisionUpsert,
): Promise<BookDecisionDocument> {
  const document: BookDecisionDocument = {
    _id: decisionDocId(override.book_id, override.block_id),
    ...override,
    updated_at: new Date(),
  };

  const { _id, ...body } = document;
  await bookDecisionsCollection().replaceOne({ _id }, body, { upsert: true });
  return document;
}

export async function listDecisionOverrides(bookId: string): Promise<BookDecisionDocument[]> {
  return bookDecisionsCollection().find({ book_id: bookId }).toArray();
}

export async function deleteDecisionOverrides(bookId: string): Promise<void> {
  await bookDecisionsCollection().deleteMany({ book_id: bookId });
}

/** Stored override rows as the `FilterDecision`s the merge expects. */
export function overridesToDecisions(overrides: BookDecisionDocument[]): FilterDecision[] {
  return overrides.map((override) => ({
    blockId: override.block_id,
    keep: override.keep,
    reason: override.reason,
    rule: override.rule,
    confidence: override.confidence,
    source: override.source,
  }));
}

/**
 * The book's effective decisions: the structural pass, refined by overrides.
 *
 * Pure, and the single place the two halves meet — every read path (review UI,
 * segment planning, narration assembly) goes through it, so none of them can
 * drift into using a stale or partial view of what survives filtering.
 */
export function resolveBookDecisions(
  structure: BookStructure,
  overrides: BookDecisionDocument[],
): FilterDecision[] {
  return mergeDecisions(classifyBlocks(structure), overridesToDecisions(overrides));
}

// ---------------------------------------------------------------------------
// Block text edits
// ---------------------------------------------------------------------------

export async function upsertBlockEdit(
  bookId: string,
  blockId: string,
  text: string,
): Promise<BookBlockEditDocument> {
  const document: BookBlockEditDocument = {
    _id: blockEditDocId(bookId, blockId),
    book_id: bookId,
    block_id: blockId,
    text,
    updated_at: new Date(),
  };

  const { _id, ...body } = document;
  await bookBlockEditsCollection().replaceOne({ _id }, body, { upsert: true });
  return document;
}

/** Drops an edit, which restores the extracted text. True when one existed. */
export async function deleteBlockEdit(bookId: string, blockId: string): Promise<boolean> {
  const result = await bookBlockEditsCollection().deleteOne({ _id: blockEditDocId(bookId, blockId) });
  return result.deletedCount > 0;
}

export async function listBlockEdits(bookId: string): Promise<BookBlockEditDocument[]> {
  return bookBlockEditsCollection().find({ book_id: bookId }).toArray();
}

export async function deleteBlockEdits(bookId: string): Promise<void> {
  await bookBlockEditsCollection().deleteMany({ book_id: bookId });
}

/**
 * The book's text as the reviewer has left it: extraction, overlaid with edits.
 *
 * Pure, and applied *after* decisions are resolved, never before. Classifying
 * edited text would let a rewrite silently flip a block from kept to dropped —
 * a reviewer fixing a typo would watch a paragraph vanish from the plan. So the
 * rules always see what extraction produced, and only narration, duration
 * estimates and what the review UI displays see the rewrite.
 *
 * Returns `structure` itself when nothing is edited, which is the common case.
 */
export function applyBlockEdits(
  structure: BookStructure,
  edits: BookBlockEditDocument[],
): BookStructure {
  if (edits.length === 0) return structure;

  const byBlockId = new Map(edits.map((edit) => [edit.block_id, edit.text]));
  return {
    ...structure,
    blocks: structure.blocks.map((block) => {
      const text = byBlockId.get(block.id);
      return text === undefined || text === block.text ? block : { ...block, text };
    }),
  };
}

/** Reads the structure and its edits together, for every path that narrates. */
export async function readEditedBookStructure(
  bookId: string,
): Promise<{ structure: BookStructure; edited: BookStructure } | null> {
  const structure = await readBookStructure(bookId);
  if (!structure) return null;
  return { structure, edited: applyBlockEdits(structure, await listBlockEdits(bookId)) };
}

// ---------------------------------------------------------------------------
// Progress (pure aggregation)
// ---------------------------------------------------------------------------

export interface BookProgress {
  total: number;
  pending: number;
  queued: number;
  rendering: number;
  complete: number;
  failed: number;
  /** 0-100, finished segments over planned segments. */
  progress: number;
  /** Book state implied by its children; never stored by hand. */
  state: BookState;
}

const EMPTY_COUNTS: Record<BookSegmentState, number> = {
  pending: 0,
  queued: 0,
  rendering: 0,
  complete: 0,
  failed: 0,
};

/**
 * Derives a book's aggregate state from its segments.
 *
 * Aggregate progress is never a stored number. A book is a fan-out of
 * independent tasks that fail, get retried and get re-planned, so any
 * hand-maintained counter would be wrong the moment one of them crashed
 * between its update and the parent's.
 *
 * A book with failures alongside unfinished work reports `ready` rather than
 * `failed`: the failures are visible per segment, and the book as a whole is
 * still something the user can act on by retrying.
 */
export function aggregateSegmentProgress(
  segments: readonly { state: BookSegmentState }[],
): BookProgress {
  const counts = { ...EMPTY_COUNTS };
  for (const segment of segments) {
    if (segment.state in counts) counts[segment.state] += 1;
  }

  const total = segments.length;
  const active = counts.queued + counts.rendering;

  let state: BookState;
  if (total === 0) state = "ready";
  else if (active > 0) state = "rendering";
  else if (counts.complete === total) state = "complete";
  else if (counts.failed === total) state = "failed";
  else state = "ready";

  return {
    total,
    ...counts,
    progress: total === 0 ? 0 : Math.round((counts.complete / total) * 100),
    state,
  };
}

/** Reads a book's segments and derives its aggregate progress. */
export async function bookProgress(bookId: string): Promise<BookProgress> {
  const segments = await bookSegmentsCollection()
    .find({ book_id: bookId }, { projection: { state: 1 } })
    .toArray();
  return aggregateSegmentProgress(segments);
}

/**
 * Book states that describe the book itself rather than a render.
 *
 * Deriving a state from segment rows only makes sense once there is a book to
 * segment. Before that — while it is extracting, while a scan is queued for or
 * going through OCR, or after extraction failed outright — the segment table is
 * empty, and `aggregateSegmentProgress` reads an empty table as `ready`. Letting
 * that through would advertise a book as reviewable half an hour before it has
 * a word in it.
 */
const SELF_DESCRIBING_BOOK_STATES: ReadonlySet<BookState> = new Set<BookState>([
  "extracting",
  "ocr_pending",
  "ocr",
  "failed",
]);

/** True while a book is queued for, or going through, recognition. */
export function isBookOcrState(state: BookState): boolean {
  return state === "ocr_pending" || state === "ocr";
}

/**
 * Writes the derived state back onto the book.
 *
 * Extraction failures are left alone: they describe the book itself rather than
 * a render, and no segment outcome should clear one.
 */
export async function syncBookState(bookId: string): Promise<BookProgress> {
  const progress = await bookProgress(bookId);
  const book = await getBook(bookId);
  if (book && !SELF_DESCRIBING_BOOK_STATES.has(book.state)) {
    await patchBook(bookId, { state: progress.state });
  }
  return progress;
}

/** Drops undefined fields so `$set` never overwrites a stored value with null. */
function stripUndefined(value: object): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result;
}
