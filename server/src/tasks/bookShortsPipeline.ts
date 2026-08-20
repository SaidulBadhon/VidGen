/**
 * Hook-short planning and stock-footage render for books.
 *
 * Planning walks the kept text in chunks and asks the LLM for teasers. Rendering
 * is the ordinary short-video pipeline with a pre-filled script, so these jobs
 * share the global task queue with other shorts rather than the audiobook
 * per-book gate — a dozen 60s clips must not stall a chapter narrate.
 */

import {
  applyBlockEdits,
  getBook,
  getBookShort,
  listBlockEdits,
  listBookShorts,
  listDecisionOverrides,
  patchBook,
  patchBookShort,
  readBookStructure,
  replaceBookShorts,
  resolveBookDecisions,
  type BookShortUpsert,
} from "../db/books.ts";
import type { BookDocument, BookShortsPlanDocument, BookShortsRenderParamsDocument } from "../db/types.ts";
import { TASK_STATE_COMPLETE, TASK_STATE_FAILED, TASK_STATE_PROCESSING } from "../models/const.ts";
import { videoParamsForBookShort } from "../models/bookSchema.ts";
import { resolveVoiceName } from "../config/settings.ts";
import { keptBlocks } from "../services/book/filter/decisions.ts";
import {
  capPlannedShorts,
  dedupePlannedShorts,
  DEFAULT_SHORT_OPTIONS,
  finalizeProposedShorts,
  idleShortsPlan,
  packShortChunks,
  passageLinesForPrompt,
  selectShortChunks,
  targetScriptWords,
  type PlannedShort,
  type ShortOptions,
} from "../services/book/shorts.ts";
import { generateBookShorts, generateBookShortPublishMetadata } from "../services/llm/index.ts";
import { errorMessage, logger } from "../utils/logger.ts";
import { getUuid } from "../utils/misc.ts";
import { PROCESS_OWNER_ID } from "./owner.ts";
import { runPipeline } from "./pipeline.ts";
import { TaskQueueFullError, taskQueue } from "./queue.ts";
import { appendTaskLog, createTask, updateTask } from "./state.ts";
import { scheduleAutoYoutubeUpload } from "./youtubeUpload.ts";

export const ACTIVE_SHORT_STATES: ReadonlySet<string> = new Set(["queued", "rendering"]);

export interface ShortsPlanStartResult {
  taskId: string;
  revision: number;
  chunks: number;
}

export interface ShortsRenderFanOutResult {
  accepted: number[];
  revision: number;
}

function currentPlan(book: BookDocument): BookShortsPlanDocument {
  return book.shorts ?? idleShortsPlan();
}

async function log(taskId: string, message: string): Promise<void> {
  logger.info(message);
  await appendTaskLog(taskId, message);
}

function toUpserts(bookId: string, revision: number, shorts: PlannedShort[]): BookShortUpsert[] {
  return shorts.map((short) => ({
    book_id: bookId,
    index: short.index,
    title: short.title,
    hook: short.hook,
    script: short.script,
    youtube_title: short.youtubeTitle || short.title,
    description: short.description || "",
    tags: short.tags || [],
    chapter_title: short.chapterTitle,
    start_block_id: short.startBlockId,
    block_ids: short.blockIds,
    estimated_duration: short.estimatedDuration,
    state: "pending" as const,
    revision,
    task_id: null,
    audio_path: null,
    video_path: null,
    subtitle_path: null,
    error: null,
  }));
}

async function attachPublishMetadata(
  shorts: PlannedShort[],
  book: { title: string; author: string; language?: string },
): Promise<PlannedShort[]> {
  const result: PlannedShort[] = [];
  for (const short of shorts) {
    const meta = await generateBookShortPublishMetadata({
      bookTitle: book.title,
      author: book.author,
      language: book.language,
      chapterTitle: short.chapterTitle,
      title: short.title,
      hook: short.hook,
      script: short.script,
    });
    result.push({
      ...short,
      youtubeTitle: meta.youtubeTitle,
      description: meta.description,
      tags: meta.tags,
    });
  }
  return result;
}

export function shortsPlanIsBusy(plan: BookShortsPlanDocument | null | undefined): boolean {
  return plan?.state === "planning";
}

export function shortsRenderIsBusy(shorts: readonly { state: string }[]): boolean {
  return shorts.some((short) => ACTIVE_SHORT_STATES.has(short.state));
}

