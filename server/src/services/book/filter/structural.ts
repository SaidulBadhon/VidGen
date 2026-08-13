/**
 * Decides, from structure alone, which blocks of a book are not worth narrating.
 *
 * This pass is deliberately deterministic rather than model-driven. Running heads
 * repeat on every page, page numbers are numeric lines, table-of-contents entries
 * carry dot leaders, and EPUB `landmarks` labels front and back matter outright, so
 * typography and markup already answer the question for the overwhelming majority of
 * blocks — faster, cheaper and more repeatably than a local model could. A later
 * phase can send only the ambiguous residue to an LLM as `source: "llm"` decisions.
 *
 * FAIL-OPEN is the cardinal rule. Anything that does not clearly match a drop rule is
 * kept with `DEFAULT_KEEP_RULE` and full confidence, and every drop carries a reason
 * the review UI shows verbatim. A boring narrated paragraph is a far better failure
 * than a silently deleted chapter.
 */

import { DEFAULT_KEEP_RULE } from "../types.ts";
import type { Block, BookStructure, Chapter, ChapterLandmark, FilterDecision } from "../types.ts";

/** Stable rule ids, exported so the review UI can group and bulk-override by rule. */
export const STRUCTURAL_RULES = [
  "landmark_front_matter",
  "landmark_back_matter",
  "landmark_toc",
  "toc_chapter_shape",
  "toc_entry_shape",
  "page_number",
  "repeated_running_head",
  "boilerplate_repeat",
  "copyright_notice",
  "footnote_block",
  "about_the_author",
] as const;

export type StructuralRule = (typeof STRUCTURAL_RULES)[number];

/**
 * How much to trust each rule. The UI surfaces this, so it is recorded honestly.
 *
 * Landmark rules sit near 1 because the book itself declared the section. Shape
 * heuristics sit in the 0.6-0.85 band because they infer intent from typography, and
 * the roman-numeral case sits at the bottom because it is the one rule that could
 * plausibly mistake prose for furniture.
 */
const CONFIDENCE = {
  landmark: 0.98,
  /** `backmatter` occasionally wraps an epilogue, so it is trusted slightly less. */
  landmarkBackMatter: 0.95,
  /** The extractor named the kind outright; that is nearly as good as a landmark. */
  declaredKind: 0.95,
  aboutAuthor: 0.85,
  copyright: 0.85,
  pageNumber: 0.85,
  runningHead: 0.8,
  tocChapter: 0.8,
  tocEntry: 0.75,
  boilerplate: 0.7,
  romanPageNumber: 0.65,
  /**
   * `frontmatter` is a container, not a verdict: publishers put the title and
   * copyright pages under it, but prefaces and forewords too. Dropped, because
   * that is what it usually wraps, but at the bottom of the band so it stands
   * out in the review list as the one landmark worth a second look.
   */
  landmarkFrontMatterGeneric: 0.6,
} as const;

const FRONT_MATTER_LANDMARKS = new Set<ChapterLandmark>(["cover", "titlepage", "copyright"]);
const BACK_MATTER_LANDMARKS = new Set<ChapterLandmark>([
  "backmatter",
  "index",
  "bibliography",
  "glossary",
  "acknowledgements",
]);

/** A table-of-contents entry is one short line; anything longer is prose. */
const TOC_ENTRY_MAX_CHARS = 90;
/** Fraction of a chapter's blocks that must look like entries before it reads as a TOC. */
const TOC_CHAPTER_RATIO = 0.7;
/** Below this, a "chapter" is too small for the ratio to mean anything. */
const TOC_CHAPTER_MIN_BLOCKS = 3;
const RUNNING_HEAD_MAX_CHARS = 60;
const RUNNING_HEAD_MIN_CHAPTERS = 5;
const BOILERPLATE_MIN_OCCURRENCES = 3;
/**
 * Boilerplate has to be substantial before repetition means anything: novels repeat
 * short lines of dialogue all the time, and dropping "yes, of course." three times
 * over would be exactly the silent deletion this module exists to prevent.
 */
const BOILERPLATE_MIN_CHARS = 12;

/**
 * A title, then leader dots, then a page number.
 *
 * The trailing number is required so that an ellipsis in ordinary prose ("he
 * paused... then left") is not read as a leader run.
 */
const TOC_LEADER_ENTRY = /(?:[.·•]\s?){3,}\s*(?:\d{1,4}|[ivxlcdm]{1,7})$/i;
/**
 * A title, a typographic gap, then a page number.
 *
 * The gap must be a tab or two or more spaces. A single space would match ordinary
 * sentences that happen to end in a number, such as "he was born in 1987".
 */
