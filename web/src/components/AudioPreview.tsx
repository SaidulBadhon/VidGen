/**
 * Listen-before-generate controls for the selected TTS voice and BGM track.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AudioLines, FileText, Loader2 } from "lucide-react";
import { api, ApiError, type MediaFile } from "../api/client.ts";
import { useI18n } from "../i18n/index.tsx";
import { Alert, Button } from "./ui.tsx";

const NO_VOICE = new Set(["no-voice", "none", ""]);
const VIETNAMESE_CHARS = /[àáâãèéêìíòóôõùúýăđơưÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝĂĐƠƯ]/;

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

function sampleTextForVoice(voiceName: string, fallback: string): string {
  if (voiceName.startsWith("elevenlabs:")) {
    const display = voiceName.split(":")[2] ?? "";
    if (VIETNAMESE_CHARS.test(display)) {
      return "Xin chào, đây là đoạn âm thanh thử nghiệm giọng nói.";
    }
  }
  return fallback;
}

function PreviewPlayer({ src, volume }: { src: string; volume?: number }) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (ref.current && volume != null) {
      ref.current.volume = Math.min(1, Math.max(0, volume));
    }
  }, [volume, src]);

  return (
    // Preview clips have no dialogue captions; this is a settings listen, not a video.
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <audio ref={ref} src={src} controls preload="metadata" className="audio-preview w-full" />
  );
}

export function VoicePreview({
  voiceName,
  voiceRate,
  voiceVolume,
  script,
}: {
  voiceName: string;
  voiceRate: number;
  voiceVolume: number;
  script: string;
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

  if (disabled) return null;

  const pending = synthesize.isPending;
  const errorMessage =
    synthesize.error instanceof ApiError
      ? synthesize.error.message
      : synthesize.error
        ? String((synthesize.error as Error).message)
        : null;

  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface-2/60 p-3">
      {estimated ? (
        <p className="text-xs text-muted">{t("Estimated Voiceover Duration", { min: estimated[0], max: estimated[1] })}</p>
      ) : (
        <p className="text-xs text-muted">{t("Voiceover Script Required")}</p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Button
          size="sm"
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
        <Button
          size="sm"
          disabled={pending || !scriptContent}
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

      {pending && <p className="text-xs text-muted">{t("Synthesizing Voice")}</p>}
      {errorMessage && (
        <Alert tone="danger">
          {t("Voice Preview Failed", { error: errorMessage })}
        </Alert>
      )}
      {preview && (
        <div className="space-y-1.5">
          <PreviewPlayer src={preview.url} />
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
