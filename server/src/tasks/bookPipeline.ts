/**
 * Per-segment rendering for long-form books: narration, captions, still video.
 *
 * A book is not a new kind of job. Each segment is an ordinary task created with
 * `createTask` and run through the existing `taskQueue`, which is what keeps
 * cancellation, ownership stamping and startup recovery working for books
 * without a second copy of any of it. What this module adds on top is the two
 * things a fan-out needs and a single task does not: a per-book concurrency cap,
 * so one 300-segment book cannot occupy every global slot for hours, and a
 * revision guard, so a render planned against an older version of the book
 * cannot write its results into a plan that has since changed underneath it.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";

import {
  getBook,
  getBookSegment,
  listDecisionOverrides,
  patchBook,
  patchBookSegment,
  readBookStructure,
  resolveBookDecisions,
  syncBookState,
  type BookSegmentUpsert,
} from "../db/books.ts";
import type { BookDocument, BookRenderParamsDocument } from "../db/types.ts";
import { TASK_STATE_COMPLETE, TASK_STATE_FAILED, TASK_STATE_PROCESSING } from "../models/const.ts";
import { aspectToResolution, type VideoAspectValue } from "../models/schema.ts";
import { videoParamsForBookRender } from "../models/bookSchema.ts";
import { keptBlocks } from "../services/book/filter/decisions.ts";
import { planSegments } from "../services/book/segment.ts";
import type { Block, BookStructure, FilterDecision, SegmentOptions } from "../services/book/types.ts";
import { assRenderOptionsFromParams, writeAssFile } from "../services/subtitle/ass.ts";
import { writeSrtFile } from "../services/subtitle/srt.ts";
import { supportsAssBurn } from "../services/video/capabilities.ts";
import { muxSoftSubtitles, sidecarSubtitlePath } from "../services/video/softSubs.ts";
import { renderStillSegment } from "../services/video/still.ts";
import { registerSubtitleFont } from "../services/video/textRender.ts";
import { synthesizeLongform } from "../services/voice/longform.ts";
import { errorMessage, logger } from "../utils/logger.ts";
import { getUuid } from "../utils/misc.ts";
import { booksDir, fontDir, taskDir } from "../utils/paths.ts";
import { PROCESS_OWNER_ID } from "./owner.ts";
import { taskQueue } from "./queue.ts";
import { appendTaskLog, createTask, updateTask } from "./state.ts";

/**
 * Segments of one book that may render at once.
 *
 * Two rather than one because a book is usually the only thing running and
 * serialising it would waste the machine; two rather than the global limit
 * because a book fans out into hundreds of segments, and letting one book fill
 * every slot would stall every short video queued behind it for hours.
 */
export const BOOK_SEGMENT_CONCURRENCY = 2;

/** Share of task progress spent on narration; the rest is the video encode. */
const SYNTHESIS_PROGRESS_SHARE = 0.7;
const SYNTHESIS_PROGRESS_FLOOR = 5;

// ---------------------------------------------------------------------------
// Per-book concurrency gate (pure)
// ---------------------------------------------------------------------------

/**
 * A counting semaphore keyed by book id.
 *
 * Deliberately implemented here rather than as a second limit inside
 * `TaskQueue`: the global queue's job is to protect the machine and knows
 * nothing about grouping, and adding a per-owner dimension to it would change
 * admission for every short video too. Holding segments back *before* they are
 * handed to the queue is also what makes the cap meaningful — waiting inside a
 * queued task would occupy the very slot the cap exists to leave free.
 */
export class BookConcurrencyGate {
  private readonly running = new Map<string, number>();
  private readonly waiters = new Map<string, (() => void)[]>();

  constructor(private readonly limit: number) {}

