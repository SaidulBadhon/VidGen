/**
 * PDF to book structure.
 *
 * A PDF has no paragraphs. It has glyph runs at coordinates, in whatever order
 * the producer happened to emit them, and every structure this pipeline needs —
 * lines, paragraphs, columns, headings, chapters — has to be inferred back out
 * of the geometry. That inference is the whole of this module, and it is kept in
 * pure functions over plain `{x, y, width, fontSize}` records so it can be
 * tested without a PDF at hand and reasoned about without pdf.js in the way.
 *
 * Two failure modes drive the design. Reading a two-column page straight across
 * the gutter produces fluent nonsense that no listener could follow, so columns
 * are detected before anything else is joined. And a scanned book has no text
 * layer at all: narrating it silently would be the worst outcome available, so
 * pages with no text but with image content are counted and reported rather than
 * quietly dropped.
 *
 * Page furniture is the other prize. Running heads and page numbers are the one
 * thing a PDF carries that an EPUB does not, and the filtering stage already
 * ships `page_number` and `running_head` rules waiting for them, so they are
 * recognised here from position plus cross-page repetition and emitted as their
 * own block kinds.
 */

import { deflateSync } from "node:zlib";

import {
  BookExtractionError,
  type Block,
  type BlockKind,
  type BookStructure,
  type Chapter,
  type ExtractionResult,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Baseline drift tolerated within one line, as a fraction of its font size. */
const LINE_BASELINE_TOLERANCE = 0.4;
/** Gap between two runs, in ems, that means a word break rather than kerning. */
const WORD_GAP_RATIO = 0.2;

/** A line wider than this fraction of the text area spans the columns. */
const SPANNING_LINE_RATIO = 0.66;
/** Above this share of spanning lines a page is simply not in columns. */
const MAX_SPANNING_SHARE = 0.35;
/** A gutter must be at least this fraction of the text area wide. */
const MIN_GUTTER_RATIO = 0.04;
/** Lines each column needs before a gutter is believed. */
const MIN_COLUMN_LINES = 4;

/** Height of the top and bottom margin bands, as a fraction of the page. */
const MARGIN_BAND = 0.08;
/** Longer than this and a margin line is prose that ran into the margin. */
const RUNNING_HEAD_MAX_CHARS = 60;
/** Distinct pages a margin line must repeat across to read as a running head. */
const RUNNING_HEAD_MIN_PAGES = 3;

/** Baseline gap that ends a paragraph, as a multiple of the running leading. */
const BLOCK_GAP_RATIO = 1.35;
/** Leading assumed when a page has too few lines to measure one. */
const DEFAULT_LEADING_RATIO = 1.2;
/** Left-edge step, in ems, that reads as a first-line indent. */
const INDENT_RATIO = 0.6;
/** Font size change between lines that means a different kind of text. */
const FONT_CHANGE_RATIO = 0.15;

/** How much larger than the body a line must be set to read as a heading. */
const HEADING_SIZE_RATIO = 1.15;
/** Headings are short. Anything longer set large is a pull quote or a cover. */
const HEADING_MAX_CHARS = 120;
const MAX_HEADING_LEVEL = 6;

/** Characters a page must carry before it counts as having a text layer. */
const MIN_PAGE_TEXT_CHARS = 12;
/** Pages per chapter when a PDF yields no headings at all to split on. */
const FALLBACK_PAGES_PER_CHAPTER = 10;
/** Page numbers named individually in a warning before it summarises. */
const MAX_LISTED_PAGES = 12;

/**
 * Ceiling on the pixels one extracted page image may carry.
 *
 * The image comes out at whatever resolution it was scanned at, so the file
 * decides the size and nothing here can bound it: 40 megapixels covers a 600 DPI
 * A4 scan and rejects anything past it, which would otherwise allocate 160 MB of
 * RGBA before the first byte was inspected.
 */
const MAX_IMAGE_PIXELS = 40_000_000;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** One glyph run, in PDF user space where y grows upward from the page's foot. */
export interface PdfTextItem {
  text: string;
  /** Left edge of the run. */
  x: number;
  /** The run's baseline. */
  y: number;
  /** Advance width of the run. */
  width: number;
  fontSize: number;
}

export interface PdfLine {
  text: string;
  left: number;
  right: number;
  /** The line's baseline. */
  y: number;
  /** The size most of the line's characters are set in. */
  fontSize: number;
}

/** A line once it knows which page it is on and where it sits down it. */
export interface PlacedLine extends PdfLine {
  page: number;
  /** 0 at the top edge of the page, 1 at the foot. */
  positionFromTop: number;
  /** Set once the line has been recognised as page furniture rather than prose. */
  furniture?: FurnitureKind;
}

export type FurnitureKind = "page_number" | "running_head";

/** A block before it has been given an id, an order and a chapter. */
export interface DraftBlock {
  kind: BlockKind;
  text: string;
  page: number;
  /** Kept so headings can be ranked into levels once the whole book is known. */
  fontSize: number;
  level?: number;
}

/**
 * What the text layer looked like, page by page.
 *
 * Exposed so a caller holding a scanned book can decide to run OCR over exactly
 * the pages that need it instead of the whole file.
 */
export interface PdfScanReport {
  totalPages: number;
  /** Pages that yielded a usable amount of text. */
  textPages: number;
  /** Pages with no text layer but with image content: scans awaiting OCR. */
  scannedPages: number[];
}

export interface PdfExtractionResult extends ExtractionResult {
  scan: PdfScanReport;
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/**
 * Groups glyph runs into lines by shared baseline.
 *
 * Runs arrive in content-stream order, which is the order the producer wrote
 * them and need not be reading order at all, so everything is sorted by
 * position first. The baseline tolerance scales with the font size because that
 * is what the drift it absorbs — accents, small caps, an inline italic swapped
 * for a slightly different face — is proportional to.
 */
export function groupItemsIntoLines(items: readonly PdfTextItem[]): PdfLine[] {
  const usable = items.filter((item) => item.text.trim() !== "" && item.fontSize > 0);
  const sorted = [...usable].sort((a, b) => b.y - a.y || a.x - b.x);

  const groups: PdfTextItem[][] = [];
  let anchorY = 0;
  let tolerance = 0;

  for (const item of sorted) {
    const current = groups[groups.length - 1];
    if (current && Math.abs(item.y - anchorY) <= tolerance) {
      current.push(item);
      // A taller run on the line widens what still counts as the same baseline:
      // a drop cap sets the tolerance, not the body text beside it.
      tolerance = Math.max(tolerance, item.fontSize * LINE_BASELINE_TOLERANCE);
      continue;
    }
    groups.push([item]);
    anchorY = item.y;
    tolerance = Math.max(1, item.fontSize * LINE_BASELINE_TOLERANCE);
  }

  return groups.map(buildLine).filter((line) => line.text !== "");
}

function buildLine(group: PdfTextItem[]): PdfLine {
  const runs = [...group].sort((a, b) => a.x - b.x);
  const first = runs[0]!;

  let text = first.text;
  let right = first.x + first.width;
  for (const run of runs.slice(1)) {
    // pdf.js hands back the runs the producer wrote, and a producer is free to
    // set every word — or every letter pair — as its own run with no space
    // between them. The advance gap is the only evidence of a word boundary.
    const separated = /\s$/.test(text) || /^\s/.test(run.text) || run.x - right > run.fontSize * WORD_GAP_RATIO;
    text += separated ? ` ${run.text}` : run.text;
    right = Math.max(right, run.x + run.width);
  }

  return {
    text: text.replace(/\s+/g, " ").trim(),
    left: Math.min(...runs.map((run) => run.x)),
    right,
    y: first.y,
    fontSize: dominantFontSize(runs),
  };
}

/** The size carrying the most characters, which is the line's body rather than its footnote marker. */
function dominantFontSize(runs: readonly PdfTextItem[]): number {
  const weights = new Map<number, number>();
  for (const run of runs) {
    const size = roundSize(run.fontSize);
    weights.set(size, (weights.get(size) ?? 0) + run.text.trim().length);
  }

  let best = runs[0]?.fontSize ?? 0;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      best = size;
      bestWeight = weight;
    }
  }
  return best;
}

