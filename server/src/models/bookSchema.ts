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
import type {
  BookRenderParamsDocument,
  BookSegmentOptionsDocument,
  BookShortsRenderParamsDocument,
} from "../db/types.ts";
import {
  DEFAULT_MAX_SHORTS,
  DEFAULT_SHORT_DURATION_SECONDS,
  DEFAULT_SHORT_OPTIONS,
  MAX_MAX_SHORTS,
  MAX_SHORT_DURATION_SECONDS,
  MAX_SHORT_SCRIPT_LENGTH,
  MIN_MAX_SHORTS,
  MIN_SHORT_DURATION_SECONDS,
  type ShortOptions,
} from "../services/book/shorts.ts";
import {
  YOUTUBE_SHORT_DESCRIPTION_MAX,
  YOUTUBE_SHORT_TAG_COUNT,
  YOUTUBE_SHORT_TAG_MAX,
  YOUTUBE_SHORT_TITLE_MAX,
  normalizeYoutubeTags,
} from "../services/llm/prompts.ts";

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

/**
 * Display name of the author. Empty is allowed so a reviewer can stop the first
 * video announcing a bibliographic leftover such as "Moyes, Jojo".
 */
export const bookAuthorField = z.string().trim().max(300);

export const bookPatchSchema = z
  .object({
    title: bookTitleField.optional(),
    author: bookAuthorField.optional(),
  })
  .refine((body) => body.title !== undefined || body.author !== undefined, {
    message: "title or author is required",
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

/**
 * Which parts of a template reach the finished segment.
 *
 * `card` is the opening title composition overlaid on the first seconds;
 * `bed` replaces the static still with a moving background for the whole
 * body. They are listed separately rather than folded into `template_id`
 * because they cost different things — a card is one short render, a bed
 * re-encodes every segment — so choosing a template and applying it to the
 * body have to stay two decisions.
 */
export const BOOK_TEMPLATE_PARTS = ["card", "bed"] as const;

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

  // All three template fields default to their no-op value for the same reason
  // `burn_book_title` defaults to false: a book rendered before templates
  // shipped and re-rendered after must be handed an identical ffmpeg argument
  // list. Empty here is not "unset, pick something sensible" — it is the
  // documented way to ask for exactly today's static still.
  template_id: z.string().default(""),
  // Empty applies none of the template, so a template can be chosen and stored
  // without a single segment encoding differently until a part is ticked.
  template_parts: z.array(z.enum(BOOK_TEMPLATE_PARTS)).default([]),
  // Empty defers to the accent the template ships with, rather than having this
  // form invent a colour; there is no neutral hex that means "no opinion".
  template_accent: z.string().default(""),

  // Off by default for the same reason `burn_book_title` is: a book rendered
  // before footage shipped and re-rendered after must be handed an identical
  // ffmpeg argument list. Narration that quietly grew moving pictures under it
  // is a different video from the one the reviewer approved.
  footage_enabled: z.boolean().default(false),
  // The provider list is the short-video product's own, taken from its schema
  // rather than restated, so a fifth provider added there cannot go missing
  // here. The default is stripped because unset must not mean "pexels": it
  // defers to the app-level `video_source` setting, so an operator who switches
  // provider — a lapsed API key, a quota — does not have to re-save every book.
  footage_source: videoParamsSchema.shape.video_source.removeDefault().nullish(),

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
    template_id: request.template_id,
    template_parts: request.template_parts,
    template_accent: request.template_accent,
    footage_enabled: request.footage_enabled,
    footage_source: request.footage_source,
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

// ---------------------------------------------------------------------------
// Hook shorts
// ---------------------------------------------------------------------------

export const bookShortsPlanRequestSchema = z.object({
  target_duration_seconds: z
    .number()
    .int()
    .min(MIN_SHORT_DURATION_SECONDS)
    .max(MAX_SHORT_DURATION_SECONDS)
    .default(DEFAULT_SHORT_DURATION_SECONDS),
  max_shorts: z.number().int().min(MIN_MAX_SHORTS).max(MAX_MAX_SHORTS).default(DEFAULT_MAX_SHORTS),
  words_per_minute: z
    .number()
    .int()
    .min(60)
    .max(400)
    .default(DEFAULT_SEGMENT_OPTIONS.wordsPerMinute),
});
export type BookShortsPlanRequest = z.infer<typeof bookShortsPlanRequestSchema>;

export function shortsPlanToOptions(request: BookShortsPlanRequest): ShortOptions {
  return {
    targetDurationSeconds: request.target_duration_seconds,
    maxShorts: request.max_shorts,
    wordsPerMinute: request.words_per_minute,
  };
}

export const bookShortPatchSchema = z
  .object({
    title: bookTitleField.optional(),
    script: z.string().trim().min(1).max(MAX_SHORT_SCRIPT_LENGTH).optional(),
    hook: z.string().trim().max(220).optional(),
    youtube_title: z.string().trim().min(1).max(YOUTUBE_SHORT_TITLE_MAX).optional(),
    description: z.string().trim().max(YOUTUBE_SHORT_DESCRIPTION_MAX).optional(),
    tags: z
      .array(z.string().trim().max(YOUTUBE_SHORT_TAG_MAX))
      .max(YOUTUBE_SHORT_TAG_COUNT)
      .transform((tags) => normalizeYoutubeTags(tags, YOUTUBE_SHORT_TAG_COUNT))
      .optional(),
  })
  .refine(
    (body) =>
      body.title !== undefined ||
      body.script !== undefined ||
      body.hook !== undefined ||
      body.youtube_title !== undefined ||
      body.description !== undefined ||
      body.tags !== undefined,
    {
      message: "title, script, hook, youtube_title, description or tags is required",
    },
  );
export type BookShortPatchRequest = z.infer<typeof bookShortPatchSchema>;

export const bookShortsRenderRequestSchema = z.object({
  voice_name: z.string().min(1),
  voice_rate: z.number().min(0.5).max(2).default(1),
  voice_volume: z.number().min(0).max(5).default(1),
  video_aspect: z.enum(["16:9", "9:16", "1:1"]).default("9:16"),
  video_source: z.enum(["pexels", "pixabay", "coverr", "local"]).default("pexels"),
  bgm_type: z.string().default("random"),
  bgm_file: z.string().default(""),
  bgm_volume: z.number().min(0).max(1).default(0.2),
  font_name: videoParamsSchema.shape.font_name,
  font_size: videoParamsSchema.shape.font_size,
  // A short is one composition or none, so there are no parts to pick and no
  // body to leave alone. Empty is the stock-footage path exactly as it is
  // today, for the same reason it is on the book render form.
  template_id: z.string().default(""),
  n_threads: z.number().int().min(1).max(64).default(2),
  indexes: z.array(z.number().int().min(0)).nullish(),
});
export type BookShortsRenderRequest = z.infer<typeof bookShortsRenderRequestSchema>;

export function shortsRenderParamsToDocument(
  request: BookShortsRenderRequest,
): BookShortsRenderParamsDocument {
  return {
    voice_name: request.voice_name,
    voice_rate: request.voice_rate,
    voice_volume: request.voice_volume,
    video_aspect: request.video_aspect,
    video_source: request.video_source,
    bgm_type: request.bgm_type,
    bgm_file: request.bgm_file,
    bgm_volume: request.bgm_volume,
    font_name: request.font_name,
    font_size: request.font_size,
    template_id: request.template_id,
    n_threads: request.n_threads,
  };
}

/**
 * `VideoParams` plus the three book fields a templated short needs.
 *
 * They ride alongside rather than inside `videoParamsSchema` because that
 * schema is the short-video product's own vocabulary, and a book-only field
 * added there would land on every task the server has ever created. Everything
 * downstream takes a `VideoParams` and simply ignores the extra keys, so an
 * untemplated short is driven by exactly the values it was driven by before.
 */
export type BookShortVideoParams = VideoParams & {
  /** The scroll-stopping opening line; `""` when the short has none. */
  hook: string;
  /** Chapter the excerpt was lifted from; `""` when it is not known. */
  chapter_title: string;
  /** `""` = the stock-footage path, exactly as today. */
  template_id: string;
};

/**
 * Adapts one stored short to the params its render takes.
 *
 * `hook` and `chapter_title` are optional because both call sites in
 * `bookShortsPipeline.ts` predate them and a short row is not guaranteed to
 * carry either; absent means empty, which is what a template reads as "no hook
 * line" rather than as a reason to fail.
 */
export function videoParamsForBookShort(options: {
  title: string;
  script: string;
  language: string;
  params: BookShortsRenderParamsDocument;
  hook?: string;
  chapter_title?: string;
}): BookShortVideoParams {
  const params = videoParamsSchema.parse({
    video_subject: options.title,
    video_script: options.script,
    video_aspect: options.params.video_aspect || "9:16",
    video_source: options.params.video_source || "pexels",
    match_materials_to_script: true,
    video_concat_mode: "sequential",
    video_language: options.language,
    voice_name: options.params.voice_name,
    voice_rate: options.params.voice_rate,
    voice_volume: options.params.voice_volume,
    bgm_type: options.params.bgm_type,
    bgm_file: options.params.bgm_file,
    bgm_volume: options.params.bgm_volume,
    subtitle_enabled: true,
    font_name: options.params.font_name,
    font_size: options.params.font_size,
    n_threads: options.params.n_threads,
  });

  return {
    ...params,
    hook: options.hook ?? "",
    chapter_title: options.chapter_title ?? "",
    template_id: options.params.template_id ?? "",
  };
}
