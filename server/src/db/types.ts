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

export interface YoutubeUploadResult {
  success: boolean;
  channel_id: string;
  channel_title: string;
  video_id?: string;
  video_url?: string;
  error?: string;
  playlist_id?: string;
  playlist_error?: string;
}

/**
 * Enough to restart an in-flight upload after the process dies.
 * Tokens stay on the channel document; this is only listing + file paths.
 */
export interface YoutubeUploadIntent {
  channel_ids: string[];
  video_paths: string[];
  title: string;
  description: string;
  tags: string[];
  privacy_status: "public" | "unlisted" | "private";
  playlist_ids?: Record<string, string>;
  /** RFC 3339 UTC. YouTube keeps the video private until this time, then publishes it. */
  publish_at?: string;
}

export interface YoutubeChannelDocument {
  _id: string;
  channel_id: string;
  title: string;
  custom_url?: string | null;
  thumbnail_url?: string | null;
  google_account_email?: string | null;
  refresh_token: string;
  access_token: string;
  access_token_expires_at: Date;
  auto_upload: boolean;
  granted_scopes?: string | null;
  error?: string | null;
  created_at: Date;
  updated_at: Date;
  connected_at: Date;
}

export interface YoutubeOAuthStateDocument {
  _id: string;
  redirect_uri: string;
  created_at: Date;
  expires_at: Date;
}

/** Singleton cursor so auto-uploads can be scheduled 6 hours apart across restarts. */
export interface YoutubeScheduleDocument {
  _id: "publish_cursor";
  next_publish_at: Date;
  updated_at: Date;
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