/** Any hyphen closing a line, which is a break in one word rather than a space. */
const HYPHEN_LINE_END = /\S[-‐­]$/u;
/** A hyphen closing a line after at least two letters: a word cut by the wrap. */
const WORD_HYPHEN_LINE_END = /\p{L}{2}[-‐­]$/u;
/** A continuation always resumes in lower case; a new sentence or a name does not. */
const CONTINUES_LOWERCASE = /^\p{Ll}/u;

/**
 * Joins the lines of one block into its text, healing words broken by wrapping.
 *
 * Both conditions on removing the hyphen are needed. Requiring it to sit at a
 * line end is what leaves "well-known" alone mid-line, since nothing is being
 * joined across it; requiring the next line to open in lower case is what leaves
 * a real compound split by the wrap — "Anglo-" then "Saxon" — hyphenated. Either
 * way the two halves close up without a space, because a hyphen at a line end is
 * never a word boundary.
 */
export function joinLineTexts(lines: readonly string[]): string {
  let joined = "";

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    if (joined === "") {
      joined = line;
      continue;
    }
    if (HYPHEN_LINE_END.test(joined)) {
      const wrapped = WORD_HYPHEN_LINE_END.test(joined) && CONTINUES_LOWERCASE.test(line);
      joined = wrapped ? joined.slice(0, -1) + line : joined + line;
      continue;
    }
    joined += ` ${line}`;
  }

  return joined;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** The vertical band of white space separating two columns of text. */
export interface ColumnSplit {
  gutterStart: number;
  gutterEnd: number;
}

/**
 * Finds the gutter of a two-column page, or nothing if the evidence is weak.
 *
 * The test is a band of the page that no text crosses. It is run over glyph runs
 * first and over assembled lines afterwards, since a run never straddles a
 * gutter but a line assembled across one does. Whatever spans most of the
 * width — a title over both columns, a wide figure — is set aside before
 * looking, because a single one of them would otherwise cover the gutter and
 * hide a layout that is plainly there. Every threshold errs towards returning
 * nothing: reading a one-column page as two would shred it, whereas missing a
 * gutter costs only the pages that genuinely have one.
 */
export function detectColumnSplit(lines: readonly PdfLine[]): ColumnSplit | undefined {
  const measured = lines.filter((line) => line.right > line.left);
  if (measured.length < MIN_COLUMN_LINES * 2) return undefined;

  const contentLeft = Math.min(...measured.map((line) => line.left));
  const contentRight = Math.max(...measured.map((line) => line.right));
  const contentWidth = contentRight - contentLeft;
  if (contentWidth <= 0) return undefined;

  const narrow = measured.filter((line) => line.right - line.left <= contentWidth * SPANNING_LINE_RATIO);
  if (narrow.length < MIN_COLUMN_LINES * 2) return undefined;
  if (measured.length - narrow.length > measured.length * MAX_SPANNING_SHARE) return undefined;

  const gap = widestGap(narrow, contentLeft, contentWidth);
  if (!gap) return undefined;
  if (gap.gutterEnd - gap.gutterStart < contentWidth * MIN_GUTTER_RATIO) return undefined;

  const left = narrow.filter((line) => line.right <= gap.gutterStart).length;
  const right = narrow.filter((line) => line.left >= gap.gutterEnd).length;
  if (left < MIN_COLUMN_LINES || right < MIN_COLUMN_LINES) return undefined;

  return gap;
}

