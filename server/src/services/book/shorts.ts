/**
 * Hook shorts: pack the book into passages, then turn model proposals into rows.
 *
 * The long-form pipeline narrates the book as-is. This one does the opposite:
 * it walks the kept text in chapter-sized chunks, asks the model for a funny
 * or surprising ~60s teaser from each, and stores those scripts so the ordinary
 * short-video pipeline can render them as 9:16 clips. The packing is pure so
 * a 400-page novel can be split without calling a model, and the model is only
 * asked about the passages that were actually selected.
 */

import { clampText } from "../llm/prompts.ts";
import { countWords, estimateSpokenSeconds } from "./segment.ts";
import type { Block, BookStructure } from "./types.ts";
import { DEFAULT_SEGMENT_OPTIONS } from "./types.ts";
import type { BookState, BookShortsPlanDocument } from "../../db/types.ts";

/** Spoken length of one hook short. TikTok/Shorts sit around a minute. */
export const DEFAULT_SHORT_DURATION_SECONDS = 60;
export const MIN_SHORT_DURATION_SECONDS = 30;
export const MAX_SHORT_DURATION_SECONDS = 90;

/** Cap so a novel cannot fan out into hundreds of teasers. */
export const DEFAULT_MAX_SHORTS = 12;
export const MIN_MAX_SHORTS = 1;
export const MAX_MAX_SHORTS = 30;

/** Source words packed into one model call — enough story for a single hook. */
export const SHORT_CHUNK_TARGET_WORDS = 900;
export const SHORT_CHUNK_MAX_WORDS = 1400;

/** Passage sent to the model, so a huge chapter cannot blow the context window. */
export const MAX_PASSAGE_CHARS = 7000;

export const MAX_SHORT_TITLE_LENGTH = 80;
export const MAX_SHORT_HOOK_LENGTH = 220;
export const MAX_SHORT_SCRIPT_LENGTH = 2000;

/** Composite request_id written on the render task: `book-short:{bookId}:{index}`. */
export const BOOK_SHORT_REQUEST_PREFIX = "book-short:";

/**
 * Reads book id and short index out of a render task's request_id.
 *
 * Splits from the right so a book id that happens to contain colons still
 * round-trips. Plan tasks use a different prefix and return null.
 */
export function parseBookShortRequestId(
  requestId: string | undefined | null,
): { bookId: string; index: number } | null {
  const value = (requestId ?? "").trim();
  if (!value.startsWith(BOOK_SHORT_REQUEST_PREFIX)) return null;
  const rest = value.slice(BOOK_SHORT_REQUEST_PREFIX.length);
  const split = rest.lastIndexOf(":");
  if (split <= 0) return null;
  const bookId = rest.slice(0, split);
  const index = Number(rest.slice(split + 1));
  if (!bookId || !Number.isInteger(index) || index < 0) return null;
  return { bookId, index };
}

export interface ShortOptions {
  targetDurationSeconds: number;
  maxShorts: number;
  wordsPerMinute: number;
}

export const DEFAULT_SHORT_OPTIONS: ShortOptions = {
  targetDurationSeconds: DEFAULT_SHORT_DURATION_SECONDS,
  maxShorts: DEFAULT_MAX_SHORTS,
  wordsPerMinute: DEFAULT_SEGMENT_OPTIONS.wordsPerMinute,
};

/**
 * A run of kept blocks sent to the model as one passage.
 *
 * `text` is what the prompt quotes; the block ids on `blocks` are the only
 * ids the model is allowed to return as `start_block_id`.
 */
export interface ShortChunk {
  index: number;
  chapterTitle: string;
  startBlockId: string;
  endBlockId: string;
  blocks: Block[];
  text: string;
  words: number;
}

export interface ProposedShort {
  title: string;
  hook: string;
  script: string;
  startBlockId: string;
}

export interface PlannedShort {
  index: number;
  title: string;
  hook: string;
  script: string;
  chapterTitle: string;
  startBlockId: string;
  blockIds: string[];
  estimatedDuration: number;
  youtubeTitle?: string;
  description?: string;
  tags?: string[];
}

export interface ShortPassageLine {
  blockId: string;
  kind: string;
  text: string;
}

/**
 * Groups kept blocks into chapter-aware passages.
 *
 * A chapter that already fits the target stays whole. A long chapter is split
 * on paragraph boundaries rather than mid-sentence, which is the same bargain
 * the long-form segmenter strikes. Tiny leftover chapters are packed onto the
 * previous chunk when they would otherwise be too thin to extract a hook from.
 */