  /** Resolves once this book has a free slot. */
  acquire(key: string): Promise<void> {
    const active = this.running.get(key) ?? 0;
    if (active < this.limit) {
      this.running.set(key, active + 1);
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const queue = this.waiters.get(key);
      if (queue) queue.push(resolve);
      else this.waiters.set(key, [resolve]);
    });
  }

  /**
   * Frees a slot, handing it straight to the next waiter when there is one.
   *
   * The count is deliberately not decremented in that case: dropping it and
   * letting the waiter re-acquire would open a window in which a third segment
   * could take the slot, which is exactly the overshoot the cap prevents.
   */
  release(key: string): void {
    const queue = this.waiters.get(key);
    const next = queue?.shift();
    if (next) {
      if (queue!.length === 0) this.waiters.delete(key);
      next();
      return;
    }

    const active = (this.running.get(key) ?? 0) - 1;
    if (active > 0) this.running.set(key, active);
    else this.running.delete(key);
  }

  activeCount(key: string): number {
    return this.running.get(key) ?? 0;
  }

  waitingCount(key: string): number {
    return this.waiters.get(key)?.length ?? 0;
  }
}

const bookGate = new BookConcurrencyGate(BOOK_SEGMENT_CONCURRENCY);

// ---------------------------------------------------------------------------
// Revision guard (pure)
// ---------------------------------------------------------------------------

export interface SegmentCommitCheck {
  /** The book as it stands now, or null when it has been deleted. */
  book: { revision: number } | null | undefined;
  /** The revision the render was planned against. */
  expectedRevision: number;
}

/**
 * Whether a finished segment render may still write its results.
 *
 * Between planning a segment and finishing it lie minutes of synthesis and
 * encoding, during which a reviewer can re-segment the book or override a
 * decision — either of which replaces segment 7 with a different run of blocks
 * under the same id. Committing then would attach an hour-old audio file to
 * text it does not narrate. A deleted book is the same failure in its extreme
 * form, and is handled by the same check.
 */
export function shouldCommitSegmentResult(check: SegmentCommitCheck): boolean {
  if (!check.book) return false;
  return check.book.revision === check.expectedRevision;
}

// ---------------------------------------------------------------------------
// Planning and narration text (pure)
// ---------------------------------------------------------------------------

/** Turns a segment plan into the rows stored for a book, all unrendered. */
export function buildSegmentUpserts(
  bookId: string,
  structure: BookStructure,
  decisions: FilterDecision[],
  options: SegmentOptions,
  revision: number,
): BookSegmentUpsert[] {
  const kept = keptBlocks(structure, decisions);
  return planSegments(structure, kept, options).map((plan) => ({
    book_id: bookId,
    index: plan.index,
    title: plan.title,
    block_ids: plan.blockIds,
    estimated_duration: plan.estimatedDuration,
    state: "pending",
    revision,
    task_id: null,
    audio_path: null,
    video_path: null,
    subtitle_path: null,
    error: null,
  }));
}

/**
 * The blocks of one segment that survive filtering, in reading order.
 *
 * Re-filtered at render time rather than trusted from the plan: a decision
 * overridden after planning must take effect on the next render without forcing
 * a re-segmentation, and a block that is now dropped must not be narrated
 * merely because it was in the segment when it was planned.
 */
export function segmentBlocks(
  structure: BookStructure,
  decisions: FilterDecision[],
  blockIds: readonly string[],
): Block[] {
  const wanted = new Set(blockIds);
  return keptBlocks(structure, decisions).filter((block) => wanted.has(block.id));
}

/**
 * Joins blocks into narration.
 *
 * A blank line between blocks is not cosmetic: it is the boundary the long-form
 * chunker splits on first, so paragraphs stay whole across synthesis requests.
 */
export function segmentNarrationText(blocks: readonly Block[]): string {
  return blocks
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Cover image
// ---------------------------------------------------------------------------

const COVER_BACKGROUND = "#14161c";
const COVER_TITLE_COLOR = "#f5f5f7";
const COVER_AUTHOR_COLOR = "#9aa0ad";

function wrapCoverLines(
  measure: (text: string) => number,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && measure(candidate) > maxWidth) {
      lines.push(current);
      if (lines.length === maxLines) return lines;
      current = word;
    } else {
      current = candidate;
    }
  }

  if (current && lines.length < maxLines) lines.push(current);
  return lines;
}

/**
 * Draws a plain title card.
 *
 * `renderStillSegment` needs a picture and most uploads carry no usable cover,
 * so one is generated rather than failing the render or shipping a blank frame.
 * It is cached per resolution because re-rendering it for every segment of a
 * 300-segment book would be pure waste.
 */
