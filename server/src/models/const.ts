/** Shared constants. Ported from python-version/app/models/const.py. */

/**
 * Characters treated as natural sentence boundaries when aligning a script to
 * TTS word-boundary events or Whisper segments. Arabic punctuation is included
 * so script text and TTS pause boundaries stay consistent for RTL languages.
 */
export const PUNCTUATIONS = [
  "?",
  ",",
  ".",
  "、",
  ";",
  ":",
  "!",
  "…",
  "？",
  "，",
  "。",
  "、",
  "；",
  "：",
  "！",
  "...",
  "،",
  "؛",
  "؟",
] as const;

export const TASK_STATE_FAILED = -1;
export const TASK_STATE_COMPLETE = 1;
export const TASK_STATE_PROCESSING = 4;

export type TaskState =
  | typeof TASK_STATE_FAILED
  | typeof TASK_STATE_COMPLETE
  | typeof TASK_STATE_PROCESSING;

export const CROSS_POST_STATE_PENDING = "pending";
export const CROSS_POST_STATE_PROCESSING = "processing";
export const CROSS_POST_STATE_COMPLETE = "complete";
export const CROSS_POST_STATE_FAILED = "failed";

export type CrossPostState =
  | typeof CROSS_POST_STATE_PENDING
  | typeof CROSS_POST_STATE_PROCESSING
  | typeof CROSS_POST_STATE_COMPLETE
  | typeof CROSS_POST_STATE_FAILED;

export const ACTIVE_CROSS_POST_STATES: ReadonlySet<string> = new Set([
  CROSS_POST_STATE_PENDING,
  CROSS_POST_STATE_PROCESSING,
]);

export const FILE_TYPE_VIDEOS = ["mp4", "mov", "mkv", "webm"] as const;
export const FILE_TYPE_IMAGES = ["jpg", "jpeg", "png", "bmp"] as const;

/** Extensions accepted by the local material upload endpoint. */
export const ALLOWED_MATERIAL_SUFFIXES = [
  "mp4",
  "mov",
  "avi",
  "flv",
  "mkv",
  "jpg",
  "jpeg",
  "png",
] as const;

/** Stages the pipeline can stop at, in execution order. */
export const STOP_AT_STAGES = [
  "script",
  "terms",
  "audio",
  "subtitle",
  "materials",
  "video",
] as const;

export type StopAt = (typeof STOP_AT_STAGES)[number];
