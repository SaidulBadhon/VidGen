/**
 * TTS catalogue helpers shared by settings, short video, and book render.
 *
 * Voice names carry their engine as a prefix (`siliconflow:`, `gemini:`, …)
 * or are a bare Azure/Edge short name. The server infers the same way, so a
 * saved voice can restore the matching dropdown without a stored server id.
 */

export const TTS_SERVERS = [
  "azure-tts-v1",
  "azure-tts-v2",
  "siliconflow",
  "gemini",
  "mimo",
  "elevenlabs",
  "chatterbox",
  "kokoro",
] as const;

export type TtsServer = (typeof TTS_SERVERS)[number];

/** Used when settings have no voice and the form has not picked one yet. */
export const DEFAULT_VOICE_NAME = "en-US-AriaNeural-Female";
export const DEFAULT_TTS_SERVER: TtsServer = "azure-tts-v1";

const NO_VOICE = new Set(["no-voice", "none"]);

export function isNoVoice(voiceName: string | null | undefined): boolean {
  return NO_VOICE.has(String(voiceName ?? "").trim().toLowerCase());
}

/** The TTS server implied by a voice name, used to restore saved settings. */
export function inferTtsServerFromVoice(voiceName: string): TtsServer {
  const name = String(voiceName ?? "").trim();
  if (name.startsWith("siliconflow:")) return "siliconflow";
  if (name.startsWith("gemini:")) return "gemini";
  if (name.startsWith("mimo:")) return "mimo";
  if (name.startsWith("elevenlabs:")) return "elevenlabs";
  if (name.startsWith("chatterbox:")) return "chatterbox";
  if (name.startsWith("kokoro:")) return "kokoro";
  if (name.includes("-V2")) return "azure-tts-v2";
  return DEFAULT_TTS_SERVER;
}

export function voiceFromSettings(ui?: Record<string, unknown> | null): {
  voiceName: string;
  ttsServer: TtsServer;
} {
  const voiceName = String(ui?.voice_name ?? "").trim() || DEFAULT_VOICE_NAME;
  const storedServer = String(ui?.tts_server ?? "").trim();
  if (isNoVoice(voiceName)) {
    return {
      voiceName,
      ttsServer: TTS_SERVERS.includes(storedServer as TtsServer)
        ? (storedServer as TtsServer)
        : DEFAULT_TTS_SERVER,
    };
  }
  return { voiceName, ttsServer: inferTtsServerFromVoice(voiceName) };
}

export interface VoiceDisplay {
  title: string;
  locale: string;
  gender: string;
}

/** Splits a catalogue name into the bits a voice card shows. */
export function displayVoice(value: string): VoiceDisplay {
  const raw = String(value ?? "").trim();
  if (!raw || isNoVoice(raw)) return { title: raw, locale: "", gender: "" };

  const gender = raw.endsWith("-Female") ? "Female" : raw.endsWith("-Male") ? "Male" : "";
  const withoutGender = gender ? raw.slice(0, raw.lastIndexOf("-")) : raw;

  if (withoutGender.startsWith("elevenlabs:")) {
    const parts = withoutGender.split(":");
    return { title: parts[2] || parts[1] || withoutGender, locale: "", gender };
  }

  if (withoutGender.startsWith("siliconflow:")) {
    const parts = withoutGender.split(":");
    return { title: titleCase(parts[2] ?? parts[1] ?? withoutGender), locale: "", gender };
  }

  const separator = withoutGender.indexOf(":");
  if (separator >= 0) {
    return { title: prettyEngineName(withoutGender.slice(separator + 1)), locale: "", gender };
  }

  const azure = /^([a-z]{2,3}-[A-Za-z]{2,})-(.+)$/.exec(withoutGender);
  if (azure) {
    return {
      title: azure[2]!
        .replace(/Neural$/i, "")
        .replace(/Multilingual$/i, " Multilingual")
        .trim(),
      locale: azure[1]!,
      gender,
    };
  }

  return { title: withoutGender, locale: "", gender };
}

function prettyEngineName(name: string): string {
  return titleCase(name.replace(/^(af|am|bf|bm)_/, "").replace(/_/g, " "));
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}
