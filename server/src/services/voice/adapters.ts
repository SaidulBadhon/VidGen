/**
 * TTS engines other than Edge.
 * Ported from python-version/app/services/voice.py.
 *
 * Only Edge and Azure V2 report word boundaries. The rest return a plain audio
 * buffer, so their cues are approximated from sentence lengths — see
 * `syntheticCues.ts` for why that matters.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { getSettings } from "../../config/settings.ts";
import { logger, errorMessage } from "../../utils/logger.ts";
import { fetchWithTimeout } from "../../utils/misc.ts";
import { runFfmpeg } from "../video/ffmpeg.ts";
import { probe } from "../video/probe.ts";
import { buildProportionalCues } from "./syntheticCues.ts";
import { getElevenlabsApiKey } from "./voices.ts";
import { ticksToSeconds, type TtsCue, type TtsResult } from "./types.ts";

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

/** Writes audio bytes and derives cues from the resulting duration. */
async function finalize(voiceFile: string, bytes: Uint8Array, text: string): Promise<TtsResult> {
  await ensureDir(voiceFile);
  await Bun.write(voiceFile, bytes);
  const info = await probe(voiceFile);
  return {
    audioFile: voiceFile,
    duration: info.duration,
    cues: buildProportionalCues(text, info.duration),
  };
}

// ---------------------------------------------------------------------------
// SiliconFlow
// ---------------------------------------------------------------------------

