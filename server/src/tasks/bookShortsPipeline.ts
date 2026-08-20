/**
 * Hook-short planning and render for books.
 *
 * Planning walks the kept text in chunks and asks the LLM for teasers. Rendering
 * is the ordinary short-video pipeline with a pre-filled script, so these jobs
 * share the global task queue with other shorts rather than the audiobook
 * per-book gate — a dozen 60s clips must not stall a chapter narrate.
 *
 * A short can also take its PICTURE from a HyperFrames template instead of
 * stock footage. That is a re-plumb of the same pipeline, not a second one:
 * HyperFrames does no TTS, so the run still goes through `runPipeline` for the
 * narration and the cues and only then swaps what the viewer looks at. Stopping
 * at `"video"` and calling a composition renderer instead would leave every
 * templated short with a null `audio_path` and `subtitle_path`, which is the
 * specific bug renderShortVideo() and its tests exist to prevent.
 */

import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { videoParamsForBookShort, type BookShortVideoParams } from "../models/bookSchema.ts";
import { aspectToResolution, type VideoAspectValue } from "../models/schema.ts";
import { resolveVoiceName } from "../config/settings.ts";
import { getBgmFile, shouldUseBgm } from "../services/bgm.ts";
import { assRenderOptionsFromParams, writeAssFile } from "../services/subtitle/ass.ts";
import { parseSrtContent } from "../services/subtitle/srt.ts";
import { supportsAssBurn } from "../services/video/capabilities.ts";
import {
  HyperframesError,
  hyperframesAvailable,
  renderComposition,
  type CompositionRenderOptions,
  type CompositionRenderResult,
} from "../services/video/hyperframes.ts";
import { probe, type MediaInfo } from "../services/video/probe.ts";
import {
  muxSoftSubtitles,
  sidecarSubtitlePath,
  type SoftSubtitleOptions,
  type SoftSubtitleResult,
} from "../services/video/softSubs.ts";
import {
  renderStillSegment,
  type StillSegmentOptions,
  type StillSegmentResult,
} from "../services/video/still.ts";
import { getTemplate, templatePartDir, type TemplateManifest } from "../services/video/templates.ts";
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
import { fontDir, taskDir } from "../utils/paths.ts";
import { PROCESS_OWNER_ID } from "./owner.ts";
import {
  resolveCustomAudioFile,
  runPipeline,
  type PipelineResult,
  type RunPipelineOptions,
} from "./pipeline.ts";
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
        hook: short.hook,
        chapter_title: short.chapter_title,
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

// ---------------------------------------------------------------------------
// Templated shorts: a HyperFrames picture in place of stock footage
// ---------------------------------------------------------------------------

/** Composition render for one short, kept beside its narration in the task dir. */
const COMPOSITION_FILE = "short-picture.mp4";

/** Where the stock path writes its deliverable; the templated path matches it. */
const FINAL_VIDEO_FILE = "final-1.mp4";

/**
 * Collaborators the render reaches for, injected so the branch table is testable.
 *
 * The thing worth testing here is not an encode — it is which path a short
 * takes and what it records afterwards. Reaching for the modules directly would
 * make "a templated short still writes its narration and its cues" a claim that
 * needs Mongo, Chrome and ffmpeg to check, which is how that assertion ends up
 * never being written. The live bundle is the default argument, so nothing in
 * production ever passes one.
 */
export interface ShortRenderDeps {
  runPipeline: (options: RunPipelineOptions) => Promise<PipelineResult>;
  hyperframesAvailable: () => Promise<boolean>;
  renderComposition: (options: CompositionRenderOptions) => Promise<CompositionRenderResult>;
  renderStillSegment: (options: StillSegmentOptions) => Promise<StillSegmentResult>;
  probe: (filePath: string) => Promise<MediaInfo>;
  supportsAssBurn: () => Promise<boolean>;
  muxSoftSubtitles: (options: SoftSubtitleOptions) => Promise<SoftSubtitleResult>;
}

export const liveShortRenderDeps: ShortRenderDeps = {
  runPipeline,
  hyperframesAvailable,
  renderComposition,
  renderStillSegment,
  probe,
  supportsAssBurn,
  muxSoftSubtitles,
};