const TOC_GAP_ENTRY = /\S(?:\t+[ \t]*|[ ]{2,})(?:\d{1,4}|[ivxlcdm]{1,7})$/i;

const DIGITS_ONLY = /^\d{1,4}$/;
/**
 * A syntactically valid roman numeral, not merely roman letters.
 *
 * A bare `[ivxlcdm]+` character class matches ordinary English words — "vivid",
 * "civil", "did", "mill" — and each would then corroborate the next as a page number.
 * Requiring real numeral syntax rules those out. Note it also matches the empty
 * string, so callers must check for text first.
 */
const ROMAN_ONLY = /^m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/i;

const ISBN = /\bISBN(?:-1[03])?\b[:\s]*[\dX][\dX\s-]{8,}/i;
const ALL_RIGHTS_RESERVED = /\ball rights reserved\b/i;
const COPYRIGHT_WITH_YEAR = /(?:©|\(c\)|\bcopyright\b)[^\n]{0,40}?\b(?:1[5-9]\d{2}|20\d{2})\b/i;
const PUBLISHER_BOILERPLATE =
  /\b(?:no part of this (?:book|publication|work) may be reproduced|printed (?:and bound )?in the (?:united states|usa|uk|united kingdom)|library of congress cataloging|a cip catalogue record|first published (?:in|by)\b)/i;

const ABOUT_THE_AUTHOR = /\babout\s+the\s+(?:author|translator|editor|illustrator)s?\b/i;

export function classifyBlocks(structure: BookStructure): FilterDecision[] {
  const readingOrder = [...structure.blocks].sort((a, b) => a.order - b.order);
  const chapters = new Map<string, Chapter>(structure.chapters.map((chapter) => [chapter.id, chapter]));
  const blocksByChapter = groupByChapter(readingOrder);

  const tocChapters = findTocShapedChapters(blocksByChapter, chapters);
  const aboutAuthorBlockIds = findAboutTheAuthorSpans(readingOrder, chapters);
  const pageNumberShapes = countPageNumberShapesPerChapter(blocksByChapter);
  const runningHeads = findRepeatedRunningHeads(readingOrder);
  const boilerplate = findBoilerplateRepeats(readingOrder);

  return structure.blocks.map((block) =>
    classifyBlock(block, {
      chapter: chapters.get(block.chapterId),
      tocChapters,
      aboutAuthorBlockIds,
      pageNumberShapes,
      runningHeads,
      boilerplate,
    }),
  );
}

interface ClassificationContext {
  chapter: Chapter | undefined;
  tocChapters: ReadonlySet<string>;
  aboutAuthorBlockIds: ReadonlySet<string>;
  pageNumberShapes: ReadonlyMap<string, number>;
  /** Normalised text to the number of distinct chapters it appears in. */
  runningHeads: ReadonlyMap<string, number>;
  /** Normalised text to its total number of occurrences. */
  boilerplate: ReadonlyMap<string, number>;
}

/**
 * Applies the rules in precedence order and returns exactly one decision.
 *
 * Order matters: what a source file declares beats what the extractor labelled, which
 * in turn beats anything inferred from the shape of the text.
 */