/** True while a shorts plan or any short render is in flight. */
export function shortsWorkIsActive(
  plan: BookShortsPlanDocument | null | undefined,
  shorts: readonly { state: string }[],
): boolean {
  return shortsPlanIsBusy(plan) || shortsRenderIsBusy(shorts);
}

export function shortsWorkActive(book: BookDocument, shorts: readonly { state: string }[]): boolean {
  return shortsWorkIsActive(book.shorts, shorts);
}

/** Plan overlay the browser can show; host-only fields stay off it. */
export function publicShortsPlan(plan: BookShortsPlanDocument | null | undefined): Record<string, unknown> {
  const value = plan ?? idleShortsPlan();
  return {
    state: value.state,
    revision: value.revision,
    chunks_total: value.chunks_total,
    chunks_done: value.chunks_done,
    target_duration_seconds: value.target_duration_seconds,
    max_shorts: value.max_shorts,
    words_per_minute: value.words_per_minute,
    error: value.error ?? null,
    render_params: value.render_params ?? null,
  };
}

/** Shorts share the global task queue; this exists so the tab can show a cap. */
export function shortGateStats(_bookId?: string): { active: number; waiting: number; limit: number } {
  return { active: 0, waiting: 0, limit: 0 };
}

/**
 * Accepts a hook-finding pass and returns immediately.
 *
 * Refused by the route when a pass is already running or shorts are rendering;
 * this function assumes those checks have already been made.
 */
export async function startBookShortsPlan(input: {
  bookId: string;
  options: ShortOptions;
}): Promise<ShortsPlanStartResult> {
  const { bookId, options } = input;
  const book = await getBook(bookId);
  if (!book) throw new Error("book not found");

  const previous = currentPlan(book);
  const revision = previous.revision + 1;
  const taskId = getUuid();
  const now = new Date();

  await createTask(taskId, {
    state: TASK_STATE_PROCESSING,
    progress: 0,
    request_id: `book-shorts-plan:${bookId}:${revision}`,
  });

  const overlay: BookShortsPlanDocument = {
    ...previous,
    state: "planning",
    revision,
    chunks_total: 0,
    chunks_done: 0,
    target_duration_seconds: options.targetDurationSeconds,
    max_shorts: options.maxShorts,
    words_per_minute: options.wordsPerMinute,
    task_id: taskId,
    error: null,
    started_at: now,
    finished_at: null,
  };
  await patchBook(bookId, { shorts: overlay });

  try {
    taskQueue.add(taskId, (signal) => runBookShortsPlan({ bookId, taskId, revision, options }, signal));
  } catch (error) {
    await patchBook(bookId, {
      shorts: { ...overlay, state: "failed", error: errorMessage(error), task_id: null, finished_at: new Date() },
    });
    throw error;
  }

  return { taskId, revision, chunks: 0 };
}

interface PlanRunContext {
  bookId: string;
  taskId: string;
  revision: number;
  options: ShortOptions;
}

function shouldCommitPlan(book: BookDocument | null, expectedRevision: number): boolean {
  if (!book?.shorts) return false;
  return book.shorts.revision === expectedRevision && book.shorts.state === "planning";
}

