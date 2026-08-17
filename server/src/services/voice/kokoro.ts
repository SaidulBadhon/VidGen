/**
 * Kokoro — the built-in local TTS engine.
 *
 * Runs the Apache-2.0 Kokoro-82M model in-process through onnxruntime (via
 * kokoro-js), so narration needs no API key, no separate server and no GPU.
 * The quantised weights (~90 MB) download from Hugging Face into
 * models/kokoro on first use — the same flow as whisper.cpp — and synthesis
 * is fully offline after that.
 *
 * English only: kokoro-js ships the en-US/en-GB voices because its phonemizer
 * covers no other language. Other languages stay on the cloud engines or a
 * self-hosted Chatterbox server.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { KokoroTTS } from "kokoro-js";
import { getSettings } from "../../config/settings.ts";
import { logger, errorMessage } from "../../utils/logger.ts";
import { modelsDir } from "../../utils/paths.ts";
import { runFfmpeg } from "../video/ffmpeg.ts";
import { probe } from "../video/probe.ts";
import { buildProportionalCues } from "./syntheticCues.ts";
import type { TtsCue, TtsResult } from "./types.ts";

const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

/** `kokoro:af_heart-Female` -> `af_heart`, or "" when the shape is wrong. */
export function parseKokoroVoiceName(voiceName: string): string {
  const value = String(voiceName ?? "");
  if (!value.startsWith("kokoro:")) return "";
  let voice = value.slice("kokoro:".length).trim();
  if (voice.endsWith("-Female") || voice.endsWith("-Male")) {
    voice = voice.slice(0, voice.lastIndexOf("-"));
  }
  return voice;
}

type LoadedModel = { dtype: string; promise: Promise<KokoroTTS> };
let loadedModel: LoadedModel | null = null;

/**
 * Loads the model once and keeps it resident; ~300 MB of RAM buys skipping
 * the multi-second session start on every narration. A failed load is
 * forgotten so the next request can retry (the usual cause is the one-time
 * weight download racing a flaky network).
 */
async function loadKokoro(dtype: string): Promise<KokoroTTS> {
  if (loadedModel && loadedModel.dtype === dtype) return loadedModel.promise;

  const promise = (async () => {
    const { KokoroTTS: Kokoro } = await import("kokoro-js");
    const { env } = await import("@huggingface/transformers");
    // Weights live next to the whisper models, where docker-compose already
    // mounts a volume; the default cache inside node_modules would be wiped
    // on every image rebuild.
    env.cacheDir = join(modelsDir(true), "kokoro");

    logger.info(`loading kokoro model (${dtype}); first run downloads ~90 MB to ${env.cacheDir}`);
    try {
      return await Kokoro.from_pretrained(KOKORO_MODEL_ID, { dtype: dtype as never, device: "cpu" });
    } catch (error) {
      // The native onnxruntime binding can be missing on unusual platforms;
      // WASM is several times slower but runs anywhere Bun does.
      logger.warning(`kokoro cpu backend failed (${errorMessage(error)}), retrying with wasm`);
      return await Kokoro.from_pretrained(KOKORO_MODEL_ID, { dtype: dtype as never, device: "wasm" });
    }
  })();

  loadedModel = { dtype, promise };
  promise.catch(() => {
    if (loadedModel?.promise === promise) loadedModel = null;
  });
  return promise;
}

let synthesisQueue: Promise<unknown> = Promise.resolve();

/**
 * Serialises syntheses across concurrent tasks: there is one model on one
 * CPU, and parallel ONNX runs contend for the same threads rather than
 * finishing sooner.
 */
function withKokoroLock<T>(task: () => Promise<T>): Promise<T> {
  const run = synthesisQueue.then(task, task);
  synthesisQueue = run.catch(() => undefined);
  return run;
}

export interface KokoroChunkTiming {
  /** The sentence text kokoro's splitter produced for this chunk. */
  text: string;
  /** Measured from the generated samples, so it is exact. */
  durationSeconds: number;
}

