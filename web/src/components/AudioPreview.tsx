/**
 * Listen-before-generate controls for the selected TTS voice and BGM track.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AudioLines, FileText, Loader2 } from "lucide-react";
import { api, ApiError, type MediaFile } from "../api/client.ts";
import { SUPPORTED_LANGUAGES, translateIn, useI18n } from "../i18n/index.tsx";
import { Alert, Button } from "./ui.tsx";

const NO_VOICE = new Set(["no-voice", "none", ""]);
const VIETNAMESE_CHARS = /[àáâãèéêìíòóôõùúýăđơưÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝĂĐƠƯ]/;

/**
 * Language code of an Azure/Edge voice, which carries its locale as a prefix:
 * `bn-BD-PradeepNeural-Male`. Every other engine names voices without one
 * (`gemini:Zephyr-Female`, `chatterbox:default-Female`) and yields null.
 */
function voiceLanguage(voiceName: string): string | null {
  const match = /^([a-z]{2,3})-[A-Za-z]{2,}-/.exec(voiceName.trim());
  return match?.[1] ?? null;
}

export function estimateVoiceoverDurationRange(text: string, voiceRate: number): [number, number] | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  const scriptCharRe = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;
  const scriptChars = normalized.match(scriptCharRe) ?? [];
  const remaining = normalized.replace(scriptCharRe, " ");
  const words = remaining.match(/\b[\w]+(?:[-'’][\w]+)*\b/g) ?? [];
  const punctuationCount = (normalized.match(/[,，.。!?！？;；:：]/g) ?? []).length;

  const baseSeconds = scriptChars.length / 4.2 + words.length / 2.6 + punctuationCount * 0.12;
  if (baseSeconds <= 0) return null;

  const estimated = baseSeconds / Math.max(voiceRate || 1, 0.1);
  return [round1(Math.max(estimated * 0.85, 1)), round1(Math.max(estimated * 1.15, 1))];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Picks the sentence the sample voice reads aloud.
 *
 * It has to be in the *voice's* language, not the interface's: a Bangla voice
 * handed the English sample speaks English, which tells you nothing about how
 * the voice will sound narrating a Bangla script. Voices whose language has no
 * locale file — and engines that do not name a language at all — keep reading
 * the UI language's sample, since there is nothing better to offer them.
 */
function sampleTextForVoice(voiceName: string, uiSample: string): string {
  if (voiceName.startsWith("elevenlabs:")) {
    // ElevenLabs voices carry no locale, so the language is inferred from the
    // display name the account owner chose.
    const display = voiceName.split(":")[2] ?? "";
    if (VIETNAMESE_CHARS.test(display)) return translateIn("vi", "Voice Example");
    return uiSample;
  }

  const language = voiceLanguage(voiceName);
  if (language && SUPPORTED_LANGUAGES.includes(language)) {
    return translateIn(language, "Voice Example");
  }
  return uiSample;
}

function PreviewPlayer({ src, volume, autoPlay = false }: { src: string; volume?: number; autoPlay?: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (ref.current && volume != null) {
      ref.current.volume = Math.min(1, Math.max(0, volume));
    }
  }, [volume, src]);

  useEffect(() => {
    const el = ref.current;
    if (!autoPlay || !el) return;
    el.currentTime = 0;
    void el.play().catch(() => undefined);
  }, [src, autoPlay]);

  return (
    // Preview clips have no dialogue captions; this is a settings listen, not a video.
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <audio ref={ref} src={src} controls autoPlay={autoPlay} preload={autoPlay ? "auto" : "metadata"} className="audio-preview w-full" />
  );
}

/** Bump `autoPlayKey` when the user picks a voice so the sample starts itself. */
export function useVoiceSampleTrigger() {
  const [autoPlayKey, setAutoPlayKey] = useState(0);
  const requestSample = useCallback((voice: string) => {
    if (NO_VOICE.has(voice.trim().toLowerCase())) return;
    setAutoPlayKey((key) => key + 1);
  }, []);
  return { autoPlayKey, requestSample } as const;
}

export function VoicePreview({
  voiceName,
  voiceRate,
  voiceVolume,
  script = "",
  autoPlayKey = 0,
}: {
  voiceName: string;
  voiceRate: number;
  voiceVolume: number;
  script?: string;
  /** Incremented when the user picks a voice; synthesizes and plays the sample. */
  autoPlayKey?: number;
}) {
  const { t } = useI18n();
  const disabled = NO_VOICE.has(voiceName.trim().toLowerCase());
  const scriptContent = script.trim();
  const sampleText = sampleTextForVoice(voiceName, t("Voice Example"));
  const estimated = estimateVoiceoverDurationRange(scriptContent, voiceRate);

  const [preview, setPreview] = useState<{ url: string; kind: "sample" | "full"; duration: number | null } | null>(
    null,
  );
  const abortRef = useRef<AbortController | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  previewUrlRef.current = preview?.url ?? null;

  useEffect(() => {
    abortRef.current?.abort();
    setPreview((current) => {
      if (!current) return current;
      URL.revokeObjectURL(current.url);
      return null;
    });
  }, [voiceName, voiceRate, voiceVolume, sampleText]);

  useEffect(() => {
    setPreview((current) => {
      if (current?.kind !== "full") return current;
      URL.revokeObjectURL(current.url);
      return null;
    });
  }, [scriptContent]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    [],
  );

  const synthesize = useMutation({
    mutationFn: async (kind: "sample" | "full") => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const result = await api.previewVoice(
          {
            voice_name: voiceName,
            voice_rate: voiceRate,
            voice_volume: voiceVolume,
            text: kind === "full" ? scriptContent : sampleText,
          },
          controller.signal,
        );
        return { kind, result };
      } catch (error) {
        if (controller.signal.aborted) return { kind, result: null };
        throw error;
      }
    },
    onSuccess: ({ kind, result }) => {
      if (!result) return;
      setPreview((current) => {
        if (current) URL.revokeObjectURL(current.url);
        return { url: URL.createObjectURL(result.blob), kind, duration: result.duration };
      });
    },
  });

  useEffect(() => {
    if (!autoPlayKey || disabled) return;
    synthesize.mutate("sample");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- play only when the user picks a voice
  }, [autoPlayKey]);

  if (disabled) return null;

  const pending = synthesize.isPending;
  const errorMessage =
    synthesize.error instanceof ApiError
      ? synthesize.error.message
      : synthesize.error
        ? String((synthesize.error as Error).message)
        : null;
  const sampleButton = (
    <Button
      size="sm"
      className={scriptContent ? undefined : "w-full"}
      disabled={pending}
      title={t("Play Voice")}
      onClick={() => synthesize.mutate("sample")}
    >
      {pending && synthesize.variables === "sample" ? (
        <Loader2 size={14} className="animate-spin" />
      ) : (
        <AudioLines size={14} />
      )}
      {t("Play Voice")}
    </Button>
  );

  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface-2/60 p-3">
      {scriptContent ? (
        <>
          {estimated ? (
            <p className="text-xs text-muted">
              {t("Estimated Voiceover Duration", { min: estimated[0], max: estimated[1] })}
            </p>
          ) : (
            <p className="text-xs text-muted">{t("Voiceover Script Required")}</p>
          )}
          <div className="grid grid-cols-2 gap-2">
            {sampleButton}
            <Button
              size="sm"
              disabled={pending}
              title={t("Full Voiceover Preview Cost Hint")}
              onClick={() => synthesize.mutate("full")}
            >
              {pending && synthesize.variables === "full" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <FileText size={14} />
              )}
              {t("Generate Full Voiceover Preview")}
            </Button>
          </div>
        </>
      ) : (
        sampleButton
      )}

      {pending && <p className="text-xs text-muted">{t("Synthesizing Voice")}</p>}
      {errorMessage && (
        <Alert tone="danger">
          {t("Voice Preview Failed", { error: errorMessage })}
        </Alert>
      )}
      {preview && (
        <div className="space-y-1.5">
          <PreviewPlayer src={preview.url} autoPlay />
          {preview.kind === "full" && preview.duration != null && (
            <p className="text-xs text-muted">
              {t("Actual Voiceover Duration", { duration: preview.duration.toFixed(1) })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function BgmPreview({
  bgmType,
  bgmFile,
  bgmVolume,
  files,
}: {
  bgmType: string;
  bgmFile: string;
  bgmVolume: number;
  files: MediaFile[];
}) {
  const { t } = useI18n();

  const selected = useMemo(() => {
    if (!bgmType || bgmType === "sonilo" || bgmType === "elevenlabs") return null;
    if (bgmType === "custom") {
      return files.find((file) => file.file === bgmFile) ?? null;
    }
    if (bgmType === "random") return files[0] ?? null;
    return null;
  }, [bgmType, bgmFile, files]);

  if (!selected) return null;

  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface-2/60 p-3">
      <p className="text-xs font-medium text-muted">
        {bgmType === "random" ? t("Random Background Music") : t("Background Music Ready")}
      </p>
      <p className="truncate text-xs text-muted" title={selected.name}>
        {selected.name}
      </p>
      <PreviewPlayer src={api.musicFileUrl(selected.file)} volume={bgmVolume} />
    </div>
  );
}
