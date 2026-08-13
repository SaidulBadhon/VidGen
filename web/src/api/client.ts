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
  ui: Record<string, unknown>;
}

export interface SettingsMetadata {
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
  logs?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface MediaFile {
  name: string;
  size: number;
  file: string;
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

  cacheStats: () =>
    request<{ videos: { files: number; bytes: number }; search: { entries: number; assets: number } }>(
      "/cache/stats",
    ),
  clearCache: (scope: "all" | "videos" | "search", maxAgeDays?: number) =>
    request<{ removed_files: number; removed_searches: number }>(
      `/cache/clear?scope=${scope}${maxAgeDays ? `&max_age_days=${maxAgeDays}` : ""}`,
      { method: "POST" },
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
