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
  bookDir,
  bookProgress,
  createBook,
  deleteBook,
  deleteBookFiles,
  getBook,
  getBookSegment,
  listBookSegments,
  listBooks,
  listDecisionOverrides,
  patchBook,
  readBookStructure,
  replaceBookSegments,
  resolveBookDecisions,
  syncBookState,
  upsertDecisionOverride,
  writeBookStructure,
  bumpBookRevision,
  aggregateSegmentProgress,
} from "../../db/books.ts";
import type { BookDocument, BookSegmentDocument } from "../../db/types.ts";
import { badRequest, conflict, notFound } from "../../http/errors.ts";
import { serveFileWithRange } from "../../http/staticFiles.ts";
import {
  bookDecisionOverrideSchema,
  bookPaginationSchema,
  bookRenderRequestSchema,
  bookSegmentOptionsSchema,
  bookUploadOptionsSchema,
  renderParamsToDocument,
  segmentOptionsFromDocument,
  segmentOptionsToDocument,
} from "../../models/bookSchema.ts";
import { extractBook, detectBookFormat } from "../../services/book/extract/index.ts";
import { decisionSummary, keptBlocks } from "../../services/book/filter/decisions.ts";
import { BookExtractionError } from "../../services/book/types.ts";
import {
  ACTIVE_SEGMENT_STATES,
  bookGateStats,
  buildSegmentUpserts,
  renderBookSegments,
} from "../../tasks/bookPipeline.ts";
import { taskQueue } from "../../tasks/queue.ts";
import { deleteTask, getTask } from "../../tasks/state.ts";
import { resolvePathWithinDirectory, sanitizeUploadFilename, UnsafePathError } from "../../utils/fileSecurity.ts";
import { errorMessage, logger } from "../../utils/logger.ts";
import { getResponse, getUuid, sleep } from "../../utils/misc.ts";
import { taskDir } from "../../utils/paths.ts";

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

const ALLOWED_BOOK_EXTENSIONS = ["epub", "txt", "text", "md", "markdown"] as const;
const ALLOWED_COVER_EXTENSIONS = ["png", "jpg", "jpeg", "webp"] as const;

/** `PK\x03\x04`; every zip, and therefore every EPUB, starts with it. */
function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
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
  const { cover_path, ...rest } = book;
  return { ...rest, has_cover: Boolean(cover_path && existsSync(cover_path)) };
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
  // better refused here than deep inside the EPUB reader.
  const zip = isZip(bytes);
  if (zip && extension !== "epub") {
    throw badRequest("this file is a zip archive; upload it with a .epub extension if it is an EPUB");
  }
  if (!zip && extension === "epub") {
    throw badRequest("this file is not a valid EPUB (it is not a zip archive)");
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
  if (structure.blocks.length === 0) throw badRequest("no readable text was found in this file");

  const bookId = getUuid();
  const segmentOptions = segmentOptionsToDocument(options);
  const decisions = resolveBookDecisions(structure, []);
  const kept = keptBlocks(structure, decisions);
  const segments = buildSegmentUpserts(
    bookId,
    structure,
    decisions,
    segmentOptionsFromDocument(segmentOptions),
    1,
  );

  await writeBookStructure(bookId, structure);

  const book = await createBook({
    _id: bookId,
    title: structure.title || name,
    author: structure.author,
    language: structure.language,
    source_filename: name,
    format: detectBookFormat(bytes, name),
    cover_path: null,
    state: "ready",
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

  const decisions = resolveBookDecisions(structure, await listDecisionOverrides(bookId));
  const byBlockId = new Map(decisions.map((decision) => [decision.blockId, decision]));

  const ordered = [...structure.blocks].sort((a, b) => a.order - b.order);
  const skip = (page - 1) * pageSize;
  const chapterTitles = new Map(structure.chapters.map((chapter) => [chapter.id, chapter.title]));

  const blocks = ordered.slice(skip, skip + pageSize).map((block) => {
    const decision = byBlockId.get(block.id);
    return {
      id: block.id,
      kind: block.kind,
      text: block.text,
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

// ---------------------------------------------------------------------------
// Review edits
// ---------------------------------------------------------------------------

/** Re-plans from the current decisions and stamps the new revision. */
async function replanBook(book: BookDocument, revision: number): Promise<number> {
  const structure = await readBookStructure(book._id);
  if (!structure) throw notFound("the extracted book structure is missing", book._id);

  const decisions = resolveBookDecisions(structure, await listDecisionOverrides(book._id));
  const kept = keptBlocks(structure, decisions);
  const segments = buildSegmentUpserts(
    book._id,
    structure,
    decisions,
    segmentOptionsFromDocument(book.segment_options),
    revision,
  );

  await replaceBookSegments(book._id, segments);
  await patchBook(book._id, { kept_block_count: kept.length });
  await syncBookState(book._id);
  return kept.length;
}

bookRouter.patch("/books/:id/decisions/:blockId", async (c) => {
  const bookId = c.req.param("id");
  const blockId = c.req.param("blockId");
  const book = await requireBook(bookId);
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

  // Kept blocks changed, so the plan built from them is stale. Re-planning here
  // rather than lazily is what keeps segments and decisions from ever
  // disagreeing about what the book contains.
  const revision = await bumpBookRevision(bookId);
  if (revision === null) throw notFound("book not found", bookId);

  const keptCount = await replanBook(book, revision);
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
      const payload = JSON.stringify({
        book_id: bookId,
        state: progress.state,
        revision: book.revision,
        progress: progress.progress,
        counts: {
          total: progress.total,
          pending: progress.pending,
          queued: progress.queued,
          rendering: progress.rendering,
          complete: progress.complete,
          failed: progress.failed,
        },
        segments: segments.map((segment) => ({ index: segment.index, state: segment.state })),
      });

      if (payload !== lastPayload) {
        await stream.writeSSE({ event: "book", data: payload });
        lastPayload = payload;
      }

      if (progress.state !== "rendering") {
        await stream.writeSSE({ event: "done", data: payload });
        return;
      }

      await sleep(1000);
    }
  });
});

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
  await requireBook(bookId);

  const segments = await listBookSegments(bookId);
  let cancelled = 0;
  for (const segment of segments) {
    if (segment.task_id && taskQueue.cancel(segment.task_id)) cancelled += 1;
  }

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

  await deleteBook(bookId);
  await deleteBookFiles(bookId);

  logger.success(`book deleted: ${bookId} (${segments.length} segments, ${cancelled} cancelled)`);
  return c.json(getResponse(200, { book_id: bookId, segments: segments.length, cancelled }));
});
