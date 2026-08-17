/**
 * Smart segmentation: find real chapter/section starts, then pack them.
 *
 * Duration mode slices wherever the clock says so, which is why a PDF that only
 * extracted "Book the First" becomes a dozen "(part N)" videos. Smart mode
 * first marks genuine narrative boundaries — extracted headings, chapter-like
 * short lines, and (when the LLM is available) confirmed starts from a compact
 * outline — then groups those sections toward the target length the same way a
 * human would: keep a short chapter whole, pack several short ones together,
 * and only duration-split a section that itself exceeds the maximum.
 *
 * Unread apparatus is dropped here rather than packed into the opening video:
 * a table of contents is a list of chapter titles, not the chapters, and a
 * listener should never hear it. The first narratable video then announces the
 * book, the author, and the opening chapter before the body starts; later
 * videos announce the chapter they begin on.
 */

import { generateSegmentBoundaries } from "../llm/index.ts";
import { MAX_SEGMENT_TITLE_LENGTH } from "../llm/prompts.ts";
import { errorMessage, logger } from "../../utils/logger.ts";
import { countWords, estimateSpokenSeconds, planSegments } from "./segment.ts";
import type { Block, BookStructure, SegmentOptions, SegmentPlan } from "./types.ts";

/** How many outline units to send the model at once. */
const OUTLINE_CHUNK_SIZE = 100;
const OUTLINE_CHUNK_OVERLAP = 8;

/**
 * A collapsed run of the book used as LLM context and as a candidate split.
 *
 * `heading` and `marker` are preferred starts; `prose` is the body between them,
 * included so the model can still start a section at a scene change when the
 * extractor missed the title.
 */
export interface OutlineUnit {
  index: number;
  startBlockId: string;
  kind: "heading" | "marker" | "prose";
  title: string;
  seconds: number;
  chapterTitle: string;
}

export interface SmartSection {
  startBlockId: string;
  title: string;
}

export interface SmartDetection {
  sections: SmartSection[];
  skipBlockIds: string[];
}

export interface SectionProposal {
  sections: SmartSection[];
  skipBlockIds?: string[];
}

export type SectionProposer = (input: {
  structure: BookStructure;
  options: SegmentOptions;
  units: OutlineUnit[];
  totalSeconds: number;
  chunkIndex: number;
  chunkCount: number;
}) => Promise<SmartSection[] | SectionProposal>;

const CHAPTER_LIKE =
  /^(book|part|act|scene|chapter|canto|volume|prologue|epilogue|preface|introduction|foreword|afterword|appendix|acknowledgements?)\b/i;
const ROMAN_TITLE = /^[IVXLCDM]{1,8}([.)]|$)(\s+\S|$)/;
/** Punctuated "1. The Period", or a heading that is only the number "1". */
const NUMBERED_TITLE = /^(chapter\s+)?\d{1,3}(([.)])(\s+\S|$)|$)/i;
const BARE_CHAPTER_NUMBER = /^(?:chapter\s+)?(\d{1,3}|[IVXLCDM]{1,8})\.?$/i;
const BOOK_PART = /^book\s+(the\s+)?([a-z]+|[IVXLCDM]+|\d+)\b/i;
const TOC_HEADING =
  /^(table\s+of\s+contents|contents(?:\s+page)?|list\s+of\s+(?:chapters|contents)|toc)\.?$/i;
/** A contents listing is a run of short titles, not chapters with a body. */
const TOC_UNIT_MAX_SECONDS = 25;
const TOC_MIN_MARKERS = 4;
const TITLE_SEPARATOR = " — ";

/** True when a short line is likely a chapter/section title rather than prose. */
export function looksLikeSectionTitle(text: string): boolean {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed || trimmed.length > 80) return false;

  const words = trimmed.split(" ");
  if (words.length > 14) return false;

  if (CHAPTER_LIKE.test(trimmed) || BOOK_PART.test(trimmed)) return true;
  if (ROMAN_TITLE.test(trimmed) && words.length <= 12) return true;
  if (NUMBERED_TITLE.test(trimmed) && words.length <= 12) return true;

  const letters = trimmed.replace(/[^A-Za-z\u00C0-\u024F]/g, "");
  if (
    letters.length >= 3 &&
    words.length <= 8 &&
    trimmed === trimmed.toUpperCase() &&
    /[A-Z]/.test(trimmed)
  ) {
    return true;
  }

  return false;
}

