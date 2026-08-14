/**
 * Recognising a scanned book, page by page, as a background job.
 *
 * OCR cannot run inside the upload request. A page takes seconds — around seven
 * on a local vision model — so a 300-page scan is over half an hour, and an HTTP
 * request that long would time out and report failure to the user while the work
 * carried on invisibly behind it. So the upload only accepts the file, and this
 * module does the reading: an ordinary task created with `createTask` and run
 * through the existing `taskQueue`, exactly as `bookPipeline.ts` runs a segment,
 * which is what keeps cancellation and ownership stamping working here without a
 * second copy of any of it.
 *
 * Two things shape everything below. Half an hour of inference must survive a
 * restart, so every recognised page is written to a manifest on disk the moment
 * it lands and a resumed run reads that manifest instead of paying again — the
 * same bargain `services/voice/longform.ts` strikes with its chunk manifest. And
 * a page the engine chokes on must cost that page and nothing more: failures are
 * recorded per page, counted, and reported at the end, never thrown.
 *
 * The pure half — paragraph assembly, the manifest, progress accounting — sits
 * at the top and is exported on its own, so what a listener will eventually hear
 * can be tested without a PDF, an engine or a database.
 */

import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

import {
  bookDir,
  getBook,
  listDecisionOverrides,
  patchBook,
  replaceBookSegments,
  resolveBookDecisions,
  syncBookState,
  writeBookStructure,
} from "../db/books.ts";
import type { BookDocument, BookOcrDocument } from "../db/types.ts";
import { segmentOptionsFromDocument } from "../models/bookSchema.ts";
import { TASK_STATE_COMPLETE, TASK_STATE_FAILED, TASK_STATE_PROCESSING } from "../models/const.ts";
import { joinLineTexts, renderPdfPageToPng } from "../services/book/extract/pdf.ts";
import { keptBlocks } from "../services/book/filter/decisions.ts";
import { recognizePage, resolveOcrConfig } from "../services/book/ocr/index.ts";
import type { Block, BookStructure, Chapter, OcrProvenance } from "../services/book/types.ts";
import { errorMessage, logger } from "../utils/logger.ts";
import { getUuid } from "../utils/misc.ts";
import { buildSegmentUpserts, shouldCommitSegmentResult } from "./bookPipeline.ts";
import { PROCESS_OWNER_ID } from "./owner.ts";
import { taskQueue } from "./queue.ts";
import { appendTaskLog, createTask, updateTask } from "./state.ts";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** File name of the resume record, inside `<bookDir>/ocr/`. */
const MANIFEST_FILE = "pages.json";
const MANIFEST_VERSION = 1;

/**
 * Pages per chapter when a scan yields nothing to split on.
 *
 * A recognised page is a text blob with no font sizes in it, so there is no
 * evidence of a heading anywhere — the one signal the PDF extractor uses to find
 * chapters is exactly the one rasterising destroys. Fixed page bands are the
 * same fallback that extractor takes when a PDF has no headings, and they exist
 * for the same reason: segmentation has to group by something, and arbitrary
 * bands beat one chapter of four hundred pages.
 */
export const OCR_PAGES_PER_CHAPTER = 10;

/**
 * Progress band the page loop occupies, leaving room either side.
 *
 * The floor is claimed as soon as the job starts so a book does not sit at zero
 * through the first slow page, and the ceiling leaves the last few percent for
 * classification and segment planning, which happen after the last page.
 */
export const OCR_PROGRESS_FLOOR = 5;
export const OCR_PROGRESS_CEILING = 95;

// ---------------------------------------------------------------------------
// Paragraph assembly (pure)
// ---------------------------------------------------------------------------

/** One page as the engine returned it. */
export interface OcrPageText {
  /** 1-based page number in the source PDF. */
  page: number;
  text: string;
  provenance?: OcrProvenance;
}

/** A paragraph of recognised prose, ready to become a `Block`. */
export interface OcrParagraph {
  text: string;
  /** Page the paragraph started on. */
  page: number;
  /** Weakest provenance among the pages that contributed to it. */
  ocr?: OcrProvenance;
}

