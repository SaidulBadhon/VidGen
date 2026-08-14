/**
 * Groups the kept blocks of a book into the segments that become individual videos.
 *
 * Whole blocks only. A segment is a run of complete blocks, which is what makes
 * "never cut mid-sentence or mid-paragraph" a structural property rather than a
 * heuristic that can be wrong at a boundary. Everything else here — target length,
 * chapter boundaries, headings — decides only *where* the joins go.
 */

import { splitStringByPunctuations } from "../../utils/text.ts";
import { DEFAULT_SEGMENT_OPTIONS } from "./types.ts";
import type { Block, BookStructure, SegmentOptions, SegmentPlan } from "./types.ts";

/**
 * How far into the target a chapter boundary becomes worth taking in duration mode.
 *
 * Below this, closing at the boundary would leave a stub segment; above it, ending on
 * a chapter break is nicer than ending mid-chapter a minute later.
 */
const PREFERRED_SPLIT_RATIO = 0.6;

/**
 * Narration rate the estimate below is calibrated at.
 *
 * `estimateNoVoiceDuration` charges Latin text at 2.7 words/second (~162 wpm), close
 * enough to the 150 wpm default that the scale factor is roughly 1 out of the box.
 */
const BASELINE_WORDS_PER_MINUTE = DEFAULT_SEGMENT_OPTIONS.wordsPerMinute;

// Rates mirrored from `estimateNoVoiceDuration` in ../voice/index.ts. They are copied
// rather than imported because that module pulls in ffmpeg, the TTS adapters and the
// settings store, none of which belong in pure segmentation logic — and because its
// three-second floor is right for a whole clip but would wreck a per-block sum.
const CJK_CHARS_PER_SECOND = 4.2;
const LATIN_WORDS_PER_SECOND = 2.7;
const OTHER_CHARS_PER_SECOND = 4.0;
const SENTENCE_PAUSE_SECONDS = 0.35;

const CJK_CHAR = /[一-鿿]/g;
const ASCII_WORD = /[A-Za-z0-9]+/g;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/gu;

/** Whitespace-delimited word count. Display only — see `estimateSpokenSeconds`. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Estimates how long a block takes to narrate, before any TTS has run.
 *
 * This cannot be word count divided by a rate: Chinese, Japanese and Korean text has
 * almost no spaces, so a whitespace count of a full CJK paragraph is close to 1 and
 * every CJK segment would come out many times too long. Scripts are therefore charged
 * separately, the same way the no-voice timeline estimator does it.
 *
 * `wordsPerMinute` divides rather than multiplies: a faster narrator means a shorter
 * clip. (The brief wrote this scaling the other way round; the inverse is the
 * physically correct one and is what a user changing the setting will expect.)
 */
export function estimateSpokenSeconds(text: string, wordsPerMinute: number): number {
  const normalized = text.trim();
  if (!normalized) return 0;

  const cjkChars = (normalized.match(CJK_CHAR) ?? []).length;
  const asciiWords = normalized.match(ASCII_WORD) ?? [];
  const asciiWordChars = asciiWords.reduce((sum, word) => sum + word.length, 0);

  // Count every letter and digit, then subtract what was already charged so Latin
  // text is not paid for twice.
  const letterOrNumber = (normalized.match(LETTER_OR_NUMBER) ?? []).length;
  const otherTextChars = Math.max(letterOrNumber - cjkChars - asciiWordChars, 0);
  const sentences = Math.max(splitStringByPunctuations(normalized).length, 1);

  const seconds =
    cjkChars / CJK_CHARS_PER_SECOND +
    asciiWords.length / LATIN_WORDS_PER_SECOND +
    otherTextChars / OTHER_CHARS_PER_SECOND +
    Math.max(sentences - 1, 0) * SENTENCE_PAUSE_SECONDS;

  const rate = wordsPerMinute > 0 ? wordsPerMinute : BASELINE_WORDS_PER_MINUTE;
  return seconds * (BASELINE_WORDS_PER_MINUTE / rate);
}