function renderDefaultCover(
  title: string,
  author: string,
  width: number,
  height: number,
  fontFile: string,
): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const family = registerSubtitleFont(fontFile);

  ctx.fillStyle = COVER_BACKGROUND;
  ctx.fillRect(0, 0, width, height);

  const titleSize = Math.round(Math.min(width, height) * 0.085);
  const authorSize = Math.round(titleSize * 0.5);
  const maxWidth = width * 0.8;

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.font = `${titleSize}px "${family}"`;
  const titleLines = wrapCoverLines((text) => ctx.measureText(text).width, title || "Untitled", maxWidth, 4);

  const lineHeight = titleSize * 1.3;
  const authorLine = author.trim();
  const blockHeight = titleLines.length * lineHeight + (authorLine ? authorSize * 3 : 0);
  let y = height / 2 - blockHeight / 2 + lineHeight / 2;

  ctx.fillStyle = COVER_TITLE_COLOR;
  for (const line of titleLines) {
    ctx.fillText(line, width / 2, y);
    y += lineHeight;
  }

  if (authorLine) {
    ctx.font = `${authorSize}px "${family}"`;
    ctx.fillStyle = COVER_AUTHOR_COLOR;
    const [firstAuthorLine] = wrapCoverLines((text) => ctx.measureText(text).width, authorLine, maxWidth, 1);
    if (firstAuthorLine) ctx.fillText(firstAuthorLine, width / 2, y + authorSize);
  }

  return canvas.toBuffer("image/png");
}

async function ensureCoverImage(
  book: BookDocument,
  width: number,
  height: number,
  fontFile: string,
): Promise<string> {
  if (book.cover_path && existsSync(book.cover_path)) return book.cover_path;

  const generated = join(booksDir(book._id), `cover-${width}x${height}.png`);
  if (!existsSync(generated)) {
    await Bun.write(generated, renderDefaultCover(book.title, book.author, width, height, fontFile));
  }
  return generated;
}

// ---------------------------------------------------------------------------
// Segment render
// ---------------------------------------------------------------------------

export interface SegmentRenderContext {
  bookId: string;
  index: number;
  taskId: string;
  /** Book revision at fan-out time; results are discarded if it moves on. */
  revision: number;
  params: BookRenderParamsDocument;
}

/** Marks a segment failed without touching its siblings or the book's state. */
async function failSegment(context: SegmentRenderContext, message: string): Promise<void> {
  logger.error(`book segment failed, book_id: ${context.bookId}, index: ${context.index}: ${message}`);
  await appendTaskLog(context.taskId, `ERROR [book-segment] ${message}`);
  await updateTask(context.taskId, {
    state: TASK_STATE_FAILED,
    failed_stage: "book-segment",
    error: message,
    owner_id: null,
  });

  // A stale task must not resurrect a segment the current plan replaced, so the
  // failure is only recorded when the revision still matches.
  const book = await getBook(context.bookId).catch(() => null);
  if (shouldCommitSegmentResult({ book, expectedRevision: context.revision })) {
    await patchBookSegment(context.bookId, context.index, { state: "failed", error: message });
    await syncBookState(context.bookId);
  }
}

/**
 * Renders one segment: narration, subtitles, then a single still-image encode.
 *
 * Every failure path ends at `failSegment`, never at a thrown error escaping
 * into the queue: a book is a fan-out, and one chapter that fails to synthesise
 * must leave the other 299 running.
 */