export function packShortChunks(
  structure: BookStructure,
  kept: readonly Block[],
  options: { targetWords?: number; maxWords?: number } = {},
): ShortChunk[] {
  const targetWords = options.targetWords ?? SHORT_CHUNK_TARGET_WORDS;
  const maxWords = options.maxWords ?? SHORT_CHUNK_MAX_WORDS;
  if (kept.length === 0) return [];

  const chapterTitles = new Map(structure.chapters.map((chapter) => [chapter.id, chapter.title]));
  const ordered = [...kept].sort((a, b) => a.order - b.order);

  const raw: { chapterTitle: string; blocks: Block[] }[] = [];
  let current: { chapterTitle: string; blocks: Block[]; words: number } | null = null;

  const flush = () => {
    if (!current || current.blocks.length === 0) return;
    raw.push({ chapterTitle: current.chapterTitle, blocks: current.blocks });
    current = null;
  };

  for (const block of ordered) {
    const words = countWords(block.text);
    const chapterTitle = chapterTitles.get(block.chapterId) || block.text.slice(0, 80) || "Untitled";
    const chapterChanged = current !== null && current.chapterTitle !== chapterTitle;
    const wouldExceedTarget = current !== null && current.words >= targetWords;
    const wouldExceedMax = current !== null && current.words + words > maxWords && current.blocks.length > 0;

    if (current === null) {
      current = { chapterTitle, blocks: [block], words };
      continue;
    }

    if (chapterChanged && current.words >= Math.min(200, targetWords * 0.35)) {
      flush();
      current = { chapterTitle, blocks: [block], words };
      continue;
    }

    if (wouldExceedMax || (wouldExceedTarget && !chapterChanged && words > 0)) {
      flush();
      current = { chapterTitle, blocks: [block], words };
      continue;
    }

    current.blocks.push(block);
    current.words += words;
    if (chapterChanged) current.chapterTitle = `${current.chapterTitle} / ${chapterTitle}`;
  }
  flush();

  return raw.map((entry, index) => toChunk(entry.blocks, entry.chapterTitle, index));
}

function toChunk(blocks: Block[], chapterTitle: string, index: number): ShortChunk {
  const text = blocks
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
  return {
    index,
    chapterTitle,
    startBlockId: blocks[0]!.id,
    endBlockId: blocks[blocks.length - 1]!.id,
    blocks,
    text,
    words: countWords(text),
  };
}

/**
 * Picks a spread of passages so a 70-chapter novel still yields ~12 shorts.
 *
 * The last tenth of the book is left out of the sample: those pages tend to
 * hold the ending, and the prompt is told not to spoil, but the safest way
 * not to is not to send them. First and a late-but-not-final chunk are always
 * included when there is more than one slot.
 */
export function selectShortChunks(chunks: readonly ShortChunk[], maxShorts: number): ShortChunk[] {
  const limit = Math.max(MIN_MAX_SHORTS, Math.min(MAX_MAX_SHORTS, Math.trunc(maxShorts)));
  if (chunks.length === 0 || limit <= 0) return [];
  if (chunks.length <= limit) return [...chunks];

  const skipTail = chunks.length >= 8 ? Math.max(1, Math.ceil(chunks.length * 0.1)) : 0;
  const usable = chunks.slice(0, chunks.length - skipTail);
  if (usable.length <= limit) return usable;

  const picked: ShortChunk[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < limit; i++) {
    const index = limit === 1 ? 0 : Math.round((i * (usable.length - 1)) / (limit - 1));
    const chunk = usable[index];
    if (!chunk || seen.has(chunk.startBlockId)) continue;
    seen.add(chunk.startBlockId);
    picked.push(chunk);
  }
  return picked;
}

/** Lines the prompt quotes, truncated so a dense chapter stays inside the budget. */
export function passageLinesForPrompt(chunk: ShortChunk, maxChars = MAX_PASSAGE_CHARS): ShortPassageLine[] {
  const lines: ShortPassageLine[] = [];
  let used = 0;
  for (const block of chunk.blocks) {
    const text = block.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const remaining = maxChars - used;
    if (remaining <= 80) break;
    const clipped = text.length > remaining ? `${text.slice(0, remaining).trimEnd()}…` : text;
    lines.push({ blockId: block.id, kind: block.kind, text: clipped });
    used += clipped.length + 16;
    if (text.length > remaining) break;
  }
  return lines;
}

export function allowedBlockIds(chunk: ShortChunk): Set<string> {
  return new Set(chunk.blocks.map((block) => block.id));
}

/**
 * Turns a model payload into grounded shorts for one chunk.
 *
 * Ids the model invented are dropped rather than guessed: a teaser pointing at
 * the wrong paragraph is worse than skipping that chunk. Empty scripts and
 * duplicate starts in the same chunk are dropped the same way.
 */