  // Direct YouTube Data API uploads (independent of upload-post.com)
  youtube_upload_state?: CrossPostState | null;
  youtube_upload_results?: YoutubeUploadResult[] | null;
  youtube_upload_error?: string | null;
  youtube_upload_owner?: string | null;
  youtube_upload_intent?: YoutubeUploadIntent | null;

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
 *
 * `ocr_pending` and `ocr` are the scanned-PDF detour into the same resting
 * state. A scan has no text layer at all, so there is nothing to review until
 * every page has been through an OCR engine — half an hour of inference for a
 * long book. The upload is accepted rather than refused, and the book waits in
 * these two states until the background job hands it over to `ready` with a
 * structure the review screen can open.
 */
export type BookState =
  | "extracting"
  | "ocr_pending"
  | "ocr"
  | "ready"
  | "rendering"
  | "complete"
  | "failed";

export type BookSegmentState = "pending" | "queued" | "rendering" | "complete" | "failed";

/** Same lifecycle as a book segment; shorts are a sibling product, not a fifth audiobook step. */
export type BookShortState = "pending" | "queued" | "rendering" | "complete" | "failed";

/** Background hook-finding pass. Independent of audiobook `BookState`. */
export type BookShortsPlanState = "idle" | "planning" | "ready" | "failed";

/** `SegmentOptions` in the snake_case the API and database share. */
export interface BookSegmentOptionsDocument {
  mode: "chapter" | "duration" | "smart";
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
  /**
   * Background music, absent on books rendered before it existed — which is
   * why all three are optional: an old book must keep re-rendering silent
   * rather than acquiring music it was never set up with.
   */
  bgm_type?: string;
  bgm_file?: string;
  bgm_volume?: number;
  /**
   * Titles burned onto the cover still. Absent on books rendered before the
   * overlay existed, which must keep using the plain cover.
   */
  burn_book_title?: boolean;
  burn_chapter_title?: boolean;
  cover_book_title_position?: string;
  cover_chapter_title_position?: string;
  /** Single pad from before the titles could move independently. */
  cover_title_position?: string;
  /**
   * HyperFrames template, absent on books stored before templates existed —
   * which is why all three are optional. A missing field reads as the same
   * no-op the request schema defaults to, so an old book re-rendered after
   * this shipped is handed an identical ffmpeg argument list rather than
   * quietly gaining a moving background it was never set up with.
   */
  template_id?: string;
  /** Which parts reach the segment; absent and empty both apply none of it. */
  template_parts?: ("card" | "bed")[];
  /** Hex accent; absent and empty both mean the template's own default. */
  template_accent?: string;
  /**
   * Stock footage under the narration, absent on books stored before it
   * existed — which is why both are optional. A missing `footage_enabled`
   * reads as the same `false` the request schema defaults to, so an old book
   * re-rendered after this shipped is handed an identical ffmpeg argument list
   * rather than quietly gaining moving pictures beneath the still it was
   * approved with.
   */
  footage_enabled?: boolean;
  /**
   * Which provider the clips come from. Absent and null both mean the same
   * thing as an unset request field: use the app-level `video_source` setting,
   * rather than pinning today's provider into the book forever.
   */
  footage_source?: "pexels" | "pixabay" | "coverr" | "local" | null;
}

/**
 * Where a book's OCR pass has got to.
 *
 * Kept on the book rather than only on the task because it outlives the task:
 * the page-by-page record on disk is what a resumed run reads, and this is what
 * tells the import screen "page 34 of 300" while it runs and "12 pages could not
 * be read" once it has finished. `pages` is the scanned page list itself, so a
 * resume knows what to work through without re-opening the PDF.
 */
export interface BookOcrDocument {
  /** Absolute path of the uploaded PDF, kept so pages can be rasterised again. */
  source_path: string;
  /** 1-based page numbers that need recognising, in reading order. */
  pages: number[];
  pages_total: number;
  pages_done: number;
  /** Pages the engine could not read. They are skipped, never fatal. */
  pages_failed: number;
  /** `ocr_provider` at the time the job was accepted, e.g. `ollama`. */
  provider: string;
  /** Mean confidence over the pages recognised so far, 0..1. */
  mean_confidence: number;
  /** Id of the ordinary task running it, so cancellation keeps working. */
  task_id?: string | null;
  error?: string | null;
  started_at?: Date | null;
  finished_at?: Date | null;
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
  /** Present only for a scanned PDF that needed, or is having, OCR run over it. */
  ocr?: BookOcrDocument | null;
  /**
   * Hook-short ideas derived from the book. Independent of the long-form
   * segment plan, so generating teasers cannot invalidate a chapter render.
   */
  shorts?: BookShortsPlanDocument | null;
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
  youtube_title?: string;
  description?: string;
  tags?: string[];
  youtube_upload_state?: CrossPostState | null;
  youtube_upload_results?: YoutubeUploadResult[] | null;
  youtube_upload_error?: string | null;
  youtube_upload_intent?: YoutubeUploadIntent | null;
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

/** Last settings used to render hook shorts, so a single short can be retried. */
export interface BookShortsRenderParamsDocument {
  voice_name: string;
  voice_rate: number;
  voice_volume: number;
  video_aspect: string;
  video_source: string;
  bgm_type: string;
  bgm_file: string;
  bgm_volume: number;
  font_name: string;
  font_size: number;
  n_threads: number;
  /**
   * HyperFrames template, absent on shorts stored before templates existed.
   * Optional for the same reason it is on the book: a missing value is the
   * stock-footage path, which is what those rows were rendered with.
   */
  template_id?: string;
}

/**
 * Progress of the pass that walks the book and writes hook-short scripts.
 *
 * Kept on the book the same way OCR is: the pass outlives the HTTP request,
 * and this is what the Shorts tab reads for "part 4 of 18". Independent of
 * audiobook `state` and of the long-form segment plan.
 */
export interface BookShortsPlanDocument {
  state: BookShortsPlanState;
  /** Bumped each time a new set of ideas replaces the previous one. */
  revision: number;
  chunks_total: number;
  chunks_done: number;
  target_duration_seconds: number;
  max_shorts: number;
  words_per_minute: number;
  task_id?: string | null;
  error?: string | null;
  render_params?: BookShortsRenderParamsDocument | null;
  started_at?: Date | null;
  finished_at?: Date | null;
}

/**
 * One hook short: a ~60s teaser written from a passage of the book.
 *
 * The spoken script lives on the document rather than on disk because it is a
 * few hundred words, not a chapter. `block_ids` remember the excerpt so a
 * regenerate can re-read the same span. Stock-footage output lives in the
 * ordinary task directory and is pointed at by `video_path`.
 */
export interface BookShortDocument {
  /** `${book_id}:${index}`. */
  _id: string;
  book_id: string;
  index: number;
  title: string;
  /** Opening line meant to stop the scroll. */
  hook: string;
  /** Spoken narration for the short. */
  script: string;
  /**
   * YouTube listing title. Kept separate from `title` so the on-screen hook
   * can stay punchy while the upload title names the book.
   */
  youtube_title?: string;
  /** YouTube description (and the caption other platforms reuse). */
  description?: string;
  /** YouTube keyword tags, stored without a leading #. */
  tags?: string[];
  chapter_title: string;
  start_block_id: string;
  block_ids: string[];
  /** Seconds, estimated from the script's word count. */
  estimated_duration: number;
  state: BookShortState;
  /** Shorts-plan revision this row was written at. */
  revision: number;
  task_id?: string | null;
  video_path?: string | null;
  audio_path?: string | null;
  subtitle_path?: string | null;
  error?: string | null;
  youtube_upload_state?: CrossPostState | null;
  youtube_upload_results?: YoutubeUploadResult[] | null;
  youtube_upload_error?: string | null;
  youtube_upload_intent?: YoutubeUploadIntent | null;
  updated_at: Date;
}

/**
 * A user's rewrite of one block's narration text.
 *
 * Stored the same way a decision override is, and for the same reason:
 * structure.json is what extraction produced and stays that way, so the
 * original is always recoverable and a re-extraction of the same file keeps
 * every edit (block ids are stable). Keyed by block rather than by segment
 * because segment rows are `${book_id}:${index}` and get replaced wholesale on
 * every re-plan — an edit hung off one would be lost the next time a reviewer
 * changed the duration or dropped a paragraph.
 *
 * Only the overlay is kept: a block edited back to its original text has its
 * row deleted rather than stored as a no-op.
 */
export interface BookBlockEditDocument {
  /** `${book_id}:${block_id}`. */
  _id: string;
  book_id: string;
  block_id: string;
  /** Replaces `Block.text` everywhere the book's text is read. */
  text: string;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Semantic footage library
//
// The filesystem is the work-list. The indexer walks `cacheVideosDir()` and
// asks Mongo, per file, "have I already described this one at the current
// versions?". So the durable record of what footage exists is the directory
// listing; `footage_index` is only a cache of the expensive answers plus a
// record of what went wrong getting them.
//
// That inversion is the point, not an accident of ordering. A work-list in
// Mongo has to stay honest against an indexer that can die mid-clip, which
// costs per-row leases, an owner id, a generation counter and tombstones — and
// every one of those was a defect in an earlier draft. A cache needs none of
// it: dropping this collection entirely costs Gemini spend and nothing else,
// because every clip is still on disk and the next walk finds all of them.
// Nothing here is ever the reason a clip is lost or re-downloaded.
// ---------------------------------------------------------------------------

/**
 * A clip description as it was stored, which is not necessarily the shape the
 * current describer would produce.
 *
 * The enum-ish fields are widened to `string` deliberately. A cached row may
 * have been written at an older `describe_version` with a different vocabulary,
 * so a caller that needs the narrow type must re-parse the value with
 * `clipDescriptionSchema` after checking the version, rather than trusting this
 * declaration. Declaring the describer's strict inferred type on a stored
 * document would claim a guarantee the collection cannot make — the rows
 * outlive the schema that wrote them, which is exactly why `describe_version`
 * exists.
 */
export interface FootageClipDescription {
  /** One line, the thing you would say to a person choosing a clip. */
  summary: string;
  detailed_description: string;
  /** Where this clip would work, in editorial terms rather than visual ones. */
  use_cases: string[];
  mood: string[];
  tags: string[];
  /** e.g. `indoor`, `outdoor`. */
  setting: string;
  /** e.g. `day`, `night`. */
  time_of_day: string;
  has_people: boolean;
  has_on_screen_text: boolean;
  /** e.g. `static`, `pan`, `handheld`. */
  camera_motion: string;
  /** Reasons to pass over an otherwise matching clip, e.g. `low light`. */
  quality_flags: string[];
}

/**
 * `indexed` and `failed` are the two resting states: described, embedded and
 * upserted, or tried and unusable. A failed row keeps its file — nothing here
 * ever deletes bytes a render might be holding.
 *
 * `stale` is not a failure. It is how a search term added after the fact gets
 * into Qdrant cheaply. Terms accumulate by `$addToSet` from the download hook,
 * and a term arriving for a clip that is already described changes only the
 * payload: not the pixels, not the description, not the vector. `stale` marks
 * exactly that job — re-read `search_terms`, re-upsert the payload, mark
 * `indexed` again, with no proxy build, no Gemini describe call and no
 * embedding. Without the third state the indexer would have to either
 * re-describe an unchanged clip to pick up a one-word provenance change, or
 * carry a separate freshness field that the describe/embed version pair does
 * not cover.
 */
export type FootageIndexState = "indexed" | "failed" | "stale";

/**
 * One failed attempt, appended rather than overwritten.
 *
 * A scalar `error` would keep only the most recent reason, which is the least
 * useful one: a clip that fails ffprobe, then times out, then trips a schema
 * violation is a different problem from one that has hit the same rate limit
 * three times, and only the history tells them apart.
 */
export interface FootageIndexError {
  at: Date;
  message: string;
}

/**
 * A creator credit, mirroring `CachedMaterialSourceInfo["creator"]` because
 * that is where the values come from — the download hook copies provenance off
 * the material it just saved.
 */
export interface FootageCreator {
  id?: string;
  name?: string;
  profile_page?: string;
}

/**
 * The cached description of one clip on disk, plus its provenance and its
 * failures. Not a work-list row: see the section note above.
 */
export interface FootageIndexDocument {
  /**
   * v5 UUID derived from `local_file`. Qdrant accepts only a uint64 or a UUID
   * as a point id, so deriving one from the filename lets the same value key
   * the Mongo row and the vector: both are found from the file alone, and
   * there is no separate mapping to keep in sync or to lose.
   */
  _id: string;
  /**
   * Basename only, e.g. `vid-d6e9….mp4`, resolved through `cacheVideosDir()`.
   *
   * Never an absolute path. The host process and a container see the same file
   * at different paths, so a stored path written by one side reads as "file is
   * gone" to the other — and reconcile answers that by deleting the point. One
   * run from the wrong side would empty the index.
   */
  local_file: string;
  state: FootageIndexState;
  /**
   * The describer's output, cached so a re-run never re-pays Gemini for a clip
   * whose bytes have not changed. Absent on a row that has only ever failed.
   */
  description?: FootageClipDescription | null;

