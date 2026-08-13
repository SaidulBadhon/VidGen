/**
 * ElevenLabs video-to-music.
 * Ported from python-version/app/services/elevenlabs_music.py.
 */

import { mkdir, rename } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { getSettings } from "../../config/settings.ts";
import { logger, errorMessage } from "../../utils/logger.ts";
import { validateAudioFile } from "../bgm.ts";
import { getElevenlabsApiKey } from "../voice/voices.ts";
import { createVideoProxy, MusicProviderError, removeFile } from "./proxy.ts";

export class ElevenLabsMusicError extends MusicProviderError {
  constructor(message: string) {
    super(message);
    this.name = "ElevenLabsMusicError";
  }
}

/** Video-to-music is a paid feature; a free key fails with a clear message. */
export class ElevenLabsPaidPlanRequiredError extends ElevenLabsMusicError {}
export class ElevenLabsAuthenticationError extends ElevenLabsMusicError {}

export const DEFAULT_BASE_URL = "https://api.elevenlabs.io";
const VIDEO_TO_MUSIC_PATH = "/v1/music/video-to-music";
const SUBSCRIPTION_PATH = "/v1/user/subscription";
const SUPPORTED_MODEL_IDS = new Set(["music_v1", "music_v2"]);
export const MAX_VIDEO_DURATION_SECONDS = 600;
export const MAX_PROMPT_LENGTH = 1000;
const MAX_PROXY_BYTES = 200 * 1024 * 1024;
const MAX_GENERATED_AUDIO_BYTES = 50 * 1024 * 1024;

export function getApiKey(): string {
  return getElevenlabsApiKey();
}

export function isEnabled(): boolean {
  return Boolean(getApiKey());
}

function modelId(): string {
  const configured = String(getSettings().elevenlabs.music_model_id ?? "").trim();
  return SUPPORTED_MODEL_IDS.has(configured) ? configured : "music_v2";
}

function requestTimeoutMs(): number {
  const seconds = Number(getSettings().elevenlabs.music_timeout ?? 600);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 600) * 1000;
}

/**
 * Checks the plan before spending time on a proxy upload.
 *
 * Free tiers cannot use video-to-music at all, and finding that out after a
 * multi-minute upload wastes the whole render.
 */
export async function validateGenerationAccess(): Promise<void> {
  const apiKey = getApiKey();
  if (!apiKey) throw new ElevenLabsMusicError("ElevenLabs background music requires an API key");

  try {
    const response = await fetch(`${DEFAULT_BASE_URL}${SUBSCRIPTION_PATH}`, {
      headers: { "xi-api-key": apiKey },
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status === 401 || response.status === 403) {
      throw new ElevenLabsAuthenticationError("ElevenLabs rejected the configured API key");
    }
    if (!response.ok) return;

    const data = (await response.json()) as { tier?: string };
    if (String(data.tier ?? "").trim().toLowerCase() === "free") {
      throw new ElevenLabsPaidPlanRequiredError(
        "ElevenLabs video-to-music requires a paid plan; the configured key is on the free tier",
      );
    }
  } catch (error) {
    if (error instanceof ElevenLabsMusicError) throw error;
    logger.warning(`could not verify ElevenLabs subscription: ${errorMessage(error)}`);
  }
}

export interface GenerateBgmOptions {
  videoPath: string;
  outputPath: string;
  videoDuration: number;
  prompt?: string;
  signal?: AbortSignal;
}

export async function generateBgm(options: GenerateBgmOptions): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) throw new ElevenLabsMusicError("ElevenLabs background music requires an API key");

  const prompt = String(options.prompt ?? "").trim();
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new ElevenLabsMusicError(`ElevenLabs music prompt exceeds ${MAX_PROMPT_LENGTH} characters`);
  }
  if (options.videoDuration > MAX_VIDEO_DURATION_SECONDS) {
    throw new ElevenLabsMusicError(`ElevenLabs supports videos up to ${MAX_VIDEO_DURATION_SECONDS} seconds`);
  }

  const proxyPath = await createVideoProxy(options.videoPath, MAX_PROXY_BYTES, "elevenlabs");
  const outputDir = dirname(resolve(options.outputPath));
  await mkdir(outputDir, { recursive: true });
  const tempAudioPath = join(
    outputDir,
    `.elevenlabs-audio-${crypto.randomUUID().slice(0, 8)}${extname(options.outputPath) || ".mp3"}`,
  );

  try {
    const form = new FormData();
    form.append("video", new Blob([await Bun.file(proxyPath).arrayBuffer()], { type: "video/mp4" }), "video.mp4");
    form.append("model_id", modelId());
    if (prompt) form.append("description", prompt);

    logger.info(`requesting ElevenLabs background music: model=${modelId()}, prompt_provided=${Boolean(prompt)}`);
    const response = await fetch(`${DEFAULT_BASE_URL}${VIDEO_TO_MUSIC_PATH}`, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
      signal: options.signal ?? AbortSignal.timeout(requestTimeoutMs()),
    });

    if (response.status === 401 || response.status === 403) {
      throw new ElevenLabsAuthenticationError("ElevenLabs rejected the configured API key");
    }
    if (!response.ok) {
      throw new ElevenLabsMusicError(
        `ElevenLabs request failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`,
      );
    }

    const audio = new Uint8Array(await response.arrayBuffer());
    if (audio.byteLength === 0) throw new ElevenLabsMusicError("ElevenLabs returned no audio data");
    if (audio.byteLength > MAX_GENERATED_AUDIO_BYTES) {
      throw new ElevenLabsMusicError("ElevenLabs audio exceeds the 50 MB limit");
    }

    await Bun.write(tempAudioPath, audio);
    await validateAudioFile(tempAudioPath, 120);
    await rename(tempAudioPath, options.outputPath);

    logger.success(`ElevenLabs background music ready: ${options.outputPath}`);
    return options.outputPath;
  } catch (error) {
    await removeFile(tempAudioPath);
    if (error instanceof MusicProviderError) throw error;
    throw new ElevenLabsMusicError(errorMessage(error));
  } finally {
    await removeFile(proxyPath);
  }
}

export async function testConnection(): Promise<{ success: boolean; message: string }> {
  try {
    await validateGenerationAccess();
    return { success: true, message: "ElevenLabs API key accepted" };
  } catch (error) {
    return { success: false, message: errorMessage(error) };
  }
}
