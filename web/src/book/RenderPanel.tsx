/**
 * Step 4: narrate and render.
 *
 * Settings are seeded from whatever the book was last rendered with, so a retry
 * after a failure does not mean re-picking a voice; the same shape is what the
 * per-segment retry endpoint reuses server-side.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Image as ImageIcon, Loader2, Play, Upload } from "lucide-react";
import { api } from "../api/client.ts";
import { useI18n } from "../i18n/index.tsx";
import { Alert, Badge, Button, Card, Field, NumberInput, Progress, Select, Slider } from "../components/ui.tsx";
import {
  ACCEPTED_COVER_EXTENSIONS,
  SUBTITLE_RENDER_MODES,
  VIDEO_ASPECTS,
  bookApi,
  errorText,
  formatDuration,
  isRenderConflict,
  type BookDetail,
  type BookEvent,
  type BookRenderRequest,
  type SubtitleRenderMode,
} from "./api.ts";

const TTS_SERVERS = ["azure-tts-v1", "azure-tts-v2", "siliconflow", "gemini", "mimo", "elevenlabs", "chatterbox"];

/** Radix Select renders an empty value as a blank trigger, so "server default" needs a name. */
const DEFAULT_FONT = "__default__";

const DEFAULT_FORM: Required<Omit<BookRenderRequest, "segment_indexes">> = {
  voice_name: "en-US-AriaNeural-Female",
  voice_rate: 1,
  voice_volume: 1,
  subtitle_render_mode: "soft",
  video_aspect: "16:9",
  font_name: "",
  font_size: 48,
  n_threads: 2,
};

type RenderForm = typeof DEFAULT_FORM;