/**
 * Builds cues from per-sentence chunk timings.
 *
 * Chunk boundaries are real measurements; only the split of one sentence into
 * its comma-delimited lines is proportional. That bounds timing error to a
 * single sentence, where the other boundary-less engines spread it across the
 * whole track. Contents concatenate to the full script in order, which is
 * what the subtitle aggregator needs to match line by line.
 */
export function buildKokoroCues(chunks: KokoroChunkTiming[]): TtsCue[] {
  const cues: TtsCue[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    for (const cue of buildProportionalCues(chunk.text, chunk.durationSeconds)) {
      cues.push({ start: offset + cue.start, end: offset + cue.end, content: cue.content });
    }
    offset += chunk.durationSeconds;
  }
  return cues;
}

export async function kokoroTts(options: {
  text: string;
  voiceName: string;
  voiceFile: string;
  voiceRate: number;
  signal?: AbortSignal;
}): Promise<TtsResult | null> {
  const voice = parseKokoroVoiceName(options.voiceName);
  if (!voice) {
    logger.error(`Invalid kokoro voice name format: ${options.voiceName}`);
    return null;
  }
  const text = options.text.trim();
  if (!text) {
    logger.error("kokoro tts called with empty text");
    return null;
  }
  // Kokoro degrades audibly outside this range.
  const speed = Math.max(0.5, Math.min(2, options.voiceRate || 1));
  const dtype = getSettings().kokoro.dtype;

  try {
    logger.info(`start kokoro tts, voice: ${voice}, speed: ${speed}`);
    return await withKokoroLock(async () => {
      const model = await loadKokoro(dtype);
      const { TextSplitterStream } = await import("kokoro-js");

      // Streaming synthesises sentence by sentence, which keeps prosody
      // (punctuation stays with its sentence) and yields a real start/end
      // time per sentence as a by-product.
      const splitter = new TextSplitterStream();
      splitter.push(text);
      splitter.close();

      const pcmChunks: Float32Array[] = [];
      const timings: KokoroChunkTiming[] = [];
      let sampleRate = 24_000;
      let totalSamples = 0;

      for await (const { text: chunkText, audio } of model.stream(splitter, { voice: voice as never, speed })) {
        if (options.signal?.aborted) {
          logger.warning("kokoro tts aborted");
          return null;
        }
        sampleRate = audio.sampling_rate;
        pcmChunks.push(audio.audio);
        totalSamples += audio.audio.length;
        timings.push({ text: chunkText, durationSeconds: audio.audio.length / audio.sampling_rate });
      }

      if (totalSamples === 0) {
        logger.error("kokoro tts produced no audio");
        return null;
      }

      const merged = new Float32Array(totalSamples);
      let position = 0;
      for (const chunk of pcmChunks) {
        merged.set(chunk, position);
        position += chunk.length;
      }

      // Same shape as the Gemini path: raw PCM to disk, ffmpeg to MP3. The
      // format is pinned so long-form chunk concatenation never sees drift.
      const pcmFile = `${options.voiceFile}.pcm`;
      await mkdir(dirname(options.voiceFile), { recursive: true });
      await Bun.write(pcmFile, new Uint8Array(merged.buffer, 0, merged.byteLength));
      await runFfmpeg([
        "-y",
        "-f",
        "f32le",
        "-ar",
        String(sampleRate),
        "-ac",
        "1",
        "-i",
        pcmFile,
        "-codec:a",
        "libmp3lame",
        "-q:a",
        "4",
        options.voiceFile,
      ]);
      await Bun.file(pcmFile)
        .delete()
        .catch(() => {});

      const info = await probe(options.voiceFile);
      return {
        audioFile: options.voiceFile,
        duration: info.duration,
        cues: buildKokoroCues(timings),
      };
    });
  } catch (error) {
    logger.error(`kokoro tts failed: ${errorMessage(error)}`);
    return null;
  }
}