export async function runSegmentRender(
  context: SegmentRenderContext,
  signal: AbortSignal,
): Promise<void> {
  const { bookId, index, taskId, params } = context;

  try {
    const book = await getBook(bookId);
    if (!shouldCommitSegmentResult({ book, expectedRevision: context.revision })) {
      logger.info(`abandoning stale book segment render, book_id: ${bookId}, index: ${index}`);
      await updateTask(taskId, { state: TASK_STATE_FAILED, error: "book changed before the render started", owner_id: null });
      return;
    }

    await updateTask(taskId, { state: TASK_STATE_PROCESSING, progress: 1, owner_id: PROCESS_OWNER_ID });
    await patchBookSegment(bookId, index, { state: "rendering", error: null });
    await syncBookState(bookId);

    const structure = await readBookStructure(bookId);
    if (!structure) throw new Error("the extracted book structure is missing from disk");

    const segment = await getBookSegment(bookId, index);
    if (!segment) throw new Error(`segment ${index} is no longer part of this book`);

    const decisions = resolveBookDecisions(structure, await listDecisionOverrides(bookId));
    const text = segmentNarrationText(segmentBlocks(structure, decisions, segment.block_ids));
    if (!text) throw new Error("every block in this segment was filtered out, so there is nothing to narrate");

    const directory = taskDir(taskId);
    const audioFile = join(directory, "narration.mp3");
    const subtitleFile = join(directory, "subtitle.srt");

    await appendTaskLog(taskId, `narrating "${segment.title}" (${text.length} characters)`);

    const narration = await synthesizeLongform({
      text,
      voiceName: params.voice_name,
      voiceRate: params.voice_rate,
      voiceVolume: params.voice_volume,
      outputFile: audioFile,
      workDir: join(directory, "chunks"),
      signal,
      onProgress: async (update) => {
        const share = update.total > 0 ? update.index / update.total : 0;
        await updateTask(taskId, {
          progress: SYNTHESIS_PROGRESS_FLOOR + share * (100 - SYNTHESIS_PROGRESS_FLOOR) * SYNTHESIS_PROGRESS_SHARE,
        });
        await appendTaskLog(
          taskId,
          `chunk ${update.index}/${update.total}${update.reused ? " (reused)" : ""}, ${update.duration.toFixed(1)}s`,
        );
      },
    });

    await writeSrtFile(subtitleFile, narration.cues);
    await updateTask(taskId, {
      progress: SYNTHESIS_PROGRESS_FLOOR + (100 - SYNTHESIS_PROGRESS_FLOOR) * SYNTHESIS_PROGRESS_SHARE,
      audio_file: audioFile,
      audio_duration: narration.duration,
      subtitle_path: subtitleFile,
    });

    const [width, height] = aspectToResolution(params.video_aspect as VideoAspectValue);
    const fontFile = join(fontDir(), params.font_name);
    const coverPath = await ensureCoverImage(book!, width, height, fontFile);

    // Burning is a preference, not a guarantee: a Homebrew ffmpeg routinely
    // ships without libass, and asking it to burn fails the whole encode. The
    // soft track is the fallback because it works on every build.
    const wantsCaptions = params.subtitle_render_mode !== "none" && narration.cues.length > 0;
    const canBurn = wantsCaptions && params.subtitle_render_mode === "burn" && (await supportsAssBurn());
    if (wantsCaptions && params.subtitle_render_mode === "burn" && !canBurn) {
      await appendTaskLog(taskId, "this ffmpeg cannot burn subtitles; embedding a soft track instead");
    }

    let assPath: string | undefined;
    if (canBurn) {
      assPath = join(directory, "subtitle.ass");
      await writeAssFile(assPath, narration.cues, assRenderOptionsFromParams(videoParamsForBookRender(params)));
    }

    const videoFile = join(directory, `segment-${String(index).padStart(4, "0")}.mp4`);
    const needsMux = wantsCaptions && !canBurn;
    // ffmpeg cannot read and write one file, so a soft mux needs its own input.
    const renderTarget = needsMux ? join(directory, "segment-silent-subs.mp4") : videoFile;

    await renderStillSegment({
      imagePath: coverPath,
      audioPath: audioFile,
      outputFile: renderTarget,
      width,
      height,
      assPath,
      fontsDir: assPath ? fontDir() : undefined,
      threads: params.n_threads,
      signal,
    });

    if (needsMux) {
      await muxSoftSubtitles({
        videoPath: renderTarget,
        subtitlePath: subtitleFile,
        outputFile: videoFile,
        language: structure.language,
        title: segment.title,
        sidecarPath: sidecarSubtitlePath(videoFile),
        signal,
      });
      await rm(renderTarget, { force: true });
    }

    // Last gate before anything is published: everything above took minutes, and
    // the plan may have been replaced while it ran.
    const current = await getBook(bookId);
    if (!shouldCommitSegmentResult({ book: current, expectedRevision: context.revision })) {
      logger.warning(`discarding book segment result after a revision change, book_id: ${bookId}, index: ${index}`);
      await updateTask(taskId, { state: TASK_STATE_FAILED, error: "book changed while this segment was rendering", owner_id: null });
      return;
    }

    await patchBookSegment(bookId, index, {
      state: "complete",
      audio_path: audioFile,
      video_path: videoFile,
      subtitle_path: subtitleFile,
      error: null,
    });
    await updateTask(taskId, {
      state: TASK_STATE_COMPLETE,
      progress: 100,
      videos: [videoFile],
      combined_videos: [videoFile],
      owner_id: null,
    });
    await syncBookState(bookId);

    logger.success(`book segment complete, book_id: ${bookId}, index: ${index}, duration: ${narration.duration.toFixed(1)}s`);
  } catch (error) {
    await failSegment(context, errorMessage(error)).catch((failure) => {
      logger.error(`failed to record book segment failure: ${errorMessage(failure)}`);
    });
  }
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

/**
 * Feeds a book's segments to the global queue, at most `BOOK_SEGMENT_CONCURRENCY`
 * at a time.
 *
 * Runs detached from the request that started it: a 300-segment book takes
 * hours, and the caller only needs to know which segments were accepted.
 */
async function fanOutSegments(
  bookId: string,
  indexes: number[],
  revision: number,
  params: BookRenderParamsDocument,
): Promise<void> {
  for (const index of indexes) {
    await bookGate.acquire(bookId);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      bookGate.release(bookId);
    };

    try {
      const book = await getBook(bookId);
      if (!shouldCommitSegmentResult({ book, expectedRevision: revision })) {
        logger.info(`stopping book fan-out, book_id: ${bookId} changed or was deleted`);
        release();
        return;
      }

      const taskId = getUuid();
      await createTask(taskId, {
        state: TASK_STATE_PROCESSING,
        progress: 0,
        request_id: `book:${bookId}:${index}`,
      });
      await patchBookSegment(bookId, index, { state: "queued", task_id: taskId, error: null });

      const context: SegmentRenderContext = { bookId, index, taskId, revision, params };
      taskQueue.add(taskId, (signal) => runSegmentRender(context, signal).finally(release));
    } catch (error) {
      release();
      const message = errorMessage(error);
      logger.error(`failed to queue book segment, book_id: ${bookId}, index: ${index}: ${message}`);
      await patchBookSegment(bookId, index, { state: "failed", error: message }).catch(() => {});
    }
  }

  await syncBookState(bookId).catch(() => {});
}