/** True when a line is a contents heading rather than a chapter of the book. */
export function looksLikeTocHeading(text: string): boolean {
  return TOC_HEADING.test(text.replace(/\s+/g, " ").trim());
}

function normalizeTitleKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Spoken label for a heading that is only a chapter number: "1" → "Chapter 1".
 * Returns null when the title already has a name ("I. The Period").
 */
export function numberedChapterLabel(title: string): string | null {
  const trimmed = title.replace(/\s+/g, " ").trim();
  const match = trimmed.match(BARE_CHAPTER_NUMBER);
  if (!match) return null;
  return `Chapter ${match[1]}`;
}

/**
 * Turns a bare "1" into "Chapter 1", and a number plus the next heading into
 * "Chapter 8 — Camilla" so POV/year lines are not used instead of the number.
 */
export function formatSectionTitle(title: string, nextHeading?: string): string {
  const primary = title.replace(/\s+/g, " ").trim();
  const following = (nextHeading ?? "").replace(/\s+/g, " ").trim();
  const numbered = numberedChapterLabel(primary);
  const head = numbered ?? primary;
  if (
    following &&
    numbered &&
    !numberedChapterLabel(following) &&
    !normalizeTitleKey(head).includes(normalizeTitleKey(following))
  ) {
    return `${head}${TITLE_SEPARATOR}${following}`;
  }
  return head || following;
}

function previewOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

function chapterTitleOf(structure: BookStructure, chapterId: string): string {
  return (structure.chapters.find((chapter) => chapter.id === chapterId)?.title ?? "").trim();
}

function isMarkerBlock(block: Block, isChapterStart: boolean): boolean {
  if (block.kind === "heading") return true;
  if (isChapterStart) return true;
  return looksLikeSectionTitle(block.text);
}

/**
 * Collapses kept blocks into heading/marker units plus the prose between them.
 *
 * The outline is what the model sees: thousands of paragraphs would blow the
 * context window, but a few hundred markers plus duration-labelled prose runs
 * are enough to recover missed "Chapter I" titles in a PDF.
 */
export function buildOutline(
  structure: BookStructure,
  kept: Block[],
  wordsPerMinute: number,
): OutlineUnit[] {
  const ordered = [...kept].sort((a, b) => a.order - b.order);
  const units: OutlineUnit[] = [];
  let prose: Block[] = [];
  const seenChapter = new Set<string>();

  const flushProse = (): void => {
    if (prose.length === 0) return;
    const first = prose[0]!;
    const seconds = prose.reduce(
      (sum, block) => sum + estimateSpokenSeconds(block.text, wordsPerMinute),
      0,
    );
    units.push({
      index: units.length,
      startBlockId: first.id,
      kind: "prose",
      title: previewOf(first.text),
      seconds,
      chapterTitle: chapterTitleOf(structure, first.chapterId),
    });
    prose = [];
  };

  for (const block of ordered) {
    const isChapterStart = !seenChapter.has(block.chapterId);
    if (isChapterStart) seenChapter.add(block.chapterId);

    if (isMarkerBlock(block, isChapterStart)) {
      flushProse();
      units.push({
        index: units.length,
        startBlockId: block.id,
        kind: block.kind === "heading" ? "heading" : "marker",
        title: previewOf(block.text) || chapterTitleOf(structure, block.chapterId),
        seconds: estimateSpokenSeconds(block.text, wordsPerMinute),
        chapterTitle: chapterTitleOf(structure, block.chapterId),
      });
      continue;
    }

    prose.push(block);
  }

  flushProse();
  return units;
}

/** Heading and marker units — the fallback when the LLM is silent or unusable. */
export function heuristicSections(units: OutlineUnit[]): SmartSection[] {
  const sections: SmartSection[] = [];
  const seen = new Set<string>();
  for (const unit of units) {
    if (unit.kind === "prose") continue;
    if (unit.kind === "marker" && !looksLikeSectionTitle(unit.title)) continue;
    if (seen.has(unit.startBlockId)) continue;
    seen.add(unit.startBlockId);
    sections.push({ startBlockId: unit.startBlockId, title: unit.title });
  }
  return sections;
}

function isThinOutlineUnit(unit: OutlineUnit): boolean {
  return unit.seconds < TOC_UNIT_MAX_SECONDS;
}

