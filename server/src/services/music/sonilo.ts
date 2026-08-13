/**
 * Sonilo video-to-music.
 * Ported from python-version/app/services/sonilo.py.
 *
 * Sonilo streams NDJSON events carrying base64 audio chunks rather than
 * returning a finished file, so the response is consumed incrementally with
 * hard caps on total size.
 */

import { rename } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { getSettings } from "../../config/settings.ts";
import { logger, errorMessage } from "../../utils/logger.ts";
import { validateAudioFile } from "../bgm.ts";
import { createVideoProxy, MusicProviderError, removeFile } from "./proxy.ts";

export class SoniloError extends MusicProviderError {
  constructor(message: string) {
    super(message);
    this.name = "SoniloError";
  }
}

export const DEFAULT_BASE_URL = "https://api.sonilo.com";
const VIDEO_TO_MUSIC_PATH = "/v1/video-to-music";
const SERVICES_PATH = "/v1/account/services";
export const MAX_VIDEO_DURATION_SECONDS = 360;
export const MAX_PROMPT_LENGTH = 2000;
const MAX_PROXY_BYTES = 300 * 1024 * 1024;
const MAX_GENERATED_AUDIO_BYTES = 30 * 1024 * 1024;
const VIDEO_TO_MUSIC_SERVICE_ID = "video_to_music";

export function getApiKey(): string {
  const configured = String(getSettings().app.sonilo_api_key ?? "").trim();
  return configured || (process.env.SONILO_API_KEY ?? "").trim();
}

export function isEnabled(): boolean {
  return Boolean(getApiKey());
}

function baseUrl(): string {
  return (String(getSettings().app.sonilo_base_url ?? "").trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/**
 * Idle timeout for the generation stream.
 *
 * This bounds how long the stream may go without data, not the total request:
 * generation legitimately takes minutes.
 */
function requestTimeoutMs(): number {
  const seconds = Number(getSettings().app.sonilo_timeout ?? 600);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 600) * 1000;
}

/** Confirms the account has video-to-music enabled, without spending credit. */
export async function validateGenerationAccess(): Promise<void> {
  const apiKey = getApiKey();
  if (!apiKey) throw new SoniloError("Sonilo background music requires an API key");

  try {
    const response = await fetch(`${baseUrl()}${SERVICES_PATH}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new SoniloError("Sonilo rejected the configured API key");
    }
    if (!response.ok) return; // Transient problems must not block generation.

    const data = (await response.json()) as { services?: { id?: string; enabled?: boolean }[] };
    const service = data.services?.find(
      (entry) => String(entry.id ?? "").trim().toLowerCase() === VIDEO_TO_MUSIC_SERVICE_ID,
    );
    if (service && service.enabled === false) {
      throw new SoniloError("the Sonilo account does not have video-to-music enabled");
    }
  } catch (error) {
    if (error instanceof SoniloError) throw error;
    // Network noise cannot be distinguished from a real permission problem, so
    // the actual generation attempt is left to decide.
    logger.warning(`could not verify Sonilo account services: ${errorMessage(error)}`);
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
  if (!apiKey) throw new SoniloError("Sonilo background music requires an API key");

  const prompt = String(options.prompt ?? "").trim();
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new SoniloError(`Sonilo music prompt exceeds ${MAX_PROMPT_LENGTH} characters`);
  }
  if (options.videoDuration > MAX_VIDEO_DURATION_SECONDS) {
    throw new SoniloError(`Sonilo supports videos up to ${MAX_VIDEO_DURATION_SECONDS} seconds`);
  }

  const proxyPath = await createVideoProxy(options.videoPath, MAX_PROXY_BYTES, "sonilo");
  const outputDir = dirname(resolve(options.outputPath));
  await mkdir(outputDir, { recursive: true });
  const tempAudioPath = join(outputDir, `.sonilo-audio-${crypto.randomUUID().slice(0, 8)}${extname(options.outputPath) || ".m4a"}`);

  try {
    const form = new FormData();
    form.append("video", new Blob([await Bun.file(proxyPath).arrayBuffer()], { type: "video/mp4" }), "video.mp4");
    if (prompt) form.append("prompt", prompt);

    logger.info(`requesting Sonilo background music: prompt_provided=${Boolean(prompt)}`);
    const response = await fetch(`${baseUrl()}${VIDEO_TO_MUSIC_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: options.signal ?? AbortSignal.timeout(requestTimeoutMs()),
    });

    if (!response.ok) {
      throw new SoniloError(`Sonilo request failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    }
    if (!response.body) throw new SoniloError("Sonilo returned an empty response body");

    const { totalBytes, title } = await streamAudio(response.body, tempAudioPath);
    if (totalBytes <= 0) throw new SoniloError("Sonilo returned no audio data");

    // Validate before publishing: a corrupt track would fail much later, during
    // the final mix, where the cause is far harder to see.
    await validateAudioFile(tempAudioPath, 120);
    await rename(tempAudioPath, options.outputPath);

    logger.success(`Sonilo background music ready: ${options.outputPath}${title ? ` (${title})` : ""}`);
    return options.outputPath;
  } catch (error) {
    await removeFile(tempAudioPath);
    if (error instanceof MusicProviderError) throw error;
    throw new SoniloError(errorMessage(error));
  } finally {
    await removeFile(proxyPath);
  }
}

/** Consumes the NDJSON event stream into an audio file. */
async function streamAudio(
  body: ReadableStream<Uint8Array>,
  tempAudioPath: string,
): Promise<{ totalBytes: number; title: string }> {
  const writer = Bun.file(tempAudioPath).writer();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalBytes = 0;
  let title = "";
  let complete = false;

  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          // Truncated or non-object lines are a protocol violation; failing
          // loudly beats silently producing a half-written track.
          throw new SoniloError("Sonilo returned a malformed event");
        }

        const type = String(event.type ?? "");
        if (type === "error") {
          throw new SoniloError(String(event.message ?? event.error ?? "unknown error"));
        }
        if (type === "title") {
          title = String(event.title ?? event.data ?? "").slice(0, 200);
          continue;
        }
        if (type === "complete") {
          complete = true;
          continue;
        }
        if (type !== "audio_chunk") {
          logger.debug(`ignoring unsupported Sonilo event: type=${type}`);
          continue;
        }

        const encoded = event.data ?? event.audio;
        if (typeof encoded !== "string" || !encoded) {
          throw new SoniloError("Sonilo returned an empty audio chunk");
        }

        const decoded = Buffer.from(encoded, "base64");
        if (decoded.byteLength === 0) throw new SoniloError("Sonilo returned an empty audio chunk");

        totalBytes += decoded.byteLength;
        if (totalBytes > MAX_GENERATED_AUDIO_BYTES) {
          throw new SoniloError("Sonilo audio exceeds the 30 MB limit");
        }
        writer.write(decoded);
      }
    }
  } finally {
    await writer.end();
  }

  if (!complete) logger.warning("Sonilo stream ended without a completion event");
  return { totalBytes, title };
}

export async function testConnection(): Promise<{ success: boolean; message: string }> {
  try {
    await validateGenerationAccess();
    return { success: true, message: "Sonilo API key accepted" };
  } catch (error) {
    return { success: false, message: errorMessage(error) };
  }
}