export interface RenderFanOutResult {
  accepted: number[];
  revision: number;
}

/**
 * Accepts a render for the given segments and returns immediately.
 *
 * Segments already rendering are skipped rather than queued twice, which would
 * have two tasks writing the same output file.
 */
export async function renderBookSegments(
  bookId: string,
  indexes: number[],
  params: BookRenderParamsDocument,
): Promise<RenderFanOutResult> {
  const book = await getBook(bookId);
  if (!book) throw new Error("book not found");

  await patchBook(bookId, { render_params: params, state: "rendering" });

  const accepted = [...indexes].sort((a, b) => a - b);
  for (const index of accepted) {
    await patchBookSegment(bookId, index, { state: "pending", error: null });
  }

  void fanOutSegments(bookId, accepted, book.revision, params).catch((error) => {
    logger.exception(`book fan-out failed, book_id: ${bookId}`, error);
  });

  return { accepted, revision: book.revision };
}

/** Segment states that must not be queued again while they are in flight. */
export const ACTIVE_SEGMENT_STATES: ReadonlySet<string> = new Set(["queued", "rendering"]);

/** Live counters, so the UI can explain why a book is progressing slowly. */
export function bookGateStats(bookId: string): { active: number; waiting: number; limit: number } {
  return {
    active: bookGate.activeCount(bookId),
    waiting: bookGate.waitingCount(bookId),
    limit: BOOK_SEGMENT_CONCURRENCY,
  };
}