function classifyBlock(block: Block, context: ClassificationContext): FilterDecision {
  const text = block.text.trim();
  const landmark = context.chapter?.landmark;

  if (landmark === "toc") {
    return drop(block, "landmark_toc", "The book marks this section as its table of contents.", CONFIDENCE.landmark);
  }
  if (landmark && FRONT_MATTER_LANDMARKS.has(landmark)) {
    return drop(
      block,
      "landmark_front_matter",
      `The book marks this section as ${landmark}, which is front matter rather than body text.`,
      CONFIDENCE.landmark,
    );
  }
  if (landmark && BACK_MATTER_LANDMARKS.has(landmark)) {
    return drop(
      block,
      "landmark_back_matter",
      `The book marks this section as ${landmark}, which is reference material rather than narration.`,
      CONFIDENCE.landmarkBackMatter,
    );
  }
  if (landmark === "frontmatter") {
    return drop(
      block,
      "landmark_front_matter",
      "The book files this section under front matter. That usually means a title or " +
        "copyright page, but it can also cover a preface worth hearing — worth reviewing.",
      CONFIDENCE.landmarkFrontMatterGeneric,
    );
  }

  switch (block.kind) {
    case "front_matter":
      return drop(
        block,
        "landmark_front_matter",
        "Extraction identified this as front matter rather than body text.",
        CONFIDENCE.declaredKind,
      );
    case "back_matter":
      return drop(
        block,
        "landmark_back_matter",
        "Extraction identified this as back matter rather than body text.",
        CONFIDENCE.declaredKind,
      );
    case "footnote":
      return drop(
        block,
        "footnote_block",
        "Footnotes are reference material and break the flow when read aloud.",
        CONFIDENCE.declaredKind,
      );
    case "page_number":
      return drop(block, "page_number", "Extraction identified this as a page number.", CONFIDENCE.declaredKind);
    case "running_head":
      return drop(
        block,
        "repeated_running_head",
        "Extraction identified this as a running head or footer repeated on every page.",
        CONFIDENCE.declaredKind,
      );
    case "toc_entry":
      return drop(
        block,
        "toc_entry_shape",
        "Extraction identified this as a table-of-contents entry.",
        CONFIDENCE.declaredKind,
      );
    default:
      break;
  }

  if (context.aboutAuthorBlockIds.has(block.id)) {
    return drop(
      block,
      "about_the_author",
      "Part of an About the author section, which is publisher biography rather than the book itself.",
      CONFIDENCE.aboutAuthor,
    );
  }

  if (context.tocChapters.has(block.chapterId)) {
    return drop(
      block,
      "toc_chapter_shape",
      "This section is mostly page numbers and dot leaders, so it reads as a table of contents rather than prose.",
      CONFIDENCE.tocChapter,
    );
  }

  const normalized = normalizeForRepeat(block.text);

  // Checked before the entry shapes below: a running head and a table-of-contents
  // entry look identical on one line ("The Harbour   47"), and repetition across
  // chapters is the evidence that tells them apart. Table-of-contents entries are
  // unique and cluster in one chapter; running heads are the ones that recur.
  const runningHeadChapters = context.runningHeads.get(normalized);
  if (runningHeadChapters !== undefined) {
    return drop(
      block,
      "repeated_running_head",
      `This short line repeats across ${runningHeadChapters} chapters, which is how a running head or footer looks.`,
      CONFIDENCE.runningHead,
    );
  }

  if (isCopyrightNotice(text)) {
    return drop(
      block,
      "copyright_notice",
      "This looks like a copyright or publisher notice (an ISBN, a rights statement or a copyright line).",
      CONFIDENCE.copyright,
    );
  }

  if (isTocEntryShaped(text)) {
    return drop(
      block,
      "toc_entry_shape",
      "This looks like a table-of-contents entry: a title followed by a page number.",
      CONFIDENCE.tocEntry,
    );
  }

  // Headings are exempt from both page-number shapes. Bare numeric chapter titles
  // ("1", "2") and part markers ("II", "III") are extremely common, and losing a
  // chapter title would corrupt the segment plan as well as the narration.
  if (block.kind !== "heading") {
    if (DIGITS_ONLY.test(text)) {
      return drop(block, "page_number", "This block is nothing but a page number.", CONFIDENCE.pageNumber);
    }
    // A lone roman numeral is only furniture when the chapter shows other page
    // numbers alongside it. Without that corroboration a single "I" in dialogue
    // would be deleted, so the rule stays silent and the block is narrated.
    const shapes = context.pageNumberShapes.get(block.chapterId) ?? 0;
    if (text && ROMAN_ONLY.test(text) && shapes >= 2) {
      return drop(
        block,
        "page_number",
        "This block is a lone roman numeral sitting alongside other page numbers in the same section.",
        CONFIDENCE.romanPageNumber,
      );
    }
  }

  // Headings are exempt: a heading repeated a few times is usually a real section
  // title ("Notes", "Prologue"), and dropping it would strand its body text.
  const repeats = block.kind === "heading" ? undefined : context.boilerplate.get(normalized);
  if (repeats !== undefined) {
    return drop(
      block,
      "boilerplate_repeat",
      `This exact text appears ${repeats} times in the book, so it reads as repeated boilerplate.`,
      CONFIDENCE.boilerplate,
    );
  }

  return {
    blockId: block.id,
    keep: true,
    reason: "No structural rule matched, so this is treated as narratable text.",
    rule: DEFAULT_KEEP_RULE,
    confidence: 1,
    source: "structural",
  };
}

function drop(block: Block, rule: StructuralRule, reason: string, confidence: number): FilterDecision {
  return { blockId: block.id, keep: false, reason, rule, confidence, source: "structural" };
}

/**
 * Collapses a block down to what repeats mean to compare.
 *
 * Stripping the trailing number is what makes "Chapter 3   47" and "Chapter 3   48"
 * the same running head rather than two unique lines.
 */
function normalizeForRepeat(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s.·•]*\d+$/, "")
    .trim();
}

function isTocEntryShaped(text: string): boolean {
  if (!text || text.length > TOC_ENTRY_MAX_CHARS || text.includes("\n")) return false;
  return TOC_LEADER_ENTRY.test(text) || TOC_GAP_ENTRY.test(text);
}

