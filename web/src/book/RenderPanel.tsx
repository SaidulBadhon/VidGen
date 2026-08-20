/**
 * Step 4: narrate and render.
 *
 * Settings apply to every clip. The whole book can be queued at once, or any
 * idle segment on its own — the server already accepts a subset, the form just
 * has to send it. A later retry without a body reuses whatever was stored here.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Image as ImageIcon, Loader2, Play, RotateCw, Upload } from "lucide-react";
import { api } from "../api/client.ts";
import { BgmPreview, VoicePreview, useVoiceSampleTrigger } from "../components/AudioPreview.tsx";
import { VoiceSelector } from "../components/voice-selector.tsx";
import { Checkbox } from "../components/ui/checkbox";
import { useI18n } from "../i18n/index.tsx";
import {
  Alert,
  Badge,
  Button,
  Card,
  ColorInput,
  Field,
  NumberInput,
  Progress,
  Select,
  Slider,
  Switch,
  cn,
} from "../components/ui.tsx";
import {
  ACCEPTED_COVER_EXTENSIONS,
  BOOK_BGM_TYPES,
  BOOK_TEMPLATE_PARTS,
  COVER_TITLE_POSITIONS,
  SUBTITLE_RENDER_MODES,
  VIDEO_ASPECTS,
  bookApi,
  bookTemplatesOf,
  errorText,
  formatDuration,
  isRenderConflict,
  type BookBgmType,
  type BookDetail,
  type BookEvent,
  type BookLogLine,
  type BookRenderRequest,
  type BookSegmentState,
  type BookTemplateMetadata,
  type BookTemplatePart,
  type CoverTitlePosition,
  type SubtitleRenderMode,
} from "./api.ts";
import { DEFAULT_TTS_SERVER, DEFAULT_VOICE_NAME, inferTtsServerFromVoice, voiceFromSettings } from "../lib/voices.ts";
import { SegmentTitleEditor } from "./SegmentTitleEditor.tsx";

/** Radix Select renders an empty value as a blank trigger, so "server default" needs a name. */
const DEFAULT_FONT = "__default__";
/** Same trick for "no template": the plain still is a real choice, not a blank row. */
const DEFAULT_TEMPLATE = "__default__";

const DEFAULT_FORM: Required<Omit<BookRenderRequest, "segment_indexes">> = {
  voice_name: DEFAULT_VOICE_NAME,
  voice_rate: 1,
  voice_volume: 1,
  subtitle_render_mode: "soft",
  video_aspect: "16:9",
  // No music by default: an audiobook is narration first, and the server
  // defaults the same way so an old book keeps rendering as it always did.
  bgm_type: "",
  bgm_file: "",
  bgm_volume: 0.2,
  font_name: "",
  font_size: 48,
  n_threads: 2,
  burn_book_title: false,
  burn_chapter_title: false,
  cover_book_title_position: "bottom",
  cover_chapter_title_position: "bottom",
  // All three empty for the same reason `burn_book_title` is false: a book
  // rendered before templates shipped and re-rendered after must come out
  // identical. Empty is the documented ask for exactly today's static still.
  template_id: "",
  template_parts: [],
  template_accent: "",
};

type RenderForm = typeof DEFAULT_FORM;

function coverPreviewFrameClass(aspect: string): string {
  if (aspect === "9:16") return "mx-auto aspect-[9/16] h-72 w-auto";
  if (aspect === "1:1") return "mx-auto aspect-square h-64 w-auto";
  return "aspect-video w-full";
}

const COVER_POSITION_CLASS: Record<CoverTitlePosition, string> = {
  top_left: "top-[7%] left-[8%] items-start text-left",
  top: "top-[7%] inset-x-[8%] items-center text-center",
  top_right: "top-[7%] right-[8%] items-end text-right",
  left: "left-[8%] inset-y-[7%] justify-center items-start text-left",
  center: "inset-[7%] items-center justify-center text-center",
  right: "right-[8%] inset-y-[7%] justify-center items-end text-right",
  bottom_left: "bottom-[7%] left-[8%] items-start text-left",
  bottom: "bottom-[7%] inset-x-[8%] items-center text-center",
  bottom_right: "bottom-[7%] right-[8%] items-end text-right",
};

