/**
 * Application settings schema.
 *
 * Keys keep the snake_case names from python-version/config.example.toml so the
 * documentation, the CLI flags and a future config.toml importer all line up
 * with what is stored in MongoDB.
 *
 * Every field has a default, so a partial or empty document still parses into a
 * complete settings object — that is what makes first boot work with no setup.
 */

import { z } from "zod";
import { DEFAULT_LLM_PROVIDER_ID, LLM_PROVIDER_IDS } from "./llmProviders.ts";

/** Accepts a single string or a list, and normalises to a trimmed list. */
const apiKeyList = z
  .union([z.string(), z.array(z.string())])
  .default([])
  .transform((value) => (typeof value === "string" ? (value.trim() ? [value.trim()] : []) : value.map((v) => String(v).trim()).filter(Boolean)));

const SUPPORTED_VIDEO_CODECS = [
  "libx264",
  "h264_nvenc",
  "h264_amf",
  "h264_qsv",
  "h264_mf",
  "h264_videotoolbox",
] as const;

export const appSettingsSchema = z.object({
  // --- General -------------------------------------------------------------
  hide_config: z.boolean().default(false),
  /** Seconds for one Edge TTS streaming request; 0 disables the timeout. */
  edge_tts_timeout: z.number().default(30),
  /** Verify TLS for provider APIs and material downloads. Keep on. */
  tls_verify: z.boolean().default(true),

  // --- Video materials -----------------------------------------------------
  video_source: z.enum(["pexels", "pixabay", "coverr", "local"]).default("pexels"),
  pexels_api_keys: apiKeyList,
  pixabay_api_keys: apiKeyList,
  coverr_api_keys: apiKeyList,

  twelvelabs_api_keys: apiKeyList,
  twelvelabs_rerank_terms: z.boolean().default(false),
  twelvelabs_marengo_model: z.string().default("marengo3.0"),
  twelvelabs_pegasus_model: z.string().default("pegasus1.5"),

  /** Order search terms and downloads to follow the script's narrative. */
  match_materials_to_script: z.boolean().default(false),

  // --- AI background music -------------------------------------------------
  sonilo_api_key: z.string().default(""),
  sonilo_base_url: z.string().default("https://api.sonilo.com"),
  /** Max seconds of silence on the generation stream, not a total deadline. */
  sonilo_timeout: z.number().default(600),

  // --- LLM -----------------------------------------------------------------
  llm_provider: z.enum(LLM_PROVIDER_IDS as [string, ...string[]]).default(DEFAULT_LLM_PROVIDER_ID),

  gemini_api_key: z.string().default(""),
  gemini_base_url: z.string().default(""),
  gemini_model_name: z.string().default(""),

  openai_api_key: z.string().default(""),
  openai_base_url: z.string().default(""),
  openai_model_name: z.string().default(""),

  /** Gemma is served by Ollama; no API key, base URL detected when empty. */
  gemma_api_key: z.string().default(""),
  gemma_base_url: z.string().default(""),
  gemma_model_name: z.string().default(""),

  // --- Speech, subtitles, video -------------------------------------------
  /** MiMo TTS shares its key and base URL with the MiMo chat endpoint. */
  mimo_api_key: z.string().default(""),
  mimo_base_url: z.string().default(""),
  mimo_tts_model_name: z.string().default("mimo-v2.5-tts"),
  mimo_tts_style_prompt: z
    .string()
    .default("请用自然、清晰、适合短视频旁白的语气朗读。"),

  /** "edge" uses TTS word boundaries, "whisper" transcribes, "" skips. */
  subtitle_provider: z.enum(["edge", "whisper", ""]).default("edge"),

  /** Empty means the app default (libx264). Unsupported encoders fall back. */
  video_codec: z.enum(["", ...SUPPORTED_VIDEO_CODECS]).default(""),

  // --- Book OCR ------------------------------------------------------------
  /**
   * Engine for pages with no text layer. "" disables OCR, so a scanned page
   * yields nothing rather than guessed text — the safe default for a pipeline
   * that narrates what it extracts.
   */
  ocr_provider: z.enum(["", "tesseract", "ollama"]).default(""),
  /** Tesseract language code(s), e.g. "eng" or "eng+deu". Vision models ignore it. */
  ocr_language: z.string().default("eng"),
  /** Explicit path to the tesseract binary; empty resolves it from PATH. */
  tesseract_path: z.string().default(""),
  /** Must be a vision-capable Ollama model, and tagged: a bare name can be rejected. */
  ocr_ollama_model: z.string().default("minicpm-v:latest"),
  /**
   * Overrides the built-in transcription prompt. Empty keeps it, and empty is
   * strongly preferred: the built-in wording is the one measured to stop the
   * model inventing structural labels, and it ships with the code rather than
   * being frozen into this document on first save.
   */
  ocr_ollama_prompt: z.string().default(""),
  /** Seconds for one page. A stuck vision model must not hang a book import. */
  ocr_ollama_timeout: z.number().default(120),
  /** 0..1. Tesseract pages scoring below this are re-read by the vision model. */
  ocr_min_confidence: z.number().min(0).max(1).default(0.75),

  // --- Storage and task runtime -------------------------------------------
  /** Public base URL for generated media links; empty yields relative paths. */
  endpoint: z.string().default(""),
  /** "" -> storage/cache_videos, "task" -> per-task dir, or an absolute path. */
  material_directory: z.string().default(""),
  max_concurrent_tasks: z.number().int().min(1).default(5),
  max_queued_tasks: z.number().int().min(1).default(100),

  // --- Cross-platform publishing ------------------------------------------
  upload_post_enabled: z.boolean().default(false),
  upload_post_api_key: z.string().default(""),
  upload_post_username: z.string().default(""),
  upload_post_platforms: z.array(z.string()).default(["tiktok", "instagram"]),
  upload_post_auto_upload: z.boolean().default(false),
  upload_post_youtube_privacy_status: z
    .enum(["public", "unlisted", "private"])
    .default("public"),
  upload_post_max_pending_tasks: z.number().int().min(1).default(10),
});