/**
 * The widest uncovered band whose centre falls in the middle half of the text.
 *
 * Confining the search to the middle half is what keeps the deep left margin of
 * a block quote, or the ragged right edge of unjustified prose, from reading as
 * a gutter.
 */
function widestGap(lines: readonly PdfLine[], contentLeft: number, contentWidth: number): ColumnSplit | undefined {
  const spans = [...lines].sort((a, b) => a.left - b.left);
  const centreLow = contentLeft + contentWidth * 0.25;
  const centreHigh = contentLeft + contentWidth * 0.75;

  let best: ColumnSplit | undefined;
  let bestWidth = 0;
  let covered = spans[0]!.right;

  for (const span of spans.slice(1)) {
    if (span.left > covered) {
      const centre = (covered + span.left) / 2;
      const width = span.left - covered;
      if (width > bestWidth && centre >= centreLow && centre <= centreHigh) {
        best = { gutterStart: covered, gutterEnd: span.left };
        bestWidth = width;
      }
    }
    covered = Math.max(covered, span.right);
  }

  return best;
}

/**
 * Turns one page's glyph runs into lines in reading order.
 *
 * The columns have to be found before the lines are, not after. Two-column
 * pages are typically set to a shared baseline grid, so grouping purely by
 * baseline welds each left-hand line to the right-hand line beside it and
 * produces a page of interleaved half-sentences that no later pass can undo.
 * Individual runs never straddle the gutter, though, so the gutter is visible in
 * the runs even when it is invisible in the lines they would form.
 */
export function layoutPage(items: readonly PdfTextItem[]): PdfLine[] {
  const split = detectColumnSplit(itemSpans(items));
  if (!split || !hasColumnsOfLines(items, split)) {
    return orderLinesForReading(groupItemsIntoLines(items));
  }

  const before = (item: PdfTextItem) => item.x + item.width <= split.gutterStart;
  const after = (item: PdfTextItem) => item.x >= split.gutterEnd;

  return orderLinesForReading([
    ...groupItemsIntoLines(items.filter(before)),
    ...groupItemsIntoLines(items.filter(after)),
    // Runs that cross the gutter are a title or a wide caption; grouped on their
    // own they stay whole lines and `orderLinesForReading` bands around them.
    ...groupItemsIntoLines(items.filter((item) => !before(item) && !after(item))),
  ]);
}

function itemSpans(items: readonly PdfTextItem[]): PdfLine[] {
  return items.map((item) => ({
    text: item.text,
    left: item.x,
    right: item.x + item.width,
    y: item.y,
    fontSize: item.fontSize,
  }));
}

/**
 * Checks a gutter found among runs is really a gutter between columns.
 *
 * Run spans are far more numerous than lines, so a candidate has to clear a
 * count of distinct baselines rather than of spans: without it, a handful of
 * word gaps that happen to line up down a sparse page would read as a column
 * break.
 */
function hasColumnsOfLines(items: readonly PdfTextItem[], split: ColumnSplit): boolean {
  const baselines = (kept: readonly PdfTextItem[]) => new Set(kept.map((item) => Math.round(item.y))).size;
  return (
    baselines(items.filter((item) => item.x + item.width <= split.gutterStart)) >= MIN_COLUMN_LINES &&
    baselines(items.filter((item) => item.x >= split.gutterEnd)) >= MIN_COLUMN_LINES
  );
}

/**
 * Puts a page's lines into reading order.
 *
 * A line crossing the gutter is treated as a divider rather than as content of
 * either column, so a page laid out as title, then two columns, then a
 * full-width note reads in that order instead of interleaving the note into a
 * column. Without that banding a mid-page figure caption would drag everything
 * below it into the wrong sequence.
 */
export function orderLinesForReading(lines: readonly PdfLine[]): PdfLine[] {
  const sorted = [...lines].sort((a, b) => b.y - a.y || a.left - b.left);
  const split = detectColumnSplit(sorted);
  if (!split) return sorted;

  const ordered: PdfLine[] = [];
  let band: PdfLine[] = [];

  const flush = () => {
    if (band.length === 0) return;
    ordered.push(...band.filter((line) => line.right <= split.gutterStart));
    ordered.push(...band.filter((line) => line.right > split.gutterStart));
    band = [];
  };

  for (const line of sorted) {
    if (line.left < split.gutterEnd && line.right > split.gutterStart) {
      flush();
      ordered.push(line);
      continue;
    }
    band.push(line);
  }
  flush();

  return ordered;
}

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

/** What `classifyPageFurniture` needs to know about a line. */
export interface FurnitureLine {
  page: number;
  text: string;
  /** 0 at the top edge of the page, 1 at the foot. */
  positionFromTop: number;
}

/** A number alone on a line, with whatever rule, bracket or word decorates it. */
const DECORATED_NUMBER = /^[\s\-–—[\](){}|·•.]*(?:pages?\s+|p\.\s*)?([0-9a-z]{1,7})[\s\-–—[\](){}|·•.]*$/i;
const DIGITS_ONLY = /^\d{1,4}$/;
/**
 * Real roman numeral syntax rather than merely roman letters.
 *
 * A bare `[ivxlcdm]+` class matches ordinary words — "vivid", "civil", "mill" —
 * and a page footer is exactly where a one-word line lands. Note this also
 * matches the empty string, so callers must check for text first.
 */
