/**
 * Typed client for the long-form book API.
 *
 * Mirrors ../api/client.ts: snake_case field names straight from the server
 * contract so bodies need no mapping layer, the shared `ApiError` for failures,
 * and an unsubscribe-returning SSE helper whose lifetime the caller owns.
 *
 * The envelope unwrapping is duplicated rather than imported because the video
 * client keeps its `request` private; the alternative is widening that module's
 * surface for a second consumer.
 */

import { ApiError, type ApiEnvelope } from "../api/client.ts";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });

  let body: ApiEnvelope<T> | null = null;
  try {
    body = (await response.json()) as ApiEnvelope<T>;
  } catch {
    // A non-JSON body means the server failed before the handler ran.
  }

  if (!response.ok) {
    throw new ApiError(body?.message ?? `request failed with status ${response.status}`, response.status, body?.data);
  }
  return (body?.data ?? (undefined as T)) as T;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * `ocr_pending` and `ocr` are the scanned-PDF detour: the upload was accepted,
 * but there is nothing to review until an engine has read every page image.
 */
export type BookState =
  | "extracting"
  | "ocr_pending"
  | "ocr"
  | "ready"
  | "rendering"
  | "complete"
  | "failed";

/** True while a book is queued for, or going through, recognition. */
export function isOcrState(state: BookState | undefined): boolean {
  return state === "ocr_pending" || state === "ocr";
}
export type BookSegmentState = "pending" | "queued" | "rendering" | "complete" | "failed";
export type SegmentMode = "chapter" | "duration" | "smart";
export type SubtitleRenderMode = "burn" | "soft" | "none";
/** The AI providers the short-video form offers cannot score a chapter-length segment. */
export type BookBgmType = "" | "random" | "custom";
/**
 * Which parts of a book-video template reach the finished segment.
 *
 * `card` is the opening title composition laid over the first seconds; `bed`
 * replaces the static still with a moving background for the whole body. They
 * are two ticks rather than one because they cost very different things — a
 * card is one short render, a bed re-encodes every segment.
 */
export type BookTemplatePart = "card" | "bed";
/** `llm` is not produced yet; the filter is structural-only for now. */
export type DecisionSource = "structural" | "user" | "llm";

export const SEGMENT_MODES: readonly SegmentMode[] = ["chapter", "duration", "smart"];
export const SUBTITLE_RENDER_MODES: readonly SubtitleRenderMode[] = ["burn", "soft", "none"];
export const VIDEO_ASPECTS: readonly string[] = ["16:9", "9:16", "1:1"];
export const BOOK_BGM_TYPES: readonly BookBgmType[] = ["", "random", "custom"];
/** Canonical order for the part checkboxes; mirrors `BOOK_TEMPLATE_PARTS` on the server. */
export const BOOK_TEMPLATE_PARTS: readonly BookTemplatePart[] = ["card", "bed"];

/**
 * Bounds copied from models/bookSchema.ts.
 *
 * The server enforces them and answers 400; mirroring them here lets the inputs
 * refuse an invalid combination before it is ever submitted.
 */
export const MIN_SEGMENT_SECONDS = 30;
export const MAX_SEGMENT_SECONDS = 4 * 60 * 60;
export const MIN_WORDS_PER_MINUTE = 60;
export const MAX_WORDS_PER_MINUTE = 400;

export const MIN_SHORT_SECONDS = 30;
export const MAX_SHORT_SECONDS = 90;
export const DEFAULT_SHORT_SECONDS = 60;
export const MIN_MAX_SHORTS = 1;
export const MAX_MAX_SHORTS = 30;
export const DEFAULT_MAX_SHORTS = 12;
export const VIDEO_SOURCES: readonly string[] = ["pexels", "pixabay", "coverr", "local"];

export const ACCEPTED_BOOK_EXTENSIONS = ".epub,.pdf,.txt,.md,.markdown,.text";
export const ACCEPTED_COVER_EXTENSIONS = ".png,.jpg,.jpeg,.webp";

/** Row-major 3×3 grid: corners, edges, and centre. Matches the server enum. */
export const COVER_TITLE_POSITIONS = [
  "top_left",
  "top",
  "top_right",
  "left",
  "center",
  "right",
  "bottom_left",
  "bottom",
  "bottom_right",
] as const;
export type CoverTitlePosition = (typeof COVER_TITLE_POSITIONS)[number];