async function runBookShortsPlan(context: PlanRunContext, signal: AbortSignal): Promise<void> {
  const { bookId, taskId, revision, options } = context;

  try {
    await updateTask(taskId, { state: TASK_STATE_PROCESSING, progress: 5, owner_id: PROCESS_OWNER_ID });
    await log(taskId, `finding hook shorts for book ${bookId}`);

    const loaded = await readBookStructure(bookId);
    if (!loaded) throw new Error("the extracted book structure is missing");

    const [overrides, edits] = await Promise.all([listDecisionOverrides(bookId), listBlockEdits(bookId)]);
    const decisions = resolveBookDecisions(loaded, overrides);
    const edited = applyBlockEdits(loaded, edits);
    const kept = keptBlocks(edited, decisions);
    if (kept.length === 0) throw new Error("this book has no kept text to make shorts from");

    const packed = packShortChunks(edited, kept);
    const chunks = selectShortChunks(packed, options.maxShorts);
    if (chunks.length === 0) throw new Error("no passages were long enough to make a short from");

    const book = await getBook(bookId);
    if (!shouldCommitPlan(book, revision)) {
      await log(taskId, "stopping shorts plan; a newer pass replaced this one");
      return;
    }

    await patchBook(bookId, {
      shorts: {
        ...(book!.shorts as BookShortsPlanDocument),
        chunks_total: chunks.length,
        chunks_done: 0,
      },
    });
    await updateTask(taskId, { progress: 10 });
    await log(taskId, `walking ${chunks.length} passage(s) of ${packed.length}`);

    const collected: PlannedShort[] = [];
    for (let index = 0; index < chunks.length; index++) {
      if (signal.aborted) throw new Error("shorts plan was cancelled");
      const latest = await getBook(bookId);
      if (!shouldCommitPlan(latest, revision)) {
        await log(taskId, "stopping shorts plan; a newer pass replaced this one");
        return;
      }

      const chunk = chunks[index]!;
      await log(taskId, `passage ${index + 1}/${chunks.length}: ${chunk.chapterTitle}`);
      const lines = passageLinesForPrompt(chunk);
      const raw = await generateBookShorts({
        bookTitle: edited.title || latest?.title || "",
        author: edited.author || latest?.author || "",
        language: edited.language || latest?.language,
        chapterTitle: chunk.chapterTitle,
        targetSeconds: options.targetDurationSeconds,
        targetWords: targetScriptWords(options),
        chunkIndex: index + 1,
        chunkCount: chunks.length,
        lines,
      });
      collected.push(...finalizeProposedShorts(raw, chunk, options));

      const done = index + 1;
      await patchBook(bookId, {
        shorts: {
          ...(latest!.shorts as BookShortsPlanDocument),
          chunks_total: chunks.length,
          chunks_done: done,
        },
      });
      await updateTask(taskId, {
        progress: 10 + Math.round((done / chunks.length) * 80),
      });
    }

    const planned = capPlannedShorts(dedupePlannedShorts(collected), options.maxShorts);
    const latest = await getBook(bookId);
    if (!shouldCommitPlan(latest, revision)) {
      await log(taskId, "stopping shorts plan; a newer pass replaced this one");
      return;
    }

    await log(taskId, `writing YouTube listings for ${planned.length} short(s)`);
    const withPublish = await attachPublishMetadata(planned, {
      title: edited.title || latest?.title || "",
      author: edited.author || latest?.author || "",
      language: edited.language || latest?.language,
    });
    if (signal.aborted) throw new Error("shorts plan was cancelled");
    const stillCurrent = await getBook(bookId);
    if (!shouldCommitPlan(stillCurrent, revision)) {
      await log(taskId, "stopping shorts plan; a newer pass replaced this one");
      return;
    }

    await replaceBookShorts(bookId, toUpserts(bookId, revision, withPublish));
    await patchBook(bookId, {
      shorts: {
        ...(stillCurrent!.shorts as BookShortsPlanDocument),
        state: "ready",
        chunks_total: chunks.length,
        chunks_done: chunks.length,
        error: null,
        finished_at: new Date(),
      },
    });
    await updateTask(taskId, { state: TASK_STATE_COMPLETE, progress: 100, owner_id: null });
    await log(taskId, `planned ${planned.length} short(s)`);
    logger.success(`book shorts planned: ${bookId} (${planned.length} shorts from ${chunks.length} passages)`);
  } catch (error) {
    const message = errorMessage(error);
    logger.error(`book shorts plan failed, book_id: ${bookId}: ${message}`);
    await appendTaskLog(taskId, `ERROR ${message}`).catch(() => {});
    await updateTask(taskId, { state: TASK_STATE_FAILED, error: message, owner_id: null }).catch(() => {});
    const latest = await getBook(bookId).catch(() => null);
    if (shouldCommitPlan(latest, revision) && latest) {
      await patchBook(bookId, {
        shorts: {
          ...(latest.shorts as BookShortsPlanDocument),
          state: "failed",
          error: message,
          finished_at: new Date(),
        },
      }).catch(() => {});
    }
  }
}

/**
 * Queues stock-footage renders for the given shorts and returns immediately.
 */
export async function renderBookShorts(
  bookId: string,
  indexes: number[],
  params: BookShortsRenderParamsDocument,
): Promise<ShortsRenderFanOutResult> {
  const book = await getBook(bookId);
  if (!book) throw new Error("book not found");

  const overlay = currentPlan(book);
  await patchBook(bookId, { shorts: { ...overlay, render_params: params } });

  const accepted = [...indexes].sort((a, b) => a - b);
  for (const index of accepted) {
    await patchBookShort(bookId, index, { state: "pending", error: null });
  }

  void fanOutShorts(bookId, accepted, overlay.revision, params).catch((error) => {
    logger.exception(`book shorts fan-out failed, book_id: ${bookId}`, error);
  });

  return { accepted, revision: overlay.revision };
}

