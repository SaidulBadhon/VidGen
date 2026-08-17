/**
 * Request schemas for the long-form book API.
 *
 * Field names are snake_case to match the rest of v1, and the render request
 * deliberately mirrors the subtitle and font fields of `videoParamsSchema`
 * rather than inventing a second vocabulary — the ASS writer consumes a
 * `VideoParams`, so the two have to agree anyway.
 */

import { z } from "zod";
import { videoParamsSchema, type VideoParams } from "./schema.ts";
import {
  COVER_TITLE_POSITIONS,
  DEFAULT_COVER_TITLE_POSITION,
  DEFAULT_SEGMENT_OPTIONS,
  type SegmentOptions,
} from "../services/book/types.ts";
import type { BookRenderParamsDocument, BookSegmentOptionsDocument } from "../db/types.ts";

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

/**
 * Bounds on segment length.
 *
 * The floor stops a book being planned into thousands of one-sentence videos,
 * and the ceiling keeps a single segment inside what one long-form synthesis
 * and one still encode can complete in a reasonable time.
 */
const MIN_SEGMENT_SECONDS = 30;
const MAX_SEGMENT_SECONDS = 4 * 60 * 60;

export const bookSegmentOptionsSchema = z
  .object({
    mode: z.enum(["chapter", "duration", "smart"]).default(DEFAULT_SEGMENT_OPTIONS.mode),
    target_duration_seconds: z
      .number()
      .int()
      .min(MIN_SEGMENT_SECONDS)
      .max(MAX_SEGMENT_SECONDS)
      .default(DEFAULT_SEGMENT_OPTIONS.targetDurationSeconds),
    max_duration_seconds: z
      .number()
      .int()
      .min(MIN_SEGMENT_SECONDS)
      .max(MAX_SEGMENT_SECONDS)
      .default(DEFAULT_SEGMENT_OPTIONS.maxDurationSeconds),
    words_per_minute: z.number().int().min(60).max(400).default(DEFAULT_SEGMENT_OPTIONS.wordsPerMinute),
  })
  // A maximum below the target would close every segment on the first block
  // that crossed it, which is not what "target 15 minutes" can ever mean.
  .refine((options) => options.max_duration_seconds >= options.target_duration_seconds, {
    message: "max_duration_seconds must be greater than or equal to target_duration_seconds",
    path: ["max_duration_seconds"],
  });

export type BookSegmentOptionsRequest = z.infer<typeof bookSegmentOptionsSchema>;

/** Multipart upload fields arrive as strings, so numbers are coerced. */
export const bookUploadOptionsSchema = z
  .object({
    mode: z.enum(["chapter", "duration", "smart"]).optional(),
    target_duration_seconds: z.coerce.number().int().optional(),
    max_duration_seconds: z.coerce.number().int().optional(),
    words_per_minute: z.coerce.number().int().optional(),
  })
  .partial();

export function segmentOptionsToDocument(
  options: BookSegmentOptionsRequest,
): BookSegmentOptionsDocument {
  return {
    mode: options.mode,
    target_duration_seconds: options.target_duration_seconds,
    max_duration_seconds: options.max_duration_seconds,
    words_per_minute: options.words_per_minute,
  };
}

/** Snake_case storage shape back to the camelCase the segmenter takes. */
export function segmentOptionsFromDocument(document: BookSegmentOptionsDocument): SegmentOptions {
  return {
    mode: document.mode,
    targetDurationSeconds: document.target_duration_seconds,
    maxDurationSeconds: document.max_duration_seconds,
    wordsPerMinute: document.words_per_minute,
  };
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/**
 * A reviewer's verdict on one block.
 *
 * Only `keep` is accepted: reason, rule and confidence describe *why the
 * server* decided something, and letting a client write them would put
 * unverifiable text in front of the next reviewer.
 */
export const bookDecisionOverrideSchema = z.object({
  keep: z.boolean(),
});
export type BookDecisionOverrideRequest = z.infer<typeof bookDecisionOverrideSchema>;

/**
 * A reviewer's rewrite of one block's narration.
 *
 * The ceiling is generous rather than tight: a block is a paragraph in most
 * books but a whole scanned page in a PDF the OCR pass ran over, and refusing
 * an edit that is merely long would block the exact case rewriting exists for.
 * Empty is allowed and means "narrate nothing here" without dropping the block,
 * which is what a reviewer wants for a stray page number they still want to see
 * in the review list.
 */
export const bookBlockTextSchema = z.object({
  text: z.string().max(200_000),
});
export type BookBlockTextRequest = z.infer<typeof bookBlockTextSchema>;

export const bookPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(500).default(50),
});
export type BookPagination = z.infer<typeof bookPaginationSchema>;

/**
 * A display title a reviewer can write.
 *
 * Trimmed and bounded so a pasted filename cannot become a 4 KB heading. Shared
 * by the book and by each segment: both names become folder names on disk.
 */
export const bookTitleField = z.string().trim().min(1).max(300);

export const bookPatchSchema = z.object({
  title: bookTitleField,
});
export type BookPatchRequest = z.infer<typeof bookPatchSchema>;