/** What a finished short leaves behind, whichever path produced it. */
export interface ShortRenderOutcome {
  videoPath: string | null;
  /** The narration. Never null on a path that completed — see shortCompletionPatch(). */
  audioPath: string | null;
  /** The cue file. Same promise as `audioPath`. */
  subtitlePath: string | null;
  audioDuration: number | null;
  /** Non-null when the short could not be rendered at all. */
  error: string | null;
  /** True when the picture came from a template composition. */
  templated: boolean;
}

/**
 * The row a completed short is written as.
 *
 * Exists as its own function so both paths provably record the same four
 * fields: the whole hazard in this module is a picture-only branch that forgets
 * `audio_path` / `subtitle_path`, and a shared shaper is what makes that
 * impossible to do on one branch and not the other.
 */
export function shortCompletionPatch(outcome: ShortRenderOutcome): {
  state: "complete";
  video_path: string | null;
  audio_path: string | null;
  subtitle_path: string | null;
  error: null;
} {
  return {
    state: "complete",
    video_path: outcome.videoPath,
    audio_path: outcome.audioPath,
    subtitle_path: outcome.subtitlePath,
    error: null,
  };
}

/** The root element's compile-time frame, read straight out of the markup. */
export interface CompositionFrame {
  duration: number;
  width: number;
  height: number;
  /** The exact `data-duration` text, so a retime can replace it byte-for-byte. */
  durationLiteral: string;
}

/**
 * The `#root` opening tag. Attribute values cannot contain `>`, so stopping at
 * the first one is safe on the well-formed markup a template ships.
 */
