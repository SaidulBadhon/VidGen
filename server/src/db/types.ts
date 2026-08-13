/**
 * MongoDB document shapes.
 *
 * Task fields keep the snake_case names the v1 API already returns, so a task
 * document can be serialised to an API response without a translation layer.
 */

import type { Settings } from "../config/schema.ts";
import type { CrossPostState } from "../models/const.ts";
import type { VideoParams } from "../models/schema.ts";
import type { BookSourceFormat, DecisionSource } from "../services/book/types.ts";

export interface SettingsDocument {
  _id: "settings";
  data: Settings;
  updated_at: Date;
}

export interface TaskWarning {
  code: string;
  video_index: number;
}

export interface CrossPostResult {
  success: boolean;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

export interface TaskDocument {
  /** The task id. Stored as `_id` and echoed as `task_id` in responses. */
  _id: string;
  task_id: string;
  state: number;
  progress: number;

  request_id?: string;
  stop_at?: string;
  params?: VideoParams;

  /**
   * `hostname:pid:uuid` of the process that owns in-flight work. Startup
   * recovery uses it to fail records whose owning process is gone.
   */
  owner_id?: string | null;

  // Stage outputs
  script?: string;
  terms?: string[];
  audio_file?: string;
  audio_duration?: number;
  subtitle_path?: string;
  materials?: string[];
  videos?: string[];
  combined_videos?: string[];

  // Failure detail
  failed_stage?: string | null;
  error?: string | null;
  warnings?: TaskWarning[] | null;

  // Cross-posting
  cross_post_state?: CrossPostState | null;
  cross_post_results?: CrossPostResult[] | null;
  cross_post_error?: string | null;
  cross_post_owner?: string | null;

  /** Per-task log lines shown in the UI, capped to a recent window. */
  logs?: string[];

  created_at: Date;
  updated_at: Date;
}

export interface CachedMaterialSourceInfo {
  provider?: string;
  search_term?: string;
  asset_id?: string | null;
  source_page?: string | null;
  creator?: { id?: string; name?: string; profile_page?: string } | null;
  rendition?: { id?: string | null; width?: number | null; height?: number | null } | null;
}

export interface CachedMaterial {
  provider: string;
  url: string;
  duration: number;
  source_info?: CachedMaterialSourceInfo | null;
}

export interface MaterialCacheDocument {
  /** sha256 of provider + term + minimum duration + aspect + format version. */
  _id: string;
  provider: string;
  search_term: string;
  minimum_duration: number;
  video_aspect: string;
  format_version: number;
  items: CachedMaterial[];
  created_at: Date;
  /** TTL index target. Mongo removes the document once this passes. */
  expires_at: Date;
}

// ---------------------------------------------------------------------------
// Long-form books
//
// A book's text never reaches Mongo. The extracted `BookStructure` of a
// 400-page book is 0.7-1.5 MB before decisions and per-segment scripts, which
// would sit uncomfortably close to the 16 MB document ceiling and would be
// re-read in full on every poll. It is written to
// `storage/books/<bookId>/structure.json` instead, and the documents below hold
// only pointers, counts and per-segment state.
// ---------------------------------------------------------------------------

/**
 * `ready` is the reviewable resting state: extracted, classified and planned,
 * with no render in flight. `failed` only ever describes extraction, since a
 * failing segment must not condemn its siblings.
 */
export type BookState = "extracting" | "ready" | "rendering" | "complete" | "failed";

export type BookSegmentState = "pending" | "queued" | "rendering" | "complete" | "failed";

/** `SegmentOptions` in the snake_case the API and database share. */
export interface BookSegmentOptionsDocument {
  mode: "chapter" | "duration";
  target_duration_seconds: number;
  max_duration_seconds: number;
  words_per_minute: number;
}

/** Render settings kept on the book so a single segment can be retried alone. */
export interface BookRenderParamsDocument {
  voice_name: string;
  voice_rate: number;
  voice_volume: number;
  subtitle_render_mode: "burn" | "soft" | "none";
  video_aspect: string;
  font_name: string;
  font_size: number;
  text_fore_color: string;
  stroke_color: string;
  stroke_width: number;
  text_background_color: boolean | string;
  rounded_subtitle_background: boolean;
  subtitle_position: string;
  custom_position: number;
  n_threads: number;
}

export interface BookDocument {
  _id: string;
  title: string;
  author: string;
  language: string;
  source_filename: string;
  format: BookSourceFormat;
  /** Absolute path of the cover still, uploaded or generated. */
  cover_path?: string | null;
  state: BookState;
  /**
   * Bumped by re-segmentation and by every decision override.
   *
   * A segment render is a background task holding block ids that were planned
   * at one revision; if the plan changes underneath it, its results belong to a
   * segment that no longer exists. Tasks re-read this before writing and
   * abandon quietly when it has moved on.
   */
  revision: number;
  chapter_count: number;
  block_count: number;
  kept_block_count: number;
  segment_options: BookSegmentOptionsDocument;
  render_params?: BookRenderParamsDocument | null;
  /** Non-fatal extraction problems, shown once in the review UI. */
  warnings?: string[];
  error?: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface BookSegmentDocument {
  /** `${book_id}:${index}`. */
  _id: string;
  book_id: string;
  index: number;
  title: string;
  block_ids: string[];
  /** Seconds, estimated from word count before any TTS has run. */
  estimated_duration: number;
  state: BookSegmentState;
  /** Book revision this segment was planned at. */
  revision: number;
  /** Id of the ordinary task rendering it, so cancellation keeps working. */
  task_id?: string | null;
  audio_path?: string | null;
  video_path?: string | null;
  subtitle_path?: string | null;
  error?: string | null;
  updated_at: Date;
}

/**
 * A user's override of one block's fate.
 *
 * Only overrides are stored. The structural pass is recomputed from
 * structure.json on read, which keeps writes to a handful of documents instead
 * of the tens of thousands a whole book would produce, and means a later
 * improvement to the rules applies to books that already exist.
 */
export interface BookDecisionDocument {
  /** `${book_id}:${block_id}`. */
  _id: string;
  book_id: string;
  block_id: string;
  keep: boolean;
  reason: string;
  rule: string;
  confidence: number;
  source: DecisionSource;
  updated_at: Date;
}