export async function siliconflowTts(options: {
  text: string;
  model: string;
  voice: string;
  voiceRate: number;
  voiceFile: string;
  voiceVolume?: number;
  signal?: AbortSignal;
}): Promise<TtsResult | null> {
  const apiKey = String(getSettings().siliconflow.api_key ?? "").trim();
  if (!apiKey) {
    logger.error("SiliconFlow API key is not set");
    return null;
  }

  // The API takes a gain in dB rather than a multiplier, so a volume of 1.0
  // maps to no change.
  const gain = Math.max(-10, Math.min(10, (options.voiceVolume ?? 1.0) - 1.0));

  const payload = {
    model: options.model,
    input: options.text.trim(),
    voice: options.voice,
    response_format: "mp3",
    sample_rate: 32000,
    stream: false,
    speed: options.voiceRate,
    gain,
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      logger.info(`start siliconflow tts, model: ${options.model}, voice: ${options.voice}, try: ${attempt}`);
      const response = await fetchWithTimeout("https://api.siliconflow.cn/v1/audio/speech", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeoutMs: 180_000,
        signal: options.signal,
      });

      if (!response.ok) {
        logger.warning(`siliconflow tts failed: HTTP ${response.status}`);
        continue;
      }
      return await finalize(options.voiceFile, new Uint8Array(await response.arrayBuffer()), options.text);
    } catch (error) {
      logger.warning(`siliconflow tts failed: ${errorMessage(error)}`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

const GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";

/**
 * Gemini returns raw 24 kHz mono PCM, so it is transcoded to MP3 for parity
 * with the other engines and with what the mixer expects.
 */
export async function geminiTts(options: {
  text: string;
  voiceName: string;
  voiceFile: string;
  signal?: AbortSignal;
}): Promise<TtsResult | null> {
  const apiKey = String(getSettings().app.gemini_api_key ?? "").trim();
  if (!apiKey) {
    logger.error("Gemini API key is not set");
    return null;
  }

  try {
    logger.info(`start gemini tts, voice name: ${options.voiceName}`);
    const response = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: options.text }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voiceName } },
            },
          },
        }),
        timeoutMs: 180_000,
        signal: options.signal,
      },
    );

    if (!response.ok) {
      logger.error(`gemini tts failed: HTTP ${response.status}`);
      return null;
    }

    const data = (await response.json()) as {
      candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[];
    };
    const base64 = data.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData?.data;
    if (!base64) {
      logger.error("No audio data found in response");
      return null;
    }

    const pcm = Buffer.from(base64, "base64");
    const pcmFile = `${options.voiceFile}.pcm`;
    await ensureDir(options.voiceFile);
    await Bun.write(pcmFile, pcm);

    await runFfmpeg([
      "-y",
      "-f",
      "s16le",
      "-ar",
      "24000",
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
      cues: buildProportionalCues(options.text, info.duration),
    };
  } catch (error) {
    logger.error(`gemini tts failed: ${errorMessage(error)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Xiaomi MiMo
// ---------------------------------------------------------------------------

const MIMO_DEFAULT_BASE_URL = "https://api.xiaomimimo.com/v1";

export async function mimoTts(options: {
  text: string;
  voice: string;
  voiceRate: number;
  voiceFile: string;
  signal?: AbortSignal;
}): Promise<TtsResult | null> {
  const app = getSettings().app;
  const apiKey = String(app.mimo_api_key ?? "").trim();
  if (!apiKey) {
    logger.error("MiMo API key is not set");
    return null;
  }

  const baseUrl = (String(app.mimo_base_url ?? "").trim() || MIMO_DEFAULT_BASE_URL).replace(/\/+$/, "");

  try {
    logger.info(`start mimo tts, voice: ${options.voice}`);
    const response = await fetchWithTimeout(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: app.mimo_tts_model_name || "mimo-v2.5-tts",
        input: options.text,
        voice: options.voice,
        response_format: "mp3",
        speed: options.voiceRate,
        // The style prompt steers delivery toward short-video narration.
        ...(app.mimo_tts_style_prompt ? { instructions: app.mimo_tts_style_prompt } : {}),
      }),
      timeoutMs: 180_000,
      signal: options.signal,
    });

    if (!response.ok) {
      logger.error(`mimo tts failed: HTTP ${response.status}`);
      return null;
    }
    return await finalize(options.voiceFile, new Uint8Array(await response.arrayBuffer()), options.text);
  } catch (error) {
    logger.error(`mimo tts failed: ${errorMessage(error)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// ElevenLabs
// ---------------------------------------------------------------------------

export async function elevenlabsTts(options: {
  text: string;
  voiceId: string;
  voiceFile: string;
  voiceRate: number;
  signal?: AbortSignal;
}): Promise<TtsResult | null> {
  const apiKey = getElevenlabsApiKey();
  if (!apiKey) {
    logger.error("ElevenLabs API key is not set");
    return null;
  }

  const modelId = String(getSettings().elevenlabs.model_id ?? "eleven_multilingual_v2");

  try {
    logger.info(`start elevenlabs tts, voice: ${options.voiceId}, model: ${modelId}`);
    const response = await fetchWithTimeout(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(options.voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: options.text,
          model_id: modelId,
          // ElevenLabs expresses tempo as a multiplier and rejects extremes.
          voice_settings: { speed: Math.max(0.7, Math.min(1.2, options.voiceRate || 1)) },
        }),
        timeoutMs: 300_000,
        signal: options.signal,
      },
    );

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      logger.error(`elevenlabs tts failed: HTTP ${response.status} ${detail}`);
      return null;
    }
    return await finalize(options.voiceFile, new Uint8Array(await response.arrayBuffer()), options.text);
  } catch (error) {
    logger.error(`elevenlabs tts failed: ${errorMessage(error)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Chatterbox (OpenAI-compatible local server)
// ---------------------------------------------------------------------------

export async function chatterboxTts(options: {
  text: string;
  voice: string;
  voiceFile: string;
  voiceRate: number;
  signal?: AbortSignal;
}): Promise<TtsResult | null> {
  const chatterbox = getSettings().chatterbox;
  const baseUrl = String(chatterbox.base_url ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    logger.error("Chatterbox base_url is not set");
    return null;
  }

  try {
    logger.info(`start chatterbox tts, voice: ${options.voice}`);
    const response = await fetchWithTimeout(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(chatterbox.api_key ? { Authorization: `Bearer ${chatterbox.api_key}` } : {}),
      },
      body: JSON.stringify({
        model: chatterbox.model_id || "chatterbox",
        input: options.text,
        voice: options.voice,
        response_format: "mp3",
        speed: options.voiceRate,
      }),
      timeoutMs: 300_000,
      signal: options.signal,
    });

    if (!response.ok) {
      logger.error(`chatterbox tts failed: HTTP ${response.status}`);
      return null;
    }
    return await finalize(options.voiceFile, new Uint8Array(await response.arrayBuffer()), options.text);
  } catch (error) {
    logger.error(`chatterbox tts failed: ${errorMessage(error)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Azure Speech V2
// ---------------------------------------------------------------------------

/**
 * Azure Speech with the official SDK.
 *
 * Unlike the other paid engines, Azure reports word boundaries, so its cues are
 * real timings rather than an approximation.
 */
export async function azureTtsV2(options: {
  text: string;
  voiceName: string;
  voiceFile: string;
  voiceRate: number;
  signal?: AbortSignal;
}): Promise<TtsResult | null> {
  const azure = getSettings().azure;
  const speechKey = String(azure.speech_key ?? "").trim();
  const speechRegion = String(azure.speech_region ?? "").trim();

  if (!speechKey || !speechRegion) {
    logger.error("Azure speech_key or speech_region is not set");
    return null;
  }

  const sdk = await import("microsoft-cognitiveservices-speech-sdk");

  const speechConfig = sdk.SpeechConfig.fromSubscription(speechKey, speechRegion);
  speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;

  const ratePercent = Math.round((options.voiceRate - 1) * 100);
  const rateAttr = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;
  const escaped = options.text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="en-US">` +
    `<voice name="${options.voiceName}"><prosody rate="${rateAttr}">${escaped}</prosody></voice></speak>`;

  return new Promise<TtsResult | null>((resolve) => {
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, undefined);
    const cues: TtsCue[] = [];

    synthesizer.wordBoundary = (_sender, event) => {
      cues.push({
        start: ticksToSeconds(event.audioOffset),
        end: ticksToSeconds(event.audioOffset + event.duration * 10_000),
        content: event.text,
      });
    };

    synthesizer.speakSsmlAsync(
      ssml,
      async (result) => {
        try {
          if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted) {
            logger.error(`azure tts v2 failed: ${result.errorDetails ?? result.reason}`);
            resolve(null);
            return;
          }

          await ensureDir(options.voiceFile);
          await Bun.write(options.voiceFile, new Uint8Array(result.audioData));
          const info = await probe(options.voiceFile);

          resolve({
            audioFile: options.voiceFile,
            duration: info.duration,
            // Fall back to estimated timing if Azure reported no boundaries.
            cues: cues.length > 0 ? cues : buildProportionalCues(options.text, info.duration),
          });
        } catch (error) {
          logger.error(`azure tts v2 failed: ${errorMessage(error)}`);
          resolve(null);
        } finally {
          synthesizer.close();
        }
      },
      (error) => {
        logger.error(`azure tts v2 failed: ${String(error)}`);
        synthesizer.close();
        resolve(null);
      },
    );
  });
}
