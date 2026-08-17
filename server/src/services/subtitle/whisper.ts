/**
 * Speech-to-text for subtitle generation.
 *
 * The Python version used faster-whisper, which is Python/CTranslate2 and has
 * no JavaScript equivalent. Ollama — the local runtime this project uses for
 * Gemma — serves language and vision models only and has no speech-to-text
 * endpoint, so it cannot stand in here either.
 *
 * Two adapters keep transcription available without a Python runtime:
 *  - `whisper-cpp` shells out to a `whisper-cli` binary the same way the rest
 *    of the app shells out to ffmpeg, and downloads its GGUF model on first
 *    use. Fully local and offline.
 *  - `openai-api` speaks the standard `/v1/audio/transcriptions` protocol, so
 *    it can point at a local server or a hosted one.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { rename, unlink } from "node:fs/promises";
import { getSettings, resolveContentLanguage } from "../../config/settings.ts";
import { logger, errorMessage } from "../../utils/logger.ts";
import { modelsDir } from "../../utils/paths.ts";
import { runFfmpeg } from "../video/ffmpeg.ts";
import { parseSrtContent, type SubtitleCue } from "./srt.ts";

/** whisper.cpp only accepts 16 kHz mono PCM WAV. */
const WHISPER_SAMPLE_RATE = 16_000;

const MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export class TranscriptionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionUnavailableError";
  }
}

/** Locates the whisper.cpp CLI, accepting both its current and legacy names. */
export function resolveWhisperBinary(): string | null {
  const configured = process.env.WHISPER_CPP_PATH?.trim();
  if (configured) return existsSync(configured) ? configured : null;

  for (const name of ["whisper-cli", "whisper-cpp", "whisper", "main"]) {
    const found = Bun.which(name);
    if (found) return found;
  }
  return null;
}

/**
 * Ensures the GGUF weights are present, downloading them once if needed.
 *
 * Models are large (up to ~3 GB for large-v3), so the download is explicit and
 * logged rather than happening silently inside a render.
 */
async function ensureWhisperModel(modelSize: string): Promise<string> {
  const directory = modelsDir(true);
  const modelPath = join(directory, `ggml-${modelSize}.bin`);

  if (existsSync(modelPath) && statSync(modelPath).size > 0) return modelPath;

  const url = `${MODEL_BASE_URL}/ggml-${modelSize}.bin`;
  logger.info(`downloading whisper model ${modelSize} from ${url} (this happens once)`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new TranscriptionUnavailableError(
      `failed to download whisper model '${modelSize}': HTTP ${response.status}. ` +
        `Download it manually to ${modelPath}.`,
    );
  }

  // Download to a sibling temp file and rename, so an interrupted run never
  // leaves a truncated model that would fail confusingly next time. A rename
  // also avoids copying several gigabytes a second time.
  const temporaryPath = `${modelPath}.part`;
  try {
    await Bun.write(temporaryPath, response);
    await rename(temporaryPath, modelPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw new TranscriptionUnavailableError(
      `failed to save whisper model '${modelSize}': ${errorMessage(error)}`,
    );
  }

  logger.success(`whisper model ready: ${modelPath}`);
  return modelPath;
}

/** Transcodes narration to the format whisper.cpp requires. */
async function toWhisperWav(audioFile: string): Promise<string> {
  const wavPath = `${audioFile}.whisper.wav`;
  await runFfmpeg([
    "-y",
    "-i",
    audioFile,
    "-ar",
    String(WHISPER_SAMPLE_RATE),
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    wavPath,
  ]);
  return wavPath;
}

async function transcribeWithWhisperCpp(audioFile: string): Promise<SubtitleCue[]> {
  const whisper = getSettings().whisper;
  const binary = resolveWhisperBinary();
  if (!binary) {
    throw new TranscriptionUnavailableError(
      "whisper.cpp was not found. Install it (`brew install whisper-cpp` or " +
        "`apt install whisper.cpp`), set WHISPER_CPP_PATH, or switch the " +
        "transcription provider to an OpenAI-compatible endpoint in Settings.",
    );
  }

  const modelPath = await ensureWhisperModel(whisper.model_size);
  const wavPath = await toWhisperWav(audioFile);
  const outputBase = `${audioFile}.whisper`;
  const language = resolveContentLanguage(whisper.language);

  try {
    logger.info(`transcribing with whisper.cpp: model=${whisper.model_size}`);
    await runFfmpegLikeProcess(binary, [
      "-m",
      modelPath,
      "-f",
      wavPath,
      "--output-srt",
      "--output-file",
      outputBase,
      "--language",
      language || "auto",
      ...(whisper.initial_prompt ? ["--prompt", whisper.initial_prompt] : []),
    ]);

    const srtPath = `${outputBase}.srt`;
    if (!existsSync(srtPath)) {
      throw new TranscriptionUnavailableError("whisper.cpp produced no subtitle output");
    }
    const cues = parseSrtContent(await Bun.file(srtPath).text());
    await unlink(srtPath).catch(() => {});
    return cues;
  } finally {
    await unlink(wavPath).catch(() => {});
  }
}

/** Runs an external binary and surfaces its stderr on failure. */
async function runFfmpegLikeProcess(binary: string, args: string[]): Promise<void> {
  const proc = Bun.spawn([binary, ...args], { stdout: "ignore", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new TranscriptionUnavailableError(
      stderr.trim().split("\n").slice(-5).join("\n") || `${binary} exited with code ${exitCode}`,
    );
  }
}

async function transcribeWithOpenAiApi(audioFile: string): Promise<SubtitleCue[]> {
  const whisper = getSettings().whisper;
  const baseUrl = whisper.api_base_url.replace(/\/+$/, "");
  if (!baseUrl) {
    throw new TranscriptionUnavailableError("transcription api_base_url is not configured");
  }

  const form = new FormData();
  form.append("file", new Blob([await Bun.file(audioFile).arrayBuffer()]), "audio.mp3");
  form.append("model", whisper.api_model || "whisper-1");
  // SRT comes back ready to parse, avoiding a second timing format.
  form.append("response_format", "srt");
  const language = resolveContentLanguage(whisper.language);
  if (language) form.append("language", language);
  if (whisper.initial_prompt) form.append("prompt", whisper.initial_prompt);

  logger.info(`transcribing with OpenAI-compatible endpoint: ${baseUrl}`);
  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: whisper.api_key ? { Authorization: `Bearer ${whisper.api_key}` } : {},
    body: form,
  });

  if (!response.ok) {
    throw new TranscriptionUnavailableError(
      `transcription request failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`,
    );
  }
  return parseSrtContent(await response.text());
}

/**
 * Transcribes narration audio into subtitle cues.
 * Returns an empty list on failure so the pipeline continues without subtitles.
 */
export async function transcribe(audioFile: string): Promise<SubtitleCue[]> {
  const provider = getSettings().whisper.provider;

  try {
    if (provider === "openai-api") return await transcribeWithOpenAiApi(audioFile);
    return await transcribeWithWhisperCpp(audioFile);
  } catch (error) {
    logger.error(`whisper transcription failed: ${errorMessage(error)}`);
    return [];
  }
}
