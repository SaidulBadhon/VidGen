/**
 * MongoDB document shapes.
 *
 * Task fields keep the snake_case names the v1 API already returns, so a task
 * document can be serialised to an API response without a translation layer.
 */

import type { Settings } from "../config/schema.ts";
import type { CrossPostState } from "../models/const.ts";
import type { VideoParams } from "../models/schema.ts";

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
