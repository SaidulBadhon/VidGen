/**
 * Long-form book API: upload, review, segment, render.
 *
 * Conventions follow routes/v1/video.ts — `getResponse(200, data)`, the helpers
 * from http/errors.ts, `streamSSE` for progress — with one deliberate departure.
 * The task SSE re-serialises the whole document every second, which is fine for
 * a short video and would be untenable for a book whose segment list runs into
 * the hundreds, so the book stream sends a small projection instead.
 *
 * Nothing here stores book text in Mongo: the structure lives on disk and only
 * user overrides of filter decisions are persisted, with the structural pass
 * recomputed on read. See db/books.ts for why.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import { appConfig } from "../../config/settings.ts";
import {
  applyBlockEdits,
  bookDir,
  bookProgress,
  createBook,
  deleteBlockEdit,
  deleteBook,
  deleteBookFiles,
  getBook,
  getBookSegment,
  listBlockEdits,
  listBookSegments,
  listBooks,
  listDecisionOverrides,
  patchBook,
  patchBookSegment,
  readBookStructure,
  replaceBookSegments,
  resolveBookDecisions,
  syncBookState,
  upsertBlockEdit,
  upsertDecisionOverride,
  writeBookStructure,
  bumpBookRevision,
  aggregateSegmentProgress,
  isBookOcrState,
} from "../../db/books.ts";
import type { BookDocument, BookSegmentDocument } from "../../db/types.ts";
import { badRequest, conflict, notFound } from "../../http/errors.ts";
import { serveFileWithRange } from "../../http/staticFiles.ts";
import {
  bookBlockTextSchema,
  bookDecisionOverrideSchema,
  bookPaginationSchema,
  bookRenderRequestSchema,
  bookSegmentOptionsSchema,
  bookUploadOptionsSchema,
  renderParamsToDocument,
  segmentOptionsFromDocument,
  segmentOptionsToDocument,
} from "../../models/bookSchema.ts";
import { extractBook, detectBookFormat, type PdfScanReport } from "../../services/book/extract/index.ts";
import { decisionSummary, keptBlocks } from "../../services/book/filter/decisions.ts";
import { isOcrEnabled } from "../../services/book/ocr/index.ts";
import { BookExtractionError, type ExtractionResult } from "../../services/book/types.ts";
import {
  ACTIVE_SEGMENT_STATES,
  bookGateStats,
  buildSegmentUpserts,
  renderBookSegments,
  segmentBlocks,
} from "../../tasks/bookPipeline.ts";
import { estimateSpokenSeconds } from "../../services/book/segment.ts";
import { ocrSourcePath, startBookOcr } from "../../tasks/ocrPipeline.ts";
import { taskQueue } from "../../tasks/queue.ts";
import { deleteTask, getRecentTaskLogs, getTask } from "../../tasks/state.ts";
import { resolvePathWithinDirectory, sanitizeUploadFilename, UnsafePathError } from "../../utils/fileSecurity.ts";
import { errorMessage, logger } from "../../utils/logger.ts";
import { getResponse, getUuid, sleep } from "../../utils/misc.ts";
import { bookProjectFolderName, taskDir } from "../../utils/paths.ts";

export const bookRouter = new Hono();

// ---------------------------------------------------------------------------
// Upload limits and validation
// ---------------------------------------------------------------------------

/**
 * Upload ceiling.
 *
 * A dense 1000-page EPUB is a few megabytes; 64 MB is generous for anything
 * this pipeline can narrate and still small enough that a hostile upload cannot
 * exhaust memory while the multipart body is buffered.
 */
export const MAX_BOOK_UPLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_COVER_UPLOAD_BYTES = 12 * 1024 * 1024;

const ALLOWED_BOOK_EXTENSIONS = ["epub", "pdf", "txt", "text", "md", "markdown"] as const;
const ALLOWED_COVER_EXTENSIONS = ["png", "jpg", "jpeg", "webp"] as const;

/** `PK\x03\x04`; every zip, and therefore every EPUB, starts with it. */
function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** `%PDF`. Real files sometimes carry junk before it, so a short prefix is scanned. */
function isPdf(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length - 4, 1024);
  for (let index = 0; index <= limit; index++) {
    if (
      bytes[index] === 0x25 &&
      bytes[index + 1] === 0x50 &&
      bytes[index + 2] === 0x44 &&
      bytes[index + 3] === 0x46
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Identifies an image from its magic bytes.
 *
 * The extension is a claim by the uploader; ffmpeg will read whatever is
 * actually there, so the bytes are what decides whether this is an image at
 * all.
 */
export function detectImageFormat(bytes: Uint8Array): "png" | "jpeg" | "webp" | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) === "RIFF" &&
    String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

function extensionOf(filename: string): string {
  return extname(filename).toLowerCase().replace(/^\./, "");
}

/**
 * Refuses an oversized body before it is buffered.
 *
 * `c.req.formData()` reads the whole multipart body into memory, so checking
 * the file size afterwards is already too late to stop a hostile upload from
 * costing that memory. Content-Length is a claim rather than proof, which is
 * why the byte length is checked again once the file is in hand.
 */
function rejectOversizedBody(contentLength: string | undefined, maxBytes: number, what: string): void {
  const declared = Number(contentLength);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw badRequest(`${what} exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB limit`);
  }
}

