import { useCallback } from "react";
import { VoicePreview, useVoiceSampleTrigger } from "@/components/AudioPreview.tsx";
import { VoiceSelector } from "@/components/voice-selector.tsx";
import { DEFAULT_TTS_SERVER } from "@/lib/voices.ts";
import { useSettingsDraft } from "./context.tsx";

export function NarrationSettingsPage() {
  const { draft, setSection } = useSettingsDraft();
  const { autoPlayKey, requestSample } = useVoiceSampleTrigger();

  const setTtsServer = useCallback(
    (value: string) => {
      setSection("ui", "tts_server", value);
      setSection("ui", "voice_name", "");
    },
    [setSection],
  );
  const setVoiceName = useCallback((value: string) => setSection("ui", "voice_name", value), [setSection]);

  if (!draft) return null;

  const ttsServer = String(draft.ui.tts_server ?? DEFAULT_TTS_SERVER) || DEFAULT_TTS_SERVER;
  const voiceName = String(draft.ui.voice_name ?? "");

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <VoiceSelector
        ttsServer={ttsServer}
        voiceName={voiceName}
        onTtsServerChange={setTtsServer}
        onVoiceNameChange={setVoiceName}
        onPreviewVoice={requestSample}
        includeNoVoice
        keepUnknownVoice={false}
        fill
      />
      <div className="shrink-0">
        <VoicePreview voiceName={voiceName} voiceRate={1} voiceVolume={1} autoPlayKey={autoPlayKey} />
      </div>
    </div>
  );
}