const ROMAN_ONLY = /^m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/i;

export function isPageNumberText(text: string): boolean {
  const match = DECORATED_NUMBER.exec(text.trim());
  const number = match?.[1] ?? "";
  if (number === "") return false;
  return DIGITS_ONLY.test(number) || ROMAN_ONLY.test(number);
}

/**
 * Collapses a margin line to what has to match for it to be the same running head.
 *
 * The page number moving from one page to the next is the only thing that
 * changes about a running foot, so it is stripped from either end before
 * anything is compared.
 */
function normalizeMarginLine(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\d+[\s.·•|—–-]*/, "")
    .replace(/[\s.·•|—–-]*\d+$/, "")
    .trim();
}

/**
 * Labels the lines that are page furniture, one verdict per input line.
 *
 * Position alone is not enough — the first line of body text on a page sits
 * close to the top margin — so it is only ever half the evidence. A page number
 * has to be nothing but a number, and a running head has to reappear on other
 * pages. A short margin line that satisfies neither is left as prose, because
 * this pass can only be trusted to delete text when it is sure.
 */
export function classifyPageFurniture(
  lines: readonly FurnitureLine[],
  totalPages: number,
): (FurnitureKind | undefined)[] {
  const inMargin = lines.map(
    (line) => line.positionFromTop <= MARGIN_BAND || line.positionFromTop >= 1 - MARGIN_BAND,
  );

  const pagesByText = new Map<string, Set<number>>();
  for (const [index, line] of lines.entries()) {
    if (!inMargin[index]) continue;
    if (line.text.trim().length > RUNNING_HEAD_MAX_CHARS) continue;
    const key = normalizeMarginLine(line.text);
    if (key === "") continue;
    const pages = pagesByText.get(key);
    if (pages) pages.add(line.page);
    else pagesByText.set(key, new Set([line.page]));
  }

  // A single page can never show that anything repeats, so the floor of two
  // keeps a short book from labelling its only header as furniture.
  const required = Math.max(2, Math.min(RUNNING_HEAD_MIN_PAGES, totalPages));

  return lines.map((line, index) => {
    if (!inMargin[index]) return undefined;
    if (isPageNumberText(line.text)) return "page_number";
    if ((pagesByText.get(normalizeMarginLine(line.text))?.size ?? 0) >= required) return "running_head";
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * The size the book's body text is set in.
 *
 * Weighted by characters rather than by lines so that a title page of six
 * enormous words cannot outvote the prose, and rounded to the half point
 * because subsetted fonts routinely report 11.9999 where they mean 12.
 */
export function modalFontSize(lines: readonly PlacedLine[]): number {
  const weights = new Map<number, number>();
  for (const line of lines) {
    if (line.furniture) continue;
    const size = roundSize(line.fontSize);
    if (size <= 0) continue;
    weights.set(size, (weights.get(size) ?? 0) + line.text.length);
  }

  let best = 0;
  let bestWeight = 0;
  for (const [size, weight] of weights) {
    // Ties go to the smaller size: body text is what a book has most of, and
    // mistaking a heading size for the body would flatten every heading away.
    if (weight > bestWeight || (weight === bestWeight && best !== 0 && size < best)) {
      best = size;
      bestWeight = weight;
    }
  }
  return best;
}

/**
 * Groups lines into blocks, breaking wherever the typography says a new one starts.
 *
 * Lines must already be in reading order, which for a multi-column page means
 * `orderLinesForReading` has run: a column change shows up here as the next line
 * sitting above the previous one, which is treated as a break.
 */
export function assembleBlocks(lines: readonly PlacedLine[], bodyFontSize: number): DraftBlock[] {
  // Headings and furniture sit in their own white space, so measuring the
  // leading over them would report a page as more loosely set than it is and
  // hide the paragraph breaks this is here to find.
  const prose = lines.filter((line) => !line.furniture && !isHeadingLine(line, bodyFontSize));
  const leading = medianLeading(prose, Math.max(bodyFontSize, 1) * DEFAULT_LEADING_RATIO);
  const blocks: DraftBlock[] = [];
  let pending: PlacedLine[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    const text = joinLineTexts(pending.map((line) => line.text));
    const first = pending[0]!;
    pending = [];
    if (text !== "") blocks.push({ kind: "paragraph", text, page: first.page, fontSize: first.fontSize });
  };

  for (const line of lines) {
    if (line.text.trim() === "") continue;

    if (line.furniture) {
      flush();
      blocks.push({ kind: line.furniture, text: line.text, page: line.page, fontSize: line.fontSize });
      continue;
    }

    if (isHeadingLine(line, bodyFontSize)) {
      flush();
      blocks.push({ kind: "heading", text: line.text, page: line.page, fontSize: line.fontSize });
      continue;
    }

    const previous = pending[pending.length - 1];
    if (previous && startsNewBlock(previous, line, leading)) flush();
    pending.push(line);
  }

  flush();
  return blocks;
}

function isHeadingLine(line: PlacedLine, bodyFontSize: number): boolean {
  if (bodyFontSize <= 0) return false;
  if (line.fontSize < bodyFontSize * HEADING_SIZE_RATIO) return false;
  // Bold-only is deliberately not a signal. Emphasised runs inside prose are far
  // too common for it, and a false heading also breaks the chapter split.
  return line.text.length <= HEADING_MAX_CHARS;
}

function startsNewBlock(previous: PlacedLine, line: PlacedLine, leading: number): boolean {
  if (line.page !== previous.page) return true;

  const gap = previous.y - line.y;
  // Reading order has already placed the lines, so a line that sits above its
  // predecessor is the top of the next column.
  if (gap <= 0) return true;
  if (gap > leading * BLOCK_GAP_RATIO) return true;
  if (line.left > previous.left + line.fontSize * INDENT_RATIO) return true;

  const larger = Math.max(line.fontSize, previous.fontSize);
  return larger > 0 && Math.abs(line.fontSize - previous.fontSize) / larger > FONT_CHANGE_RATIO;
}

/**
 * The book's usual distance between baselines.
 *
 * A median rather than a mean, and measured only within a page, so that the
 * jumps between columns and pages — which are the very gaps this number is used
 * to recognise — cannot inflate it.
 */
function medianLeading(lines: readonly PlacedLine[], fallback: number): number {
  const gaps: number[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1]!;
    const line = lines[index]!;
    if (line.page !== previous.page) continue;
    const gap = previous.y - line.y;
    if (gap > 0 && gap < fallback * 3) gaps.push(gap);
  }
  if (gaps.length === 0) return fallback;

  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]!;
}

/**
 * Ranks the heading sizes found and turns that ranking into depths.
 *
 * A PDF never states that one heading nests inside another; the only evidence is
 * that it is set smaller, so the sizes are ordered and the rank becomes the
 * level. Six is the floor because `Block.level` goes no deeper.
 */
export function assignHeadingLevels(blocks: readonly DraftBlock[]): DraftBlock[] {
  const sizes = [...new Set(blocks.filter((block) => block.kind === "heading").map((block) => roundSize(block.fontSize)))];
  if (sizes.length === 0) return [...blocks];

  sizes.sort((a, b) => b - a);
  const levels = new Map(sizes.map((size, index) => [size, Math.min(index + 1, MAX_HEADING_LEVEL)]));

  return blocks.map((block) =>
    block.kind === "heading"
      ? { ...block, level: levels.get(roundSize(block.fontSize)) ?? MAX_HEADING_LEVEL }
      : block,
  );
}

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

interface PdfMetadata {
  title: string;
  author: string;
  language: string;
}

/**
 * Splits the blocks into chapters at the shallowest heading level present.
 *
 * A book set with only one heading size should still break on it, so the level
 * comes from the document rather than being fixed at 1. When there are no
 * headings at all — a scan, or a typesetter who never varied the size — fixed
 * page bands stand in, because segmentation needs something to group by and an
 * arbitrary split is far better than one chapter of four hundred pages.
 */
function buildStructure(
  drafts: readonly DraftBlock[],
  metadata: PdfMetadata,
  fallbackTitle: string,
  pageCount: number,
  warnings: string[],
): BookStructure {
  const headingLevels = drafts.filter((draft) => draft.kind === "heading").map((draft) => draft.level ?? 1);
  const chapterLevel = headingLevels.length > 0 ? Math.min(...headingLevels) : undefined;

  if (chapterLevel === undefined && drafts.length > 0) {
    warnings.push(
      "the pdf has no headings to split on, so it was divided into chapters of " +
        `${FALLBACK_PAGES_PER_CHAPTER} pages each`,
    );
  }

  const chapters: Chapter[] = [];
  const blocks: Block[] = [];
  let band = -1;

  for (const draft of drafts) {
    let title = "";
    let startsChapter = false;

    if (chapterLevel === undefined) {
      const nextBand = Math.floor(Math.max(0, draft.page - 1) / FALLBACK_PAGES_PER_CHAPTER);
      if (nextBand !== band) {
        band = nextBand;
        startsChapter = true;
        title = pageBandTitle(band, pageCount);
      }
    } else if (draft.kind === "heading" && (draft.level ?? 1) === chapterLevel) {
      startsChapter = true;
      title = draft.text;
    }

    if (startsChapter || chapters.length === 0) {
      const index = chapters.length;
      chapters.push({
        id: `ch-${index}`,
        title: title || fallbackTitle,
        level: startsChapter && chapterLevel !== undefined ? chapterLevel : 1,
        order: index,
        blockIds: [],
      });
    }

    const chapterIndex = chapters.length - 1;
    const chapter = chapters[chapterIndex]!;
    const block: Block = {
      id: `${chapterIndex}:${chapter.blockIds.length}`,
      kind: draft.kind,
      text: draft.text,
      chapterId: chapter.id,
      // `blocks` holds the whole book in reading order, so its length before the
      // push is already the global index this block occupies.
      order: blocks.length,
      page: draft.page,
    };
    if (draft.level !== undefined) block.level = draft.level;

    blocks.push(block);
    chapter.blockIds.push(block.id);
  }

  if (chapters.length === 0) {
    // A book with nothing in it still has to be a book: the review screen needs
    // somewhere to show the warning that says why it is empty.
    chapters.push({ id: "ch-0", title: fallbackTitle, level: 1, order: 0, blockIds: [] });
  }

  return {
    title: metadata.title || fallbackTitle,
    author: metadata.author,
    language: metadata.language,
    chapters,
    blocks,
  };
}

function pageBandTitle(band: number, pageCount: number): string {
  const first = band * FALLBACK_PAGES_PER_CHAPTER + 1;
  const last = Math.min(first + FALLBACK_PAGES_PER_CHAPTER - 1, Math.max(first, pageCount));
  return first === last ? `Page ${first}` : `Pages ${first}-${last}`;
}

// ---------------------------------------------------------------------------
// Page images
// ---------------------------------------------------------------------------

/**
 * The pixel layouts pdf.js decodes to, mirroring its `ImageKind` enum.
 *
 * Restated here rather than imported so that the conversion below stays a pure
 * function over bytes, testable without loading pdf.js at all. A test asserts
 * the two definitions still agree.
 */
export const PDF_IMAGE_KIND = {
  /** Packed 1 bit per pixel, rows padded to a byte; a set bit is white. */
  grayscale1bpp: 1,
  rgb24: 2,
  rgba32: 3,
} as const;

/** A decoded image exactly as pdf.js hands it over. */
export interface PdfImage {
  width: number;
  height: number;
  /** One of `PDF_IMAGE_KIND`. */
  kind: number;
  data: Uint8Array | Uint8ClampedArray;
}

/**
 * Expands a decoded pdf.js image to the RGBA a canvas can take.
 *
 * Every layout is checked against the byte count it implies before a single
 * pixel is read. A truncated or mislabelled image is a real thing to find in a
 * damaged scan, and the alternative to rejecting it is reading past the end of
 * the buffer, which is precisely the class of bug this whole path exists to
 * avoid.
 */
export function imageToRgba(image: PdfImage): Uint8ClampedArray {
  const { width, height, kind, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new BookExtractionError(`the page image has unusable dimensions (${width}x${height})`);
  }

  const pixels = width * height;
  if (pixels > MAX_IMAGE_PIXELS) {
    throw new BookExtractionError(
      `the page image is ${width}x${height}, beyond the ${MAX_IMAGE_PIXELS / 1_000_000} megapixel limit`,
    );
  }

  const rgba = new Uint8ClampedArray(pixels * 4);

  if (kind === PDF_IMAGE_KIND.grayscale1bpp) {
    const rowBytes = (width + 7) >> 3;
    requireBytes(data, rowBytes * height, kind);
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        // pdf.js packs these most significant bit first, and a set bit is white:
        // the same convention its own canvas renderer reads them with.
        const bit = (data[row * rowBytes + (column >> 3)]! >> (7 - (column & 7))) & 1;
        const level = bit === 1 ? 255 : 0;
        const target = (row * width + column) * 4;
        rgba[target] = level;
        rgba[target + 1] = level;
        rgba[target + 2] = level;
        rgba[target + 3] = 255;
      }
    }
    return rgba;
  }

  const stride = kind === PDF_IMAGE_KIND.rgb24 ? 3 : kind === PDF_IMAGE_KIND.rgba32 ? 4 : 0;
  if (stride === 0) {
    throw new BookExtractionError(`the page image uses an unsupported pixel layout (kind ${kind})`);
  }
  requireBytes(data, pixels * stride, kind);

  for (let target = 0, source = 0; target < rgba.length; target += 4, source += stride) {
    rgba[target] = data[source]!;
    rgba[target + 1] = data[source + 1]!;
    rgba[target + 2] = data[source + 2]!;
    rgba[target + 3] = stride === 3 ? 255 : data[source + 3]!;
  }
  return rgba;
}