export const bookSegmentPatchSchema = z.object({
  title: bookTitleField,
});
export type BookSegmentPatchRequest = z.infer<typeof bookSegmentPatchSchema>;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * How captions reach the finished segment.
 *
 * `burn` still degrades to a soft track when the ffmpeg in use has no libass —
 * see `supportsAssBurn()` — so this is a preference rather than a guarantee.
 */
export const SUBTITLE_RENDER_MODES = ["burn", "soft", "none"] as const;

/**
 * Where a book's background music comes from.
 *
 * The short-video form also offers Sonilo and ElevenLabs, and they are left out
 * here on purpose: both score an *existing video file* they have to be sent,
 * and both cap it well below a chapter — 360s and 600s against a default
 * fifteen-minute segment. Offering them would mean encoding every segment
 * twice and still failing on most of them.
 */
export const BOOK_BGM_TYPES = ["", "random", "custom"] as const;

export const bookRenderRequestSchema = z.object({
  voice_name: z.string().min(1),
  voice_rate: z.number().min(0.5).max(2).default(1),
  voice_volume: z.number().min(0).max(5).default(1),

  subtitle_render_mode: z.enum(SUBTITLE_RENDER_MODES).default("soft"),
  video_aspect: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),

  // Unlike the short-video form this defaults to none rather than "random":
  // music under hours of narration is a choice, and a book re-rendered after
  // this shipped must not quietly gain a soundtrack it never had.
  bgm_type: z.enum(BOOK_BGM_TYPES).default(""),
  bgm_file: z.string().default(""),
  bgm_volume: z.number().min(0).max(1).default(0.2),

  // Reused verbatim from videoParamsSchema so the ASS writer sees exactly the
  // styling vocabulary it already understands.
  font_name: videoParamsSchema.shape.font_name,
  font_size: videoParamsSchema.shape.font_size,
  text_fore_color: videoParamsSchema.shape.text_fore_color,
  stroke_color: videoParamsSchema.shape.stroke_color,
  stroke_width: videoParamsSchema.shape.stroke_width,
  text_background_color: videoParamsSchema.shape.text_background_color,
  rounded_subtitle_background: videoParamsSchema.shape.rounded_subtitle_background,
  subtitle_position: videoParamsSchema.shape.subtitle_position,
  custom_position: videoParamsSchema.shape.custom_position,

  n_threads: z.number().int().min(1).max(64).default(2),

  // Off by default so a book re-rendered after this shipped keeps the cover
  // it already used, instead of quietly gaining titles it never asked for.
  burn_book_title: z.boolean().default(false),
  burn_chapter_title: z.boolean().default(false),
  cover_book_title_position: z.enum(COVER_TITLE_POSITIONS).default(DEFAULT_COVER_TITLE_POSITION),
  cover_chapter_title_position: z.enum(COVER_TITLE_POSITIONS).default(DEFAULT_COVER_TITLE_POSITION),

  /** Restricts the fan-out to specific segments; empty renders the whole book. */
  segment_indexes: z.array(z.number().int().min(0)).nullish(),
});
export type BookRenderRequest = z.infer<typeof bookRenderRequestSchema>;

export function renderParamsToDocument(request: BookRenderRequest): BookRenderParamsDocument {
  return {
    voice_name: request.voice_name,
    voice_rate: request.voice_rate,
    voice_volume: request.voice_volume,
    subtitle_render_mode: request.subtitle_render_mode,
    video_aspect: request.video_aspect,
    bgm_type: request.bgm_type,
    bgm_file: request.bgm_file,
    bgm_volume: request.bgm_volume,
    burn_book_title: request.burn_book_title,
    burn_chapter_title: request.burn_chapter_title,
    cover_book_title_position: request.cover_book_title_position,
    cover_chapter_title_position: request.cover_chapter_title_position,
    font_name: request.font_name,
    font_size: request.font_size,
    text_fore_color: request.text_fore_color,
    stroke_color: request.stroke_color,
    stroke_width: request.stroke_width,
    text_background_color: request.text_background_color,
    rounded_subtitle_background: request.rounded_subtitle_background,
    subtitle_position: request.subtitle_position,
    custom_position: request.custom_position,
    n_threads: request.n_threads,
  };
}

/**
 * Adapts stored render params to the `VideoParams` the ASS writer consumes.
 *
 * `assRenderOptionsFromParams` reads only aspect, font and subtitle styling;
 * everything else is filled from the schema's own defaults rather than being
 * duplicated here, so a new field in `videoParamsSchema` cannot silently arrive
 * unset.
 */
export function videoParamsForBookRender(params: BookRenderParamsDocument): VideoParams {
  return videoParamsSchema.parse({
    video_subject: "",
    video_aspect: params.video_aspect,
    voice_name: params.voice_name,
    voice_rate: params.voice_rate,
    voice_volume: params.voice_volume,
    font_name: params.font_name,
    font_size: params.font_size,
    text_fore_color: params.text_fore_color,
    stroke_color: params.stroke_color,
    stroke_width: params.stroke_width,
    text_background_color: params.text_background_color,
    rounded_subtitle_background: params.rounded_subtitle_background,
    subtitle_position: params.subtitle_position,
    custom_position: params.custom_position,
    n_threads: params.n_threads,
  });
}