export interface SegmentOptions {
  mode: SegmentMode;
  target_duration_seconds: number;
  max_duration_seconds: number;
  words_per_minute: number;
}

export interface BookRenderParams {
  voice_name: string;
  voice_rate: number;
  voice_volume: number;
  subtitle_render_mode: SubtitleRenderMode;
  video_aspect: string;
  /** Absent on books last rendered before background music existed. */
  bgm_type?: BookBgmType;
  bgm_file?: string;
  bgm_volume?: number;
  /** Absent on books last rendered before cover titles could be burned in. */
  burn_book_title?: boolean;
  burn_chapter_title?: boolean;
  cover_book_title_position?: CoverTitlePosition;
  cover_chapter_title_position?: CoverTitlePosition;
  /** Single pad from before the titles could move independently. */
  cover_title_position?: CoverTitlePosition;
  /** Absent on books last rendered before motion templates existed. */
  template_id?: string;
  template_parts?: BookTemplatePart[];
  template_accent?: string;
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

/** What a render form submits. Only `voice_name` is required; the rest default. */
export interface BookRenderRequest {
  voice_name: string;
  voice_rate?: number;
  voice_volume?: number;
  subtitle_render_mode?: SubtitleRenderMode;
  video_aspect?: string;
  bgm_type?: BookBgmType;
  bgm_file?: string;
  bgm_volume?: number;
  font_name?: string;
  font_size?: number;
  n_threads?: number;
  burn_book_title?: boolean;
  burn_chapter_title?: boolean;
  cover_book_title_position?: CoverTitlePosition;
  cover_chapter_title_position?: CoverTitlePosition;
  /**
   * The template to apply, named by the metadata entry's `id` — the two sides
   * use different key names on purpose, so the form reads `id` off the dropdown
   * entry and sends it here as `template_id`.
   *
   * `""` on all three is not "unset, pick something sensible": it is the
   * documented request for exactly today's static still, and the server's zod
   * schema defaults each of them to it. Unlike `font_name`, an empty string
   * here is meaningful and must be sent rather than stripped.
   */
  template_id?: string;
  template_parts?: BookTemplatePart[];
  template_accent?: string;
  segment_indexes?: number[];
}

/**
 * One book-video template as `GET /settings/metadata` serves it.
 *
 * Only the fields a dropdown draws itself from cross the wire; the manifest's
 * durations and encode profile stay the renderer's business.
 */
export interface BookTemplateMetadata {
  id: string;
  label: string;
  description: string;
  /** What this template actually ships — never assume both parts exist. */
  parts: BookTemplatePart[];
  default_accent: string;
}

/**
 * Pulls the template list out of a settings-metadata payload.
 *
 * Read defensively because the key is genuinely optional on the wire: a server
 * older than this feature omits it, and a host that cannot run a HyperFrames
 * render serves `[]`. Both mean the same thing to the form — no templates, hide
 * the control — so both come back as an empty array rather than as an
 * `undefined` every caller would have to remember to check. `SettingsMetadata`
 * in ../api/client.ts does not declare the key, hence the structural read.
 */
export function bookTemplatesOf(metadata: unknown): BookTemplateMetadata[] {
  const value = (metadata as { book_templates?: unknown } | null | undefined)?.book_templates;
  return Array.isArray(value) ? (value as BookTemplateMetadata[]) : [];
}

export type BookShortState = "pending" | "queued" | "rendering" | "complete" | "failed";
export type BookShortsPlanState = "idle" | "planning" | "ready" | "failed";

export interface BookShortsRenderParams {
  voice_name: string;
  voice_rate: number;
  voice_volume: number;
  video_aspect: string;
  video_source?: string;
  bgm_type: string;
  bgm_file: string;
  bgm_volume: number;
  font_name: string;
  font_size: number;
  n_threads: number;
}

export interface BookShortsPlan {
  state: BookShortsPlanState;
  revision: number;
  chunks_total: number;
  chunks_done: number;
  target_duration_seconds: number;
  max_shorts: number;
  words_per_minute?: number;
  error?: string | null;
  render_params?: BookShortsRenderParams | null;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface BookShortsRenderRequest {
  voice_name: string;
  voice_rate?: number;
  voice_volume?: number;
  video_aspect?: string;
  video_source?: string;
  bgm_type?: string;
  bgm_file?: string;
  bgm_volume?: number;
  font_name?: string;
  font_size?: number;
  n_threads?: number;
  indexes?: number[];
}

export interface BookShort {
  _id: string;
  book_id: string;
  index: number;
  title: string;
  hook: string;
  script: string;
  youtube_title?: string;
  description?: string;
  tags?: string[];
  chapter_title: string;
  start_block_id: string;
  estimated_duration: number;
  state: BookShortState;
  revision: number;
  block_count?: number;
  task_id?: string | null;
  error?: string | null;
  updated_at?: string;
  video_url: string | null;
  audio_url: string | null;
  subtitle_url: string | null;
  youtube_upload_state?: string | null;
  youtube_upload_error?: string | null;
  youtube_upload_results?: {
    success: boolean;
    channel_id: string;
    channel_title: string;
    video_id?: string;
    video_url?: string;
    error?: string;
  }[] | null;
}

export interface BookShortsBundle {
  plan: BookShortsPlan;
  items: BookShort[];
  progress: BookProgress;
}

export interface BookShortsPage {
  book_id: string;
  plan: BookShortsPlan | null;
  shorts: BookShort[];
  progress: BookProgress;
  queue: { active: number; waiting: number; limit: number };
}

/**
 * How far a scanned book's recognition has got.
 *
 * `source_path` is deliberately absent: the server keeps the uploaded PDF but
 * never tells the browser where.
 */
export interface BookOcr {
  pages: number[];
  pages_total: number;
  pages_done: number;
  /** Pages no engine could read. They are skipped, not fatal. */
  pages_failed: number;
  provider: string;
  /** 0..1 over the pages read so far. Recognised text is never certain. */
  mean_confidence: number;
  task_id?: string | null;
  error?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface Book {
  _id: string;
  title: string;
  author: string;
  language: string;
  source_filename: string;
  format: string;
  /** The cover itself is served from its own endpoint; host paths never leave the server. */
  has_cover: boolean;
  state: BookState;
  revision: number;
  chapter_count: number;
  block_count: number;
  kept_block_count: number;
  segment_options: SegmentOptions;
  render_params?: BookRenderParams | null;
  /** Present only for a scanned PDF that needed OCR. */
  ocr?: BookOcr | null;
  /** Present once hook shorts have been planned or attempted. */
  shorts?: BookShortsPlan | null;
  warnings?: string[];
  error?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface BookProgress {
  total: number;
  pending: number;
  queued: number;
  rendering: number;
  complete: number;
  failed: number;
  /** Percent complete, 0-100. */
  progress: number;
  state: BookState;
}

export interface BookListEntry extends Book {
  progress: BookProgress;
}

export interface BookSegment {
  _id: string;
  book_id: string;
  index: number;
  title: string;
  /** Seconds, estimated from word count before any TTS has run. */
  estimated_duration: number;
  state: BookSegmentState;
  revision: number;
  block_count: number;
  task_id?: string | null;
  error?: string | null;
  updated_at?: string;
  audio_url: string | null;
  video_url: string | null;
  subtitle_url: string | null;
  youtube_title?: string;
  description?: string;
  tags?: string[];
  youtube_upload_state?: string | null;
  youtube_upload_error?: string | null;
  youtube_upload_results?: {
    success: boolean;
    channel_id: string;
    channel_title: string;
    video_id?: string;
    video_url?: string;
    error?: string;
  }[] | null;
}

export interface BookBlock {
  id: string;
  kind: string;
  /** What will be narrated: the extracted text, or the reviewer's rewrite of it. */
  text: string;
  /** The extracted text, sent only when a rewrite is replacing it. */
  original_text: string | null;
  edited: boolean;
  level: number | null;
  chapter_id: string;
  chapter_title: string;
  order: number;
  keep: boolean;
  /** Plain-language explanation written by the filter; shown verbatim. */
  reason: string;
  rule: string;
  /** 0..1. Low-confidence drops are the ones worth a second look. */
  confidence: number;
  source: DecisionSource;
}

/** A block as it appears inside one segment: kept, in narration order, no verdict. */
export interface SegmentBlock {
  id: string;
  kind: string;
  text: string;
  original_text: string | null;
  edited: boolean;
  level: number | null;
  chapter_id: string;
  chapter_title: string;
  order: number;
}

export interface SegmentBlocksResult {
  book_id: string;
  index: number;
  title: string;
  state: BookSegmentState;
  blocks: SegmentBlock[];
}

export interface BlockTextResult {
  book_id: string;
  block_id: string;
  text: string;
  /** False when the submitted text matched the original, which reverts the edit. */
  edited: boolean;
  /** The segment marked unrendered by the edit, or null when the block is dropped. */
  segment_index: number | null;
  estimated_duration: number | null;
}

export interface RuleSummary {
  rule: string;
  kept: number;
  dropped: number;
  reason: string;
}

export interface DecisionSummary {
  total: number;
  kept: number;
  dropped: number;
  /** One row per rule, most-dropped first. */
  rules: RuleSummary[];
}

export interface BookDetail {
  book: Book;
  progress: BookProgress;
  segments: BookSegment[];
  decisions: DecisionSummary;
  overrides: number;
  queue: { active: number; waiting: number; limit: number };
  shorts?: BookShortsBundle;
}

export interface BookUploadResult {
  book: Book;
  /** Count, not the segments themselves — the upload response stays small. */
  segments: number;
  warnings: string[];
  decisions: DecisionSummary;
  /** Present when the upload was a scan and went to the OCR queue instead. */
  ocr?: { pages: number; task_id: string };
}

export interface OcrResumeResult {
  book_id: string;
  task_id: string;
  pages: number;
  /** Pages a previous run already read and this one will not pay for again. */
  resumed: number;
}

export interface BookListPage {
  books: BookListEntry[];
  total: number;
  page: number;
  page_size: number;
}

export interface BookBlockPage {
  blocks: BookBlock[];
  total: number;
  page: number;
  page_size: number;
}

export interface DecisionResult {
  book_id: string;
  block_id: string;
  keep: boolean;
  revision: number;
  kept_block_count: number;
  /** Number of segments the book re-planned into. */
  segments: number;
}

export interface SegmentPlanResult {
  book_id: string;
  revision: number;
  segment_options: SegmentOptions;
  segments: BookSegment[];
}

export interface RenderResult {
  book_id: string;
  revision: number;
  /** Segment indexes the server actually queued. */
  accepted: number[];
  title?: string;
}

export interface BookRenameResult {
  book_id: string;
  title: string;
  author: string;
}

export interface SegmentRenameResult {
  book_id: string;
  index: number;
  title: string;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

function bookPath(bookId: string, suffix = ""): string {
  return `/books/${encodeURIComponent(bookId)}${suffix}`;
}

export const bookApi = {
  upload: (file: File, options?: Partial<SegmentOptions>) => {
    const form = new FormData();
    form.append("file", file);
    for (const [key, value] of Object.entries(options ?? {})) {
      if (value !== undefined && value !== null) form.append(key, String(value));
    }
    return request<BookUploadResult>("/books", { method: "POST", body: form });
  },

  list: (page = 1, pageSize = 20) => request<BookListPage>(`/books?page=${page}&page_size=${pageSize}`),

  get: (bookId: string) => request<BookDetail>(bookPath(bookId)),

  /** Changes the display title and/or author. The original filename is left alone. */
  patch: (bookId: string, fields: { title?: string; author?: string }) =>
    request<BookRenameResult>(bookPath(bookId), {
      method: "PATCH",
      body: JSON.stringify(fields),
    }),

  /** Changes the display name. The original filename is left alone. */
  rename: (bookId: string, title: string) => bookApi.patch(bookId, { title }),

  blocks: (bookId: string, page = 1, pageSize = 50) =>
    request<BookBlockPage>(bookPath(bookId, `/blocks?page=${page}&page_size=${pageSize}`)),

  setDecision: (bookId: string, blockId: string, keep: boolean) =>
    request<DecisionResult>(bookPath(bookId, `/decisions/${encodeURIComponent(blockId)}`), {
      method: "PATCH",
      body: JSON.stringify({ keep }),
    }),

  /** The kept blocks of one segment, in the order they will be narrated. */
  segmentBlocks: (bookId: string, index: number) =>
    request<SegmentBlocksResult>(bookPath(bookId, `/segments/${index}/blocks`)),

  /**
   * Rewrites one block's narration.
   *
   * Sending the original text back reverts the edit, so no separate endpoint is
   * needed to undo one. The segment holding the block is marked unrendered.
   */
  setBlockText: (bookId: string, blockId: string, text: string) =>
    request<BlockTextResult>(bookPath(bookId, `/blocks/${encodeURIComponent(blockId)}`), {
      method: "PATCH",
      body: JSON.stringify({ text }),
    }),

  setSegmentOptions: (bookId: string, options: SegmentOptions) =>
    request<SegmentPlanResult>(bookPath(bookId, "/segments"), {
      method: "PATCH",
      body: JSON.stringify(options),
    }),

  /** Changes one segment's display name. Re-planning still rebuilds titles from headings. */
  renameSegment: (bookId: string, index: number, title: string) =>
    request<SegmentRenameResult>(bookPath(bookId, `/segments/${index}`), {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),

  uploadCover: (bookId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ book_id: string; format: string; size: number }>(bookPath(bookId, "/cover"), {
      method: "POST",
      body: form,
    });
  },

  /** Revision doubles as a cache buster so a replaced cover shows immediately. */
  coverUrl: (bookId: string, revision: number) =>
    `/api/v1${bookPath(bookId, "/cover")}?v=${revision}`,

  /**
   * Restarts a recognition pass that stopped without finishing.
   *
   * Pages already read are on disk, so this costs only what is left; the server
   * answers 409 when a pass is genuinely still running.
   */
  resumeOcr: (bookId: string) =>
    request<OcrResumeResult>(bookPath(bookId, "/ocr"), { method: "POST" }),

  render: (bookId: string, body: BookRenderRequest) =>
    request<RenderResult>(bookPath(bookId, "/render"), { method: "POST", body: JSON.stringify(body) }),

  /**
   * Retries one segment. With no body the server reuses the settings the book
   * was last rendered with, and answers 400 when there are none yet.
   */
  renderSegment: (bookId: string, index: number, body?: BookRenderRequest) =>
    request<RenderResult>(bookPath(bookId, `/segments/${index}/render`), {
      method: "POST",
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),

  listShorts: (bookId: string) => request<BookShortsPage>(bookPath(bookId, "/shorts")),

  planShorts: (bookId: string, body?: { target_duration_seconds?: number; max_shorts?: number; words_per_minute?: number }) =>
    request<{ book_id: string; task_id: string; revision: number }>(bookPath(bookId, "/shorts/plan"), {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),

  patchShort: (
    bookId: string,
    index: number,
    fields: {
      title?: string;
      hook?: string;
      script?: string;
      youtube_title?: string;
      description?: string;
      tags?: string[];
    },
  ) =>
    request<BookShort>(bookPath(bookId, `/shorts/${index}`), {
      method: "PATCH",
      body: JSON.stringify(fields),
    }),

  removeShort: (bookId: string, index: number) =>
    request<{ book_id: string; index: number }>(bookPath(bookId, `/shorts/${index}`), { method: "DELETE" }),

  regenerateShort: (bookId: string, index: number) =>
    request<BookShort>(bookPath(bookId, `/shorts/${index}/regenerate`), { method: "POST" }),

  regenerateShortMetadata: (bookId: string, index: number) =>
    request<BookShort>(bookPath(bookId, `/shorts/${index}/metadata`), { method: "POST" }),

  renderShorts: (bookId: string, body: BookShortsRenderRequest) =>
    request<RenderResult>(bookPath(bookId, "/shorts/render"), {
      method: "POST",
      body: JSON.stringify(body),
    }),

  renderShort: (bookId: string, index: number, body?: BookShortsRenderRequest) =>
    request<RenderResult>(bookPath(bookId, `/shorts/${index}/render`), {
      method: "POST",
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),

  remove: (bookId: string) =>
    request<{ book_id: string; segments: number; cancelled: number }>(bookPath(bookId), { method: "DELETE" }),
};

// ---------------------------------------------------------------------------
// Progress stream
// ---------------------------------------------------------------------------

/** One line a running task wrote about itself. `segment` is -1 for the OCR pass. */
export interface BookLogLine {
  segment: number;
  line: string;
}

export interface BookEvent {
  book_id: string;
  state: BookState;
  revision: number;
  progress: number;
  counts: {
    total: number;
    pending: number;
    queued: number;
    rendering: number;
    complete: number;
    failed: number;
  };
  segments: { index: number; state: BookSegmentState }[];
  ocr?: {
    pages_total: number;
    pages_done: number;
    pages_failed: number;
    mean_confidence: number;
  } | null;
  /**
   * The tail of what the active work is saying, newest last.
   *
   * Bounded server-side to a couple of dozen lines and rendered as it arrives,
   * so neither the payload nor the browser accumulates a book-length transcript.
   */
  recent_logs?: BookLogLine[];
  shorts?: {
    state: BookShortsPlanState | "rendering";
    revision: number;
    chunks_total: number;
    chunks_done: number;
    counts: BookProgress;
    items: { index: number; state: BookShortState }[];
  };
  shorts_logs?: { index: number; line: string }[];
}

/**
 * Subscribes to a book's aggregate render progress.
 *
 * Returns an unsubscribe function; the caller owns the lifetime. `onError`
 * fires for both the server's named `error` event and a transport failure,
 * because either way the stream is over and the caller has to poll instead.
 */
export function subscribeToBook(
  bookId: string,
  handlers: {
    onProgress?: (event: BookEvent) => void;
    onDone?: (event: BookEvent) => void;
    onError?: (message?: string) => void;
  },
): () => void {
  const source = new EventSource(`/api/v1${bookPath(bookId, "/events")}`);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    source.close();
  };

  source.addEventListener("book", (event) => {
    handlers.onProgress?.(JSON.parse((event as MessageEvent).data) as BookEvent);
  });

  source.addEventListener("done", (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as BookEvent;
    close();
    handlers.onDone?.(payload);
  });

  source.addEventListener("error", (event) => {
    // The browser's own error event carries no data; the server's named one does.
    const data: unknown = (event as MessageEvent).data;
    if (closed) return;
    close();
    let message: string | undefined;
    if (typeof data === "string") {
      try {
        message = (JSON.parse(data) as { message?: string }).message;
      } catch {
        message = data;
      }
    }
    handlers.onError?.(message);
  });

  return close;
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Seconds as `m:ss` or `1h 04m`.
 *
 * Estimated durations arrive as raw floats and a book segment is routinely
 * longer than an hour, so neither a bare number nor `mm:ss` alone would read.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Retargets a streamed task-file URL so the browser saves it.
 *
 * Segment URLs are `/tasks/...` (optionally behind `app.endpoint`). Those
 * paths play inline. The video API already exposes `/api/v1/download/...`
 * with `Content-Disposition: attachment`; this keeps the same relative path.
 */
export function taskDownloadUrl(fileUrl: string): string {
  const marker = "/tasks/";
  const at = fileUrl.indexOf(marker);
  if (at < 0) return fileUrl;
  return `/api/v1/download/${fileUrl.slice(at + marker.length)}`;
}

/** A filename the browser can save, derived from the segment title. */
export function segmentDownloadName(title: string, fileUrl: string): string {
  const ext = fileUrl.split("?")[0]?.split(".").pop() || "bin";
  const base = title.replace(/[^\p{L}\p{N}\s._-]+/gu, "").trim().replace(/\s+/g, " ") || "segment";
  return `${base}.${ext}`;
}

/** A change was refused because segments are mid-render. */
export function isRenderConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

interface ZodIssueLike {
  path?: (string | number)[];
  message?: string;
}

/** Validation failures come back as the raw zod issue list in `data`. */
function zodIssues(detail: unknown): ZodIssueLike[] {
  if (!Array.isArray(detail)) return [];
  return detail.filter(
    (issue): issue is ZodIssueLike =>
      typeof issue === "object" && issue !== null && typeof (issue as ZodIssueLike).message === "string",
  );
}

/**
 * A failure as a sentence, never a JSON dump.
 *
 * Field errors are the common case and the server sends them as zod issues,
 * which are unreadable raw; they are flattened to `field: message`.
 */
export function errorText(error: unknown, t: Translate): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return error.message?.trim() || t("Book Busy Rendering");
    const issues = zodIssues(error.detail);
    if (issues.length > 0) {
      return issues
        .map((issue) => {
          const field = (issue.path ?? []).join(".").replace(/_/g, " ");
          return field ? `${field}: ${issue.message}` : String(issue.message);
        })
        .join("; ");
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Rule ids are stable server-side; unknown ones degrade to a readable form. */
export function ruleLabel(rule: string, t: Translate): string {
  if (!rule) return "";
  const key = `book_rule.${rule}`;
  const label = t(key);
  return label === key ? rule.replace(/_/g, " ") : label;
}

export function blockKindLabel(kind: string, t: Translate): string {
  const key = `book_kind.${kind}`;
  const label = t(key);
  return label === key ? kind.replace(/_/g, " ") : label;
}
