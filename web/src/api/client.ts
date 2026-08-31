/**
 * Typed client for the v1 API.
 *
 * Field names stay snake_case to match the server contract exactly, so request
 * bodies can be handed straight to the API without a mapping layer.
 */

export interface ApiEnvelope<T> {
  status: number;
  data?: T;
  message?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

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

export interface Settings {
  app: Record<string, unknown>;
  whisper: Record<string, unknown>;
  proxy: Record<string, unknown>;
  azure: Record<string, unknown>;
  siliconflow: Record<string, unknown>;
  elevenlabs: Record<string, unknown>;
  chatterbox: Record<string, unknown>;
  qdrant: {
    url: string;
    api_key: string;
    collection: string;
  };
  footage_index: {
    enabled: boolean;
    auto_index: boolean;
    describe_model: string;
    embed_model: string;
    concurrency: number;
    /**
     * Minutes between the server's own index passes; `0` turns the loop off.
     * Fractional values are valid, and the server holds anything above zero to
     * a one-second floor.
     */
    index_interval_minutes: number;
    proxy_height: number;
    proxy_fps: number;
    proxy_max_seconds: number;
  };
  scene_footage: {
    enabled: boolean;
    shortlist_size: number;
    judge_batch: number;
    judge_model: string;
    duration_ratio: number;
    concurrency: number;
    fallback_enabled: boolean;
  };
  ui: Record<string, unknown>;
}

export interface SettingsMetadata {
  /** Dotted paths (`app.openai_api_key`) the server takes from the environment. */
  env_managed_fields: string[];
  llm_providers: {
    provider_id: string;
    label: string;
    api_key_url: string;
    default_model: string;
    default_base_url: string;
    requires_api_key: boolean;
    requires_base_url: boolean;
    show_api_key: boolean;
    show_base_url: boolean;
  }[];
  video_codecs: string[];
  fonts: string[];
  subtitle_positions: string[];
  video_aspects: string[];
  video_sources: string[];
  transition_modes: (string | null)[];
}

export interface TaskWarning {
  code: string;
  video_index: number;
}

export interface Task {
  task_id: string;
  state: number;
  progress: number;
  params?: Record<string, unknown>;
  script?: string;
  terms?: string[];
  videos?: string[];
  combined_videos?: string[];
  subtitle_path?: string;
  audio_file?: string;
  audio_duration?: number;
  materials?: string[];
  failed_stage?: string | null;
  error?: string | null;
  warnings?: TaskWarning[] | null;
  cross_post_state?: string | null;
  cross_post_error?: string | null;
  youtube_upload_state?: string | null;
  youtube_upload_error?: string | null;
  youtube_upload_results?: YoutubeUploadResult[] | null;
  logs?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface MediaFile {
  name: string;
  size: number;
  file: string;
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

export interface YoutubeChannel {
  id: string;
  channel_id: string;
  title: string;
  custom_url: string | null;
  thumbnail_url: string | null;
  google_account_email: string | null;
  auto_upload: boolean;
  playlist_access: boolean;
  error: string | null;
  created_at?: string;
  updated_at?: string;
  connected_at?: string;
}

export interface YoutubePlaylist {
  id: string;
  title: string;
  item_count: number;
}

export interface YoutubeStatus {
  configured: boolean;
  redirect_uri: string;
  redirect_uri_from_env: boolean;
  channel_count: number;
  privacy_status: "public" | "unlisted" | "private";
}

// ---------------------------------------------------------------------------
// Footage library
// ---------------------------------------------------------------------------

/** Who shot the clip, when the provider tells us. Absent on locally pulled clips. */
export interface FootageCreator {
  name?: string;
  profile_page?: string;
}

/**
 * One indexed stock clip, exactly as the Qdrant payload stores it.
 *
 * Everything except `score` is written at index time by the describe pass, so
 * the fields are the vision model's vocabulary rather than a closed enum — see
 * `server/src/services/footage/types.ts`. `summary` doubles as the title; there
 * is no separate title field.
 */
export interface FootageItem {
  local_file: string;
  duration: number;
  width: number;
  height: number;
  aspect: string;
  bytes: number;
  provider: string;
  asset_id?: string;
  source_page?: string;
  creator?: FootageCreator;
  search_terms: string[];
  summary: string;
  detailed_description: string;
  use_cases: string[];
  mood: string[];
  tags: string[];
  setting: string;
  time_of_day: string;
  camera_motion: string;
  has_people: boolean;
  has_on_screen_text: boolean;
  quality_flags: string[];
  indexed_at: string;
  /** Relevance, present only when the request carried `q`. */
  score?: number;
}

export interface FootageListResult {
  total: number;
  items: FootageItem[];
}

/**
 * The `/footage/list` query.
 *
 * `q` switches the endpoint from a plain listing to a semantic search: items
 * come back carrying `score` and ordered by relevance instead of by the
 * library's own order.
 *
 * `sort` is a passthrough. The server owns its vocabulary and the UI does not
 * invent one, so it only ever carries a value a caller put in the URL.
 */
export interface FootageListQuery {
  limit?: number;
  offset?: number;
  aspect?: string;
  provider?: string;
  has_people?: boolean;
  min_duration?: number;
  q?: string;
  sort?: string;
}

export interface FootageStats {
  files: { count: number; bytes: number };
  rows: { total: number; indexed: number; stale: number; failed: number; current: number };
  qdrant: {
    ok: boolean;
    url: string;
    collection: string;
    alias: string;
    version?: string;
    detail?: string;
    /** Null when Qdrant did not answer: unknown is not the same as empty. */
    points: number | null;
  };
  drift: { orphan_points: number; missing_points: number } | null;
  lock: { held: boolean; [key: string]: unknown } | null;
}

export interface ConnectionTestResult {
  success: boolean;
  message: string;
  elapsedSeconds?: number;
  provider?: string;
  model?: string;
}

/** Placeholder the server sends instead of a stored secret. */
export const SECRET_PLACEHOLDER = "__stored__";

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const api = {
  health: () => request<{ version: string; database: string; ffmpeg: string }>("/health"),

  getSettings: () => request<Settings>("/settings"),
  saveSettings: (patch: Partial<Settings>) =>
    request<Settings>("/settings", { method: "POST", body: JSON.stringify(patch) }),
  getSettingsMetadata: () => request<SettingsMetadata>("/settings/metadata"),

  generateScript: (body: Record<string, unknown>) =>
    request<{ video_script: string }>("/scripts", { method: "POST", body: JSON.stringify(body) }),
  generateTerms: (body: Record<string, unknown>) =>
    request<{ video_terms: string[] }>("/terms", { method: "POST", body: JSON.stringify(body) }),
  previewPrompt: (body: Record<string, unknown>) =>
    request<{ prompt: string }>("/scripts/preview-prompt", { method: "POST", body: JSON.stringify(body) }),
  testLlm: () => request<ConnectionTestResult>("/llm/test-connection", { method: "POST" }),
  testProvider: (provider: string) =>
    request<ConnectionTestResult>(`/providers/${provider}/test`, { method: "POST" }),

  createVideo: (body: Record<string, unknown>) =>
    request<{ task_id: string }>("/videos", { method: "POST", body: JSON.stringify(body) }),
  listTasks: (page = 1, pageSize = 20) =>
    request<{ tasks: Task[]; total: number; page: number; page_size: number }>(
      `/tasks?page=${page}&page_size=${pageSize}`,
    ),
  getTask: (taskId: string) => request<Task>(`/tasks/${taskId}`),
  deleteTask: (taskId: string) => request<void>(`/tasks/${taskId}`, { method: "DELETE" }),
  cancelTask: (taskId: string) => request<void>(`/tasks/${taskId}/cancel`, { method: "POST" }),
  queueStats: () =>
    request<{ running: number; queued: number; maxConcurrent: number; maxQueued: number }>("/queue"),

  listMusics: () => request<{ files: MediaFile[] }>("/musics"),
  uploadMusic: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ file: string }>("/musics", { method: "POST", body: form });
  },
  listMaterials: () => request<{ files: MediaFile[] }>("/video_materials"),
  uploadMaterial: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ file: string }>("/video_materials", { method: "POST", body: form });
  },
  deleteMaterial: (name: string) =>
    request<void>(`/video_materials/${encodeURIComponent(name)}`, { method: "DELETE" }),

  listVoices: (server: string) =>
    request<{ server: string; voices: string[] }>(`/voices?server=${encodeURIComponent(server)}`),

  /**
   * One page of the footage library.
   *
   * Undefined and empty values are dropped rather than sent blank, so an
   * unset filter is absent from the query string instead of arriving as
   * `aspect=` — the two are not the same request.
   */
  listFootage: (query: FootageListQuery = {}) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      search.set(key, String(value));
    }
    const suffix = search.toString();
    return request<FootageListResult>(`/footage/list${suffix ? `?${suffix}` : ""}`);
  },
  footageStats: () => request<FootageStats>("/footage/stats"),

  /** Poster frame for a clip. Served as image/jpeg. */
  footageThumbUrl: (localFile: string) => `/api/v1/footage/thumb/${encodeURIComponent(localFile)}`,
  /** The clip itself. Range-capable, so `<video controls>` can seek. */
  footageClipUrl: (localFile: string) => `/api/v1/footage/clip/${encodeURIComponent(localFile)}`,

  /** Synthesises a short listen of the selected voice. Returns a playable blob. */
  previewVoice: async (
    body: { voice_name: string; voice_rate: number; voice_volume: number; text: string },
    signal?: AbortSignal,
  ): Promise<{ blob: Blob; mimeType: string; duration: number | null }> => {
    const response = await fetch("/api/v1/voices/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      let message = `request failed with status ${response.status}`;
      try {
        const envelope = (await response.json()) as ApiEnvelope<unknown>;
        if (envelope.message) message = envelope.message;
      } catch {
        // Non-JSON error body; keep the status text.
      }
      throw new ApiError(message, response.status);
    }

    const blob = await response.blob();
    const durationHeader = response.headers.get("X-Audio-Duration");
    const duration = durationHeader ? Number(durationHeader) : NaN;
    return {
      blob,
      mimeType: response.headers.get("Content-Type") ?? blob.type,
      duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    };
  },

  musicFileUrl: (filename: string) => `/api/v1/musics/${encodeURIComponent(filename)}`,

  cacheStats: () =>
    request<{ videos: { files: number; bytes: number }; search: { entries: number; assets: number } }>(
      "/cache/stats",
    ),
  clearCache: (scope: "all" | "videos" | "search", maxAgeDays?: number) =>
    request<{ removed_files: number; removed_searches: number }>(
      `/cache/clear?scope=${scope}${maxAgeDays ? `&max_age_days=${maxAgeDays}` : ""}`,
      { method: "POST" },
    ),

  youtubeStatus: (origin = window.location.origin) =>
    request<YoutubeStatus>(`/youtube/status?origin=${encodeURIComponent(origin)}`),
  listYoutubeChannels: () => request<{ channels: YoutubeChannel[] }>("/youtube/channels"),
  listYoutubePlaylists: (channelId: string) =>
    request<{ playlists: YoutubePlaylist[] }>(`/youtube/channels/${channelId}/playlists`),
  createYoutubePlaylist: (
    channelId: string,
    body: { title: string; description?: string; privacy_status?: "public" | "unlisted" | "private" },
  ) =>
    request<{ playlist: YoutubePlaylist }>(`/youtube/channels/${channelId}/playlists`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  startYoutubeOAuth: (origin = window.location.origin) =>
    request<{ url: string; redirect_uri: string }>(
      `/youtube/oauth/start?origin=${encodeURIComponent(origin)}`,
    ),
  setYoutubeChannelAutoUpload: (id: string, auto_upload: boolean) =>
    request<{ channels: YoutubeChannel[] }>(`/youtube/channels/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ auto_upload }),
    }),
  disconnectYoutubeChannel: (id: string) =>
    request<{ id: string }>(`/youtube/channels/${id}`, { method: "DELETE" }),
  uploadToYoutube: (body: {
    source: "task" | "book_short" | "book_segment";
    task_id?: string;
    book_id?: string;
    short_index?: number;
    segment_index?: number;
    video_index?: number;
    channel_ids: string[];
    title?: string;
    description?: string;
    tags?: string[];
    privacy_status?: "public" | "unlisted" | "private";
    playlist_ids?: Record<string, string>;
    publish_at?: string;
  }) => request<{ task_id?: string; book_id?: string; index?: number; channels: number }>(
    "/youtube/uploads",
    { method: "POST", body: JSON.stringify(body) },
  ),
  generateYoutubeListing: (body: {
    source: "task" | "book_short" | "book_segment";
    task_id?: string;
    book_id?: string;
    short_index?: number;
    segment_index?: number;
  }) => request<{ title: string; description: string; tags: string[] }>(
    "/youtube/listing",
    { method: "POST", body: JSON.stringify(body) },
  ),
};

/**
 * Subscribes to a task's live progress.
 * Returns an unsubscribe function; the caller owns the lifetime.
 */
export function subscribeToTask(
  taskId: string,
  handlers: { onTask?: (task: Task) => void; onLogs?: (lines: string[]) => void; onDone?: (task: Task) => void },
): () => void {
  const source = new EventSource(`/api/v1/tasks/${taskId}/events`);

  source.addEventListener("task", (event) => handlers.onTask?.(JSON.parse((event as MessageEvent).data) as Task));
  source.addEventListener("logs", (event) => handlers.onLogs?.(JSON.parse((event as MessageEvent).data) as string[]));
  source.addEventListener("done", (event) => {
    handlers.onDone?.(JSON.parse((event as MessageEvent).data) as Task);
    source.close();
  });
  source.addEventListener("error", () => source.close());

  return () => source.close();
}