function isChapterLikeUnit(unit: OutlineUnit): boolean {
  if (looksLikeTocHeading(unit.title)) return true;
  if (unit.kind === "prose") return false;
  return looksLikeSectionTitle(unit.title);
}

/**
 * Outline ids that are a contents listing rather than the book itself.
 *
 * A table of contents is a tight run of chapter-like titles with no body
 * between them, often under a "Contents" heading, and those titles reappear
 * later with a real chapter attached. Title-page lines before that heading
 * stay: they are what the first video should announce.
 */
export function findSkipBlockIds(units: OutlineUnit[]): string[] {
  const skip = new Set<string>();

  for (const unit of units) {
    if (looksLikeTocHeading(unit.title)) skip.add(unit.startBlockId);
  }

  let index = 0;
  while (index < units.length) {
    if (!isThinOutlineUnit(units[index]!)) {
      index += 1;
      continue;
    }

    const cluster: OutlineUnit[] = [];
    let cursor = index;
    while (cursor < units.length && isThinOutlineUnit(units[cursor]!)) {
      cluster.push(units[cursor]!);
      cursor += 1;
    }

    const tocHeadingAt = cluster.findIndex((unit) => looksLikeTocHeading(unit.title));
    const chapterLike = cluster.filter((unit) => isChapterLikeUnit(unit));
    const isToc = tocHeadingAt >= 0 || chapterLike.length >= TOC_MIN_MARKERS;

    if (isToc) {
      const lastKeep = chapterLike.at(-1);
      const later = units.slice(cursor);

      for (const [offset, unit] of cluster.entries()) {
        if (looksLikeTocHeading(unit.title)) {
          skip.add(unit.startBlockId);
          continue;
        }

        const afterContents = tocHeadingAt >= 0 && offset > tocHeadingAt;
        const appearsLater = later.some(
          (candidate) => normalizeTitleKey(candidate.title) === normalizeTitleKey(unit.title),
        );
        const laterInCluster = cluster.some(
          (other, otherOffset) =>
            otherOffset > offset &&
            normalizeTitleKey(other.title) === normalizeTitleKey(unit.title),
        );

        // The last chapter-like title before body is the real start, even when
        // the same line already appeared in the contents list.
        if (unit === lastKeep) continue;

        if (afterContents || appearsLater || laterInCluster) {
          skip.add(unit.startBlockId);
        }
      }
    }

    index = cursor === index ? index + 1 : cursor;
  }

  return [...skip];
}

const APPARATUS_KINDS = new Set<Block["kind"]>([
  "toc_entry",
  "page_number",
  "running_head",
  "front_matter",
  "back_matter",
]);

/** True when honouring a skip id would not delete a paragraph of body text. */
export function isUnrelatedBlock(block: Block): boolean {
  if (APPARATUS_KINDS.has(block.kind)) return true;
  const text = block.text.replace(/\s+/g, " ").trim();
  if (!text) return true;
  if (looksLikeTocHeading(text)) return true;
  if (looksLikeSectionTitle(text)) return true;
  return text.length <= 80 && estimateSpokenSeconds(text, 150) < TOC_UNIT_MAX_SECONDS;
}

/**
 * Removes contents listings and other unread ids from the blocks that will be
 * planned. Real prose is kept even if the model marked it skip.
 */
export function excludeSkippedBlocks(kept: Block[], skipBlockIds: Iterable<string>): Block[] {
  const skip = new Set(skipBlockIds);
  if (skip.size === 0) return kept;
  const filtered = kept.filter((block) => !skip.has(block.id) || !isUnrelatedBlock(block));
  return filtered.length > 0 ? filtered : kept;
}

/**
 * Filename stems are useful on disk and useless when spoken: "tale-of-two-cities"
 * is not the title of the book.
 */
export function speakableBookTitle(title: string): string {
  const trimmed = title.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  if (/[\\/]/.test(trimmed)) return "";
  if (/\.(epub|pdf|txt|md)$/i.test(trimmed)) return "";
  if (/_/.test(trimmed) && !/\s/.test(trimmed)) return "";
  return trimmed;
}