function requireBytes(data: { length: number }, needed: number, kind: number): void {
  if (data.length < needed) {
    throw new BookExtractionError(
      `the page image is truncated: kind ${kind} needs ${needed} bytes but carries ${data.length}`,
    );
  }
}

/** The eight bytes every PNG opens with. */
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Colour type 6: 8-bit RGBA, which is what `imageToRgba` produces. */
const PNG_COLOR_TYPE_RGBA = 6;
const PNG_FILTER_NONE = 0;
/** Each byte stored as its difference from the byte above; good on scans. */
const PNG_FILTER_UP = 2;

/**
 * Encodes RGBA pixels as a PNG.
 *
 * Hand-written rather than routed through Skia, for the same reason the zip
 * reader in this directory is hand-written: it is a small, exactly specified
 * format and the alternative drags a native library into the path. That matters
 * here more than usual — pdf.js's own canvas path is what corrupts memory in
 * Bun, and @napi-rs/canvas measurably retains around 26 MB per page-sized
 * canvas it is asked for, which over a scanned book is gigabytes that never come
 * back. This wants nothing but a deflate.
 */
export function encodePng(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  if (rgba.length < width * height * 4) {
    throw new BookExtractionError(`the pixel buffer is too small for a ${width}x${height} image`);
  }

  const stride = width * 4;
  // One filter byte per scanline, ahead of that scanline's pixels.
  const raw = new Uint8Array((stride + 1) * height);

  for (let row = 0; row < height; row += 1) {
    const source = row * stride;
    const target = row * (stride + 1);
    // The first scanline has nothing above it to subtract from.
    raw[target] = row === 0 ? PNG_FILTER_NONE : PNG_FILTER_UP;
    for (let index = 0; index < stride; index += 1) {
      const value = rgba[source + index]!;
      raw[target + 1 + index] = row === 0 ? value : (value - rgba[source - stride + index]!) & 0xff;
    }
  }

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8;
  header[9] = PNG_COLOR_TYPE_RGBA;

  return concatBytes([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", new Uint8Array(deflateSync(raw))),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) chunk[4 + index] = type.charCodeAt(index);
  chunk.set(data, 8);
  // The checksum covers the type and the data, but not the length.
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/** Table-free CRC-32; a page has four chunks, so the table would not pay for itself. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    output.set(part, cursor);
    cursor += part.length;
  }
  return output;
}

// ---------------------------------------------------------------------------
// pdf.js
// ---------------------------------------------------------------------------

type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfDocument = Awaited<ReturnType<PdfjsModule["getDocument"]>["promise"]>;
type PdfPage = Awaited<ReturnType<PdfDocument["getPage"]>>;

let pdfjs: Promise<PdfjsModule> | undefined;

/**
 * Loads pdf.js on first use rather than at import time.
 *
 * It is the largest dependency the server has and only one upload format needs
 * it, so an EPUB or a text file should not pay to parse it. The extraction
 * dispatcher imports this module eagerly, which is exactly why the cost has to
 * sit behind a call instead of at the top of the file.
 */
function loadPdfjs(): Promise<PdfjsModule> {
  pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs;
}

interface OpenPdf {
  document: PdfDocument;
  module: PdfjsModule;
  close: () => Promise<void>;
}

async function openPdf(data: Uint8Array): Promise<OpenPdf> {
  const module = await loadPdfjs();
  // pdf.js transfers the buffer it is handed and leaves the caller's view
  // detached. The caller still owns these bytes — the OCR pass rasterises the
  // very same upload after extraction has read it — so it is given a copy.
  const task = module.getDocument({ data: new Uint8Array(data), useSystemFonts: true, verbosity: 0 });

  try {
    return { document: await task.promise, module, close: () => task.destroy() };
  } catch (error) {
    await task.destroy().catch(() => undefined);
    throw asExtractionError(error);
  }
}

function asExtractionError(error: unknown): BookExtractionError {
  if (error instanceof BookExtractionError) return error;
  // Checked by name rather than by class: pdf.js raises `PasswordException`
  // from inside its worker, and an instanceof against the class this side of
  // that boundary is not reliable.
  if ((error as { name?: string }).name === "PasswordException") {
    return new BookExtractionError(
      "the pdf is password-protected, so none of its text can be read; supply an unlocked copy",
    );
  }
  return new BookExtractionError(`not a usable pdf: ${messageOf(error)}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface PageRead {
  lines: PlacedLine[];
  /** Characters of real text found, which is what decides if the page was scanned. */
  characters: number;
}

async function readPage(page: PdfPage, pageNumber: number): Promise<PageRead> {
  const content = await page.getTextContent();
  const items: PdfTextItem[] = [];
  let characters = 0;

  for (const item of content.items) {
    // Marked-content markers carry structure tags, not glyphs.
    if (!("str" in item)) continue;
    if (item.str.trim() === "") continue;

    const transform = item.transform as number[];
    characters += item.str.trim().length;
    items.push({
      text: item.str,
      x: transform[4] ?? 0,
      y: transform[5] ?? 0,
      width: item.width,
      // `height` is the rendered size for upright text and zero for some rotated
      // runs, where the text matrix's vertical scale is the only source left.
      fontSize: item.height > 0 ? item.height : Math.hypot(transform[2] ?? 0, transform[3] ?? 0),
    });
  }

  const view = page.view as number[];
  const foot = view[1] ?? 0;
  const head = view[3] ?? 0;
  const height = head - foot;

  const lines = layoutPage(items).map((line) => ({
    ...line,
    page: pageNumber,
    positionFromTop: height > 0 ? clamp((head - line.y) / height, 0, 1) : 0.5,
  }));

  return { lines, characters };
}

/** Whether the page paints any bitmap, which is what separates a scan from a blank leaf. */
async function paintsImages(page: PdfPage, module: PdfjsModule): Promise<boolean> {
  const { OPS } = module;
  const imageOperators = new Set([
    OPS.paintImageXObject,
    OPS.paintImageXObjectRepeat,
    OPS.paintInlineImageXObject,
    OPS.paintImageMaskXObject,
  ]);

  const operators = await page.getOperatorList();
  return operators.fnArray.some((operator) => imageOperators.has(operator));
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export async function extractPdf(data: Uint8Array, filename: string): Promise<PdfExtractionResult> {
  const warnings: string[] = [];
  const { document, module, close } = await openPdf(data);

  try {
    const totalPages = document.numPages;
    const placed: PlacedLine[] = [];
    const scannedPages: number[] = [];
    let textPages = 0;

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      let page: PdfPage | undefined;
      try {
        page = await document.getPage(pageNumber);
        const read = await readPage(page, pageNumber);
        // The lines are kept whatever the verdict: a part-title page holding two
        // words is not a scan, and dropping it would lose the two words.
        placed.push(...read.lines);
        if (read.characters >= MIN_PAGE_TEXT_CHARS) textPages += 1;
        else if (await paintsImages(page, module)) scannedPages.push(pageNumber);
      } catch (error) {
        // One unreadable page must not cost the other four hundred.
        warnings.push(`page ${pageNumber} could not be read: ${messageOf(error)}`);
      } finally {
        page?.cleanup();
      }
    }

    reportScanCoverage({ totalPages, textPages, scannedPages }, warnings);

    const lines = withFurniture(placed, totalPages);
    const drafts = assignHeadingLevels(assembleBlocks(lines, modalFontSize(lines)));
    const structure = buildStructure(drafts, await readMetadata(document), stemOf(filename), totalPages, warnings);

    return { structure, warnings, scan: { totalPages, textPages, scannedPages } };
  } finally {
    await close();
  }
}

/**
 * Extracts one scanned page as a PNG, for OCR.
 *
 * This deliberately does not go anywhere near `page.render()`. pdf.js's canvas
 * path reaches for `ImageData`, `OffscreenCanvas` and `createImageBitmap`, all
 * three of which are absent in Bun, and painting an image XObject through it
 * segfaults the process at varying addresses — memory corruption, not a null
 * dereference that could be guarded. A Bun server has no process isolation, so
 * one scanned upload would take the whole thing down.
 *
 * Lifting the image straight out of the operator list is also simply better for
 * the job. What comes back is the scan at its own resolution, with no guess at a
 * DPI and no second rasterisation to lose detail to. The limitation — it only
 * works when the page really is an image — is exactly the case that needs OCR,
 * since a page carrying a text layer never does.
 *
 * `scale` is accepted for call compatibility and ignored: the embedded image
 * arrives at its native resolution, which is the best available.
 */
export async function renderPdfPageToPng(
  data: Uint8Array,
  pageNumber: number,
  scale?: number,
): Promise<Uint8Array> {
  // Kept in the signature on purpose, so a caller passing a DPI scale still
  // compiles; there is nothing here for it to do.
  void scale;
  const { document, module, close } = await openPdf(data);

  try {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) {
      throw new BookExtractionError(
        `cannot extract page ${pageNumber} as an image: the pdf has ${document.numPages} page(s)`,
      );
    }

    const page = await document.getPage(pageNumber);
    try {
      const image = await largestPageImage(page, module);
      if (!image) {
        throw new BookExtractionError(
          `page ${pageNumber} is not a scanned image, and pages with mixed content cannot be ` +
            "turned into one; only pages whose whole content is an image can be sent to OCR",
        );
      }

      return encodePng(imageToRgba(image), image.width, image.height);
    } finally {
      page.cleanup();
    }
  } finally {
    await close();
  }
}

/**
 * The biggest image painted on a page, or nothing if it paints none.
 *
 * Biggest by pixel count rather than first: a scanned page routinely carries a
 * small logo or a scanner watermark alongside the leaf itself, and the leaf is
 * always the larger of them.
 */
async function largestPageImage(page: PdfPage, module: PdfjsModule): Promise<PdfImage | undefined> {
  const { OPS } = module;
  // Image masks are excluded on purpose: they are stencils painted in the
  // current fill colour, so their bits do not mean black and white, and guessing
  // the polarity wrong would hand OCR a photographic negative.
  const byId = new Set<number>([OPS.paintImageXObject, OPS.paintImageXObjectRepeat]);
  const inline = OPS.paintInlineImageXObject;

  const operators = await page.getOperatorList();
  const objs = page.objs as unknown as { has(id: string): boolean; get(id: string, callback?: unknown): unknown };

  let best: PdfImage | undefined;
  for (const [index, operator] of operators.fnArray.entries()) {
    // Operators that take no arguments — `save`, `restore` — carry a null here.
    const first = (operators.argsArray[index] as unknown[] | null)?.[0];

    let candidate: unknown;
    if (byId.has(operator) && typeof first === "string") {
      // Resolved synchronously whenever the operator list already carries the
      // object, which it does once its `dependency` op has been fulfilled.
      candidate = objs.has(first)
        ? objs.get(first)
        : await new Promise((resolve) => objs.get(first, resolve));
    } else if (operator === inline && typeof first === "object" && first !== null) {
      candidate = first;
    } else {
      continue;
    }

    const image = asPdfImage(candidate);
    if (image && (!best || image.width * image.height > best.width * best.height)) best = image;
  }

  return best;
}

function asPdfImage(value: unknown): PdfImage | undefined {
  const image = value as Partial<PdfImage> | null | undefined;
  if (!image || typeof image.width !== "number" || typeof image.height !== "number") return undefined;
  if (typeof image.kind !== "number" || !image.data || typeof image.data.length !== "number") return undefined;
  return { width: image.width, height: image.height, kind: image.kind, data: image.data };
}

// ---------------------------------------------------------------------------
// Assembly helpers
// ---------------------------------------------------------------------------

function withFurniture(placed: readonly PlacedLine[], totalPages: number): PlacedLine[] {
  const verdicts = classifyPageFurniture(placed, totalPages);
  return placed.map((line, index) => {
    const furniture = verdicts[index];
    return furniture ? { ...line, furniture } : line;
  });
}

/**
 * Says plainly how much of the book has no text layer.
 *
 * Silence is the failure this guards against: a scanned book that extracts to
 * nothing looks exactly like a book with nothing to say, and the difference only
 * becomes obvious once someone has waited for an empty audiobook to render.
 */
function reportScanCoverage(scan: PdfScanReport, warnings: string[]): void {
  if (scan.totalPages === 0) {
    warnings.push("the pdf contains no pages");
    return;
  }

  if (scan.scannedPages.length > 0) {
    warnings.push(
      scan.textPages === 0
        ? `none of the ${scan.totalPages} pages have a text layer: this is a scanned pdf and needs OCR ` +
            "before any of it can be narrated"
        : `${scan.scannedPages.length} of ${scan.totalPages} pages have no text layer and look like scanned ` +
            `images (${formatPageList(scan.scannedPages)}); they will be missing from the narration unless OCR is run`,
    );
    return;
  }

  if (scan.textPages === 0) {
    warnings.push(`none of the ${scan.totalPages} pages contained readable text`);
  }
}

function formatPageList(pages: readonly number[]): string {
  const shown = pages.slice(0, MAX_LISTED_PAGES).join(", ");
  return pages.length > MAX_LISTED_PAGES ? `${shown} and ${pages.length - MAX_LISTED_PAGES} more` : shown;
}

async function readMetadata(document: PdfDocument): Promise<PdfMetadata> {
  try {
    const info = (await document.getMetadata()).info as Record<string, unknown>;
    return {
      title: readString(info.Title),
      author: readString(info.Author),
      language: readString(info.Language),
    };
  } catch {
    // The info dictionary is optional and frequently malformed. Losing the
    // title costs a filename-derived one; failing the extraction costs the book.
    return { title: "", author: "", language: "" };
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function roundSize(size: number): number {
  return Math.round(size * 2) / 2;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function stemOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