const TITLE_SHADOW = "[text-shadow:0_1px_4px_rgba(0,0,0,0.85)]";

function coverVertical(position: CoverTitlePosition): "top" | "center" | "bottom" {
  if (position.startsWith("top")) return "top";
  if (position.startsWith("bottom")) return "bottom";
  return "center";
}

function CoverScrims({ positions }: { positions: CoverTitlePosition[] }) {
  const kinds = new Set(positions.map(coverVertical));
  return (
    <>
      {kinds.has("top") && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[42%] bg-gradient-to-b from-black/80 via-black/45 to-transparent" />
      )}
      {kinds.has("bottom") && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[42%] bg-gradient-to-t from-black/80 via-black/45 to-transparent" />
      )}
      {kinds.has("center") && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-[36%] -translate-y-1/2 bg-gradient-to-b from-transparent via-black/60 to-transparent" />
      )}
    </>
  );
}

function CoverOverlayCopy({
  bookTitle,
  chapterTitle,
  showBookTitle,
  showChapterTitle,
  position,
}: {
  bookTitle: string;
  chapterTitle: string;
  showBookTitle: boolean;
  showChapterTitle: boolean;
  position: CoverTitlePosition;
}) {
  if (!showBookTitle && !showChapterTitle) return null;
  return (
    <div className={cn("pointer-events-none absolute flex flex-col", COVER_POSITION_CLASS[position])}>
      {showBookTitle && (
        <p className={cn("line-clamp-3 text-sm font-semibold leading-snug text-white", TITLE_SHADOW)}>
          {bookTitle}
        </p>
      )}
      {showChapterTitle && (
        <p className={cn("line-clamp-2 text-xs leading-snug text-white/85", TITLE_SHADOW, showBookTitle && "mt-0.5")}>
          {chapterTitle}
        </p>
      )}
    </div>
  );
}

/**
 * The still as it will be encoded: fitted cover, then optional titles with a
 * drop shadow. The preview uses the first chapter; each clip burns its own.
 */
function CoverPreview({
  src,
  alt,
  emptyLabel,
  aspect,
  bookTitle,
  chapterTitle,
  showBookTitle,
  showChapterTitle,
  bookPosition,
  chapterPosition,
}: {
  src?: string;
  alt: string;
  emptyLabel: string;
  aspect: string;
  bookTitle: string;
  chapterTitle: string;
  showBookTitle: boolean;
  showChapterTitle: boolean;
  bookPosition: CoverTitlePosition;
  chapterPosition: CoverTitlePosition;
}) {
  const overlay = showBookTitle || showChapterTitle;
  const stacked = showBookTitle && showChapterTitle && bookPosition === chapterPosition;

  return (
    <div
      className={cn(
        "relative flex items-center justify-center overflow-hidden rounded-lg border border-border bg-black",
        coverPreviewFrameClass(aspect),
      )}
    >
      {src ? (
        <img src={src} alt={alt} className="h-full w-full object-contain" />
      ) : overlay ? (
        <div className="h-full w-full bg-[#14161c]" />
      ) : (
        <div className="flex flex-col items-center gap-2 p-4 text-center text-muted-foreground">
          <ImageIcon size={22} />
          <p className="text-xs">{emptyLabel}</p>
        </div>
      )}

      {overlay && (
        <CoverScrims
          positions={[
            ...(showBookTitle ? [bookPosition] : []),
            ...(showChapterTitle ? [chapterPosition] : []),
          ]}
        />
      )}

      {stacked ? (
        <CoverOverlayCopy
          bookTitle={bookTitle}
          chapterTitle={chapterTitle}
          showBookTitle
          showChapterTitle
          position={bookPosition}
        />
      ) : (
        <>
          <CoverOverlayCopy
            bookTitle={bookTitle}
            chapterTitle={chapterTitle}
            showBookTitle={showBookTitle}
            showChapterTitle={false}
            position={bookPosition}
          />
          <CoverOverlayCopy
            bookTitle={bookTitle}
            chapterTitle={chapterTitle}
            showBookTitle={false}
            showChapterTitle={showChapterTitle}
            position={chapterPosition}
          />
        </>
      )}
    </div>
  );
}