export function speakablePersonName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/** Chapter name from a stored segment title that may already include book and author. */
export function sectionNameFromTitle(title: string, structure: BookStructure): string {
  let rest = title.replace(/\s+/g, " ").trim();
  for (const part of [speakableBookTitle(structure.title), speakablePersonName(structure.author)]) {
    if (!part) continue;
    if (rest === part) {
      rest = "";
      break;
    }
    const dashed = `${part}${TITLE_SEPARATOR}`;
    const hyphen = `${part} - `;
    if (rest.startsWith(dashed)) rest = rest.slice(dashed.length).trim();
    else if (rest.startsWith(hyphen)) rest = rest.slice(hyphen.length).trim();
  }
  return rest || title.replace(/\s+/g, " ").trim();
}

/**
 * First video: Book — Author — Chapter. Later videos: the chapter name only.
 */
export function formatOpeningTitle(structure: BookStructure, sectionTitle: string): string {
  const section = sectionTitle.replace(/\s+/g, " ").trim();
  const parts: string[] = [];
  const book = speakableBookTitle(structure.title);
  const author = speakablePersonName(structure.author);
  if (book && normalizeTitleKey(book) !== normalizeTitleKey(section)) parts.push(book);
  if (author && normalizeTitleKey(author) !== normalizeTitleKey(section)) parts.push(author);
  if (section) parts.push(section);
  const joined = parts.join(TITLE_SEPARATOR) || section || book || "Segment";
  return joined.slice(0, MAX_SEGMENT_TITLE_LENGTH);
}

function normalizeAnnouncement(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Spoken lines that open a video, omitting any line already present at the
 * start of the segment so a heading block is not read twice.
 */
export function announcementLines(
  structure: BookStructure,
  segment: { index: number; title: string },
  existingBlocks: readonly Block[] = [],
): string[] {
  const section = sectionNameFromTitle(segment.title, structure);
  const lines =
    segment.index === 0
      ? [speakableBookTitle(structure.title), speakablePersonName(structure.author), section]
      : [section];

  const existing = existingBlocks
    .slice(0, 6)
    .map((block) => normalizeAnnouncement(block.text))
    .filter(Boolean);

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const line of lines) {
    const trimmed = line.replace(/\s+/g, " ").trim();
    if (!trimmed) continue;
    const key = normalizeAnnouncement(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    if (existing.some((text) => text === key || text.startsWith(key))) continue;
    unique.push(trimmed);
  }
  return unique;
}

function asProposal(result: SmartSection[] | SectionProposal): SectionProposal {
  if (Array.isArray(result)) return { sections: result, skipBlockIds: [] };
  return { sections: result.sections, skipBlockIds: result.skipBlockIds ?? [] };
}

function isProtectedSectionStart(units: OutlineUnit[], id: string): boolean {
  const unit = units.find((entry) => entry.startBlockId === id);
  if (!unit || unit.kind === "prose") return false;
  return looksLikeSectionTitle(unit.title) || Boolean(numberedChapterLabel(unit.title));
}

/**
 * LLM skip lists are often wrong about numbered headings (they look like page
 * numbers). Contents listings still come from the heuristic skip set.
 */
function honoredSkipIds(units: OutlineUnit[], heuristicSkip: string[], proposedSkip: string[]): string[] {
  const skip = new Set(heuristicSkip);
  for (const id of proposedSkip) {
    if (skip.has(id)) continue;
    if (isProtectedSectionStart(units, id)) continue;
    skip.add(id);
  }
  return [...skip];
}

function mergeSectionStarts(heuristic: SmartSection[], proposed: SmartSection[]): SmartSection[] {
  const byId = new Map<string, SmartSection>();
  for (const section of heuristic) {
    byId.set(section.startBlockId, {
      startBlockId: section.startBlockId,
      title: formatSectionTitle(section.title),
    });
  }
  for (const section of proposed) {
    const id = section.startBlockId.trim();
    if (!id) continue;
    const title = formatSectionTitle(section.title);
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { startBlockId: id, title });
      continue;
    }
    byId.set(id, {
      startBlockId: id,
      title: preferSectionTitle(existing.title, title),
    });
  }
  return [...byId.values()];
}

function preferSectionTitle(heuristic: string, proposed: string): string {
  if (!proposed) return heuristic;
  if (!heuristic) return proposed;
  const heuristicNumber = numberedChapterLabel(heuristic);
  const proposedNumber = numberedChapterLabel(proposed);
  if (heuristicNumber && !proposedNumber) return formatSectionTitle(heuristic, proposed);
  if (proposed.length >= heuristic.length) return proposed;
  return heuristic;
}

