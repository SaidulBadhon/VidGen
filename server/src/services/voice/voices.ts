/**
 * Voice catalogue and voice-name parsing.
 * Ported from python-version/app/services/voice.py.
 *
 * Voice names carry their engine as a prefix (`siliconflow:`, `gemini:`,
 * `mimo:`, `elevenlabs:`, `chatterbox:`, `kokoro:`) or are a bare Azure/Edge
 * short name with a `-Female` / `-Male` display suffix.
 */

import azureVoices from "../../data/azureVoices.json" with { type: "json" };
import { getSettings } from "../../config/settings.ts";
import { logger, errorMessage } from "../../utils/logger.ts";
import { fetchWithTimeout } from "../../utils/misc.ts";

export const NO_VOICE_NAME = "no-voice";
const NO_VOICE_ALIASES = new Set([NO_VOICE_NAME, "none"]);

interface AzureVoiceEntry {
  name: string;
  gender: string;
}

/**
 * Locales shown in the Azure voice picker. Prefixes match `bn-BD-…`, `en-US-…`.
 * Widen this when more languages should appear in the UI.
 */
export const AZURE_VOICE_LOCALES = ["bn-", "en-"];

/** All bundled Azure/Edge voices as `name-Gender` display strings. */
export function getAllAzureVoices(filterLocals?: string[]): string[] {
  const voices: string[] = [];
  for (const item of azureVoices as AzureVoiceEntry[]) {
    const display = `${item.name}-${item.gender}`;
    if (filterLocals && filterLocals.length > 0) {
      if (filterLocals.some((locale) => item.name.toLowerCase().startsWith(locale.toLowerCase()))) {
        voices.push(display);
      }
    } else {
      voices.push(display);
    }
  }
  return voices.sort();
}

/** Strips the display-only gender suffix: `zh-CN-XiaoyiNeural-Female`. */
export function parseVoiceName(name: string): string {
  return String(name ?? "")
    .replace(/-Female/g, "")
    .replace(/-Male/g, "")
    .trim();
}

/** Returns the base voice name when this is an Azure V2 voice, else "". */
export function isAzureV2Voice(voiceName: string): string {
  const parsed = parseVoiceName(voiceName);
  if (parsed.endsWith("-V2")) return parsed.replace("-V2", "").trim();
  return "";
}

export const isSiliconflowVoice = (v: string) => String(v ?? "").startsWith("siliconflow:");
export const isGeminiVoice = (v: string) => String(v ?? "").startsWith("gemini:");
export const isMimoVoice = (v: string) => String(v ?? "").startsWith("mimo:");
export const isElevenlabsVoice = (v: string) => String(v ?? "").startsWith("elevenlabs:");
export const isChatterboxVoice = (v: string) => String(v ?? "").startsWith("chatterbox:");
export const isKokoroVoice = (v: string) => String(v ?? "").startsWith("kokoro:");

/**
 * Whether the user explicitly chose "no narration".
 *
 * An empty voice name deliberately does not count: that is far more likely to
 * be a broken config or a missing API parameter, and silently producing a
 * silent video would hide a real error.
 */
export function isNoVoice(voiceName: string | null | undefined): boolean {
  return NO_VOICE_ALIASES.has(String(voiceName ?? "").trim().toLowerCase());
}

/**
 * ElevenLabs key, config first and environment as fallback.
 *
 * The music feature already honours ELEVENLABS_API_KEY, and TTS must use the
 * same rule — otherwise an environment-only deployment lists voices happily but
 * fails at synthesis time claiming no key is configured.
 */
export function getElevenlabsApiKey(): string {
  const configured = String(getSettings().elevenlabs.api_key ?? "").trim();
  return configured || (process.env.ELEVENLABS_API_KEY ?? "").trim();
}

// ---------------------------------------------------------------------------
// Remote voice catalogues
// ---------------------------------------------------------------------------

/** SiliconFlow ships a small fixed set of system voices. */
export function getSiliconflowVoices(): string[] {
  const models = ["FunAudioLLM/CosyVoice2-0.5B"];
  const voices = ["alex", "anna", "bella", "benjamin", "charles", "claire", "david", "diana"];
  const genders: Record<string, string> = {
    alex: "Male",
    anna: "Female",
    bella: "Female",
    benjamin: "Male",
    charles: "Male",
    claire: "Female",
    david: "Male",
    diana: "Female",
  };

  const result: string[] = [];
  for (const model of models) {
    for (const voice of voices) {
      result.push(`siliconflow:${model}:${voice}-${genders[voice] ?? "Female"}`);
    }
  }
  return result;
}

/** Gemini's prebuilt TTS voices. */
export function getGeminiVoices(): string[] {
  const voices: Record<string, string> = {
    Zephyr: "Female",
    Puck: "Male",
    Charon: "Male",
    Kore: "Female",
    Fenrir: "Male",
    Leda: "Female",
    Orus: "Male",
    Aoede: "Female",
    Callirrhoe: "Female",
    Autonoe: "Female",
    Enceladus: "Male",
    Iapetus: "Male",
    Umbriel: "Male",
    Algieba: "Male",
    Despina: "Female",
    Erinome: "Female",
    Algenib: "Male",
    Rasalgethi: "Male",
    Laomedeia: "Female",
    Achernar: "Female",
    Alnilam: "Male",
    Schedar: "Male",
    Gacrux: "Female",
    Pulcherrima: "Female",
    Achird: "Male",
    Zubenelgenubi: "Male",
    Vindemiatrix: "Female",
    Sadachbia: "Male",
    Sadaltager: "Male",
    Sulafat: "Female",
  };
  return Object.entries(voices).map(([name, gender]) => `gemini:${name}-${gender}`);
}

