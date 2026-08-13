/**
 * On-demand TTS sample for the settings UI.
 *
 * Preview audio is synthesised into a temp file, read into memory for the
 * HTTP response, then deleted so repeated listens do not fill storage/temp.
 */

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { logger, errorMessage } from "../../utils/logger.ts";
import { storageDir } from "../../utils/paths.ts";
import { getAudioDuration, tts } from "./index.ts";

const DEFAULT_SAMPLE = "This is an example text for testing speech synthesis";

/**
 * Sniffs the real container so a WAV payload served as audio/mpeg does not
 * fail in the browser. Chatterbox and some OpenAI-compatible endpoints ignore
 * response_format=mp3 and still return WAV.
 */
export function detectAudioMime(filePath: string, bytes: Uint8Array): string {
  const header = bytes.subarray(0, 12);
  const asString = (start: number, end: number) => String.fromCharCode(...header.subarray(start, end));

  if (asString(0, 4) === "RIFF" && asString(8, 12) === "WAVE") return "audio/wav";
  if (asString(0, 3) === "ID3") return "audio/mpeg";
  if (header.length >= 2 && header[0] === 0xff && (header[1] === 0xfb || header[1] === 0xf3 || header[1] === 0xf2)) {
    return "audio/mpeg";
  }
  if (asString(0, 4) === "OggS") return "audio/ogg";

  const lower = filePath.toLowerCase();
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".aac")) return "audio/aac";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".flac")) return "audio/flac";
  return "audio/mpeg";
}

export interface VoicePreviewResult {
  bytes: Uint8Array;
  mimeType: string;
  duration: number | null;
}

/** Synthesises a short (or full-script) listen and returns the audio bytes. */
export async function synthesizeVoicePreview(options: {
  text: string;
  voiceName: string;
  voiceRate: number;
  voiceVolume: number;
  signal?: AbortSignal;
}): Promise<VoicePreviewResult | null> {
  const text = options.text.trim() || DEFAULT_SAMPLE;
  const audioFile = join(storageDir("temp", true), `tmp-voice-${crypto.randomUUID()}.mp3`);

  logger.info(
    `generating voice preview: voice=${options.voiceName}, rate=${options.voiceRate}, ` +
      `volume=${options.voiceVolume}, text_length=${text.length}`,
  );

  try {
    const result = await tts({
      text,
      voiceName: options.voiceName,
      voiceRate: options.voiceRate,
      voiceVolume: options.voiceVolume,
      voiceFile: audioFile,
      signal: options.signal,
    });

    if (!result) {
      logger.error("voice preview did not produce an audio file");
      return null;
    }

    const bytes = new Uint8Array(await Bun.file(audioFile).arrayBuffer());
    if (bytes.byteLength === 0) {
      logger.error(`voice preview audio file is empty: ${audioFile}`);
      return null;
    }

    const probed = result.duration && result.duration > 0 ? result.duration : await getAudioDuration(audioFile);
    const duration = Number.isFinite(probed) && probed > 0 ? probed : null;
    if (duration == null) {
      logger.warning(`voice preview duration is unavailable: voice=${options.voiceName}`);
    }

    return { bytes, mimeType: detectAudioMime(audioFile, bytes), duration };
  } finally {
    await unlink(audioFile).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warning(`failed to delete voice preview file ${audioFile}: ${errorMessage(error)}`);
      }
    });
  }
}