function blockIndexById(kept: Block[]): Map<string, number> {
  const index = new Map<string, number>();
  kept.forEach((block, i) => index.set(block.id, i));
  return index;
}

/**
 * Drops unknown ids, restores reading order, and guarantees the first kept
 * block starts a section so no narration is stranded before the first cut.
 */
export function normalizeSections(
  kept: Block[],
  proposed: SmartSection[],
): SmartSection[] {
  if (kept.length === 0) return [];

  const indexOf = blockIndexById(kept);
  const byId = new Map<string, SmartSection>();
  for (const section of proposed) {
    const id = section.startBlockId.trim();
    if (!indexOf.has(id)) continue;
    if (byId.has(id)) continue;
    const title = section.title.replace(/\s+/g, " ").trim().slice(0, MAX_SEGMENT_TITLE_LENGTH);
    byId.set(id, { startBlockId: id, title });
  }

  const firstId = kept[0]!.id;
  if (!byId.has(firstId)) {
    byId.set(firstId, { startBlockId: firstId, title: "" });
  }

  return [...byId.values()].sort(
    (a, b) => (indexOf.get(a.startBlockId) ?? 0) - (indexOf.get(b.startBlockId) ?? 0),
  );
}

function chunkUnits(units: OutlineUnit[]): OutlineUnit[][] {
  if (units.length <= OUTLINE_CHUNK_SIZE) return [units];

  const chunks: OutlineUnit[][] = [];
  let start = 0;
  while (start < units.length) {
    const end = Math.min(start + OUTLINE_CHUNK_SIZE, units.length);
    chunks.push(units.slice(start, end));
    if (end >= units.length) break;
    start = Math.max(end - OUTLINE_CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}

async function defaultProposer(input: {
  structure: BookStructure;
  options: SegmentOptions;
  units: OutlineUnit[];
  totalSeconds: number;
  chunkIndex: number;
  chunkCount: number;
}): Promise<SectionProposal> {
  const proposed = await generateSegmentBoundaries({
    bookTitle: input.structure.title,
    author: input.structure.author,
    language: input.structure.language,
    targetSeconds: input.options.targetDurationSeconds,
    maxSeconds: input.options.maxDurationSeconds,
    totalSeconds: input.totalSeconds,
    units: input.units,
    chunkIndex: input.chunkIndex,
    chunkCount: input.chunkCount,
  });
  return {
    sections: proposed.sections.map((section) => ({
      startBlockId: section.startBlockId,
      title: section.title,
    })),
    skipBlockIds: proposed.skipBlockIds,
  };
}

/**
 * Resolves section starts for smart mode.
 *
 * The LLM is asked first and merged with heading/marker starts so a model that
 * only marks "Chapter 2" and "Chapter 8" cannot swallow 3–7 as "2 (part 12)".
 * If it returns nothing usable (offline model, empty JSON, ids that do not
 * exist) the heading/marker heuristic is used alone. Contents listings are
 * skipped in either path so they cannot become videos.
 */
export async function detectSmartSections(
  structure: BookStructure,
  kept: Block[],
  options: SegmentOptions,
  propose: SectionProposer = defaultProposer,
): Promise<SmartDetection> {
  const ordered = [...kept].sort((a, b) => a.order - b.order);
  const units = buildOutline(structure, ordered, options.wordsPerMinute);
  const heuristicSkip = findSkipBlockIds(units);
  const fallbackSections = heuristicSections(units).filter(
    (section) => !heuristicSkip.includes(section.startBlockId),
  );
  const fallback = normalizeSections(ordered, fallbackSections);

  try {
    const chunks = chunkUnits(units);
    const proposed: SmartSection[] = [];
    const proposedSkip: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const part = asProposal(
        await propose({
          structure,
          options,
          units: chunk,
          totalSeconds: chunk.reduce((sum, unit) => sum + unit.seconds, 0),
          chunkIndex: index + 1,
          chunkCount: chunks.length,
        }),
      );
      proposed.push(...part.sections);
      proposedSkip.push(...(part.skipBlockIds ?? []));
    }

    const skip = honoredSkipIds(units, heuristicSkip, proposedSkip);
    const skipSet = new Set(skip);
    const merged = mergeSectionStarts(fallbackSections, proposed).filter(
      (section) => !skipSet.has(section.startBlockId),
    );
    const normalized = normalizeSections(ordered, merged);
    if (normalized.length > 0) {
      logger.info(
        `smart segments: using ${normalized.length} section starts (${proposed.length} from LLM, ${fallbackSections.length} heuristic), skipping ${skip.length} unread ids`,
      );
      return { sections: normalized, skipBlockIds: skip };
    }
    logger.warning(
      `smart segments: LLM returned ${proposed.length} starts (${normalized.length} usable); falling back to ${fallback.length} heuristic starts`,
    );
    return { sections: fallback, skipBlockIds: heuristicSkip };
  } catch (error) {
    logger.warning(`smart segments: LLM detection failed, using heuristic starts: ${errorMessage(error)}`);
  }

  return { sections: fallback, skipBlockIds: heuristicSkip };
}

interface SectionRun {
  blocks: Block[];
  title: string;
  seconds: number;
  /** True when the title came from a named start or a heading, not a chapter fallback. */
  explicit: boolean;
}

function titleForRun(
  blocks: Block[],
  structure: BookStructure,
  named: Map<string, string>,
): { title: string; explicit: boolean } {
  const first = blocks[0];
  if (!first) return { title: "Segment", explicit: false };

  const namedTitle = (named.get(first.id) ?? "").trim();
  const firstHeading = first.kind === "heading" ? first.text.trim() : "";
  const primary = namedTitle || firstHeading;
  const nextHeading =
    blocks[1]?.kind === "heading" && blocks[1].text.trim() && !numberedChapterLabel(blocks[1].text)
      ? blocks[1].text.trim()
      : undefined;

  if (primary) {
    return { title: formatSectionTitle(primary, nextHeading), explicit: true };
  }

  const heading = blocks.find((block) => block.kind === "heading" && block.text.trim());
  if (heading) {
    return { title: formatSectionTitle(heading.text.trim()), explicit: true };
  }
  return {
    title: formatSectionTitle(
      chapterTitleOf(structure, first.chapterId) || structure.title.trim() || "Segment",
    ),
    explicit: false,
  };
}

function durationSplitTitle(
  runTitle: string,
  labeled: { title: string; explicit: boolean },
  partIndex: number,
): string {
  if (partIndex === 0) return runTitle;
  if (labeled.explicit) {
    const runKey = normalizeTitleKey(runTitle);
    const partKey = normalizeTitleKey(labeled.title);
    if (partKey && partKey !== runKey && !partKey.startsWith(`${runKey} `) && !runKey.startsWith(`${partKey} `)) {
      return labeled.title;
    }
  }
  return `${runTitle} (part ${partIndex + 1})`;
}

function splitIntoRuns(
  kept: Block[],
  structure: BookStructure,
  sections: SmartSection[],
  wordsPerMinute: number,
): SectionRun[] {
  const starts = new Set(sections.map((section) => section.startBlockId));
  const named = new Map(sections.map((section) => [section.startBlockId, section.title]));

  const groups: Block[][] = [];
  let open: Block[] = [];
  for (const block of kept) {
    if (open.length > 0 && starts.has(block.id)) {
      groups.push(open);
      open = [];
    }
    open.push(block);
  }
  if (open.length > 0) groups.push(open);

  const runs: SectionRun[] = [];
  let carry: Block[] = [];

  const pushRun = (blocks: Block[]): void => {
    const namedTitle = titleForRun(blocks, structure, named);
    runs.push({
      blocks,
      title: namedTitle.title,
      seconds: blocks.reduce((sum, block) => sum + estimateSpokenSeconds(block.text, wordsPerMinute), 0),
      explicit: namedTitle.explicit,
    });
  };

  for (const group of groups) {
    const blocks = carry.length > 0 ? [...carry, ...group] : group;
    carry = [];
    let end = blocks.length;
    while (end > 0 && blocks[end - 1]!.kind === "heading") end -= 1;
    if (end === 0) {
      carry = blocks;
      continue;
    }
    pushRun(blocks.slice(0, end));
    carry = blocks.slice(end);
  }

  if (carry.length > 0) pushRun(carry);

  return runs;
}

function toPlan(
  blocks: Block[],
  structure: BookStructure,
  title: string,
  index: number,
  wordsPerMinute: number,
): SegmentPlan {
  const chapterIds: string[] = [];
  for (const block of blocks) {
    if (!chapterIds.includes(block.chapterId)) chapterIds.push(block.chapterId);
  }
  const displayTitle = index === 0 ? formatOpeningTitle(structure, title) : title.replace(/\s+/g, " ").trim();
  return {
    index,
    title: displayTitle.slice(0, MAX_SEGMENT_TITLE_LENGTH) || "Segment",
    blockIds: blocks.map((block) => block.id),
    estimatedDuration: Math.round(
      blocks.reduce((sum, block) => sum + estimateSpokenSeconds(block.text, wordsPerMinute), 0),
    ),
    wordCount: blocks.reduce((sum, block) => sum + countWords(block.text), 0),
    chapterIds,
  };
}

function preferredRun(open: SectionRun[], structure: BookStructure): SectionRun {
  const book = normalizeTitleKey(speakableBookTitle(structure.title));
  const author = normalizeTitleKey(speakablePersonName(structure.author));
  const looksNamed = (title: string): boolean =>
    Boolean(looksLikeSectionTitle(title) || numberedChapterLabel(title));
  const chapter = open.find((run) => {
    if (!run.explicit) return false;
    const key = normalizeTitleKey(run.title);
    if (!key) return false;
    if (book && key === book) return false;
    if (author && key === author) return false;
    if (!looksNamed(run.title)) return false;
    return true;
  });
  return chapter ?? open.find((run) => run.explicit) ?? open[0]!;
}

/**
 * Packs named sections toward the target length.
 *
 * Consecutive short sections share a video until the target is reached; a
 * section that itself exceeds the maximum is duration-split so the block
 * invariant still holds. Titles come from the section starts, not "(part N)",
 * unless a single section had to be split.
 */
export function planSmartSegments(
  structure: BookStructure,
  kept: Block[],
  options: SegmentOptions,
  sections: SmartSection[],
  skipBlockIds: Iterable<string> = [],
): SegmentPlan[] {
  const ordered = excludeSkippedBlocks(
    [...kept].sort((a, b) => a.order - b.order),
    skipBlockIds,
  );
  if (ordered.length === 0) return [];

  const runs = splitIntoRuns(
    ordered,
    structure,
    normalizeSections(ordered, sections),
    options.wordsPerMinute,
  );
  if (runs.length === 0) return [];

  const segments: SegmentPlan[] = [];
  let open: SectionRun[] = [];
  let openSeconds = 0;

  const closeOpen = (): void => {
    if (open.length === 0) return;
    const blocks = open.flatMap((run) => run.blocks);
    const titled = preferredRun(open, structure);
    segments.push(toPlan(blocks, structure, titled.title, segments.length, options.wordsPerMinute));
    open = [];
    openSeconds = 0;
  };

  const named = new Map(normalizeSections(ordered, sections).map((section) => [section.startBlockId, section.title]));

  const emitDurationSplit = (run: SectionRun): void => {
    const inner = planSegments(structure, run.blocks, { ...options, mode: "duration" });
    if (inner.length <= 1) {
      segments.push(toPlan(run.blocks, structure, run.title, segments.length, options.wordsPerMinute));
      return;
    }
    inner.forEach((part, partIndex) => {
      const blocks = part.blockIds
        .map((id) => run.blocks.find((block) => block.id === id))
        .filter((block): block is Block => Boolean(block));
      const labeled = titleForRun(blocks, structure, named);
      const title = durationSplitTitle(run.title, labeled, partIndex);
      segments.push(toPlan(blocks, structure, title, segments.length, options.wordsPerMinute));
    });
  };

  for (const run of runs) {
    if (run.seconds > options.maxDurationSeconds && open.length === 0) {
      emitDurationSplit(run);
      continue;
    }

    if (open.length > 0) {
      const combined = openSeconds + run.seconds;
      if (combined > options.maxDurationSeconds || openSeconds >= options.targetDurationSeconds) {
        closeOpen();
        if (run.seconds > options.maxDurationSeconds) {
          emitDurationSplit(run);
          continue;
        }
      }
    }

    open.push(run);
    openSeconds += run.seconds;
  }

  closeOpen();
  return segments;
}

/** Plans segments, using AI/heuristic section detection when mode is `smart`. */
export async function planBookSegments(
  structure: BookStructure,
  kept: Block[],
  options: SegmentOptions,
  propose?: SectionProposer,
): Promise<SegmentPlan[]> {
  if (options.mode !== "smart") return planSegments(structure, kept, options);
  const detection = await detectSmartSections(structure, kept, options, propose);
  return planSmartSegments(structure, kept, options, detection.sections, detection.skipBlockIds);
}