/** A word cut in half by the page break; the halves close up with no space. */
const HYPHEN_PAGE_END = /\p{L}{2}[-‐­]$/u;
/**
 * Sentence-final punctuation, including any quote or bracket closing over it.
 *
 * `foo."` and `foo.)` end a sentence just as `foo.` does, and a page that ends
 * on one is a page that ends on a complete thought.
 */
const SENTENCE_END = /[.!?…。！？؟][")'’”»\]】］]*$/u;
/** Opens in lower case, possibly behind an opening quote: mid-sentence. */
const CONTINUES_LOWERCASE = /^[([{"'‘“«【［]*\p{Ll}/u;

/**
 * Whether the last paragraph of one page runs on into the first of the next.
 *
 * A page break in a scan is a property of the paper, not of the prose. The
 * engine cannot know that, so it ends every page with a paragraph and starts the
 * next with another, and taken literally that splits a sentence in half at every
 * leaf — three hundred times over a book, each one a break the narrator would
 * read as a pause.
 *
 * Evidence, strongest first: a word broken by a hyphen at the foot of the page
 * can only be a continuation; a sentence that closed cannot be; and failing
 * both, text resuming in lower case is mid-sentence. Anything else is left
 * alone, because joining two genuinely separate paragraphs welds two thoughts
 * together and is the worse mistake of the two.
 */
export function continuesAcrossPageBreak(previous: string, next: string): boolean {
  const left = previous.trimEnd();
  const right = next.trimStart();
  if (left === "" || right === "") return false;

  if (HYPHEN_PAGE_END.test(left)) return true;
  if (SENTENCE_END.test(left)) return false;
  return CONTINUES_LOWERCASE.test(right);
}

/**
 * Splits one page's recognised text into paragraphs.
 *
 * A blank line is the only paragraph boundary an engine reliably reports, so it
 * is the only one trusted. Within a paragraph the lines are joined by the PDF
 * extractor's own `joinLineTexts`, which is what heals a word broken across a
 * line — reimplementing that reasoning here would be a second de-hyphenator to
 * keep in step with the first.
 */
export function splitOcrParagraphs(text: string): string[] {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((paragraph) => joinLineTexts(paragraph.split("\n")))
    .filter((paragraph) => paragraph !== "");
}

/**
 * The most cautious of two provenances.
 *
 * A paragraph assembled across a page boundary was recognised twice, possibly by
 * different engines and certainly with different confidence. It is only as
 * trustworthy as its worst half, and the review screen sorts by confidence, so
 * carrying the lower score is what puts a joined paragraph in front of a
 * reviewer rather than hiding it behind the better page's score.
 */
export function weakerProvenance(
  a: OcrProvenance | undefined,
  b: OcrProvenance | undefined,
): OcrProvenance | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.confidence < a.confidence ? b : a;
}

/**
 * Turns a book's recognised pages into paragraphs, in reading order.
 *
 * Pages are taken in the order given; the caller reads them out of the manifest,
 * which is written in page order.
 */
export function assembleOcrParagraphs(pages: readonly OcrPageText[]): OcrParagraph[] {
  const paragraphs: OcrParagraph[] = [];

  for (const page of pages) {
    const parts = splitOcrParagraphs(page.text);
    if (parts.length === 0) continue;

    let first = 0;
    const previous = paragraphs[paragraphs.length - 1];
    if (previous && continuesAcrossPageBreak(previous.text, parts[0]!)) {
      // `joinLineTexts` again, so the hyphen at the foot of the page is healed
      // by the same rule that heals one at the end of a line.
      previous.text = joinLineTexts([previous.text, parts[0]!]);
      previous.ocr = weakerProvenance(previous.ocr, page.provenance);
      first = 1;
    }

    for (let index = first; index < parts.length; index += 1) {
      paragraphs.push({ text: parts[index]!, page: page.page, ...(page.provenance ? { ocr: page.provenance } : {}) });
    }
  }

  return paragraphs;
}

// ---------------------------------------------------------------------------
// Structure (pure)
// ---------------------------------------------------------------------------

export interface OcrStructureOptions {
  title: string;
  author: string;
  language: string;
  /** Used for the chapter titles' upper bound; the scan report's page count. */
  totalPages: number;
  pagesPerChapter?: number;
}

function pageBandTitle(band: number, pagesPerChapter: number, totalPages: number): string {
  const first = band * pagesPerChapter + 1;
  const last = Math.min(first + pagesPerChapter - 1, Math.max(first, totalPages));
  return first === last ? `Page ${first}` : `Pages ${first}-${last}`;
}

/**
 * Assembles recognised pages into the structure the rest of the pipeline reads.
 *
 * Ids follow the contract every other extractor keeps: chapters are `ch-${i}`,
 * a block is `${chapterIndex}:${blockIndex}` within its chapter, and `order` is
 * the block's position in the whole book. Filtering and segmentation both depend
 * on that, and a block that came from a camera is not exempt from it.
 *
 * Every block carries its `ocr` provenance. That is the point of the whole
 * detour: a vision model fails by writing fluent, plausible prose rather than
 * obvious garbage, which is undetectable once spoken, so nothing recognised is
 * allowed downstream looking like text that was read from a text layer.
 */
export function buildOcrStructure(
  pages: readonly OcrPageText[],
  options: OcrStructureOptions,
): BookStructure {
  const pagesPerChapter = Math.max(1, options.pagesPerChapter ?? OCR_PAGES_PER_CHAPTER);
  const chapters: Chapter[] = [];
  const blocks: Block[] = [];
  let band = -1;

  for (const paragraph of assembleOcrParagraphs(pages)) {
    const nextBand = Math.floor(Math.max(0, paragraph.page - 1) / pagesPerChapter);
    if (nextBand !== band || chapters.length === 0) {
      band = nextBand;
      chapters.push({
        id: `ch-${chapters.length}`,
        title: pageBandTitle(band, pagesPerChapter, options.totalPages),
        level: 1,
        order: chapters.length,
        blockIds: [],
      });
    }

    const chapterIndex = chapters.length - 1;
    const chapter = chapters[chapterIndex]!;
    const block: Block = {
      id: `${chapterIndex}:${chapter.blockIds.length}`,
      kind: "paragraph",
      text: paragraph.text,
      chapterId: chapter.id,
      order: blocks.length,
      page: paragraph.page,
    };
    if (paragraph.ocr) block.ocr = paragraph.ocr;

    blocks.push(block);
    chapter.blockIds.push(block.id);
  }

  if (chapters.length === 0) {
    // A book with nothing in it is still a book: the review screen needs
    // somewhere to show the warning that says why it is empty.
    chapters.push({ id: "ch-0", title: options.title || "Untitled", level: 1, order: 0, blockIds: [] });
  }

  return {
    title: options.title,
    author: options.author,
    language: options.language,
    chapters,
    blocks,
  };
}

// ---------------------------------------------------------------------------
// Manifest (pure)
// ---------------------------------------------------------------------------

/** One page's outcome, whether it was read or not. */
export interface OcrPageRecord {
  page: number;
  text: string;
  provider: string;
  confidence: number;
  /** Set when the engine could not read the page; `text` is then empty. */
  error?: string;
}

export interface OcrManifest {
  version: number;
  /** Identity of the run this manifest belongs to. */
  fingerprint: string;
  pages: OcrPageRecord[];
}

export interface OcrRunIdentity {
  /** Digest of the source PDF's bytes. */
  sourceHash: string;
  /** `ocr_provider`, e.g. `tesseract`. */
  provider: string;
  language: string;
}

/**
 * Identity of an OCR run.
 *
 * "There is a manifest on disk" proves nothing about whether its pages were read
 * from this file, by the engine now configured, in the language now configured.
 * Reuse is gated on this string instead: switching the provider is something a
 * user does precisely because they were unhappy with what the last one wrote, so
 * it has to invalidate the pages it wrote rather than leave a book half read by
 * each.
 */
export function ocrRunFingerprint(identity: OcrRunIdentity): string {
  return [String(MANIFEST_VERSION), identity.sourceHash, identity.provider, identity.language].join(" ");
}

function isPageRecord(value: unknown): value is OcrPageRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.page === "number" &&
    Number.isInteger(record.page) &&
    record.page >= 1 &&
    typeof record.text === "string" &&
    typeof record.provider === "string" &&
    typeof record.confidence === "number" &&
    Number.isFinite(record.confidence) &&
    (record.error === undefined || typeof record.error === "string")
  );
}

/**
 * Reads a manifest left by an earlier run, or nothing when it cannot be trusted.
 *
 * Individual malformed entries are dropped rather than failing the whole file: a
 * run killed mid-write should cost one page, not the half hour before it.
 */
export function parseOcrManifest(raw: unknown, fingerprint: string): OcrManifest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const document = raw as Record<string, unknown>;
  if (document.version !== MANIFEST_VERSION) return null;
  if (document.fingerprint !== fingerprint) return null;
  if (!Array.isArray(document.pages)) return null;

  return {
    version: MANIFEST_VERSION,
    fingerprint,
    pages: document.pages.filter(isPageRecord),
  };
}

/** The stored outcome for a page, or null when it has not been read yet. */
export function findRecognizedPage(
  manifest: OcrManifest | null,
  page: number,
): OcrPageRecord | null {
  if (!manifest) return null;
  return manifest.pages.find((record) => record.page === page) ?? null;
}

/**
 * Whether a page still has to go through the engine.
 *
 * A page that failed last time is retried: the common causes — the model was not
 * loaded, the socket timed out, the process was killed mid-page — are all
 * transient, and a resume is the natural moment to try again. A page that
 * genuinely came back blank carries no error and is not read twice, since paying
 * seven seconds to confirm an empty leaf is empty is seven seconds wasted on
 * every resume.
 */
export function shouldRecognizePage(manifest: OcrManifest | null, page: number): boolean {
  const record = findRecognizedPage(manifest, page);
  return record === null || record.error !== undefined;
}

/** Pages of a run that are already done, in the order they will be read back. */
export function recognizedPages(manifest: OcrManifest | null, pages: readonly number[]): OcrPageRecord[] {
  if (!manifest) return [];
  const wanted = new Set(pages);
  return manifest.pages
    .filter((record) => wanted.has(record.page) && record.error === undefined)
    .sort((a, b) => a.page - b.page);
}

// ---------------------------------------------------------------------------
// Progress accounting (pure)
// ---------------------------------------------------------------------------

export interface OcrRunProgress {
  /** Pages the engine read, however poorly. */
  done: number;
  /** Pages it could not read at all. These are skipped, never fatal. */
  failed: number;
  total: number;
  /** Pages accounted for either way; what "page 34 of 300" counts. */
  attempted: number;
  /** Mean confidence over the pages that were read, 0..1. */
  meanConfidence: number;
}

/**
 * Summarises the records a run has accumulated.
 *
 * Derived from the manifest rather than counted up as the loop goes, so a
 * resumed run reports the true total instead of restarting the count from the
 * page it happened to resume at.
 */
export function summarizeOcrRun(
  records: readonly OcrPageRecord[],
  total: number,
): OcrRunProgress {
  const read = records.filter((record) => record.error === undefined);
  const failed = records.length - read.length;
  const confidence = read.reduce((sum, record) => sum + record.confidence, 0);

  return {
    done: read.length,
    failed,
    total,
    attempted: records.length,
    meanConfidence: read.length === 0 ? 0 : confidence / read.length,
  };
}

/** Maps pages accounted for onto the task's 0-100 progress bar. */
export function ocrTaskProgress(attempted: number, total: number): number {
  if (total <= 0) return OCR_PROGRESS_CEILING;
  const share = Math.min(1, Math.max(0, attempted / total));
  return OCR_PROGRESS_FLOOR + share * (OCR_PROGRESS_CEILING - OCR_PROGRESS_FLOOR);
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function ocrDir(bookId: string): string {
  return join(bookDir(bookId), "ocr");
}

export function ocrManifestPath(bookId: string): string {
  return join(ocrDir(bookId), MANIFEST_FILE);
}

/** The uploaded PDF, kept so its pages can be rasterised long after the upload. */
export function ocrSourcePath(bookId: string): string {
  return join(bookDir(bookId), "source.pdf");
}

async function readManifest(bookId: string, fingerprint: string): Promise<OcrManifest | null> {
  const path = ocrManifestPath(bookId);
  if (!existsSync(path)) return null;

  try {
    return parseOcrManifest(await Bun.file(path).json(), fingerprint);
  } catch (error) {
    logger.warning(`unreadable ocr manifest, starting fresh: ${errorMessage(error)}`);
    return null;
  }
}

/** Written through a temporary file, so a crash cannot leave half a manifest. */
async function writeManifest(bookId: string, manifest: OcrManifest): Promise<void> {
  const path = ocrManifestPath(bookId);
  const tempPath = `${path}.tmp`;
  await Bun.write(tempPath, JSON.stringify(manifest));
  await rename(tempPath, path);
}

function hashBytes(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

export interface OcrRunContext {
  bookId: string;
  taskId: string;
  /** Book revision at accept time; results are discarded if it moves on. */
  revision: number;
  sourcePath: string;
  /** 1-based page numbers to read, in reading order. */
  pages: number[];
  /** Total pages in the PDF, for the chapter band titles. */
  totalPages: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("the ocr pass was cancelled");
}

/** Patches the book's OCR record without disturbing the rest of it. */
async function patchOcrState(
  bookId: string,
  current: BookOcrDocument,
  fields: Partial<BookOcrDocument>,
): Promise<BookOcrDocument> {
  const merged = { ...current, ...fields };
  await patchBook(bookId, { ocr: merged });
  return merged;
}

/**
 * Recognises every outstanding page, writing each result before starting the next.
 *
 * The manifest is rewritten after every page on purpose. It is the difference
 * between a restart costing one page and costing the whole book, and at one
 * write per several seconds of inference the cost of it is not measurable.
 */
async function recognizeOutstandingPages(
  context: OcrRunContext,
  bytes: Uint8Array,
  manifest: OcrManifest,
  signal: AbortSignal,
  book: BookOcrDocument,
): Promise<{ records: OcrPageRecord[]; ocr: BookOcrDocument }> {
  const { bookId, taskId, pages } = context;
  let ocr = book;

  for (const [position, page] of pages.entries()) {
    throwIfAborted(signal);

    if (!shouldRecognizePage(manifest, page)) {
      logger.debug(`ocr page ${page} reused from a previous run, book_id: ${bookId}`);
      continue;
    }

    // Between pages the plan can be replaced or the book deleted outright, and
    // there is no point paying for a page nothing will read.
    const current = await getBook(bookId);
    if (!shouldCommitSegmentResult({ book: current, expectedRevision: context.revision })) {
      throw new Error("the book changed while it was being recognised");
    }

    const record = await recognizeOnePage(bytes, page);
    manifest.pages = [...manifest.pages.filter((entry) => entry.page !== page), record].sort(
      (a, b) => a.page - b.page,
    );
    await writeManifest(bookId, manifest);

    const progress = summarizeOcrRun(manifest.pages, pages.length);
    ocr = await patchOcrState(bookId, ocr, {
      pages_done: progress.done,
      pages_failed: progress.failed,
      mean_confidence: progress.meanConfidence,
    });

    await updateTask(taskId, { progress: ocrTaskProgress(progress.attempted, pages.length) });
    await appendTaskLog(
      taskId,
      record.error
        ? `ERROR [book-ocr] page ${page} (${position + 1}/${pages.length}) could not be read: ${record.error}`
        : `page ${page} (${position + 1}/${pages.length}) read by ${record.provider}, ` +
            `confidence ${record.confidence.toFixed(2)}, ${record.text.length} characters`,
    );
  }

  return { records: manifest.pages, ocr };
}

/**
 * Rasterises one page and hands it to the engine.
 *
 * Never throws. A scan is exactly the kind of file that carries a damaged page,
 * a mixed-content page the rasteriser refuses, or a page the model times out on,
 * and any of those failing the whole book would throw away every page already
 * paid for. The failure is recorded against the page and the run moves on.
 */
async function recognizeOnePage(bytes: Uint8Array, page: number): Promise<OcrPageRecord> {
  try {
    // `renderPdfPageToPng` copies the bytes it is handed, so the buffer survives
    // being read three hundred times.
    const image = await renderPdfPageToPng(bytes, page);
    const recognition = await recognizePage(image);
    return {
      page,
      text: recognition.text,
      provider: recognition.provenance.provider,
      confidence: recognition.provenance.confidence,
    };
  } catch (error) {
    const message = errorMessage(error);
    logger.warning(`ocr failed on page ${page}: ${message}`);
    return { page, text: "", provider: "", confidence: 0, error: message };
  }
}

/**
 * Turns the recognised pages into a reviewable book.
 *
 * The same landing as an ordinary import: structure on disk, decisions
 * classified, segments planned, `ready`. Nothing downstream is told the text
 * arrived by a different route — except the blocks themselves, which carry their
 * provenance so the review screen can say so.
 */
async function publishOcrResult(
  context: OcrRunContext,
  book: BookDocument,
  records: readonly OcrPageRecord[],
): Promise<{ blocks: number; kept: number; chapters: number }> {
  const pages: OcrPageText[] = records
    .filter((record) => record.error === undefined && record.text.trim() !== "")
    .map((record) => ({
      page: record.page,
      text: record.text,
      provenance: { provider: record.provider, confidence: record.confidence },
    }));

  const structure = buildOcrStructure(pages, {
    title: book.title,
    author: book.author,
    language: book.language,
    totalPages: context.totalPages,
  });

  if (structure.blocks.length === 0) {
    throw new Error("ocr finished but recognised no text on any page of this book");
  }

  await writeBookStructure(context.bookId, structure);

  const decisions = resolveBookDecisions(structure, await listDecisionOverrides(context.bookId));
  const kept = keptBlocks(structure, decisions);
  const segments = await buildSegmentUpserts(
    context.bookId,
    structure,
    decisions,
    segmentOptionsFromDocument(book.segment_options),
    context.revision,
  );
  await replaceBookSegments(context.bookId, segments);

  return { blocks: structure.blocks.length, kept: kept.length, chapters: structure.chapters.length };
}

/**
 * Reads a scanned book and leaves it in the state an ordinary import reaches.
 *
 * Every failure path ends by recording the failure on the book and the task
 * rather than by throwing into the queue: the upload was accepted, so the user
 * is watching this book, and it has to be able to say what went wrong with it.
 */
export async function runBookOcr(context: OcrRunContext, signal: AbortSignal): Promise<void> {
  const { bookId, taskId } = context;

  try {
    const book = await getBook(bookId);
    if (!shouldCommitSegmentResult({ book, expectedRevision: context.revision })) {
      logger.info(`abandoning a stale ocr pass, book_id: ${bookId}`);
      await updateTask(taskId, {
        state: TASK_STATE_FAILED,
        error: "the book changed before recognition started",
        owner_id: null,
      });
      return;
    }

    const config = resolveOcrConfig();
    await updateTask(taskId, {
      state: TASK_STATE_PROCESSING,
      progress: OCR_PROGRESS_FLOOR,
      owner_id: PROCESS_OWNER_ID,
    });

    if (!existsSync(context.sourcePath)) {
      throw new Error("the uploaded pdf is missing from disk, so its pages cannot be read again");
    }

    await mkdir(ocrDir(bookId), { recursive: true });
    const bytes = new Uint8Array(await Bun.file(context.sourcePath).arrayBuffer());
    const fingerprint = ocrRunFingerprint({
      sourceHash: hashBytes(bytes),
      provider: config.provider,
      language: config.language,
    });

    const manifest = (await readManifest(bookId, fingerprint)) ?? {
      version: MANIFEST_VERSION,
      fingerprint,
      pages: [],
    };

    const resumed = recognizedPages(manifest, context.pages).length;
    if (resumed > 0) {
      await appendTaskLog(taskId, `resuming: ${resumed} of ${context.pages.length} pages are already read`);
    }

    let ocr: BookOcrDocument = {
      source_path: context.sourcePath,
      pages: context.pages,
      pages_total: context.pages.length,
      pages_done: resumed,
      pages_failed: 0,
      provider: config.provider,
      mean_confidence: 0,
      task_id: taskId,
      error: null,
      started_at: new Date(),
      finished_at: null,
    };
    await patchBook(bookId, { state: "ocr", ocr });

    logger.info(
      `ocr started, book_id: ${bookId}, pages: ${context.pages.length}, ` +
        `resumed: ${resumed}, provider: ${config.provider}`,
    );

    const outcome = await recognizeOutstandingPages(context, bytes, manifest, signal, ocr);
    ocr = outcome.ocr;
    throwIfAborted(signal);

    // Last gate before anything is published: recognition took half an hour, and
    // a book deleted while it ran must not have a structure written back for it.
    const current = await getBook(bookId);
    if (!shouldCommitSegmentResult({ book: current, expectedRevision: context.revision })) {
      logger.warning(`discarding an ocr result after a revision change, book_id: ${bookId}`);
      await updateTask(taskId, {
        state: TASK_STATE_FAILED,
        error: "the book changed while it was being recognised",
        owner_id: null,
      });
      return;
    }

    const progress = summarizeOcrRun(outcome.records, context.pages.length);
    const published = await publishOcrResult(context, current!, outcome.records);

    await patchBook(bookId, {
      state: "ready",
      chapter_count: published.chapters,
      block_count: published.blocks,
      kept_block_count: published.kept,
      warnings: [...(current!.warnings ?? []), ...ocrWarnings(progress)],
      error: null,
      ocr: {
        ...ocr,
        pages_done: progress.done,
        pages_failed: progress.failed,
        mean_confidence: progress.meanConfidence,
        finished_at: new Date(),
        error: null,
      },
    });
    await syncBookState(bookId);

    await appendTaskLog(
      taskId,
      `recognised ${progress.done} of ${progress.total} pages into ${published.blocks} blocks ` +
        `(${published.kept} kept)`,
    );
    await updateTask(taskId, { state: TASK_STATE_COMPLETE, progress: 100, owner_id: null });

    logger.success(
      `ocr complete, book_id: ${bookId}, pages: ${progress.done}/${progress.total}, ` +
        `failed: ${progress.failed}, blocks: ${published.blocks}`,
    );
  } catch (error) {
    await failOcrRun(context, errorMessage(error)).catch((failure) => {
      logger.error(`failed to record an ocr failure: ${errorMessage(failure)}`);
    });
  }
}

/**
 * Warnings the review screen shows once, at the top of the book.
 *
 * Both of these are things a reader has to know before listening: that the words
 * were guessed from pixels at all, and that some pages contributed nothing.
 */
function ocrWarnings(progress: OcrRunProgress): string[] {
  const warnings = [
    `every word in this book was recognised from page images, not read from a text layer; ` +
      `mean confidence was ${(progress.meanConfidence * 100).toFixed(0)}% — review it before narrating it`,
  ];

  if (progress.failed > 0) {
    warnings.push(
      `${progress.failed} of ${progress.total} pages could not be read at all and are missing from the text`,
    );
  }

  return warnings;
}

/** Records a failed run on both the task and the book, so neither looks live. */
async function failOcrRun(context: OcrRunContext, message: string): Promise<void> {
  logger.error(`ocr failed, book_id: ${context.bookId}: ${message}`);
  await appendTaskLog(context.taskId, `ERROR [book-ocr] ${message}`);
  await updateTask(context.taskId, {
    state: TASK_STATE_FAILED,
    failed_stage: "book-ocr",
    error: message,
    owner_id: null,
  });

  const book = await getBook(context.bookId).catch(() => null);
  if (!shouldCommitSegmentResult({ book, expectedRevision: context.revision })) return;

  // The record may not exist yet: the run can fail before the first page, and
  // `patchBook` would then write `ocr: undefined` and lose the source path a
  // resume needs.
  const ocr = book?.ocr ?? null;
  await patchBook(context.bookId, {
    state: "failed",
    error: message,
    ...(ocr ? { ocr: { ...ocr, error: message, finished_at: new Date() } } : {}),
  });
}

// ---------------------------------------------------------------------------
// Accepting a run
// ---------------------------------------------------------------------------

export interface OcrStartResult {
  taskId: string;
  pages: number;
}

/**
 * Accepts an OCR pass and returns immediately.
 *
 * The task is created before the queue is told about it, so a book that is
 * merely waiting for a free slot still shows a task the user can cancel.
 */
export async function startBookOcr(input: {
  bookId: string;
  revision: number;
  sourcePath: string;
  pages: number[];
  totalPages: number;
}): Promise<OcrStartResult> {
  const taskId = getUuid();
  await createTask(taskId, {
    state: TASK_STATE_PROCESSING,
    progress: 0,
    request_id: `book-ocr:${input.bookId}`,
  });

  const context: OcrRunContext = {
    bookId: input.bookId,
    taskId,
    revision: input.revision,
    sourcePath: input.sourcePath,
    pages: input.pages,
    totalPages: input.totalPages,
  };

  taskQueue.add(taskId, (signal) => runBookOcr(context, signal));
  return { taskId, pages: input.pages.length };
}
