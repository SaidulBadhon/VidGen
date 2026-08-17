/**
 * Text-to-speech entry point.
 * Ported from `tts()` in python-version/app/services/voice.py.
 */

import { mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { appConfig } from "../../config/settings.ts";
import { logger, errorMessage } from "../../utils/logger.ts";
import { splitStringByPunctuations } from "../../utils/text.ts";
import { runFfmpeg } from "../video/ffmpeg.ts";
import { probe } from "../video/probe.ts";
import { azureTtsV2, chatterboxTts, elevenlabsTts, geminiTts, mimoTts, siliconflowTts } from "./adapters.ts";
import { convertRateToPercent, synthesizeEdgeTts } from "./edgeTts.ts";
import { kokoroTts } from "./kokoro.ts";
import { buildProportionalCues } from "./syntheticCues.ts";
import {
  isAzureV2Voice,
  isChatterboxVoice,
  isElevenlabsVoice,
  isGeminiVoice,
  isKokoroVoice,
  isMimoVoice,
  isNoVoice,
  isSiliconflowVoice,
  parseVoiceName,
} from "./voices.ts";
import type { TtsRequest, TtsResult } from "./types.ts";

const DEFAULT_EDGE_TTS_TIMEOUT_SECONDS = 30;

export * from "./voices.ts";
export * from "./types.ts";
export { createSubtitleCues } from "./subtitles.ts";
export { convertRateToPercent } from "./edgeTts.ts";

/**
 * Timeout for a single Edge TTS request.
 *
 * Edge consumer TTS can hang indefinitely when the network is blocked, the
 * service throttles, or the chosen voice does not match the text's language,
 * which leaves the task with no feedback at all. A value of 0 disables it.
 */
export function getEdgeTtsTimeoutMs(): number {
  const raw = appConfig().edge_tts_timeout;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) {
    logger.warning(`invalid edge_tts_timeout: ${raw}, fallback to ${DEFAULT_EDGE_TTS_TIMEOUT_SECONDS}s`);
    return DEFAULT_EDGE_TTS_TIMEOUT_SECONDS * 1000;
  }
  return seconds <= 0 ? 0 : seconds * 1000;
}

/**
 * Estimates a timeline length for "no narration" mode.
 *
 * A silent placeholder still drives material trimming, subtitle timing and the
 * final mux, so it needs a plausible duration: CJK at ~4.2 chars/s, Latin at
 * ~2.7 words/s, other scripts at ~4 chars/s, plus a short pause per sentence.
 */
export function estimateNoVoiceDuration(text: string): number {
  const normalized = String(text ?? "").trim();
  if (!normalized) return 3.0;

  const cjkChars = (normalized.match(/[一-鿿]/g) ?? []).length;
  const asciiWords = normalized.match(/[A-Za-z0-9]+/g) ?? [];
  const asciiWordChars = asciiWords.reduce((sum, word) => sum + word.length, 0);

  // Count every letter/number, then subtract what was already counted so Latin
  // text is not charged twice.
  const letterOrNumber = (normalized.match(/[\p{L}\p{N}]/gu) ?? []).length;
  const otherTextChars = Math.max(letterOrNumber - cjkChars - asciiWordChars, 0);

  const sentenceCount = Math.max(splitStringByPunctuations(normalized).length, 1);

  const duration =
    cjkChars / 4.2 + asciiWords.length / 2.7 + otherTextChars / 4.0 + Math.max(sentenceCount - 1, 0) * 0.35;

  return Math.max(3.0, duration);
}

/** Generates an MP3 of silence as the timeline placeholder for no-voice mode. */
export async function generateSilentAudio(durationSeconds: number, outputFile: string): Promise<boolean> {
  await mkdir(dirname(outputFile), { recursive: true });
  const duration = Math.max(Number(durationSeconds) || 0, 0.1);

  logger.info(`generating silent audio for no-voice mode, duration: ${duration.toFixed(2)}s`);
  try {
    await runFfmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=mono",
      "-t",
      duration.toFixed(3),
      "-codec:a",
      "libmp3lame",
      "-q:a",
      "4",
      outputFile,
    ]);
  } catch (error) {
    logger.error(`failed to generate silent audio: ${errorMessage(error)}`);
    return false;
  }

  if (!existsSync(outputFile) || statSync(outputFile).size <= 0) {
    logger.error(
      `silent audio output file is missing or empty, file: ${outputFile}, duration: ${duration.toFixed(2)}s`,
    );
    return false;
  }
  return true;
}