export function finalizeProposedShorts(
  raw: unknown,
  chunk: ShortChunk,
  options: ShortOptions,
): PlannedShort[] {
  const entries = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { shorts?: unknown }).shorts)
      ? (raw as { shorts: unknown[] }).shorts
      : [];

  const allowed = allowedBlockIds(chunk);
  const seen = new Set<string>();
  const result: PlannedShort[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const startBlockId = String(record.start_block_id ?? record.startBlockId ?? "").trim();
    const title = clampText(record.title, MAX_SHORT_TITLE_LENGTH);
    const hook = clampText(record.hook, MAX_SHORT_HOOK_LENGTH);
    const script = clampText(record.script, MAX_SHORT_SCRIPT_LENGTH);
    if (!title || !script) continue;
    if (startBlockId && !allowed.has(startBlockId)) continue;
    const groundedId = allowed.has(startBlockId) ? startBlockId : chunk.startBlockId;
    if (seen.has(groundedId)) continue;
    seen.add(groundedId);

    const spoken = clampShortScript(script, Math.round(targetScriptWords(options) * 1.25));
    result.push({
      index: 0,
      title,
      hook: hook || firstSentence(spoken),
      script: spoken,
      chapterTitle: chunk.chapterTitle,
      startBlockId: groundedId,
      blockIds: chunk.blocks.map((block) => block.id),
      estimatedDuration: estimateSpokenSeconds(spoken, options.wordsPerMinute),
    });
  }

  return result.slice(0, 2);
}

function firstSentence(text: string): string {
  const match = text.trim().match(/^[^.!?。！？\n]+[.!?。！？]?/);
  return clampText(match?.[0] ?? text, MAX_SHORT_HOOK_LENGTH);
}

/** Reindexes a concatenated list of per-chunk proposals into a single plan. */
export function numberPlannedShorts(shorts: PlannedShort[]): PlannedShort[] {
  return shorts.map((short, index) => ({ ...short, index }));
}

/** Drops later ideas that reuse an earlier title. */
export function dedupePlannedShorts(shorts: readonly PlannedShort[]): PlannedShort[] {
  const seen = new Set<string>();
  const result: PlannedShort[] = [];
  for (const short of shorts) {
    const key = short.title.replace(/\s+/g, " ").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(short);
  }
  return result;
}

/** Hard cap after walking the whole book, keeping reading order. */
export function capPlannedShorts(shorts: readonly PlannedShort[], maxShorts: number): PlannedShort[] {
  const limit = Math.max(MIN_MAX_SHORTS, Math.min(MAX_MAX_SHORTS, Math.trunc(maxShorts)));
  return numberPlannedShorts(shorts.slice(0, limit));
}

/**
 * Trims a spoken script to a word budget, closing on a sentence when possible.
 *
 * Models overrun a "sixty seconds" instruction; TTS would otherwise produce a
 * two-minute short. Cutting at a sentence keeps the last line speakable.
 */
export function clampShortScript(script: string, maxWords: number): string {
  const cleaned = script
    .replace(/\*/g, "")
    .replace(/^#+\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  if (maxWords <= 0 || countWords(cleaned) <= maxWords) return cleaned;

  const sentences = cleaned.split(/(?<=[.!?。！？])\s+/).filter(Boolean);
  const kept: string[] = [];
  let words = 0;
  for (const sentence of sentences) {
    const next = countWords(sentence);
    if (kept.length > 0 && words + next > maxWords) break;
    kept.push(sentence);
    words += next;
    if (words >= maxWords) break;
  }
  if (kept.length > 0) return kept.join(" ").trim();
  return cleaned.split(/\s+/).slice(0, maxWords).join(" ");
}

/** Target spoken-word count used in the prompt, derived from duration and rate. */
export function targetScriptWords(options: ShortOptions): number {
  const seconds = Math.max(
    MIN_SHORT_DURATION_SECONDS,
    Math.min(MAX_SHORT_DURATION_SECONDS, options.targetDurationSeconds),
  );
  return Math.max(80, Math.round((seconds * options.wordsPerMinute) / 60));
}

/** True once import (and OCR, if needed) has produced kept text to walk. */
export function bookIsReadyForShorts(state: BookState): boolean {
  return state !== "extracting" && state !== "ocr_pending" && state !== "ocr" && state !== "failed";
}

/** Empty overlay for a book that has never run the shorts pass. */
export function idleShortsPlan(): BookShortsPlanDocument {
  return {
    state: "idle",
    revision: 0,
    chunks_total: 0,
    chunks_done: 0,
    target_duration_seconds: DEFAULT_SHORT_DURATION_SECONDS,
    max_shorts: DEFAULT_MAX_SHORTS,
    words_per_minute: DEFAULT_SEGMENT_OPTIONS.wordsPerMinute,
    task_id: null,
    error: null,
    render_params: null,
    started_at: null,
    finished_at: null,
  };
}

/** Kept blocks in reading order for a stored short's excerpt. */
export function blocksForShort(
  structure: BookStructure,
  blockIds: readonly string[],
  startBlockId?: string,
): Block[] {
  const wanted = new Set(blockIds.filter(Boolean));
  if (wanted.size === 0 && startBlockId) wanted.add(startBlockId);
  return [...structure.blocks].sort((a, b) => a.order - b.order).filter((block) => wanted.has(block.id));
}