async function fanOutShorts(
  bookId: string,
  indexes: number[],
  revision: number,
  params: BookShortsRenderParamsDocument,
): Promise<void> {
  for (const index of indexes) {
    const book = await getBook(bookId);
    if (!book || (book.shorts?.revision ?? 0) !== revision) {
      logger.info(`stopping shorts fan-out, book_id: ${bookId} plan changed or was deleted`);
      return;
    }

    const taskId = getUuid();
    const resolved: BookShortsRenderParamsDocument = {
      ...params,
      voice_name: resolveVoiceName(params.voice_name),
    };

    try {
      const short = await getBookShort(bookId, index);
      if (!short) continue;

      const videoParams = videoParamsForBookShort({
        title: short.title,
        script: short.script,
        language: book.language,
        params: resolved,
      });

      await createTask(taskId, {
        state: TASK_STATE_PROCESSING,
        progress: 0,
        request_id: `book-short:${bookId}:${index}`,
        params: videoParams,
      });
      await patchBookShort(bookId, index, { state: "queued", task_id: taskId, error: null });

      taskQueue.add(taskId, (signal) => runShortRender({ bookId, index, taskId, revision, params: resolved }, signal));
    } catch (error) {
      const message = error instanceof TaskQueueFullError ? error.message : errorMessage(error);
      logger.error(`failed to queue book short, book_id: ${bookId}, index: ${index}: ${message}`);
      await patchBookShort(bookId, index, { state: "failed", error: message }).catch(() => {});
    }
  }
}

interface ShortRenderContext {
  bookId: string;
  index: number;
  taskId: string;
  revision: number;
  params: BookShortsRenderParamsDocument;
}

async function runShortRender(context: ShortRenderContext, signal: AbortSignal): Promise<void> {
  const { bookId, index, taskId, revision, params } = context;

  const stillCurrent = async (): Promise<boolean> => {
    const book = await getBook(bookId);
    const short = await getBookShort(bookId, index);
    if (!book || !short) return false;
    if ((book.shorts?.revision ?? 0) !== revision) return false;
    if (short.task_id !== taskId) return false;
    return true;
  };

  try {
    if (!(await stillCurrent())) return;
    await patchBookShort(bookId, index, { state: "rendering", error: null });

    const short = await getBookShort(bookId, index);
    const book = await getBook(bookId);
    if (!short || !book) return;

    const videoParams = videoParamsForBookShort({
      title: short.title,
      script: short.script,
      language: book.language,
      params,
    });

    const result = await runPipeline({ taskId, params: videoParams, stopAt: "video", signal });
    if (!(await stillCurrent())) return;

    if (result.state === TASK_STATE_FAILED || result.error) {
      await patchBookShort(bookId, index, {
        state: "failed",
        error: result.error || "short render failed",
      });
      return;
    }

    const videoPath = result.videos?.[0] ?? result.combined_videos?.[0] ?? null;
    await patchBookShort(bookId, index, {
      state: "complete",
      video_path: videoPath,
      audio_path: result.audio_file ?? null,
      subtitle_path: result.subtitle_path ?? null,
      error: null,
    });

    if (videoPath) {
      await scheduleAutoYoutubeUpload({
        taskId,
        videoPaths: [videoPath],
        videoSubject: short.youtube_title || short.title,
        videoScript: short.script,
        videoLanguage: book.language,
      }).catch((error) => {
        logger.warning(`YouTube auto-upload skipped for short ${bookId}/${index}: ${errorMessage(error)}`);
      });
    }
  } catch (error) {
    const message = errorMessage(error);
    logger.error(`book short render failed, book_id: ${bookId}, index: ${index}: ${message}`);
    if (await stillCurrent()) {
      await patchBookShort(bookId, index, { state: "failed", error: message }).catch(() => {});
    }
  }
}

export function shortsOptionsFromPlan(plan: BookShortsPlanDocument | null | undefined): ShortOptions {
  if (!plan) return DEFAULT_SHORT_OPTIONS;
  return {
    targetDurationSeconds: plan.target_duration_seconds || DEFAULT_SHORT_OPTIONS.targetDurationSeconds,
    maxShorts: plan.max_shorts || DEFAULT_SHORT_OPTIONS.maxShorts,
    wordsPerMinute: plan.words_per_minute || DEFAULT_SHORT_OPTIONS.wordsPerMinute,
  };
}