function isCopyrightNotice(text: string): boolean {
  if (!text) return false;
  return (
    ISBN.test(text) ||
    ALL_RIGHTS_RESERVED.test(text) ||
    COPYRIGHT_WITH_YEAR.test(text) ||
    PUBLISHER_BOILERPLATE.test(text)
  );
}

function isPageNumberShaped(block: Block): boolean {
  if (block.kind === "page_number") return true;
  if (block.kind === "heading") return false;
  const text = block.text.trim();
  if (!text) return false;
  return DIGITS_ONLY.test(text) || ROMAN_ONLY.test(text);
}

function groupByChapter(readingOrder: Block[]): Map<string, Block[]> {
  const groups = new Map<string, Block[]>();
  for (const block of readingOrder) {
    const existing = groups.get(block.chapterId);
    if (existing) existing.push(block);
    else groups.set(block.chapterId, [block]);
  }
  return groups;
}

/**
 * Chapters that are a table of contents even though nothing said so.
 *
 * Only chapters with no landmark at all are considered: if the source declared one,
 * that declaration is the authority and the per-block rules still catch stray
 * entries, so there is nothing to gain from second-guessing it here.
 */
function findTocShapedChapters(
  blocksByChapter: ReadonlyMap<string, Block[]>,
  chapters: ReadonlyMap<string, Chapter>,
): Set<string> {
  const result = new Set<string>();
  for (const [chapterId, blocks] of blocksByChapter) {
    if (chapters.get(chapterId)?.landmark) continue;
    if (blocks.length < TOC_CHAPTER_MIN_BLOCKS) continue;
    const shaped = blocks.filter(
      (block) => block.kind === "toc_entry" || isTocEntryShaped(block.text.trim()),
    ).length;
    if (shaped / blocks.length > TOC_CHAPTER_RATIO) result.add(chapterId);
  }
  return result;
}

/**
 * Blocks belonging to an "About the author" section.
 *
 * The section runs from its heading to the next heading at the same or shallower
 * depth, and never past the end of its chapter: a chapter break is at least as strong
 * a terminator as a heading, and stopping early only ever keeps more text.
 */
function findAboutTheAuthorSpans(
  readingOrder: Block[],
  chapters: ReadonlyMap<string, Chapter>,
): Set<string> {
  const ids = new Set<string>();
  let spanLevel: number | null = null;
  let spanChapterId = "";

  for (const block of readingOrder) {
    const chapter = chapters.get(block.chapterId);
    if (chapter && ABOUT_THE_AUTHOR.test(chapter.title)) {
      ids.add(block.id);
      continue;
    }

    if (spanLevel !== null && block.chapterId !== spanChapterId) spanLevel = null;

    if (block.kind === "heading") {
      const level = block.level ?? 1;
      if (ABOUT_THE_AUTHOR.test(block.text)) {
        spanLevel = level;
        spanChapterId = block.chapterId;
        ids.add(block.id);
        continue;
      }
      if (spanLevel !== null && level <= spanLevel) {
        spanLevel = null;
        continue;
      }
    }

    if (spanLevel !== null) ids.add(block.id);
  }

  return ids;
}

function countPageNumberShapesPerChapter(blocksByChapter: ReadonlyMap<string, Block[]>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [chapterId, blocks] of blocksByChapter) {
    counts.set(chapterId, blocks.filter(isPageNumberShaped).length);
  }
  return counts;
}

/** Normalised text to the number of distinct chapters it appears in, once that is 5+. */
function findRepeatedRunningHeads(readingOrder: Block[]): Map<string, number> {
  const chaptersByText = new Map<string, Set<string>>();
  for (const block of readingOrder) {
    if (block.text.trim().length >= RUNNING_HEAD_MAX_CHARS) continue;
    const key = normalizeForRepeat(block.text);
    if (!key) continue;
    const existing = chaptersByText.get(key);
    if (existing) existing.add(block.chapterId);
    else chaptersByText.set(key, new Set([block.chapterId]));
  }

  const result = new Map<string, number>();
  for (const [key, chapterIds] of chaptersByText) {
    if (chapterIds.size >= RUNNING_HEAD_MIN_CHAPTERS) result.set(key, chapterIds.size);
  }
  return result;
}

/** Normalised text to its occurrence count, once that is 3+. */
function findBoilerplateRepeats(readingOrder: Block[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const block of readingOrder) {
    const key = normalizeForRepeat(block.text);
    if (key.length < BOILERPLATE_MIN_CHARS) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const result = new Map<string, number>();
  for (const [key, count] of counts) {
    if (count >= BOILERPLATE_MIN_OCCURRENCES) result.set(key, count);
  }
  return result;
}