export const whisperSettingsSchema = z.object({
  /**
   * Transcription backend.
   * - "whisper-cpp": local whisper.cpp binary, model auto-downloaded to models/
   * - "openai-api": any OpenAI-compatible /v1/audio/transcriptions endpoint,
   *   which can be a local server or a hosted one
   */
  provider: z.enum(["whisper-cpp", "openai-api"]).default("whisper-cpp"),
  model_size: z.string().default("large-v3"),
  /** Reserved for whisper.cpp builds with GPU support. */
  device: z.enum(["cpu", "cuda", "auto"]).default("auto"),
  /** Biases the decoder toward specific vocabulary. Empty disables it. */
  initial_prompt: z.string().default(""),
  /** Forces a language instead of auto-detecting. Empty auto-detects. */
  language: z.string().default(""),

  // Used only when provider is "openai-api".
  api_base_url: z.string().default("https://api.openai.com/v1"),
  api_key: z.string().default(""),
  api_model: z.string().default("whisper-1"),
});

export const proxySettingsSchema = z.object({
  http: z.string().default(""),
  https: z.string().default(""),
});

export const azureSettingsSchema = z.object({
  speech_key: z.string().default(""),
  speech_region: z.string().default(""),
});

export const siliconflowSettingsSchema = z.object({
  api_key: z.string().default(""),
});

export const elevenlabsSettingsSchema = z.object({
  api_key: z.string().default(""),
  model_id: z.string().default("eleven_multilingual_v2"),
  /** Video-to-Music uses a separate model family on the same key. */
  music_model_id: z.enum(["music_v1", "music_v2"]).default("music_v2"),
  music_timeout: z.number().default(600),
});

export const chatterboxSettingsSchema = z.object({
  base_url: z.string().default("http://127.0.0.1:4123/v1"),
  api_key: z.string().default(""),
  model_id: z.string().default("chatterbox"),
  voices: z.array(z.string()).default(["default-Female"]),
});

export const uiSettingsSchema = z.object({
  hide_log: z.boolean().default(false),
  open_task_folder_on_completion: z.boolean().default(true),
  language: z.string().default(""),
  tts_server: z.string().default("azure-tts-v1"),
  voice_name: z.string().default(""),
  font_name: z.string().default("MicrosoftYaHeiBold.ttc"),
  font_size: z.number().default(60),
  text_fore_color: z.string().default("#FFFFFF"),
  stroke_color: z.string().default("#000000"),
  stroke_width: z.number().default(1.5),
  subtitle_position: z.enum(["top", "center", "bottom", "custom"]).default("bottom"),
  custom_position: z.number().default(70.0),
  subtitle_background_enabled: z.boolean().default(false),
  subtitle_background_color: z.string().default("#000000"),
  rounded_subtitle_background: z.boolean().default(false),
});

export const settingsSchema = z.object({
  app: appSettingsSchema.default({}),
  whisper: whisperSettingsSchema.default({}),
  proxy: proxySettingsSchema.default({}),
  azure: azureSettingsSchema.default({}),
  siliconflow: siliconflowSettingsSchema.default({}),
  elevenlabs: elevenlabsSettingsSchema.default({}),
  chatterbox: chatterboxSettingsSchema.default({}),
  ui: uiSettingsSchema.default({}),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;
export type WhisperSettings = z.infer<typeof whisperSettingsSchema>;
export type ProxySettings = z.infer<typeof proxySettingsSchema>;
export type AzureSettings = z.infer<typeof azureSettingsSchema>;
export type SiliconflowSettings = z.infer<typeof siliconflowSettingsSchema>;
export type ElevenlabsSettings = z.infer<typeof elevenlabsSettingsSchema>;
export type ChatterboxSettings = z.infer<typeof chatterboxSettingsSchema>;
export type UiSettings = z.infer<typeof uiSettingsSchema>;
export type Settings = z.infer<typeof settingsSchema>;

export type SettingsSection = keyof Settings;

/** A complete settings object built purely from schema defaults. */
export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}

/**
 * Fields never returned to the browser in cleartext.
 *
 * The UI shows a masked placeholder and only sends a value back when the user
 * actually types a new one, so a settings round-trip cannot blank a stored key.
 */
export const SECRET_FIELDS: ReadonlyArray<[SettingsSection, string]> = [
  ["app", "pexels_api_keys"],
  ["app", "pixabay_api_keys"],
  ["app", "coverr_api_keys"],
  ["app", "twelvelabs_api_keys"],
  ["app", "sonilo_api_key"],
  ["app", "gemini_api_key"],
  ["app", "openai_api_key"],
  ["app", "gemma_api_key"],
  ["app", "mimo_api_key"],
  ["app", "upload_post_api_key"],
  ["whisper", "api_key"],
  ["azure", "speech_key"],
  ["siliconflow", "api_key"],
  ["elevenlabs", "api_key"],
  ["chatterbox", "api_key"],
];

export { SUPPORTED_VIDEO_CODECS };