  // Provenance the filename cannot carry. `vid-<md5(url)>.mp4` is a one-way
  // hash of a URL that is nowhere else on disk, so without these fields a clip
  // in the cache has no recoverable source, no credit and no reason for being
  // there.
  provider: string;
  /**
   * Every term that has ever selected this clip, accumulated with `$addToSet`.
   * A clip reached by three searches is one file with three terms, not three
   * rows, and a new term here is what flips the row to `stale`.
   */
  search_terms: string[];
  asset_id?: string;
  rendition_id?: string;
  source_page?: string;
  creator?: FootageCreator | null;

  // Probed from the file, so a search can filter on shape without opening it.
  duration?: number;
  width?: number;
  height?: number;
  bytes?: number;

  /**
   * Which describer and embedder produced this row. The indexer compares the
   * pair against the current constants and treats a mismatch as work to do, so
   * bumping a version is the whole migration mechanism — which is why the two
   * are indexed together rather than separately.
   */
  describe_version: number;
  embed_version: number;

  /**
   * How many times this clip has been through the pipeline. Read as a give-up
   * signal for a file that will never describe cleanly, so a repeated
   * `indexAll` does not spend on it forever.
   */
  attempts: number;
  last_attempt_at?: Date;
  errors?: FootageIndexError[];
  created_at: Date;
  updated_at: Date;
}

/** What one search term yielded during a pull, and why it yielded that much. */
export interface FootageRunTermResult {
  term: string;
  aspect: string;
  attempted: number;
  accepted: number;
  /** Rejected for not matching the repo's exact-resolution rule. */
  rejected_resolution: number;
  /** Last HTTP status seen for the term: a 429 here explains a thin result. */
  last_status?: number;
}

export type FootageRunStopReason = "complete" | "budget" | "disk" | "aborted" | "error";

/**
 * One bulk-pull run.
 *
 * This is the one place where a document is the only record, because a clip
 * that was never downloaded leaves no file — and the filesystem work-list can
 * only speak about files that exist. Without this, "term X is thin" is
 * indistinguishable from "term X was rate-limited", "the byte budget ran out
 * before term X" and "the run was killed halfway", which are four different
 * things to do next.
 *
 * It is a log: written by the pull, read by a person, never consulted by the
 * indexer.
 */
export interface FootageRunDocument {
  _id: string;
  started_at: Date;
  /** Absent while a run is in flight, and on a run whose process was killed. */
  finished_at?: Date;
  stop_reason?: FootageRunStopReason;
  per_term: FootageRunTermResult[];
  /**
   * Actual bytes written to disk, not the sizes the provider advertised — the
   * budget is spent in real bytes, and the advertised size is discarded long
   * before it reaches here.
   */
  bytes_written: number;
  clips_added: number;
  clips_failed: number;
}