function CoverTitlePositionPicker({
  value,
  onChange,
  disabled,
  label,
}: {
  value: CoverTitlePosition;
  onChange: (value: CoverTitlePosition) => void;
  disabled?: boolean;
  label: string;
}) {
  const { t } = useI18n();

  return (
    <Field label={label}>
      <div
        className="grid w-[5.75rem] grid-cols-3 gap-1"
        role="radiogroup"
        aria-label={label}
      >
        {COVER_TITLE_POSITIONS.map((position) => {
          const selected = value === position;
          return (
            <button
              key={position}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={t(`Book Cover Position ${position}`)}
              title={t(`Book Cover Position ${position}`)}
              disabled={disabled}
              className={cn(
                "h-7 rounded-sm border transition-colors",
                selected
                  ? "border-primary bg-primary"
                  : "border-border bg-muted/70 hover:bg-muted",
                disabled && "pointer-events-none opacity-50",
              )}
              onClick={() => onChange(position)}
            />
          );
        })}
      </div>
    </Field>
  );
}

/**
 * Motion-template controls: which template, which of its parts to apply, and an
 * accent that overrides the one the template ships with.
 *
 * Renders nothing at all when the host offers no templates. That empty list is
 * how a machine without Node and Chrome keeps this form behaving exactly as it
 * did before templates existed — so the control has to disappear rather than
 * offer a choice the renderer would then have to ignore.
 */
function TemplatePicker({
  templates,
  templateId,
  parts,
  accent,
  onTemplateChange,
  onPartsChange,
  onAccentChange,
}: {
  templates: BookTemplateMetadata[];
  templateId: string;
  parts: BookTemplatePart[];
  accent: string;
  onTemplateChange: (template: BookTemplateMetadata | null) => void;
  onPartsChange: (parts: BookTemplatePart[]) => void;
  onAccentChange: (accent: string) => void;
}) {
  const { t } = useI18n();

  // The dropdown entry is keyed `id`; the request field is `template_id`. The
  // two names are different on purpose, and this is the seam between them.
  const active = templates.find((template) => template.id === templateId) ?? null;
  // Only the parts this template actually ships get a checkbox — a card-only
  // template must not offer a bed there is nothing to render from.
  const shipped = BOOK_TEMPLATE_PARTS.filter((part) => active?.parts.includes(part) ?? false);

  if (templates.length === 0) return null;

  return (
    <>
      <hr className="border-border" />

      <Field label={t("Book Template")} hint={active?.description || t("Book Template Hint")}>
        <Select
          value={templateId || DEFAULT_TEMPLATE}
          onValueChange={(value) =>
            onTemplateChange(templates.find((template) => template.id === value) ?? null)
          }
          options={[
            { value: DEFAULT_TEMPLATE, label: t("Book Template None") },
            ...templates.map((template) => ({ value: template.id, label: template.label })),
          ]}
        />
      </Field>

      {/* A stored choice outlives the template it names — a rebuilt image may
          simply not ship it any more. Say so, because the Select has no option
          to match and would otherwise sit blank with no explanation. */}
      {templateId !== "" && !active && (
        <Alert tone="warning">{t("Book Template Missing", { id: templateId })}</Alert>
      )}

      {active && (
        <>
          <Field label={t("Book Template Parts")} hint={t("Book Template Parts Hint")}>
            <div className="space-y-2">
              {shipped.map((part) => (
                <label key={part} className="flex cursor-pointer items-center gap-2.5 text-sm">
                  <Checkbox
                    checked={parts.includes(part)}
                    onCheckedChange={(checked) =>
                      // Rebuilt from `shipped` rather than spliced, which keeps
                      // the canonical order, cannot duplicate, and drops any
                      // part carried over from a template that had one.
                      onPartsChange(
                        shipped.filter((candidate) =>
                          candidate === part ? checked === true : parts.includes(candidate),
                        ),
                      )
                    }
                  />
                  {t(`Book Template Part ${part}`)}
                </label>
              ))}
            </div>
          </Field>

          {/* Empty accent defers to the one the template ships, so the toggle
              seeds a real colour to edit rather than starting from black. */}
          <Switch
            checked={accent !== ""}
            onCheckedChange={(value) => onAccentChange(value ? active.default_accent : "")}
            label={t("Book Template Accent")}
          />
          {accent === "" ? (
            <p className="text-xs text-muted-foreground">{t("Book Template Accent Hint")}</p>
          ) : (
            <ColorInput value={accent} onChange={onAccentChange} />
          )}
        </>
      )}
    </>
  );
}