const ROOT_ELEMENT = /<[a-zA-Z][^>]*\bid=["']root["'][^>]*>/;

const COMPOSITION_VARIABLES = /data-composition-variables=(["'])([\s\S]*?)\1/;

function tagAttribute(tag: string, name: string): string | null {
  return new RegExp(`\\b${name}=["']([^"']*)["']`).exec(tag)?.[1] ?? null;
}

/** Seconds as a composition writes them: no trailing zeros, no exponent. */
function formatSeconds(value: number): string {
  return String(Number(value.toFixed(3)));
}

/**
 * Reads the frame a composition was compiled against, or null when it declares
 * no usable one.
 *
 * Null is a fall-back-to-stock signal rather than an error: a template is a
 * checked-in file that can be edited into an unusable state, and a short must
 * not fail because someone deleted an attribute.
 */
export function readCompositionFrame(html: string): CompositionFrame | null {
  const tag = ROOT_ELEMENT.exec(String(html ?? ""))?.[0];
  if (!tag) return null;

  const durationLiteral = tagAttribute(tag, "data-duration");
  const duration = Number(durationLiteral);
  const width = Number(tagAttribute(tag, "data-width"));
  const height = Number(tagAttribute(tag, "data-height"));
  if (!durationLiteral || !(duration > 0) || !(width > 0) || !(height > 0)) return null;

  return { duration, width, height, durationLiteral };
}

/**
 * Rewrites a composition to a new length. Returns null when it has no root
 * duration to rewrite.
 *
 * This is the T0 finding that shapes the whole templated path: root
 * `data-duration` is read at *compile* time, so `--variables` cannot change how
 * long a render is. A short is exactly as long as its TTS, which varies with
 * script, voice and rate — so the length has to be written into the markup, and
 * into a working copy, never into `resource/`.
 *
 * Every `data-duration` equal to the root's is replaced, not just the root's
 * own. A composition's full-span clip carries the same literal, and patching
 * only the root leaves that clip ending at the authored length — which shows up
 * as a blank frame over the tail of every short longer than the default. An
 * element that runs the whole composition is exactly the element that must be
 * retimed with it, so matching on the literal is the rule rather than a trick.
 *
 * CSS animation durations are deliberately left alone: they are style, not
 * timing, and a template author who wants motion for the full runtime is
 * expected to author it so it survives (the classic short holds its final frame
 * via `animation-fill-mode: both`). Rewriting arbitrary CSS from here would
 * break far more than it fixed.
 */
export function retimeComposition(html: string, seconds: number): string | null {
  const frame = readCompositionFrame(html);
  if (!frame || !(seconds > 0)) return null;

  const next = formatSeconds(seconds);
  if (next === frame.durationLiteral) return html;

  let retimed = html;
  for (const quote of ['"', "'"]) {
    retimed = retimed
      .split(`data-duration=${quote}${frame.durationLiteral}${quote}`)
      .join(`data-duration=${quote}${next}${quote}`);
  }
  return retimed;
}

/**
 * Variable ids a composition declares, or null when it declares none readably.
 *
 * Used to send only what the composition asked for. The CLI is handed
 * `--variables` as one JSON argv entry, and a template that declares a
 * different vocabulary should render with its own defaults rather than have a
 * render rejected — or worse, silently reshaped — by keys it never asked for.
 */
export function declaredCompositionVariables(html: string): string[] | null {
  const match = COMPOSITION_VARIABLES.exec(String(html ?? ""));
  if (!match) return null;

  // The attribute is ordinary HTML, so its JSON may arrive entity-encoded.
  const raw = match[2]!
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

  try {
    const parsed = JSON.parse(raw) as Array<{ id?: unknown }>;
    if (!Array.isArray(parsed)) return null;
    const ids = parsed.map((entry) => String(entry?.id ?? "").trim()).filter(Boolean);
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

/**
 * Values for a short's composition, narrowed to what it declares.
 *
 * `video_subject` is the short's own hook-y title rather than the book's, which
 * is why the book title is passed in separately; `hook` and `chapter_title` ride
 * on the params for exactly this reason.
 */
export function shortCompositionVariables(input: {
  bookTitle: string;
  params: BookShortVideoParams;
  accent: string;
  declared?: string[] | null;
}): Record<string, string> {
  const { params } = input;
  const candidates: Record<string, string> = {
    bookTitle: input.bookTitle || params.video_subject || "",
    chapterTitle: params.chapter_title || "",
    hookText: params.hook || params.video_subject || "",
    accent: input.accent,
  };

  const declared = input.declared;
  if (!declared || declared.length === 0) return candidates;

  const picked: Record<string, string> = {};
  for (const id of declared) {
    if (id in candidates) picked[id] = candidates[id]!;
  }
  return picked;
}

/**
 * Where `runPipeline` put the narration.
 *
 * `stopAt: "subtitle"` returns the cue file and nothing else, so the audio has
 * to be located by the same rule pipeline.ts wrote it with. That coupling is
 * the price of not re-plumbing the shared pipeline's return shape for one
 * caller; it is asserted by the existence check at the call site, which falls
 * back to stock footage rather than handing ffmpeg a path to nothing.
 */
export function narrationFileForTask(taskId: string, params: BookShortVideoParams): string {
  const custom = String(params.custom_audio_file ?? "").trim();
  if (custom) return resolveCustomAudioFile(taskId, custom);
  return join(taskDir(taskId), "audio.mp3");
}

interface TemplatedShortPlan {
  manifest: TemplateManifest;
  projectDir: string;
  html: string;
  frame: CompositionFrame;
  variables: Record<string, string>;
}

export interface ShortRenderInput {
  taskId: string;
  bookTitle: string;
  params: BookShortVideoParams;
  signal: AbortSignal;
  log?: (message: string) => Promise<void>;
  /** Composition render progress, 0..1. Already coalesced by the renderer. */
  onProgress?: (fraction: number) => void;
}

/**
 * Decides whether this short can take the templated path, before any work is paid for.
 *
 * Every refusal is a log line and a `null`, never a throw: a short must not fail
 * because a template was deleted, renamed, authored at the wrong aspect or
 * because this host cannot start Chrome. The order is deliberate — the cheap
 * checks reject first, and `hyperframesAvailable()` runs last because it
 * launches a browser.
 */
async function planTemplatedShort(
  input: ShortRenderInput,
  deps: ShortRenderDeps,
  say: (message: string) => Promise<void>,
): Promise<TemplatedShortPlan | null> {
  const templateId = String(input.params.template_id ?? "").trim();
  if (!templateId) return null;

  const decline = async (reason: string): Promise<null> => {
    logger.warning(`book short ${input.taskId} falls back to stock footage: ${reason}`);
    await say(`template "${templateId}" is unusable (${reason}); rendering stock footage instead`);
    return null;
  };

  const manifest = getTemplate(templateId);
  if (!manifest) return decline("no template with that id is installed");
  if (!manifest.parts.includes("short")) return decline("the template ships no short composition");

  let projectDir: string;
  let html: string;
  try {
    projectDir = templatePartDir(templateId, "short");
    html = await readFile(join(projectDir, "index.html"), "utf8");
  } catch (error) {
    return decline(`its short composition could not be read: ${errorMessage(error)}`);
  }

  const frame = readCompositionFrame(html);
  if (!frame) return decline("its short composition declares no usable #root frame");

  let width: number;
  let height: number;
  try {
    [width, height] = aspectToResolution(input.params.video_aspect as VideoAspectValue);
  } catch (error) {
    return decline(errorMessage(error));
  }

  // A composition's real size comes from data-width/data-height, which is also
  // compile-time. The CLI refuses a `--resolution` that disagrees, so an aspect
  // mismatch is a render that dies minutes from now; catching it here costs a
  // string compare.
  if (frame.width !== width || frame.height !== height) {
    return decline(`it is authored at ${frame.width}x${frame.height}, not the requested ${width}x${height}`);
  }

  if (!(await deps.hyperframesAvailable())) return decline("hyperframes cannot render on this host");

  return {
    manifest,
    projectDir,
    html,
    frame,
    variables: shortCompositionVariables({
      bookTitle: input.bookTitle,
      params: input.params,
      accent: manifest.defaultAccent,
      declared: declaredCompositionVariables(html),
    }),
  };
}

/**
 * Renders the composition at exactly `duration`, from a throwaway copy.
 *
 * `resource/` is checked in and shared by every concurrent render, so the
 * retimed markup goes to a temp tree that is deleted whatever happens. Mutating
 * the shipped file would make two shorts rendering at once race over each
 * other's length, and would leave the repo dirty after a crash.
 */
async function renderShortComposition(options: {
  taskId: string;
  plan: TemplatedShortPlan;
  duration: number;
  deps: ShortRenderDeps;
  signal: AbortSignal;
  onProgress?: (fraction: number) => void;
}): Promise<string> {
  const retimed = retimeComposition(options.plan.html, options.duration);
  if (!retimed) throw new Error("the short composition has no root data-duration to retime");

  const workRoot = await mkdtemp(join(tmpdir(), "vidgen-short-"));
  // A path that does not exist yet, so `cp` copies the project *as* it rather
  // than merging into a directory mkdtemp already created.
  const workDir = join(workRoot, "short");

  try {
    await cp(options.plan.projectDir, workDir, { recursive: true });
    await writeFile(join(workDir, "index.html"), retimed, "utf8");

    const rendered = await options.deps.renderComposition({
      templateDir: workDir,
      variables: options.plan.variables,
      outputFile: join(taskDir(options.taskId), COMPOSITION_FILE),
      width: options.plan.frame.width,
      height: options.plan.frame.height,
      // The template's own statement about how fast its motion needs to be
      // sampled; still.ts then encodes the body at the same rate.
      fps: options.plan.manifest.bedEncode.fps,
      onProgress: options.onProgress,
      signal: options.signal,
    });
    return rendered.outputFile;
  } finally {
    await rm(workRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Puts the composition, the narration, the cues and the music into one file.
 *
 * The composition is handed to `renderStillSegment` as a *bed*. A short's
 * composition is cut to exactly the narration's length, so the `-stream_loop`
 * that exists for a 20s chapter bed is a no-op here and no new compositor is
 * needed — while the audio half of that graph stays byte-identical to the one
 * every audiobook chapter already uses.
 */
async function assembleTemplatedShort(
  input: ShortRenderInput,
  deps: ShortRenderDeps,
  plan: TemplatedShortPlan,
  narration: PipelineResult,
  say: (message: string) => Promise<void>,
): Promise<ShortRenderOutcome> {
  const { taskId, params, signal } = input;
  const directory = taskDir(taskId);

  const audioPath = narrationFileForTask(taskId, params);
  if (!existsSync(audioPath)) throw new Error(`the narration is missing: ${audioPath}`);

  // The real length, probed rather than taken from the TTS engine's estimate:
  // the composition is compiled to this number and any drift shows as a frozen
  // tail or a truncated picture.
  const audioInfo = await deps.probe(audioPath);
  const duration = audioInfo.duration;
  if (!(duration > 0)) throw new Error(`the narration has no readable duration: ${audioPath}`);

  await say(`rendering the "${plan.manifest.id}" short composition to ${formatSeconds(duration)}s`);
  const bedPath = await renderShortComposition({
    taskId,
    plan,
    duration,
    deps,
    signal,
    onProgress: input.onProgress,
  });

  const subtitlePath = String(narration.subtitle_path ?? "").trim();
  const cues =
    subtitlePath && existsSync(subtitlePath) ? parseSrtContent(await readFile(subtitlePath, "utf8")) : [];

  // Burning is a preference, not a guarantee — a Homebrew ffmpeg routinely ships
  // without libass, and asking it to burn fails the whole encode. Same trade the
  // audiobook path makes: soft track as the fallback, because it works on every
  // build. Dropping captions instead would silently gut the templated short on
  // exactly the hosts that cannot burn.
  let assPath: string | undefined;
  if (cues.length > 0 && (await deps.supportsAssBurn())) {
    assPath = join(directory, "subtitle.ass");
    await writeAssFile(assPath, cues, assRenderOptionsFromParams(params));
  } else if (cues.length > 0) {
    await say("this ffmpeg cannot burn subtitles; embedding a soft track instead");
  }

  const videoFile = join(directory, FINAL_VIDEO_FILE);
  const needsMux = cues.length > 0 && !assPath;
  // ffmpeg cannot read and write one file, so a soft mux needs its own input.
  const renderTarget = needsMux ? join(directory, "short-silent-subs.mp4") : videoFile;

  const bgmPath = shouldUseBgm(params.bgm_type, params.bgm_volume)
    ? getBgmFile(params.bgm_type, params.bgm_file)
    : "";
  // The AI music providers generate their track inside the stock video stage,
  // which is the stage this path replaces. Their tracks therefore do not reach a
  // templated short — said out loud rather than shipped as silence nobody
  // explains.
  if (!bgmPath && shouldUseBgm(params.bgm_type, params.bgm_volume)) {
    await say(`no background music resolved for bgm_type "${params.bgm_type}"; rendering narration only`);
  }

  const still: StillSegmentOptions = {
    bedPath,
    audioPath,
    outputFile: renderTarget,
    width: plan.frame.width,
    height: plan.frame.height,
    assPath,
    fontsDir: assPath ? fontDir() : undefined,
    bedEncode: plan.manifest.bedEncode,
    threads: params.n_threads,
    signal,
  };

  try {
    await deps.renderStillSegment({ ...still, bgmPath, bgmVolume: params.bgm_volume });
  } catch (error) {
    // Music fails for reasons the narration survives — a corrupt upload, a codec
    // this ffmpeg cannot decode. Mirrors the audiobook path: re-encode silent
    // rather than throw away a finished composition. A cancellation is not one
    // of those reasons.
    if (!bgmPath || signal.aborted) throw error;
    logger.exception(`failed to mix background music into book short ${taskId}: ${bgmPath}`, error);
    await say("background music could not be mixed; rendering narration only");
    await deps.renderStillSegment(still);
  }

  if (needsMux) {
    await deps.muxSoftSubtitles({
      videoPath: renderTarget,
      subtitlePath,
      outputFile: videoFile,
      language: params.video_language,
      title: params.video_subject,
      sidecarPath: sidecarSubtitlePath(videoFile),
      signal,
    });
    await rm(renderTarget, { force: true }).catch(() => {});
  }

  // The point of the whole exercise: the narration and the cues are the
  // pipeline's, they exist, and they are recorded.
  return {
    videoPath: videoFile,
    audioPath,
    subtitlePath: subtitlePath || null,
    audioDuration: duration,
    error: null,
    templated: true,
  };
}

/** The stock-footage path, unchanged: one pipeline run straight through to a video. */
async function renderStockShort(
  input: ShortRenderInput,
  deps: ShortRenderDeps,
): Promise<ShortRenderOutcome> {
  const result = await deps.runPipeline({
    taskId: input.taskId,
    params: input.params,
    stopAt: "video",
    signal: input.signal,
  });

  if (result.state === TASK_STATE_FAILED || result.error) {
    return {
      videoPath: null,
      audioPath: null,
      subtitlePath: null,
      audioDuration: null,
      error: result.error || "short render failed",
      templated: false,
    };
  }

  return {
    videoPath: result.videos?.[0] ?? result.combined_videos?.[0] ?? null,
    audioPath: result.audio_file ?? null,
    subtitlePath: result.subtitle_path ?? null,
    audioDuration: result.audio_duration ?? null,
    error: null,
    templated: false,
  };
}

/**
 * Renders one short and reports what it produced. No database, by design.
 *
 * With no template selected this is the stock-footage path byte for byte. With
 * one selected the pipeline still runs — only as far as `"subtitle"`, which is
 * what keeps TTS, cues and the task's script artefacts exactly as they are —
 * and the picture is then a composition rather than downloaded clips.
 *
 * Degrade, never fail. Anything that goes wrong on the templated side after the
 * narration exists falls back to stock footage. That fallback re-runs the
 * pipeline from the top, paying for TTS a second time, on purpose: reusing the
 * narration would mean handing the pipeline a `custom_audio_file`, which sends
 * the subtitle stage down a different route and makes a *fallback* produce
 * something a stock short would not. A wasted synthesis is cheaper than a
 * degraded path that quietly differs from the one it is degrading to.
 */
export async function renderShortVideo(
  input: ShortRenderInput,
  deps: ShortRenderDeps = liveShortRenderDeps,
): Promise<ShortRenderOutcome> {
  const say = input.log ?? (async () => {});

  const plan = await planTemplatedShort(input, deps, say);
  if (!plan) return renderStockShort(input, deps);

  const narration = await deps.runPipeline({
    taskId: input.taskId,
    params: input.params,
    stopAt: "subtitle",
    signal: input.signal,
  });

  // A failed narration is a failed short on either path; there is nothing to
  // degrade to, because stock footage would need the same TTS.
  if (narration.state === TASK_STATE_FAILED || narration.error) {
    return {
      videoPath: null,
      audioPath: null,
      subtitlePath: narration.subtitle_path ?? null,
      audioDuration: null,
      error: narration.error || "short render failed",
      templated: true,
    };
  }

  try {
    return await assembleTemplatedShort(input, deps, plan, narration, say);
  } catch (error) {
    // A user cancelling is not a broken template, and retrying it as stock
    // footage would ignore the cancellation.
    if (input.signal.aborted || (error instanceof HyperframesError && error.reason === "cancelled")) {
      throw error;
    }
    logger.exception(`templated short ${input.taskId} fell back to stock footage`, error);
    await say(`the "${plan.manifest.id}" template failed (${errorMessage(error)}); rendering stock footage instead`);
    return renderStockShort(input, deps);
  }
}

// ---------------------------------------------------------------------------
// Render task
// ---------------------------------------------------------------------------

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
      hook: short.hook,
      chapter_title: short.chapter_title,
    });

    const outcome = await renderShortVideo({
      taskId,
      bookTitle: book.title,
      params: videoParams,
      signal,
      log: (message) => log(taskId, message),
      onProgress: (fraction) => {
        // The renderer coalesces these already; the composition owns the middle
        // of the bar, between the pipeline's subtitle stop and the ffmpeg pass.
        void updateTask(taskId, {
          state: TASK_STATE_PROCESSING,
          progress: 50 + fraction * 40,
          owner_id: PROCESS_OWNER_ID,
        }).catch(() => {});
      },
    });
    if (!(await stillCurrent())) return;

    if (outcome.error) {
      await patchBookShort(bookId, index, { state: "failed", error: outcome.error });
      return;
    }

    const videoPath = outcome.videoPath;
    await patchBookShort(bookId, index, shortCompletionPatch(outcome));

    // `stopAt: "subtitle"` left the task complete carrying only its cue file, so
    // the templated path is the one that has to publish the artefacts the task
    // API and the browser read back. The stock path already did this itself.
    if (outcome.templated) {
      await updateTask(taskId, {
        state: TASK_STATE_COMPLETE,
        progress: 100,
        videos: videoPath ? [videoPath] : [],
        combined_videos: videoPath ? [videoPath] : [],
        audio_file: outcome.audioPath ?? undefined,
        audio_duration: outcome.audioDuration ?? undefined,
        subtitle_path: outcome.subtitlePath ?? undefined,
        owner_id: null,
      }).catch((error) => {
        logger.warning(`could not publish templated short artefacts for ${taskId}: ${errorMessage(error)}`);
      });
    }

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
