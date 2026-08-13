/**
 * Book domain types.
 *
 * The whole long-form pipeline is built on one invariant: a `Block` is atomic.
 * Extraction produces blocks, filtering keeps or drops whole blocks, and
 * segmentation groups whole blocks. Nothing downstream ever splits one, which is
 * how "never cut mid-sentence or mid-paragraph" is guaranteed structurally
 * rather than by a heuristic that can be wrong at a boundary.
 */

/**
 * What a block is, as far as narration is concerned.
 *
 * The distinction that matters is narratable prose versus apparatus — page
 * furniture, references and navigation that a listener should never hear.
 */
export type BlockKind =
  | "heading"
  | "paragraph"
  | "list_item"
  | "quote"
  | "code"
  | "caption"
  | "footnote"
  | "page_number"
  | "running_head"
  | "toc_entry"
  | "front_matter"
  | "back_matter"
  | "unknown";

export interface Block {
  /** Stable across re-extraction of the same file: `${chapterIndex}:${blockIndex}`. */
  id: string;
  kind: BlockKind;
  text: string;
  /** Heading depth 1-6. Absent for every other kind. */
  level?: number;
  chapterId: string;
  /** Position in global reading order, used to restore sequence after filtering. */
  order: number;
  /** PDF page this block came from. Unused by EPUB and plain text. */
  page?: number;
}

/**
 * Semantic role declared by the source file rather than inferred.
 *
 * EPUB's `guide`/`landmarks` names front and back matter outright, which is far
 * more reliable than any text heuristic, so it is preserved verbatim and given
 * precedence by the filter.
 */
export type ChapterLandmark =
  | "cover"
  | "toc"
  | "titlepage"
  | "copyright"
  /**
   * EPUB 3's broad "everything before the body" container. Unlike `titlepage`
   * and `copyright` it is not a promise that the section is unreadable — a
   * preface or foreword often lives under it — so the filter treats it as a
   * weaker signal than the specific labels.
   */
  | "frontmatter"
  | "bodymatter"
  | "backmatter"
  | "index"
  | "bibliography"
  | "glossary"
  | "acknowledgements";

export interface Chapter {
  /** `ch-${index}`, matching the `chapterIndex` embedded in its block ids. */
  id: string;
  title: string;
  level: number;
  order: number;
  blockIds: string[];
  landmark?: ChapterLandmark;
}

export interface BookStructure {
  title: string;
  author: string;
  /** BCP-47 where the source provides it, otherwise "". */
  language: string;
  chapters: Chapter[];
  /** Every block in reading order. Chapters index into this by id. */
  blocks: Block[];
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Who decided a block's fate.
 *
 * `user` always wins on merge: an explicit override in the review UI must never
 * be recomputed away by a later structural pass.
 */
export type DecisionSource = "structural" | "llm" | "user";

export interface FilterDecision {
  blockId: string;
  keep: boolean;
  /** Human-readable, shown verbatim in the review UI. */
  reason: string;
  /** Machine id for grouping and bulk override, e.g. `repeated_running_head`. */
  rule: string;
  /** 0..1. Low confidence must resolve to keep, never to a silent drop. */
  confidence: number;
  source: DecisionSource;
}

/** Rule id used when nothing matched. Kept explicit so the log is never empty. */
export const DEFAULT_KEEP_RULE = "default_keep";

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

export interface SegmentPlan {
  index: number;
  title: string;
  blockIds: string[];
  /** Seconds, estimated from word count before any TTS has run. */
  estimatedDuration: number;
  wordCount: number;
  /** Chapters this segment draws from, in order. Usually one. */
  chapterIds: string[];
}

export interface SegmentOptions {
  /** `chapter` gives one video per chapter; `duration` targets a fixed length. */
  mode: "chapter" | "duration";
  targetDurationSeconds: number;
  /** Hard ceiling. A segment closes rather than exceed this. */
  maxDurationSeconds: number;
  wordsPerMinute: number;
}

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = {
  mode: "duration",
  targetDurationSeconds: 900,
  maxDurationSeconds: 1500,
  // Audiobook narration sits around 150 wpm; Audible's own guidance is 150-160.
  wordsPerMinute: 150,
};

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export type BookSourceFormat = "epub" | "text";

export interface ExtractionResult {
  structure: BookStructure;
  /** Non-fatal problems worth showing the user, e.g. a chapter that parsed empty. */
  warnings: string[];
}

export class BookExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookExtractionError";
  }
}