/** Xiaomi MiMo TTS voices. */
export function getMimoVoices(): string[] {
  const voices: Record<string, string> = {
    xiaoyao: "Female",
    xiaoxuan: "Female",
    xiaomo: "Female",
    xiaofeng: "Male",
    xiaoyu: "Male",
    xiaoyun: "Female",
    xiaozhi: "Male",
    xiaonan: "Female",
  };
  return Object.entries(voices).map(([name, gender]) => `mimo:${name}-${gender}`);
}

/**
 * Voices bundled with the local Kokoro model, best first.
 *
 * The order follows the model card's quality grades (af_heart is the flagship
 * voice), so the top of the dropdown is also the best-sounding pick. English
 * only — see services/voice/kokoro.ts for why.
 */
export function getKokoroVoices(): string[] {
  const voices: Record<string, string> = {
    af_heart: "Female",
    af_bella: "Female",
    af_nicole: "Female",
    bf_emma: "Female",
    af_aoede: "Female",
    af_kore: "Female",
    af_sarah: "Female",
    am_fenrir: "Male",
    am_michael: "Male",
    am_puck: "Male",
    af_alloy: "Female",
    af_nova: "Female",
    bf_isabella: "Female",
    bm_fable: "Male",
    bm_george: "Male",
    af_sky: "Female",
    af_jessica: "Female",
    af_river: "Female",
    bf_alice: "Female",
    bf_lily: "Female",
    am_echo: "Male",
    am_eric: "Male",
    am_liam: "Male",
    am_onyx: "Male",
    bm_daniel: "Male",
    bm_lewis: "Male",
    am_santa: "Male",
    am_adam: "Male",
  };
  return Object.entries(voices).map(([name, gender]) => `kokoro:${name}-${gender}`);
}

/** Chatterbox voices come from the configured server, not a fixed list. */
export function getChatterboxVoices(): string[] {
  const configured = getSettings().chatterbox.voices ?? [];
  const voices = configured.map((voice) => String(voice).trim()).filter(Boolean);
  if (voices.length === 0) return ["chatterbox:default-Female"];
  return voices.map((voice) => (voice.startsWith("chatterbox:") ? voice : `chatterbox:${voice}`));
}

interface ElevenLabsVoice {
  voice_id: string;
  name: string;
}

/**
 * Fetches the account's ElevenLabs voices.
 *
 * Returns an empty list rather than throwing so the settings UI degrades to
 * "no voices found" instead of failing to render.
 */
export async function getElevenlabsVoices(apiKey?: string): Promise<string[]> {
  const key = (apiKey ?? getElevenlabsApiKey()).trim();
  if (!key) return [];

  try {
    const response = await fetchWithTimeout("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": key },
      timeoutMs: 30_000,
    });
    if (!response.ok) {
      logger.warning(`failed to list elevenlabs voices: HTTP ${response.status}`);
      return [];
    }
    const data = (await response.json()) as { voices?: ElevenLabsVoice[] };
    return (data.voices ?? []).map((voice) => `elevenlabs:${voice.voice_id}:${voice.name}`);
  } catch (error) {
    logger.warning(`failed to list elevenlabs voices: ${errorMessage(error)}`);
    return [];
  }
}

/** Every voice the UI can offer, grouped by TTS server. */
export async function listVoicesForServer(server: string): Promise<string[]> {
  switch (server) {
    case "azure-tts-v2":
      return getAllAzureVoices(AZURE_VOICE_LOCALES).filter((voice) => voice.includes("V2"));
    case "siliconflow":
      return getSiliconflowVoices();
    case "gemini":
      return getGeminiVoices();
    case "mimo":
      return getMimoVoices();
    case "elevenlabs":
      return getElevenlabsVoices();
    case "chatterbox":
      return getChatterboxVoices();
    case "kokoro":
      return getKokoroVoices();
    case "azure-tts-v1":
    default:
      return getAllAzureVoices(AZURE_VOICE_LOCALES).filter((voice) => !voice.includes("V2"));
  }
}

/** The TTS server implied by a voice name, used to restore saved settings. */
export function inferTtsServerFromVoice(voiceName: string): string {
  if (isSiliconflowVoice(voiceName)) return "siliconflow";
  if (isGeminiVoice(voiceName)) return "gemini";
  if (isMimoVoice(voiceName)) return "mimo";
  if (isElevenlabsVoice(voiceName)) return "elevenlabs";
  if (isChatterboxVoice(voiceName)) return "chatterbox";
  if (isKokoroVoice(voiceName)) return "kokoro";
  if (isAzureV2Voice(voiceName)) return "azure-tts-v2";
  return "azure-tts-v1";
}