/** Edge TTS, with the retry loop the consumer endpoint needs. */
async function edgeTts(request: TtsRequest): Promise<TtsResult | null> {
  const voiceName = parseVoiceName(request.voiceName);
  const text = request.text.trim();
  const rate = convertRateToPercent(request.voiceRate);
  const timeoutMs = getEdgeTtsTimeoutMs();

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      logger.info(`start, voice name: ${voiceName}, try: ${attempt}`);
      const { audio, cues } = await synthesizeEdgeTts({
        text,
        voiceName,
        rate,
        timeoutMs,
        signal: request.signal,
      });

      if (audio.byteLength === 0) {
        logger.warning("failed, edge tts returned no audio");
        continue;
      }

      await mkdir(dirname(request.voiceFile), { recursive: true });
      await Bun.write(request.voiceFile, audio);
      const info = await probe(request.voiceFile);

      return {
        audioFile: request.voiceFile,
        duration: info.duration,
        // Boundaries can be absent for some voices; approximate rather than
        // dropping subtitles entirely.
        cues: cues.length > 0 ? cues : buildProportionalCues(text, info.duration),
      };
    } catch (error) {
      logger.error(`failed, error: ${errorMessage(error)}`);
    }
  }
  return null;
}

/**
 * Synthesises narration with the engine implied by the voice name.
 *
 * Returns null on failure so the pipeline can mark the audio stage failed with
 * a specific reason rather than continuing with a silent video.
 */
export async function tts(request: TtsRequest): Promise<TtsResult | null> {
  const { text, voiceName, voiceRate, voiceFile, voiceVolume = 1.0, signal } = request;

  if (isNoVoice(voiceName)) {
    const duration = estimateNoVoiceDuration(text);
    if (!(await generateSilentAudio(duration, voiceFile))) return null;
    return { audioFile: voiceFile, duration, cues: buildProportionalCues(text, duration) };
  }

  const azureV2Voice = isAzureV2Voice(voiceName);
  if (azureV2Voice) {
    return azureTtsV2({ text, voiceName: azureV2Voice, voiceFile, voiceRate, signal });
  }

  if (isSiliconflowVoice(voiceName)) {
    // Format: siliconflow:model:voice-Gender
    const parts = voiceName.split(":");
    if (parts.length < 3) {
      logger.error(`Invalid siliconflow voice name format: ${voiceName}`);
      return null;
    }
    const model = parts[1]!;
    const voice = parts[2]!.split("-")[0]!;
    return siliconflowTts({
      text,
      model,
      voice: `${model}:${voice}`,
      voiceRate,
      voiceFile,
      voiceVolume,
      signal,
    });
  }

  if (isGeminiVoice(voiceName)) {
    // Format: gemini:Voice-Gender
    const parts = voiceName.split(":");
    if (parts.length < 2) {
      logger.error(`Invalid gemini voice name format: ${voiceName}`);
      return null;
    }
    return geminiTts({ text, voiceName: parts[1]!.split("-")[0]!, voiceFile, signal });
  }

  if (isMimoVoice(voiceName)) {
    // Format: mimo:voice-Gender, or mimo:voice after parseVoiceName.
    const parts = voiceName.split(":");
    if (parts.length < 2) {
      logger.error(`Invalid mimo voice name format: ${voiceName}`);
      return null;
    }
    return mimoTts({ text, voice: parts[1]!.split("-")[0]!, voiceRate, voiceFile, signal });
  }

  if (isElevenlabsVoice(voiceName)) {
    // Format: elevenlabs:{voice_id}:{name}
    const parts = voiceName.split(":");
    if (parts.length < 2) {
      logger.error(`Invalid elevenlabs voice name format: ${voiceName}`);
      return null;
    }
    return elevenlabsTts({ text, voiceId: parts[1]!, voiceFile, voiceRate, signal });
  }

  if (isChatterboxVoice(voiceName)) {
    // Format: chatterbox:<voice>, optionally with a -Female/-Male suffix.
    const separator = voiceName.indexOf(":");
    let voice = voiceName.slice(separator + 1).trim();
    if (!voice) {
      logger.error(`Invalid chatterbox voice name format: ${voiceName}`);
      return null;
    }
    if (voice.endsWith("-Female") || voice.endsWith("-Male")) {
      voice = voice.slice(0, voice.lastIndexOf("-"));
    }
    return chatterboxTts({ text, voice, voiceFile, voiceRate, signal });
  }

  if (isKokoroVoice(voiceName)) {
    // Format: kokoro:voice-Gender. Runs the bundled local model in-process.
    return kokoroTts({ text, voiceName, voiceFile, voiceRate, signal });
  }

  return edgeTts(request);
}

/** Duration of an audio file in seconds, 0 when unreadable. */
export async function getAudioDuration(audioFile: string): Promise<number> {
  try {
    const info = await probe(audioFile);
    return info.duration;
  } catch (error) {
    logger.warning(`failed to read audio duration: ${audioFile}, error: ${errorMessage(error)}`);
    return 0;
  }
}