async function readUpload(
  file: File,
  maxBytes: number,
  what: string,
): Promise<{ name: string; bytes: Uint8Array }> {
  if (file.size > maxBytes) {
    throw badRequest(`${what} exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB limit`);
  }

  let name: string;
  try {
    name = sanitizeUploadFilename(file.name);
  } catch (error) {
    if (error instanceof UnsafePathError) throw badRequest(error.message);
    throw error;
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) throw badRequest(`${what} is empty`);
  // Re-checked after reading: `File.size` is metadata and a streamed upload can
  // report one length and deliver another.
  if (bytes.byteLength > maxBytes) {
    throw badRequest(`${what} exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB limit`);
  }

  return { name, bytes };
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

/**
 * Turns a stored absolute path into a link the browser can fetch.
 *
 * Same containment rule as the task API: anything that does not resolve inside
 * the tasks directory is dropped rather than turned into a reachable URL, so a
 * malformed record can never become a file-read endpoint.
 */
function segmentFileToUri(file: string | null | undefined): string | null {
  if (!file) return null;

  const tasksDir = taskDir();
  let resolved: string;
  try {
    resolved = resolvePathWithinDirectory(tasksDir, file);
  } catch (error) {
    logger.warning(`skip unsafe book segment path, path: ${file}, error: ${errorMessage(error)}`);
    return null;
  }

  const endpoint = String(appConfig().endpoint ?? "").replace(/\/+$/, "");
  const uriPath = `tasks/${relative(tasksDir, resolved).replace(/\\/g, "/")}`;
  return endpoint ? `${endpoint}/${uriPath}` : `/${uriPath}`;
}

/** Strips host paths; the cover is reachable through its own endpoint instead. */
function publicBook(book: BookDocument): Record<string, unknown> {
  const { cover_path, ocr, ...rest } = book;
  // The OCR record carries the absolute path of the stored upload, which is a
  // host path like any other and stays on the server. Everything else in it —
  // the page counts the import screen shows — is safe to send.
  const { source_path, ...publicOcr } = ocr ?? {};
  void source_path;
  return {
    ...rest,
    ...(ocr ? { ocr: publicOcr } : {}),
    has_cover: Boolean(cover_path && existsSync(cover_path)),
  };
}

function publicSegment(segment: BookSegmentDocument): Record<string, unknown> {
  const { audio_path, video_path, subtitle_path, block_ids, ...rest } = segment;
  return {
    ...rest,
    // The id list of a long segment is thousands of entries and no client needs
    // it; the count is what the review UI actually shows.
    block_count: block_ids.length,
    audio_url: segmentFileToUri(audio_path),
    video_url: segmentFileToUri(video_path),
    subtitle_url: segmentFileToUri(subtitle_path),
  };
}

async function requireBook(bookId: string): Promise<BookDocument> {
  const book = await getBook(bookId);
  if (!book) throw notFound("book not found", bookId);
  return book;
}

/**
 * Refuses a change that would invalidate work already in flight.
 *
 * Re-planning while segments render is not merely untidy: the revision guard
 * would make every running task discard its results, silently throwing away
 * however many minutes of synthesis were already paid for.
 */
function requireIdleSegments(bookId: string, segments: BookSegmentDocument[]): void {
  const active = segments.filter((segment) => ACTIVE_SEGMENT_STATES.has(segment.state));
  if (active.length > 0) {
    throw conflict(
      `${active.length} segment(s) are still rendering; cancel them before changing the plan`,
      bookId,
    );
  }
}

// ---------------------------------------------------------------------------
// What an extraction that found nothing means
// ---------------------------------------------------------------------------

export const NO_TEXT_MESSAGE = "no readable text was found in this file";

/**
 * Refusal for a scan when OCR is switched off.
 *
 * Deliberately not a silent acceptance. A book with no text layer and no engine
 * to read it can never be narrated, and accepting it would leave the user with a
 * library entry that fails at the far end of a render for a reason nobody could
 * see. Naming the setting is the difference between an error and an instruction.
 */
export const OCR_DISABLED_MESSAGE =
  "this PDF has no text layer; it is a scanned book and needs OCR. " +
  "Enable OCR in Settings (ocr_provider) and upload it again.";

export type ExtractionOutcome =
  | { action: "accept" }
  /** Recognise these 1-based pages in the background, then land in `ready`. */
  | { action: "ocr"; pages: number[] }
  | { action: "reject"; message: string };

export interface ExtractionOutcomeInput {
  blockCount: number;
  /** The PDF scan report, or null when the upload was not a PDF. */
  scan: PdfScanReport | null;
  ocrEnabled: boolean;
}

/**
 * Decides what an upload that yielded no blocks actually is.
 *
 * Three different situations arrive here looking identical, and answering all of
 * them with one message is what made a scanned book indistinguishable from an
 * empty file: a genuinely empty upload, a scan with no engine configured, and a
 * scan this server can read given half an hour. Only the first is a dead end.
 */
export function decideExtractionOutcome(input: ExtractionOutcomeInput): ExtractionOutcome {
  if (input.blockCount > 0) return { action: "accept" };

  const scannedPages = input.scan?.scannedPages ?? [];
  if (scannedPages.length === 0) return { action: "reject", message: NO_TEXT_MESSAGE };
  if (!input.ocrEnabled) return { action: "reject", message: OCR_DISABLED_MESSAGE };

  return { action: "ocr", pages: [...scannedPages].sort((a, b) => a - b) };
}

/** The scan report a PDF extraction carries, or null for every other format. */
export function pdfScanReport(result: ExtractionResult): PdfScanReport | null {
  const scan = (result as { scan?: PdfScanReport }).scan;
  return scan && Array.isArray(scan.scannedPages) ? scan : null;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

bookRouter.post("/books", async (c) => {
  rejectOversizedBody(c.req.header("Content-Length"), MAX_BOOK_UPLOAD_BYTES, "the uploaded book");

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw badRequest("a file field is required");

  const { name, bytes } = await readUpload(file, MAX_BOOK_UPLOAD_BYTES, "the uploaded book");

  const extension = extensionOf(name);
  if (!(ALLOWED_BOOK_EXTENSIONS as readonly string[]).includes(extension)) {
    throw badRequest(`unsupported book format; supported formats: ${ALLOWED_BOOK_EXTENSIONS.join(", ")}`);
  }

  // Extension and content must agree in both directions. A zip named .txt would
  // otherwise be narrated as binary noise, and an .epub that is not a zip is
  // better refused here than deep inside the EPUB reader. The same reasoning
  // applies to PDF, whose reader is even less forgiving of arbitrary bytes.
  const zip = isZip(bytes);
  if (zip && extension !== "epub") {
    throw badRequest("this file is a zip archive; upload it with a .epub extension if it is an EPUB");
  }
  if (!zip && extension === "epub") {
    throw badRequest("this file is not a valid EPUB (it is not a zip archive)");
  }

  const pdf = isPdf(bytes);
  if (pdf && extension !== "pdf") {
    throw badRequest("this file is a PDF; upload it with a .pdf extension");
  }
  if (!pdf && extension === "pdf") {
    throw badRequest("this file is not a valid PDF (it does not start with %PDF)");
  }

  const options = bookSegmentOptionsSchema.parse(
    bookUploadOptionsSchema.parse(Object.fromEntries(form.entries())),
  );

  let extracted;
  try {
    extracted = await extractBook(bytes, name);
  } catch (error) {
    if (error instanceof BookExtractionError) throw badRequest(error.message);
    throw error;
  }

  const { structure, warnings } = extracted;
  const scan = pdfScanReport(extracted);
  const outcome = decideExtractionOutcome({
    blockCount: structure.blocks.length,
    scan,
    ocrEnabled: isOcrEnabled(),
  });
  if (outcome.action === "reject") throw badRequest(outcome.message);

  const bookId = getUuid();
  const segmentOptions = segmentOptionsToDocument(options);
  const decisions = resolveBookDecisions(structure, []);
  const kept = keptBlocks(structure, decisions);
  const segments =
    outcome.action === "ocr"
      ? []
      : await buildSegmentUpserts(bookId, structure, decisions, segmentOptionsFromDocument(segmentOptions), 1);

  // Written even when it is empty: the review screen reads it the moment the
  // book appears in the library, and a missing file there reads as corruption
  // rather than as work in progress.
  await writeBookStructure(bookId, structure);

  const book = await createBook({
    _id: bookId,
    title: structure.title || name,
    author: structure.author,
    language: structure.language,
    source_filename: name,
    format: detectBookFormat(bytes, name),
    cover_path: null,
    state: outcome.action === "ocr" ? "ocr_pending" : "ready",
    revision: 1,
    chapter_count: structure.chapters.length,
    block_count: structure.blocks.length,
    kept_block_count: kept.length,
    segment_options: segmentOptions,
    render_params: null,
    warnings,
    error: null,
  });

  await replaceBookSegments(bookId, segments);

  if (outcome.action === "ocr") {
    const started = await beginOcr(book, bytes, outcome.pages, scan?.totalPages ?? outcome.pages.length);
    return c.json(
      getResponse(200, {
        book: publicBook({ ...book, state: "ocr_pending" }),
        segments: 0,
        warnings,
        decisions: decisionSummary(decisions),
        ocr: { pages: started.pages, task_id: started.taskId },
      }),
    );
  }

  logger.success(
    `book uploaded: ${bookId} "${book.title}" (${structure.blocks.length} blocks, ${segments.length} segments)`,
  );

  return c.json(
    getResponse(200, {
      book: publicBook(book),
      segments: segments.length,
      warnings,
      decisions: decisionSummary(decisions),
    }),
  );
});

/**
 * Keeps the uploaded PDF and queues the pass that reads it.
 *
 * The file has to survive the request that carried it: rasterising page 200
 * happens twenty minutes later, and the multipart body is long gone by then. It
 * lives in the book's own directory, so deleting the book takes it too.
 */
async function beginOcr(
  book: BookDocument,
  bytes: Uint8Array,
  pages: number[],
  totalPages: number,
): Promise<{ taskId: string; pages: number }> {
  const sourcePath = ocrSourcePath(book._id);
  await Bun.write(sourcePath, bytes);

  await patchBook(book._id, {
    ocr: {
      source_path: sourcePath,
      pages,
      pages_total: pages.length,
      pages_done: 0,
      pages_failed: 0,
      provider: "",
      mean_confidence: 0,
      task_id: null,
      error: null,
      started_at: null,
      finished_at: null,
    },
  });

  const started = await startBookOcr({
    bookId: book._id,
    revision: book.revision,
    sourcePath,
    pages,
    totalPages,
  });

  logger.success(
    `scanned book accepted for ocr: ${book._id} "${book.title}" (${pages.length} of ${totalPages} pages)`,
  );
  return started;
}

/**
 * Resumes an OCR pass that stopped without finishing.
 *
 * A restart cannot resume itself: the pass runs in-process, so a server that
 * goes down mid-book leaves a record saying `ocr` with nothing working on it.
 * The pages already recognised are on disk, so this costs only what is left —
 * which is the entire reason the manifest is written page by page.
 */
bookRouter.post("/books/:id/ocr", async (c) => {
  const bookId = c.req.param("id");
  const book = await requireBook(bookId);

  const ocr = book.ocr;
  if (!ocr || ocr.pages.length === 0) throw badRequest("this book was not imported as a scan", bookId);
  if (ocr.task_id && taskQueue.isActive(ocr.task_id)) {
    throw conflict("this book is already being recognised", bookId);
  }
  if (!existsSync(ocr.source_path)) {
    throw badRequest("the uploaded pdf is no longer on disk, so it cannot be read again", bookId);
  }

  const started = await startBookOcr({
    bookId,
    revision: book.revision,
    sourcePath: ocr.source_path,
    pages: ocr.pages,
    totalPages: Math.max(ocr.pages_total, ...ocr.pages),
  });

  logger.info(`ocr resumed: ${bookId} (${started.pages} pages, ${ocr.pages_done} already read)`);
  return c.json(
    getResponse(200, { book_id: bookId, task_id: started.taskId, pages: started.pages, resumed: ocr.pages_done }),
  );
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

bookRouter.get("/books", async (c) => {
  const { page, page_size: pageSize } = bookPaginationSchema.parse({
    page: c.req.query("page") ?? 1,
    page_size: c.req.query("page_size") ?? 10,
  });

  const { books, total } = await listBooks(page, pageSize);
  const withProgress = await Promise.all(
    books.map(async (book) => ({ ...publicBook(book), progress: await bookProgress(book._id) })),
  );

  return c.json(getResponse(200, { books: withProgress, total, page, page_size: pageSize }));
});

bookRouter.get("/books/:id", async (c) => {
  const bookId = c.req.param("id");
  const book = await requireBook(bookId);

  const [segments, structure, overrides] = await Promise.all([
    listBookSegments(bookId),
    readBookStructure(bookId),
    listDecisionOverrides(bookId),
  ]);

  const decisions = structure ? resolveBookDecisions(structure, overrides) : [];

  return c.json(
    getResponse(200, {
      book: publicBook(book),
      progress: aggregateSegmentProgress(segments),
      segments: segments.map(publicSegment),
      decisions: decisionSummary(decisions),
      overrides: overrides.length,
      queue: bookGateStats(bookId),
    }),
  );
});

/** Blocks joined with their effective decisions, for the review UI. */
bookRouter.get("/books/:id/blocks", async (c) => {
  const bookId = c.req.param("id");
  await requireBook(bookId);

  const { page, page_size: pageSize } = bookPaginationSchema.parse({
    page: c.req.query("page") ?? 1,
    page_size: c.req.query("page_size") ?? 50,
  });

  const structure = await readBookStructure(bookId);
  if (!structure) throw notFound("the extracted book structure is missing", bookId);

  const [overrides, edits] = await Promise.all([
    listDecisionOverrides(bookId),
    listBlockEdits(bookId),
  ]);
  // Decisions come from the extracted text, the listing from the edited text:
  // a rewrite must never re-run the rules and change what survives filtering.
  const decisions = resolveBookDecisions(structure, overrides);
  const byBlockId = new Map(decisions.map((decision) => [decision.blockId, decision]));
  const originalText = new Map(structure.blocks.map((block) => [block.id, block.text]));

  const ordered = [...applyBlockEdits(structure, edits).blocks].sort((a, b) => a.order - b.order);
  const skip = (page - 1) * pageSize;
  const chapterTitles = new Map(structure.chapters.map((chapter) => [chapter.id, chapter.title]));

  const blocks = ordered.slice(skip, skip + pageSize).map((block) => {
    const decision = byBlockId.get(block.id);
    const original = originalText.get(block.id) ?? block.text;
    return {
      id: block.id,
      kind: block.kind,
      text: block.text,
      // Sent only when it differs, so an unedited book pays nothing for the field.
      original_text: original === block.text ? null : original,
      edited: original !== block.text,
      level: block.level ?? null,
      chapter_id: block.chapterId,
      chapter_title: chapterTitles.get(block.chapterId) ?? "",
      order: block.order,
      keep: decision?.keep ?? true,
      reason: decision?.reason ?? "",
      rule: decision?.rule ?? "",
      confidence: decision?.confidence ?? 1,
      source: decision?.source ?? "structural",
    };
  });

  return c.json(
    getResponse(200, { blocks, total: ordered.length, page, page_size: pageSize }),
  );
});

/**
 * The blocks of one segment, in narration order, with their edits applied.
 *
 * The segments screen needs the text a segment will actually narrate, which is
 * neither a page of the book-wide block list nor anything stored on the segment
 * row: the row holds block ids, and dropped blocks are filtered out at render
 * time. This endpoint answers the same question the renderer asks.
 */
bookRouter.get("/books/:id/segments/:index/blocks", async (c) => {
  const bookId = c.req.param("id");
  const index = Number(c.req.param("index"));
  if (!Number.isInteger(index) || index < 0) {
    throw badRequest("segment index must be a non-negative integer", bookId);
  }

  await requireBook(bookId);
  const segment = await getBookSegment(bookId, index);
  if (!segment) throw notFound("segment not found", bookId);

  const structure = await readBookStructure(bookId);
  if (!structure) throw notFound("the extracted book structure is missing", bookId);

  const [overrides, edits] = await Promise.all([
    listDecisionOverrides(bookId),
    listBlockEdits(bookId),
  ]);
  const decisions = resolveBookDecisions(structure, overrides);
  const editedById = new Map(applyBlockEdits(structure, edits).blocks.map((block) => [block.id, block]));
  const chapterTitles = new Map(structure.chapters.map((chapter) => [chapter.id, chapter.title]));

  const blocks = segmentBlocks(structure, decisions, segment.block_ids).map((block) => {
    const edited = editedById.get(block.id) ?? block;
    return {
      id: block.id,
      kind: block.kind,
      text: edited.text,
      original_text: edited.text === block.text ? null : block.text,
      edited: edited.text !== block.text,
      level: block.level ?? null,
      chapter_id: block.chapterId,
      chapter_title: chapterTitles.get(block.chapterId) ?? "",
      order: block.order,
    };
  });

  return c.json(
    getResponse(200, {
      book_id: bookId,
      index,
      title: segment.title,
      state: segment.state,
      blocks,
    }),
  );
});

// ---------------------------------------------------------------------------
// Review edits
// ---------------------------------------------------------------------------

/**
 * Rebuilds the segment plan after a pause in review clicks.
 *
 * A keep/drop used to wait on this on the request path, which made toggling one
 * copyright line feel like re-importing the book: the structure is re-read, every
 * segment is rewritten, and the output folder is wiped. Reviewers click many
 * times in a row, so the work is coalesced and run after they pause. Narration
 * already re-filters dropped blocks at render time, so a brief stale plan cannot
 * put rejected text back into a video.
 */
const REPLAN_DEBOUNCE_MS = 600;
const replanTimers = new Map<string, ReturnType<typeof setTimeout>>();
const replanTail = new Map<string, Promise<void>>();

function scheduleBookReplan(bookId: string): void {
  const pending = replanTimers.get(bookId);
  if (pending) clearTimeout(pending);
  replanTimers.set(
    bookId,
    setTimeout(() => {
      replanTimers.delete(bookId);
      const previous = replanTail.get(bookId) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(() => runScheduledReplan(bookId));
      replanTail.set(bookId, next);
      void next.finally(() => {
        if (replanTail.get(bookId) === next) replanTail.delete(bookId);
      });
    }, REPLAN_DEBOUNCE_MS),
  );
}

async function runScheduledReplan(bookId: string): Promise<void> {
  const book = await getBook(bookId);
  if (!book) return;

  const segments = await listBookSegments(bookId);
  if (segments.some((segment) => ACTIVE_SEGMENT_STATES.has(segment.state))) {
    logger.info(`skipping background replan while rendering: ${bookId}`);
    return;
  }

  try {
    await replanBook(book, book.revision);
    logger.info(`background replan finished: ${bookId}, revision: ${book.revision}`);
  } catch (error) {
    logger.exception(`background replan failed: ${bookId}`, error);
  }
}

/** Re-plans from the current decisions and stamps the new revision. */
async function replanBook(book: BookDocument, revision: number): Promise<number> {
  const structure = await readBookStructure(book._id);
  if (!structure) throw notFound("the extracted book structure is missing", book._id);

  const [overrides, edits] = await Promise.all([
    listDecisionOverrides(book._id),
    listBlockEdits(book._id),
  ]);
  // Rules see the extracted text, the planner sees the rewritten text: a longer
  // rewrite must lengthen its segment's estimate without changing what is kept.
  const decisions = resolveBookDecisions(structure, overrides);
  const edited = applyBlockEdits(structure, edits);
  const kept = keptBlocks(edited, decisions);
  const segments = await buildSegmentUpserts(
    book._id,
    edited,
    decisions,
    segmentOptionsFromDocument(book.segment_options),
    revision,
  );

  // Named output folders belong to the previous plan; leaving them would mix
  // old chapter videos with the new titles after a re-plan.
  await rm(join(taskDir(), bookProjectFolderName(book.title, book._id)), { recursive: true, force: true });
  await replaceBookSegments(book._id, segments);
  await patchBook(book._id, { kept_block_count: kept.length });
  await syncBookState(book._id);
  return kept.length;
}

bookRouter.patch("/books/:id/decisions/:blockId", async (c) => {
  const bookId = c.req.param("id");
  const blockId = c.req.param("blockId");
  await requireBook(bookId);
  const body = bookDecisionOverrideSchema.parse(await c.req.json().catch(() => ({})));

  const structure = await readBookStructure(bookId);
  if (!structure) throw notFound("the extracted book structure is missing", bookId);
  if (!structure.blocks.some((block) => block.id === blockId)) {
    throw notFound("block not found in this book", bookId);
  }

  requireIdleSegments(bookId, await listBookSegments(bookId));

  await upsertDecisionOverride({
    book_id: bookId,
    block_id: blockId,
    keep: body.keep,
    reason: body.keep
      ? "Kept by a reviewer, overriding the automatic decision."
      : "Dropped by a reviewer, overriding the automatic decision.",
    rule: "user_override",
    confidence: 1,
    source: "user",
  });

  // The override is the source of truth; the segment plan is rebuilt in the
  // background so this click is a write, not a full re-segmentation.
  const overrides = await listDecisionOverrides(bookId);
  const keptCount = keptBlocks(structure, resolveBookDecisions(structure, overrides)).length;
  const revision = await bumpBookRevision(bookId, { kept_block_count: keptCount });
  if (revision === null) throw notFound("book not found", bookId);

  scheduleBookReplan(bookId);
  return c.json(
    getResponse(200, {
      book_id: bookId,
      block_id: blockId,
      keep: body.keep,
      revision,
      kept_block_count: keptCount,
      segments: (await listBookSegments(bookId)).length,
    }),
  );
});

/**
 * Rewrites one block's narration text.
 *
 * Deliberately does *not* re-plan. A re-plan replaces every segment row, which
 * would throw away the renders of the other 299 segments because a reviewer
 * fixed a word in one of them; and since block ids are stable, the grouping the
 * plan describes is still correct after an edit. What does change is the
 * affected segment's estimate — and its video, which no longer matches its
 * text — so that one segment is recosted and marked unrendered, and the
 * reviewer re-renders it when they are ready.
 */
bookRouter.patch("/books/:id/blocks/:blockId", async (c) => {
  const bookId = c.req.param("id");
  const blockId = c.req.param("blockId");
  const book = await requireBook(bookId);
  const body = bookBlockTextSchema.parse(await c.req.json().catch(() => ({})));

  const structure = await readBookStructure(bookId);
  if (!structure) throw notFound("the extracted book structure is missing", bookId);

  const original = structure.blocks.find((block) => block.id === blockId);
  if (!original) throw notFound("block not found in this book", bookId);

  const segments = await listBookSegments(bookId);
  requireIdleSegments(bookId, segments);

  // Storing an edit identical to the extracted text would leave a row claiming
  // the block was rewritten, and the review UI would badge it forever.
  const reverted = body.text === original.text;
  if (reverted) await deleteBlockEdit(bookId, blockId);
  else await upsertBlockEdit(bookId, blockId, body.text);

  const target = segments.find((segment) => segment.block_ids.includes(blockId));
  let estimated: number | null = null;

  if (target) {
    const [overrides, edits] = await Promise.all([
      listDecisionOverrides(bookId),
      listBlockEdits(bookId),
    ]);
    const decisions = resolveBookDecisions(structure, overrides);
    const editedById = new Map(applyBlockEdits(structure, edits).blocks.map((b) => [b.id, b]));
    const kept = segmentBlocks(structure, decisions, target.block_ids).map(
      (block) => editedById.get(block.id) ?? block,
    );

    const { wordsPerMinute } = segmentOptionsFromDocument(book.segment_options);
    estimated = Math.round(
      kept.reduce((sum, block) => sum + estimateSpokenSeconds(block.text, wordsPerMinute), 0),
    );

    // Mirrors the planner's rule: a segment that opens on a heading is named
    // after it, so rewording that heading has to rename the segment too.
    const first = kept[0];
    const title =
      first && first.kind === "heading" && first.text.trim() ? first.text.trim() : target.title;

    await patchBookSegment(bookId, target.index, {
      title,
      estimated_duration: estimated,
      state: "pending",
      task_id: null,
      audio_path: null,
      video_path: null,
      subtitle_path: null,
      error: null,
    });
    await syncBookState(bookId);
  }

  logger.info(
    `book block ${reverted ? "reverted" : "edited"}: ${bookId}/${blockId}` +
      (target ? `, segment ${target.index} marked unrendered` : ", not in any segment"),
  );

  return c.json(
    getResponse(200, {
      book_id: bookId,
      block_id: blockId,
      text: body.text,
      edited: !reverted,
      segment_index: target?.index ?? null,
      estimated_duration: estimated,
    }),
  );
});

bookRouter.patch("/books/:id/segments", async (c) => {
  const bookId = c.req.param("id");
  const book = await requireBook(bookId);

  const merged = { ...book.segment_options, ...(await c.req.json().catch(() => ({}))) };
  const options = bookSegmentOptionsSchema.parse(merged);

  requireIdleSegments(bookId, await listBookSegments(bookId));

  const revision = await bumpBookRevision(bookId, { segment_options: segmentOptionsToDocument(options) });
  if (revision === null) throw notFound("book not found", bookId);

  const updated = { ...book, segment_options: segmentOptionsToDocument(options) };
  await replanBook(updated, revision);
  const segments = await listBookSegments(bookId);

  return c.json(
    getResponse(200, {
      book_id: bookId,
      revision,
      segment_options: updated.segment_options,
      segments: segments.map(publicSegment),
    }),
  );
});

// ---------------------------------------------------------------------------
// Cover
// ---------------------------------------------------------------------------

bookRouter.post("/books/:id/cover", async (c) => {
  const bookId = c.req.param("id");
  await requireBook(bookId);
  rejectOversizedBody(c.req.header("Content-Length"), MAX_COVER_UPLOAD_BYTES, "the cover image");

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw badRequest("a file field is required");

  const { name, bytes } = await readUpload(file, MAX_COVER_UPLOAD_BYTES, "the cover image");
  if (!(ALLOWED_COVER_EXTENSIONS as readonly string[]).includes(extensionOf(name))) {
    throw badRequest(`unsupported cover format; supported formats: ${ALLOWED_COVER_EXTENSIONS.join(", ")}`);
  }

  const format = detectImageFormat(bytes);
  if (!format) throw badRequest("the uploaded cover is not a PNG, JPEG or WebP image");

  // Named from the detected format, not the claimed extension, so ffmpeg picks
  // its demuxer from what the file actually is.
  const coverPath = join(bookDir(bookId), `cover.${format === "jpeg" ? "jpg" : format}`);
  await Bun.write(coverPath, bytes);
  await bumpBookRevision(bookId, { cover_path: coverPath });

  logger.info(`book cover updated: ${bookId} (${format}, ${bytes.byteLength} bytes)`);
  return c.json(getResponse(200, { book_id: bookId, format, size: bytes.byteLength }));
});

bookRouter.get("/books/:id/cover", async (c) => {
  const book = await requireBook(c.req.param("id"));
  if (!book.cover_path || !existsSync(book.cover_path)) throw notFound("this book has no cover", book._id);

  try {
    return serveFileWithRange(c, resolvePathWithinDirectory(bookDir(book._id), book.cover_path));
  } catch (error) {
    if (error instanceof UnsafePathError) throw notFound("this book has no cover", book._id);
    throw error;
  }
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

bookRouter.post("/books/:id/render", async (c) => {
  const bookId = c.req.param("id");
  const book = await requireBook(bookId);
  // An absent body should surface as "voice_name is required", not as a JSON
  // parse error the caller cannot act on.
  const request = bookRenderRequestSchema.parse(await c.req.json().catch(() => ({})));

  const segments = await listBookSegments(bookId);
  if (segments.length === 0) throw badRequest("this book has no segments to render", bookId);

  const requested = request.segment_indexes?.length
    ? new Set(request.segment_indexes)
    : null;

  const targets = segments.filter(
    (segment) =>
      !ACTIVE_SEGMENT_STATES.has(segment.state) && (requested === null || requested.has(segment.index)),
  );
  if (targets.length === 0) throw conflict("every requested segment is already rendering", bookId);

  const params = renderParamsToDocument(request);
  const result = await renderBookSegments(
    bookId,
    targets.map((segment) => segment.index),
    params,
  );

  logger.info(`book render accepted: ${bookId}, segments: ${result.accepted.length}, revision: ${result.revision}`);
  return c.json(
    getResponse(200, { book_id: bookId, revision: result.revision, accepted: result.accepted, title: book.title }),
  );
});

bookRouter.post("/books/:id/segments/:index/render", async (c) => {
  const bookId = c.req.param("id");
  const index = Number(c.req.param("index"));
  if (!Number.isInteger(index) || index < 0) throw badRequest("segment index must be a non-negative integer", bookId);

  const book = await requireBook(bookId);
  const segment = await getBookSegment(bookId, index);
  if (!segment) throw notFound("segment not found", bookId);
  if (ACTIVE_SEGMENT_STATES.has(segment.state)) throw conflict("this segment is already rendering", bookId);

  // A retry may restate the settings or reuse the ones the book was last
  // rendered with; without either there is nothing to render from.
  const body = await c.req.json().catch(() => null);
  const params = body
    ? renderParamsToDocument(bookRenderRequestSchema.parse(body))
    : book.render_params;
  if (!params) throw badRequest("this book has not been rendered yet; send the render settings", bookId);

  const result = await renderBookSegments(bookId, [index], params);
  return c.json(getResponse(200, { book_id: bookId, revision: result.revision, accepted: result.accepted }));
});

// ---------------------------------------------------------------------------
// Progress stream
// ---------------------------------------------------------------------------

/**
 * Segments whose logs are worth reading right now.
 *
 * Capped, and capped at the head of the list rather than the tail, because the
 * queue starts segments in order: the two or three at the front are the ones
 * actually running, and the other 297 have nothing to say yet.
 */
const MAX_LOGGED_SEGMENTS = 4;
/** Lines pulled from each of those, and the ceiling on the joined feed. */
const LOG_LINES_PER_SEGMENT = 12;
const MAX_RECENT_LOG_LINES = 25;

interface RecentLogLine {
  /** Segment index, or -1 for the book-wide OCR pass. */
  segment: number;
  line: string;
}

/**
 * The tail of what the active work is saying about itself.
 *
 * Books render for hours and until now said nothing while they did: the task
 * records were full of "narrating chapter 12" and "chunk 40/57" and none of it
 * ever reached a screen, so a sixteen-hour render and a stuck one looked
 * identical. This is deliberately a small bounded window rather than the logs
 * themselves — the whole reason this endpoint sends a projection is that a
 * book-sized document cannot be re-serialised every second, and streaming every
 * line would undo exactly that.
 */
async function recentBookLogs(
  segments: readonly BookSegmentDocument[],
  book: BookDocument,
): Promise<RecentLogLine[]> {
  const active = segments
    .filter((segment) => segment.task_id && ACTIVE_SEGMENT_STATES.has(segment.state))
    .slice(0, MAX_LOGGED_SEGMENTS);

  const ocrTaskId = isBookOcrState(book.state) ? book.ocr?.task_id : null;
  const taskIds = [...active.map((segment) => segment.task_id!), ...(ocrTaskId ? [ocrTaskId] : [])];
  if (taskIds.length === 0) return [];

  const logs = await getRecentTaskLogs(taskIds, LOG_LINES_PER_SEGMENT);
  const lines: RecentLogLine[] = [];

  for (const segment of active) {
    for (const line of logs.get(segment.task_id!) ?? []) lines.push({ segment: segment.index, line });
  }
  for (const line of ocrTaskId ? (logs.get(ocrTaskId) ?? []) : []) lines.push({ segment: -1, line });

  // Newest last, and only the tail survives: the feed is a window on now, not a
  // transcript, and the browser renders exactly what arrives here.
  return lines.slice(-MAX_RECENT_LOG_LINES);
}

/**
 * Aggregate progress over SSE.
 *
 * A projection, never the documents: a book carries hundreds of segments whose
 * `block_ids` run to thousands of entries each, and serialising that every
 * second per open browser tab would dwarf the render it is reporting on.
 */
bookRouter.get("/books/:id/events", async (c) => {
  const bookId = c.req.param("id");

  return streamSSE(c, async (stream) => {
    let lastPayload = "";

    while (!stream.closed) {
      const book = await getBook(bookId);
      if (!book) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: "book not found" }) });
        return;
      }

      const segments = await listBookSegments(bookId);
      const progress = aggregateSegmentProgress(segments);
      // A book being recognised has no segments at all, so the segment-derived
      // state reads `ready` — which is the one thing it certainly is not.
      const recognising = isBookOcrState(book.state);
      const payload = JSON.stringify({
        book_id: bookId,
        state: recognising ? book.state : progress.state,
        revision: book.revision,
        progress: recognising ? ocrPercent(book) : progress.progress,
        counts: {
          total: progress.total,
          pending: progress.pending,
          queued: progress.queued,
          rendering: progress.rendering,
          complete: progress.complete,
          failed: progress.failed,
        },
        segments: segments.map((segment) => ({ index: segment.index, state: segment.state })),
        ocr: book.ocr
          ? {
              pages_total: book.ocr.pages_total,
              pages_done: book.ocr.pages_done,
              pages_failed: book.ocr.pages_failed,
              mean_confidence: book.ocr.mean_confidence,
            }
          : null,
        recent_logs: await recentBookLogs(segments, book),
      });

      if (payload !== lastPayload) {
        await stream.writeSSE({ event: "book", data: payload });
        lastPayload = payload;
      }

      if (progress.state !== "rendering" && !recognising) {
        await stream.writeSSE({ event: "done", data: payload });
        return;
      }

      await sleep(1000);
    }
  });
});

/** Pages read over pages to read, as a percentage. */
function ocrPercent(book: BookDocument): number {
  const total = book.ocr?.pages_total ?? 0;
  if (total <= 0) return 0;
  const attempted = (book.ocr?.pages_done ?? 0) + (book.ocr?.pages_failed ?? 0);
  return Math.min(100, Math.round((attempted / total) * 100));
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

/**
 * Deletes a book and everything it produced.
 *
 * Children are cancelled first and on purpose: a running segment holds its task
 * directory open and would keep writing into it, so removing files before
 * stopping the work that writes them leaves half-rendered output behind and a
 * task failing on a missing directory.
 */
bookRouter.delete("/books/:id", async (c) => {
  const bookId = c.req.param("id");
  const book = await requireBook(bookId);

  const segments = await listBookSegments(bookId);
  let cancelled = 0;
  for (const segment of segments) {
    if (segment.task_id && taskQueue.cancel(segment.task_id)) cancelled += 1;
  }
  // An OCR pass is not a segment, so the loop above never sees it; left running
  // it would keep writing a manifest into a directory about to be deleted.
  if (book?.ocr?.task_id && taskQueue.cancel(book.ocr.task_id)) cancelled += 1;

  // Bumping the revision makes any task that slipped past cancellation discard
  // its results instead of writing into a directory that is about to vanish.
  await bumpBookRevision(bookId);

  for (const segment of segments) {
    if (!segment.task_id) continue;
    const task = await getTask(segment.task_id);
    if (task) {
      await rm(join(taskDir(), segment.task_id), { recursive: true, force: true });
      await deleteTask(segment.task_id);
    }
  }
  await rm(join(taskDir(), bookProjectFolderName(book.title, book._id)), { recursive: true, force: true });
  // The OCR task owns no task directory — its output lives in the book's own —
  // so only the record has to go.
  if (book.ocr?.task_id) await deleteTask(book.ocr.task_id);

  await deleteBook(bookId);
  await deleteBookFiles(bookId);

  logger.success(`book deleted: ${bookId} (${segments.length} segments, ${cancelled} cancelled)`);
  return c.json(getResponse(200, { book_id: bookId, segments: segments.length, cancelled }));
});