/**
 * Plans the segments for a book from the blocks that survived filtering.
 *
 * `maxDurationSeconds` is a soft ceiling by necessity, not by oversight: a single
 * block longer than the maximum cannot be honoured without splitting it, and never
 * splitting a block is the stronger guarantee. The invariant that does hold exactly is
 * that dropping a segment's final block always brings it back under the maximum.
 */
export function planSegments(
  structure: BookStructure,
  kept: Block[],
  options: SegmentOptions,
): SegmentPlan[] {
  const ordered = [...kept].sort((a, b) => a.order - b.order);
  if (ordered.length === 0) return [];

  const chapterTitles = new Map<string, string>(
    structure.chapters.map((chapter) => [chapter.id, chapter.title]),
  );
  const seconds = new Map<string, number>();
  const words = new Map<string, number>();
  for (const block of ordered) {
    seconds.set(block.id, estimateSpokenSeconds(block.text, options.wordsPerMinute));
    words.set(block.id, countWords(block.text));
  }

  const segments: SegmentPlan[] = [];
  const partCounts = new Map<string, number>();
  let open: Block[] = [];
  let openSeconds = 0;

  const buildSegment = (blocks: Block[]): SegmentPlan => {
    const chapterIds: string[] = [];
    for (const block of blocks) {
      if (!chapterIds.includes(block.chapterId)) chapterIds.push(block.chapterId);
    }

    const primaryChapterId = chapterIds[0] ?? "";
    const part = (partCounts.get(primaryChapterId) ?? 0) + 1;
    partCounts.set(primaryChapterId, part);

    const first = blocks[0]!;
    const chapterTitle =
      (chapterTitles.get(primaryChapterId) ?? "").trim() || structure.title.trim() || "Segment";

    return {
      index: segments.length,
      title:
        first.kind === "heading" && first.text.trim()
          ? first.text.trim()
          : `${chapterTitle} (part ${part})`,
      blockIds: blocks.map((block) => block.id),
      estimatedDuration: Math.round(blocks.reduce((sum, block) => sum + (seconds.get(block.id) ?? 0), 0)),
      wordCount: blocks.reduce((sum, block) => sum + (words.get(block.id) ?? 0), 0),
      chapterIds,
    };
  };

  /**
   * Closes the open segment, carrying any trailing run of headings into the next one.
   *
   * A segment must never end on a chapter title with nothing underneath it, so the
   * heading moves forward to introduce the segment it actually belongs to. If the open
   * segment is nothing but headings there is no body to close around, so it stays open
   * and absorbs whatever comes next.
   */
  const closeSegment = (): void => {
    let end = open.length;
    while (end > 0 && open[end - 1]!.kind === "heading") end -= 1;
    if (end === 0) return;

    const carried = open.slice(end);
    segments.push(buildSegment(open.slice(0, end)));
    open = carried;
    openSeconds = carried.reduce((sum, block) => sum + (seconds.get(block.id) ?? 0), 0);
  };

  for (const block of ordered) {
    const blockSeconds = seconds.get(block.id) ?? 0;

    if (open.length > 0) {
      const chapterChanged = block.chapterId !== open[open.length - 1]!.chapterId;
      const combined = openSeconds + blockSeconds;
      const shouldClose =
        options.mode === "chapter"
          ? // One video per chapter: only the hard ceiling ever splits a chapter, so a
            // chapter shorter than the maximum survives as a single segment.
            chapterChanged || combined > options.maxDurationSeconds
          : // Duration (and a stray `smart` call that skipped the AI path) fill
            // toward the target, prefer a chapter join once past 60%, and never
            // cross the ceiling except for an indivisible block.
            combined > options.maxDurationSeconds ||
            openSeconds >= options.targetDurationSeconds ||
            (chapterChanged && openSeconds >= options.targetDurationSeconds * PREFERRED_SPLIT_RATIO);

      if (shouldClose) closeSegment();
    }

    open.push(block);
    openSeconds += blockSeconds;
  }

  // Whatever is left is a segment even if it is only a heading: a trailing title whose
  // body was filtered away is still text the user asked to narrate.
  if (open.length > 0) segments.push(buildSegment(open));

  return segments;
}