function storedCoverPosition(
  value: string | undefined,
  fallback?: string,
): CoverTitlePosition {
  const candidate = value ?? fallback;
  if (candidate && COVER_TITLE_POSITIONS.includes(candidate as CoverTitlePosition)) {
    return candidate as CoverTitlePosition;
  }
  return "bottom";
}

function stateTone(state: BookSegmentState): "muted" | "success" | "warning" | "danger" | "accent" {
  if (state === "complete") return "success";
  if (state === "failed") return "danger";
  if (state === "rendering" || state === "queued") return "accent";
  return "muted";
}

export function RenderPanel({
  bookId,
  detail,
  progress,
  liveStates,
  streamFailed,
  renderingActive,
  onRenderStarted,
}: {
  bookId: string;
  detail?: BookDetail;
  progress: BookEvent | null;
  liveStates: Record<number, BookSegmentState> | null;
  streamFailed: boolean;
  renderingActive: boolean;
  onRenderStarted: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const coverInput = useRef<HTMLInputElement>(null);
  const syncedRef = useRef("");

  const [ttsServer, setTtsServer] = useState<string>(DEFAULT_TTS_SERVER);
  const [form, setForm] = useState<RenderForm>(DEFAULT_FORM);
  const { autoPlayKey, requestSample } = useVoiceSampleTrigger();

  const metadata = useQuery({ queryKey: ["settings-metadata"], queryFn: api.getSettingsMetadata });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
  const musics = useQuery({ queryKey: ["musics"], queryFn: api.listMusics });

  // Seeded once per stored settings change; a background refetch of the book
  // must not overwrite half-adjusted sliders.
  const stored = detail?.book.render_params ?? null;
  const storedKey = stored ? JSON.stringify(stored) : "";
  useEffect(() => {
    const key = `${bookId}:${storedKey}`;
    if (syncedRef.current === key) return;
    if (!stored) {
      if (!settings.isSuccess) return;
      const { voiceName, ttsServer: server } = voiceFromSettings(settings.data.ui);
      setForm({ ...DEFAULT_FORM, voice_name: voiceName });
      setTtsServer(server);
      syncedRef.current = key;
      return;
    }
    syncedRef.current = key;
    setForm({
      voice_name: stored.voice_name,
      voice_rate: stored.voice_rate,
      voice_volume: stored.voice_volume,
      subtitle_render_mode: stored.subtitle_render_mode,
      video_aspect: stored.video_aspect,
      // A book rendered before music existed stores none of these, and must
      // come back as "no music" rather than as the form's own defaults.
      bgm_type: stored.bgm_type ?? "",
      bgm_file: stored.bgm_file ?? "",
      bgm_volume: stored.bgm_volume ?? DEFAULT_FORM.bgm_volume,
      font_name: stored.font_name,
      font_size: stored.font_size,
      n_threads: stored.n_threads,
      burn_book_title: stored.burn_book_title ?? false,
      burn_chapter_title: stored.burn_chapter_title ?? false,
      cover_book_title_position: storedCoverPosition(
        stored.cover_book_title_position,
        stored.cover_title_position,
      ),
      cover_chapter_title_position: storedCoverPosition(
        stored.cover_chapter_title_position,
        stored.cover_title_position,
      ),
      // Seeded straight from storage rather than validated against the
      // metadata: the two queries settle independently, and a template list
      // that has not arrived yet must not silently clear a stored choice.
      // TemplatePicker reports an id the host no longer offers instead.
      template_id: stored.template_id ?? "",
      template_parts: stored.template_parts ?? [],
      template_accent: stored.template_accent ?? "",
    });
    setTtsServer(inferTtsServerFromVoice(stored.voice_name));
  }, [bookId, storedKey, stored, settings.isSuccess, settings.data]);

  const uploadCover = useMutation({
    mutationFn: (file: File) => bookApi.uploadCover(bookId, file),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["book", bookId] }),
  });

  const uploadMusic = useMutation({
    mutationFn: (file: File) => api.uploadMusic(file),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["musics"] });
      // Uploading is only ever done to use the track, so selecting it here
      // saves hunting for it in a list that may hold dozens of files.
      if (result?.file) setForm((current) => ({ ...current, bgm_type: "custom", bgm_file: result.file }));
    },
  });

  const buildBody = (): BookRenderRequest => {
    const body: BookRenderRequest = { ...form };
    // An empty font means "whatever the server defaults to"; sending "" would
    // be taken as a real font name and fail at the ASS writer.
    //
    // The template fields are deliberately *not* given the same treatment.
    // There "" is the documented no-op the schema defaults to, so dropping it
    // and sending it are the same request — and keeping it makes the body say
    // out loud that this render wants the plain still.
    if (!body.font_name) delete body.font_name;
    return body;
  };

  const startRender = useMutation({
    mutationFn: (indexes?: number[]) => {
      const body = buildBody();
      if (indexes) body.segment_indexes = indexes;
      return bookApi.render(bookId, body);
    },
    onSuccess: () => {
      onRenderStarted();
      queryClient.invalidateQueries({ queryKey: ["book", bookId] });
    },
  });

  const set = <K extends keyof RenderForm>(key: K, value: RenderForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const templates = bookTemplatesOf(metadata.data);

  // Switching templates keeps the ticks the new one can honour and drops the
  // rest, and always returns the accent to "": every template ships its own
  // default, so carrying one template's colour onto another would be inventing
  // a choice nobody made.
  const chooseTemplate = (template: BookTemplateMetadata | null) =>
    setForm((current) => ({
      ...current,
      template_id: template?.id ?? "",
      template_parts: template
        ? current.template_parts.filter((part) => template.parts.includes(part))
        : [],
      template_accent: "",
    }));

  const segments = detail?.segments ?? [];
  const totalDuration = segments.reduce((sum, segment) => sum + (segment.estimated_duration || 0), 0);
  const failed = segments.filter((segment) => segment.state === "failed");
  const counts = progress?.counts ?? detail?.progress ?? null;
  const percent = progress?.progress ?? detail?.progress.progress ?? 0;
  const queue = detail?.queue;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title={t("Book Cover")}>
          <div className="space-y-3">
            <CoverPreview
              src={detail?.book.has_cover ? bookApi.coverUrl(bookId, detail.book.revision) : undefined}
              alt={t("Book Cover Alt", { title: detail?.book.title ?? "" })}
              emptyLabel={t("Book No Cover")}
              aspect={form.video_aspect}
              bookTitle={detail?.book.title?.trim() || t("Book Cover")}
              chapterTitle={segments[0]?.title?.trim() || t("Book Cover Chapter Preview")}
              showBookTitle={form.burn_book_title}
              showChapterTitle={form.burn_chapter_title}
              bookPosition={form.cover_book_title_position}
              chapterPosition={form.cover_chapter_title_position}
            />

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
            <p className="text-xs text-muted-foreground">{t("Book Cover Hint")}</p>
            {uploadCover.isError && <Alert tone="danger">{errorText(uploadCover.error, t)}</Alert>}

            <hr className="border-border" />

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Switch
                  checked={form.burn_book_title}
                  onCheckedChange={(value) => set("burn_book_title", value)}
                  label={t("Book Cover Burn Title")}
                />
                <CoverTitlePositionPicker
                  value={form.cover_book_title_position}
                  onChange={(value) => set("cover_book_title_position", value)}
                  disabled={!form.burn_book_title}
                  label={t("Book Cover Book Position")}
                />
              </div>
              <div className="space-y-2">
                <Switch
                  checked={form.burn_chapter_title}
                  onCheckedChange={(value) => set("burn_chapter_title", value)}
                  label={t("Book Cover Burn Chapter")}
                />
                <CoverTitlePositionPicker
                  value={form.cover_chapter_title_position}
                  onChange={(value) => set("cover_chapter_title_position", value)}
                  disabled={!form.burn_chapter_title}
                  label={t("Book Cover Chapter Position")}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t("Book Cover Burn Hint")}</p>

            <TemplatePicker
              templates={templates}
              templateId={form.template_id}
              parts={form.template_parts}
              accent={form.template_accent}
              onTemplateChange={chooseTemplate}
              onPartsChange={(parts) => set("template_parts", parts)}
              onAccentChange={(accent) => set("template_accent", accent)}
            />
          </div>
        </Card>

        <Card title={t("Book Narration")}>
          <div className="space-y-3">
            <VoiceSelector
              ttsServer={ttsServer}
              voiceName={form.voice_name}
              onTtsServerChange={setTtsServer}
              onVoiceNameChange={(value) => set("voice_name", value)}
              onPreviewVoice={requestSample}
            />
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
            <VoicePreview
              voiceName={form.voice_name}
              voiceRate={form.voice_rate}
              voiceVolume={form.voice_volume}
              autoPlayKey={autoPlayKey}
            />

            <hr className="border-border" />

            <Field label={t("Background Music")} hint={t("Book Music Hint")}>
              <Select
                value={form.bgm_type}
                onValueChange={(value) => set("bgm_type", value as BookBgmType)}
                options={BOOK_BGM_TYPES.map((type) => ({
                  value: type,
                  label: t(`Book Music ${type || "none"}`),
                }))}
              />
            </Field>

            {form.bgm_type === "custom" && (
              <div className="space-y-2">
                <Select
                  value={form.bgm_file}
                  onValueChange={(value) => set("bgm_file", value)}
                  options={(musics.data?.files ?? []).map((file) => ({ value: file.file, label: file.name }))}
                  placeholder={musics.isLoading ? t("Loading") : t("Select Background Music")}
                />
                <label className="cursor-pointer">
                  <input
                    type="file"
                    className="hidden"
                    accept=".mp3,.m4a,.aac,.wav,.flac,.ogg,.opus,.wma"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) uploadMusic.mutate(file);
                      event.target.value = "";
                    }}
                  />
                  <span className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                    {uploadMusic.isPending ? (
                      <Loader2 className="animate-spin" size={12} />
                    ) : (
                      <Upload size={12} />
                    )}
                    {t("Upload Background Music")}
                  </span>
                </label>
                {uploadMusic.isError && <Alert tone="danger">{errorText(uploadMusic.error, t)}</Alert>}
                {/* The server treats an unpicked track as no music. On a
                    sixty-second clip that is obvious; on a book it is hours of
                    rendering before anyone finds out. */}
                {!form.bgm_file && <Alert tone="warning">{t("Book Music Pick Required")}</Alert>}
              </div>
            )}

            {form.bgm_type !== "" && (
              <>
                <Field label={t("Background Music Volume")}>
                  <Slider
                    value={form.bgm_volume}
                    min={0}
                    max={1}
                    step={0.05}
                    onValueChange={(value) => set("bgm_volume", value)}
                    format={(value) => value.toFixed(2)}
                  />
                </Field>
                <BgmPreview
                  bgmType={form.bgm_type}
                  bgmFile={form.bgm_file}
                  bgmVolume={form.bgm_volume}
                  files={musics.data?.files ?? []}
                />
              </>
            )}
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
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
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
              <span className="text-muted-foreground">{t("Book Segments")}: </span>
              <span className="font-medium tabular-nums">{segments.length}</span>
            </span>
            <span>
              <span className="text-muted-foreground">{t("Book Estimated Total")}: </span>
              <span className="font-medium tabular-nums">{formatDuration(totalDuration)}</span>
            </span>
            <span>
              <span className="text-muted-foreground">{t("Book Kept")}: </span>
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
            onClick={() => startRender.mutate(undefined)}
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

          {segments.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t("Book Render One Hint")}</p>
              <div className="scroll-x">
                <table className="w-full min-w-[520px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="pb-2 pr-3 font-medium">#</th>
                      <th className="pb-2 pr-3 font-medium">{t("Book Segment Title")}</th>
                      <th className="pb-2 pr-3 font-medium">{t("Book Estimated Duration")}</th>
                      <th className="pb-2 pr-3 font-medium">{t("Task Status")}</th>
                      <th className="pb-2 font-medium">{t("Task Actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {segments.map((segment) => {
                      const state = liveStates?.[segment.index] ?? segment.state;
                      const busy = state === "queued" || state === "rendering";
                      const again = state === "complete" || state === "failed";
                      const posting = startRender.isPending && startRender.variables?.[0] === segment.index;
                      return (
                        <tr key={segment._id} className="border-b border-border/60 last:border-0">
                          <td className="py-2 pr-3 align-middle tabular-nums text-muted-foreground">
                            {segment.index + 1}
                          </td>
                          <td className="py-2 pr-3 align-middle">
                            <SegmentTitleEditor
                              bookId={bookId}
                              index={segment.index}
                              title={segment.title}
                              locked={busy}
                            />
                            {segment.error && (
                              <div className="text-xs text-destructive" title={segment.error}>
                                <span className="line-clamp-2">{segment.error}</span>
                              </div>
                            )}
                          </td>
                          <td className="py-2 pr-3 align-middle tabular-nums whitespace-nowrap">
                            {formatDuration(segment.estimated_duration)}
                          </td>
                          <td className="py-2 pr-3 align-middle">
                            <Badge tone={stateTone(state)}>{t(`Book Segment State ${state}`)}</Badge>
                          </td>
                          <td className="py-2 align-middle">
                            <Button
                              size="sm"
                              disabled={busy || !form.voice_name || startRender.isPending}
                              title={again ? t("Book Retry Segment") : t("Book Render Segment")}
                              onClick={() => startRender.mutate([segment.index])}
                            >
                              {busy || posting ? (
                                <Loader2 className="animate-spin" size={14} />
                              ) : again ? (
                                <RotateCw size={14} />
                              ) : (
                                <Play size={14} />
                              )}
                              {again ? t("Book Retry") : t("Book Render One")}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
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
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
              <span>{t("Book Segment State pending")}: {counts.pending}</span>
              <span>{t("Book Segment State queued")}: {counts.queued}</span>
              <span>{t("Book Segment State rendering")}: {counts.rendering}</span>
              <span>{t("Book Segment State complete")}: {counts.complete}</span>
              <span>{t("Book Segment State failed")}: {counts.failed}</span>
            </div>

            {queue && queue.waiting > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("Book Queue Note", { active: queue.active, waiting: queue.waiting, limit: queue.limit })}
              </p>
            )}

            {streamFailed && <Alert tone="warning">{t("Book Stream Fallback")}</Alert>}

            {failed.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-destructive">
                  {t("Book Segments Failed", { count: failed.length })}
                </p>
                {failed.map((segment) => (
                  <div
                    key={segment._id}
                    className="flex flex-wrap items-start gap-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        #{segment.index + 1} {segment.title || t("Book Untitled Segment")}
                      </p>
                      <p className="text-xs text-muted-foreground">{segment.error ?? t("Task Status Failed")}</p>
                    </div>
                    <Button
                      size="sm"
                      title={t("Book Retry Segment")}
                      disabled={startRender.isPending || !form.voice_name}
                      onClick={() => startRender.mutate([segment.index])}
                    >
                      {startRender.isPending && startRender.variables?.[0] === segment.index ? (
                        <Loader2 className="animate-spin" size={14} />
                      ) : (
                        <RotateCw size={14} />
                      )}
                      {t("Book Retry")}
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <ActivityFeed lines={progress?.recent_logs ?? []} />
          </div>
        </Card>
      )}
    </div>
  );
}

/**
 * The tail of what the render is saying about itself.
 *
 * A book render is hours long and until now said nothing while it ran: the task
 * records filled up with "narrating chapter 12" and "chunk 40/57" and none of it
 * reached a screen, so a working render and a stuck one looked identical. The
 * lines are rendered exactly as the stream delivers them — the server sends a
 * bounded window rather than a transcript, so nothing accumulates here either.
 */
function ActivityFeed({ lines }: { lines: BookLogLine[] }) {
  const { t } = useI18n();
  const scroller = useRef<HTMLPreElement>(null);

  // Newest last means the interesting end is the bottom one.
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines]);

  if (lines.length === 0) return null;

  return (
    <details open>
      <summary className="cursor-pointer text-xs text-muted-foreground">{t("Book Activity")}</summary>
      <pre
        ref={scroller}
        className="scroll-x mt-2 max-h-56 overflow-auto rounded-lg border border-border bg-surface-2 p-2 text-xs"
      >
        {lines
          .map(({ segment, line }) => (segment < 0 ? line : `#${segment + 1} ${line}`))
          .join("\n")}
      </pre>
    </details>
  );
}