export function RenderPanel({
  bookId,
  detail,
  progress,
  streamFailed,
  renderingActive,
  onRenderStarted,
}: {
  bookId: string;
  detail?: BookDetail;
  progress: BookEvent | null;
  streamFailed: boolean;
  renderingActive: boolean;
  onRenderStarted: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const coverInput = useRef<HTMLInputElement>(null);
  const syncedRef = useRef("");

  const [ttsServer, setTtsServer] = useState("azure-tts-v1");
  const [form, setForm] = useState<RenderForm>(DEFAULT_FORM);

  const metadata = useQuery({ queryKey: ["settings-metadata"], queryFn: api.getSettingsMetadata });
  const voices = useQuery({ queryKey: ["voices", ttsServer], queryFn: () => api.listVoices(ttsServer) });

  // Seeded once per stored settings change; a background refetch of the book
  // must not overwrite half-adjusted sliders.
  const stored = detail?.book.render_params ?? null;
  const storedKey = stored ? JSON.stringify(stored) : "";
  useEffect(() => {
    const key = `${bookId}:${storedKey}`;
    if (syncedRef.current === key) return;
    syncedRef.current = key;
    if (!stored) {
      setForm(DEFAULT_FORM);
      return;
    }
    setForm({
      voice_name: stored.voice_name,
      voice_rate: stored.voice_rate,
      voice_volume: stored.voice_volume,
      subtitle_render_mode: stored.subtitle_render_mode,
      video_aspect: stored.video_aspect,
      font_name: stored.font_name,
      font_size: stored.font_size,
      n_threads: stored.n_threads,
    });
  }, [bookId, storedKey, stored]);

  const uploadCover = useMutation({
    mutationFn: (file: File) => bookApi.uploadCover(bookId, file),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["book", bookId] }),
  });

  const startRender = useMutation({
    mutationFn: () => {
      const body: BookRenderRequest = { ...form };
      // An empty font means "whatever the server defaults to"; sending "" would
      // be taken as a real font name and fail at the ASS writer.
      if (!body.font_name) delete body.font_name;
      return bookApi.render(bookId, body);
    },
    onSuccess: () => {
      onRenderStarted();
      queryClient.invalidateQueries({ queryKey: ["book", bookId] });
    },
  });

  const set = <K extends keyof RenderForm>(key: K, value: RenderForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const segments = detail?.segments ?? [];
  const totalDuration = segments.reduce((sum, segment) => sum + (segment.estimated_duration || 0), 0);
  const failed = segments.filter((segment) => segment.state === "failed");
  const counts = progress?.counts ?? detail?.progress ?? null;
  const percent = progress?.progress ?? detail?.progress.progress ?? 0;
  const queue = detail?.queue;

  const voiceOptions = (voices.data?.voices ?? []).map((voice) => ({ value: voice, label: voice }));
  // The stored voice may not belong to the server currently selected; keep it
  // listed so the select never silently shows a different voice than it sends.
  if (form.voice_name && !voiceOptions.some((option) => option.value === form.voice_name)) {
    voiceOptions.unshift({ value: form.voice_name, label: form.voice_name });
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title={t("Book Cover")}>
          <div className="space-y-3">
            <div className="flex aspect-video items-center justify-center overflow-hidden rounded-lg border border-border bg-surface-2">
              {detail?.book.has_cover ? (
                <img
                  src={bookApi.coverUrl(bookId, detail.book.revision)}
                  alt={t("Book Cover Alt", { title: detail.book.title })}
                  className="h-full w-full object-contain"
                />
              ) : (
                <div className="flex flex-col items-center gap-2 p-4 text-center text-muted">
                  <ImageIcon size={22} />
                  <p className="text-xs">{t("Book No Cover")}</p>
                </div>
              )}
            </div>

            <input
              ref={coverInput}
              type="file"
              className="hidden"
              accept={ACCEPTED_COVER_EXTENSIONS}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) uploadCover.mutate(file);
                event.target.value = "";
              }}
            />
            <Button
              size="sm"
              className="w-full"
              disabled={uploadCover.isPending}
              onClick={() => coverInput.current?.click()}
            >
              {uploadCover.isPending ? <Loader2 className="animate-spin" size={14} /> : <Upload size={14} />}
              {detail?.book.has_cover ? t("Book Replace Cover") : t("Book Upload Cover")}
            </Button>
            <p className="text-xs text-muted">{t("Book Cover Hint")}</p>
            {uploadCover.isError && <Alert tone="danger">{errorText(uploadCover.error, t)}</Alert>}
          </div>
        </Card>

        <Card title={t("Book Narration")}>
          <div className="space-y-3">
            <Field label={t("TTS Server")}>
              <Select
                value={ttsServer}
                onValueChange={setTtsServer}
                options={TTS_SERVERS.map((server) => ({ value: server, label: server }))}
              />
            </Field>
            <Field label={t("Speech Synthesis")}>
              <Select
                value={form.voice_name}
                onValueChange={(value) => set("voice_name", value)}
                options={voiceOptions}
                placeholder={voices.isLoading ? t("Loading") : t("Book Pick A Voice")}
              />
            </Field>
            <Field label={t("Speech Rate")}>
              <Slider
                value={form.voice_rate}
                min={0.5}
                max={2}
                step={0.05}
                onValueChange={(value) => set("voice_rate", value)}
                format={(value) => `${value.toFixed(2)}x`}
              />
            </Field>
            <Field label={t("Speech Volume")}>
              <Slider
                value={form.voice_volume}
                min={0}
                max={2}
                step={0.05}
                onValueChange={(value) => set("voice_volume", value)}
                format={(value) => value.toFixed(2)}
              />
            </Field>
          </div>
        </Card>

        <Card title={t("Book Output")}>
          <div className="space-y-3">
            <Field label={t("Book Subtitle Mode")} hint={t(`Book Subtitle Mode Hint ${form.subtitle_render_mode}`)}>
              <Select
                value={form.subtitle_render_mode}
                onValueChange={(value) => set("subtitle_render_mode", value as SubtitleRenderMode)}
                options={SUBTITLE_RENDER_MODES.map((mode) => ({
                  value: mode,
                  label: t(`Book Subtitle Mode ${mode}`),
                }))}
              />
            </Field>

            <Field label={t("Video Ratio")}>
              <Select
                value={form.video_aspect}
                onValueChange={(value) => set("video_aspect", value)}
                options={VIDEO_ASPECTS.map((aspect) => ({ value: aspect, label: aspect }))}
              />
            </Field>

            <details className="rounded-lg border border-border bg-surface-2 p-3">
              <summary className="cursor-pointer text-xs font-medium text-muted">
                {t("Book Subtitle Appearance")}
              </summary>
              <div className="mt-3 space-y-3">
                <Field label={t("Font")}>
                  <Select
                    value={form.font_name || DEFAULT_FONT}
                    onValueChange={(value) => set("font_name", value === DEFAULT_FONT ? "" : value)}
                    options={[
                      { value: DEFAULT_FONT, label: t("Book Default Font") },
                      ...(metadata.data?.fonts ?? []).map((font) => ({ value: font, label: font })),
                    ]}
                  />
                </Field>
                <Field label={t("Font Size")}>
                  <NumberInput
                    min={20}
                    max={120}
                    value={form.font_size}
                    onChange={(event) => set("font_size", Number(event.target.value))}
                  />
                </Field>
                <Field label={t("Threads")}>
                  <NumberInput
                    min={1}
                    max={64}
                    value={form.n_threads}
                    onChange={(event) => set("n_threads", Number(event.target.value))}
                  />
                </Field>
              </div>
            </details>
          </div>
        </Card>
      </div>

      <Card title={t("Book Start Render")}>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span>
              <span className="text-muted">{t("Book Segments")}: </span>
              <span className="font-medium tabular-nums">{segments.length}</span>
            </span>
            <span>
              <span className="text-muted">{t("Book Estimated Total")}: </span>
              <span className="font-medium tabular-nums">{formatDuration(totalDuration)}</span>
            </span>
            <span>
              <span className="text-muted">{t("Book Kept")}: </span>
              <span className="font-medium tabular-nums">{detail?.book.kept_block_count ?? 0}</span>
            </span>
          </div>

          {segments.length === 0 && <Alert tone="warning">{t("Book No Segments")}</Alert>}

          <Button
            variant="primary"
            size="lg"
            className="w-full"
            disabled={
              segments.length === 0 || !form.voice_name || startRender.isPending || renderingActive
            }
            onClick={() => startRender.mutate()}
          >
            {startRender.isPending || renderingActive ? (
              <Loader2 className="animate-spin" size={18} />
            ) : (
              <Play size={18} />
            )}
            {renderingActive ? t("Book Rendering") : t("Book Render Book")}
          </Button>

          {startRender.isError && (
            <Alert tone={isRenderConflict(startRender.error) ? "warning" : "danger"}>
              {errorText(startRender.error, t)}
            </Alert>
          )}
          {startRender.isSuccess && !renderingActive && (
            <Alert tone="success">
              {t("Book Render Queued", { count: startRender.data.accepted.length })}
            </Alert>
          )}
        </div>
      </Card>

      {counts && counts.total > 0 && (
        <Card
          title={
            <span className="inline-flex items-center gap-2">
              {t("Book Progress")}
              <Badge
                tone={
                  counts.failed > 0
                    ? "danger"
                    : counts.complete === counts.total
                      ? "success"
                      : renderingActive
                        ? "accent"
                        : "muted"
                }
              >
                {t("Book Complete Of", { complete: counts.complete, total: counts.total })}
              </Badge>
            </span>
          }
        >
          <div className="space-y-3">
            <Progress value={percent} />
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
              <span>{t("Book Segment State pending")}: {counts.pending}</span>
              <span>{t("Book Segment State queued")}: {counts.queued}</span>
              <span>{t("Book Segment State rendering")}: {counts.rendering}</span>
              <span>{t("Book Segment State complete")}: {counts.complete}</span>
              <span>{t("Book Segment State failed")}: {counts.failed}</span>
            </div>

            {queue && queue.waiting > 0 && (
              <p className="text-xs text-muted">
                {t("Book Queue Note", { active: queue.active, waiting: queue.waiting, limit: queue.limit })}
              </p>
            )}

            {streamFailed && <Alert tone="warning">{t("Book Stream Fallback")}</Alert>}

            {failed.length > 0 && (
              <div className="space-y-1.5">
                {failed.map((segment) => (
                  <Alert key={segment._id} tone="danger">
                    #{segment.index + 1} {segment.title}: {segment.error ?? t("Task Status Failed")}
                  </Alert>
                ))}
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
