/**
 * Hook shorts: find teaser ideas in the book, then render them as 9:16 clips.
 *
 * This is a sibling of the long-form chapter pipeline, not a fifth step of it.
 * The AI walks selected passages, writes ~60s spoken scripts meant to stop a
 * scroller, and the ordinary short-video pipeline turns those scripts into
 * portrait videos with stock footage and captions.
 */

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Film,
  Loader2,
  RotateCcw,
  Save,
  Sparkles,
  Tags,
  Trash2,
  Upload,
  Youtube,
} from "lucide-react";
import { api, ApiError } from "../api/client.ts";
import { BgmPreview, VoicePreview, useVoiceSampleTrigger } from "../components/AudioPreview.tsx";
import { VoiceSelector } from "../components/voice-selector.tsx";
import { Checkbox } from "../components/ui/checkbox";
import { useI18n } from "../i18n/index.tsx";
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  NumberInput,
  Progress,
  Select,
  Slider,
  TextArea,
  TextInput,
  buttonClass,
  cn,
} from "../components/ui.tsx";
import {
  BOOK_BGM_TYPES,
  DEFAULT_MAX_SHORTS,
  DEFAULT_SHORT_SECONDS,
  MAX_MAX_SHORTS,
  MAX_SHORT_SECONDS,
  MIN_MAX_SHORTS,
  MIN_SHORT_SECONDS,
  VIDEO_SOURCES,
  bookApi,
  errorText,
  formatDuration,
  isOcrState,
  segmentDownloadName,
  taskDownloadUrl,
  type BookBgmType,
  type BookDetail,
  type BookEvent,
  type BookShort,
  type BookShortState,
  type BookShortsRenderRequest,
  type Translate,
} from "./api.ts";
import {
  YoutubeUploadDialog,
  YoutubeUploadStatus,
  youtubeUploadBusy,
  youtubeAlreadyUploaded,
  type YoutubeUploadDraft,
} from "../components/YoutubeUploadDialog.tsx";
import { DEFAULT_TTS_SERVER, DEFAULT_VOICE_NAME, inferTtsServerFromVoice, voiceFromSettings } from "../lib/voices.ts";

function stateTone(state: BookShortState): "muted" | "success" | "warning" | "danger" | "accent" {
  if (state === "complete") return "success";
  if (state === "failed") return "danger";
  if (state === "queued" || state === "rendering") return "accent";
  return "muted";
}

function shortsError(error: unknown, t: Translate): string {
  if (error instanceof ApiError && error.status === 409) return t("Book Busy Shorts");
  return errorText(error, t);
}

export function ShortsPanel({
  bookId,
  detail,
  progress,
  streamFailed,
  onWorkStarted,
}: {
  bookId: string;
  detail: BookDetail | undefined;
  progress: BookEvent | null;
  streamFailed: boolean;
  onWorkStarted: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [targetSeconds, setTargetSeconds] = useState(DEFAULT_SHORT_SECONDS);
  const [maxShorts, setMaxShorts] = useState(DEFAULT_MAX_SHORTS);
  const [voiceName, setVoiceName] = useState(DEFAULT_VOICE_NAME);
  const [ttsServer, setTtsServer] = useState<string>(DEFAULT_TTS_SERVER);
  const [voiceRate, setVoiceRate] = useState(1);
  const [voiceVolume, setVoiceVolume] = useState(1);
  const [videoSource, setVideoSource] = useState("pexels");
  const [bgmType, setBgmType] = useState<BookBgmType>("random");
  const [bgmFile, setBgmFile] = useState("");
  const [bgmVolume, setBgmVolume] = useState(0.2);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [youtubeDraft, setYoutubeDraft] = useState<YoutubeUploadDraft | null>(null);
  const seededSelection = useRef("");
  const syncedForm = useRef("");
  const { autoPlayKey, requestSample } = useVoiceSampleTrigger();

  const settings = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
  const musics = useQuery({ queryKey: ["musics"], queryFn: api.listMusics });
  const shortsQuery = useQuery({
    queryKey: ["book-shorts", bookId],
    queryFn: () => bookApi.listShorts(bookId),
    enabled: Boolean(bookId),
    refetchInterval: (query) => {
      const data = query.state.data;
      const youtubeBusy = Boolean(data?.shorts.some((short) => youtubeUploadBusy(short.youtube_upload_state)));
      const busy =
        data?.plan?.state === "planning" ||
        Boolean(data && data.progress.queued + data.progress.rendering > 0);
      if (youtubeBusy) return 3000;
      return streamFailed && busy ? 3000 : false;
    },
  });

  const storedPlan = shortsQuery.data?.plan ?? detail?.book.shorts ?? null;
  const storedFormKey = `${bookId}:${storedPlan?.revision ?? 0}:${JSON.stringify(storedPlan?.render_params ?? null)}`;
  useEffect(() => {
    if (syncedForm.current === storedFormKey) return;
    if (!settings.isSuccess) return;
    const { voiceName: name, ttsServer: server } = voiceFromSettings(settings.data.ui);
    setVoiceName(name);
    setTtsServer(server);
    if (storedPlan?.target_duration_seconds) setTargetSeconds(storedPlan.target_duration_seconds);
    if (storedPlan?.max_shorts) setMaxShorts(storedPlan.max_shorts);
    const stored = storedPlan?.render_params;
    if (stored?.voice_name) {
      setVoiceName(stored.voice_name);
      setTtsServer(inferTtsServerFromVoice(stored.voice_name));
    }
    if (stored?.voice_rate) setVoiceRate(stored.voice_rate);
    if (stored?.voice_volume !== undefined) setVoiceVolume(stored.voice_volume);
    if (stored?.video_source) setVideoSource(stored.video_source);
    if (stored?.bgm_type === "" || stored?.bgm_type === "random" || stored?.bgm_type === "custom") {
      setBgmType(stored.bgm_type);
    }
    if (stored?.bgm_file) setBgmFile(stored.bgm_file);
    if (stored?.bgm_volume !== undefined) setBgmVolume(stored.bgm_volume);
    syncedForm.current = storedFormKey;
  }, [storedFormKey, settings.isSuccess, settings.data, storedPlan]);

  const plan = storedPlan;
  const liveShorts = progress?.shorts;
  const planning = liveShorts?.state === "planning" || plan?.state === "planning";
  const rendering =
    liveShorts?.state === "rendering" ||
    Boolean(shortsQuery.data && shortsQuery.data.progress.queued + shortsQuery.data.progress.rendering > 0);
  const busy = planning || rendering;

  const shorts = shortsQuery.data?.shorts ?? [];
  const liveStates = liveShorts
    ? Object.fromEntries(liveShorts.items.map((item) => [item.index, item.state]))
    : null;

  const indexKey = shorts.map((short) => short.index).join(",");
  useEffect(() => {
    const ids = shorts.map((short) => short.index);
    setSelected((prev) => {
      if (seededSelection.current !== indexKey) {
        seededSelection.current = indexKey;
        return ids;
      }
      return prev.filter((index) => ids.includes(index));
    });
  }, [indexKey, shorts]);

  const chunksTotal = liveShorts?.chunks_total || plan?.chunks_total || 0;
  const chunksDone = liveShorts?.chunks_done || plan?.chunks_done || 0;
  const renderCounts = liveShorts?.counts ?? shortsQuery.data?.progress;
  const ready = Boolean(detail) && !isOcrState(detail?.book.state) && detail?.book.state !== "extracting";
  const allSelected = shorts.length > 0 && selected.length === shorts.length;

  const refreshShorts = () => {
    queryClient.invalidateQueries({ queryKey: ["book-shorts", bookId] });
    queryClient.invalidateQueries({ queryKey: ["book", bookId] });
  };

  const renderBody = (indexes?: number[]): BookShortsRenderRequest => ({
    voice_name: voiceName,
    voice_rate: voiceRate,
    voice_volume: voiceVolume,
    video_aspect: "9:16",
    video_source: videoSource,
    bgm_type: bgmType,
    bgm_file: bgmFile,
    bgm_volume: bgmVolume,
    ...(indexes ? { indexes } : {}),
  });

  const planMut = useMutation({
    mutationFn: () =>
      bookApi.planShorts(bookId, {
        target_duration_seconds: targetSeconds,
        max_shorts: maxShorts,
      }),
    onSuccess: () => {
      onWorkStarted();
      refreshShorts();
    },
  });

  const renderMut = useMutation({
    mutationFn: (indexes?: number[]) => bookApi.renderShorts(bookId, renderBody(indexes)),
    onSuccess: () => {
      onWorkStarted();
      refreshShorts();
    },
  });

  const retryMut = useMutation({
    mutationFn: (index: number) => bookApi.renderShort(bookId, index, renderBody([index])),
    onSuccess: () => {
      onWorkStarted();
      refreshShorts();
    },
  });

  const dropMut = useMutation({
    mutationFn: (index: number) => bookApi.removeShort(bookId, index),
    onSuccess: (_, index) => {
      setSelected((prev) => prev.filter((value) => value !== index));
      if (openIndex === index) setOpenIndex(null);
      refreshShorts();
    },
  });

  const uploadMusic = useMutation({
    mutationFn: (file: File) => api.uploadMusic(file),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["musics"] });
      if (result?.file) {
        setBgmType("custom");
        setBgmFile(result.file);
      }
    },
  });

  const toggleSelected = (index: number, checked: boolean) => {
    setSelected((prev) => (checked ? [...prev, index] : prev.filter((value) => value !== index)));
  };

  return (
    <div className="space-y-5">
      <Card title={t("Book Shorts Title")}>
        <p className="text-sm text-muted">{t("Book Shorts Intro")}</p>
        {!ready && (
          <Alert tone="warning">
            {t("Book Shorts Not Ready")}
          </Alert>
        )}

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label={t("Book Shorts Duration")} hint={t("Book Shorts Duration Hint")}>
            <NumberInput
              min={MIN_SHORT_SECONDS}
              max={MAX_SHORT_SECONDS}
              value={targetSeconds}
              disabled={busy || !ready}
              onChange={(event) => setTargetSeconds(Number(event.target.value) || DEFAULT_SHORT_SECONDS)}
            />
          </Field>
          <Field label={t("Book Shorts Max")} hint={t("Book Shorts Max Hint")}>
            <NumberInput
              min={MIN_MAX_SHORTS}
              max={MAX_MAX_SHORTS}
              value={maxShorts}
              disabled={busy || !ready}
              onChange={(event) => setMaxShorts(Number(event.target.value) || DEFAULT_MAX_SHORTS)}
            />
          </Field>
        </div>

        {planning && chunksTotal > 0 && (
          <div className="mt-4">
            <Progress value={Math.round((chunksDone / chunksTotal) * 100)} />
            <p className="mt-1 text-xs tabular-nums text-muted">
              {t("Book Shorts Reading Part", { done: chunksDone, total: chunksTotal })}
            </p>
          </div>
        )}

        {plan?.state === "failed" && plan.error && !planning && (
          <Alert tone="danger">
            {plan.error}
          </Alert>
        )}

        {planMut.isError && (
          <Alert tone="warning">
            {shortsError(planMut.error, t)}
          </Alert>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            disabled={busy || !ready || planMut.isPending}
            onClick={() => planMut.mutate()}
          >
            {planMut.isPending || planning ? (
              <Loader2 className="animate-spin" size={14} />
            ) : (
              <Sparkles size={14} />
            )}
            {shorts.length > 0 ? t("Book Shorts Regenerate") : t("Book Shorts Find")}
          </Button>
          {shorts.length > 0 && (
            <p className="text-xs text-muted">{t("Book Shorts Replace Hint")}</p>
          )}
        </div>
      </Card>

      {shorts.length > 0 && (
        <Card title={t("Book Shorts Render")}>
          <div className="space-y-3">
            <Field label={t("Book Pick A Voice")}>
              <VoiceSelector
                ttsServer={ttsServer}
                voiceName={voiceName}
                onTtsServerChange={setTtsServer}
                onVoiceNameChange={setVoiceName}
                onPreviewVoice={requestSample}
              />
            </Field>
            <Field label={t("Speech Rate")}>
              <Slider
                value={voiceRate}
                min={0.5}
                max={2}
                step={0.05}
                onValueChange={setVoiceRate}
                format={(value) => `${value.toFixed(2)}x`}
              />
            </Field>
            <Field label={t("Speech Volume")}>
              <Slider
                value={voiceVolume}
                min={0}
                max={2}
                step={0.05}
                onValueChange={setVoiceVolume}
                format={(value) => value.toFixed(2)}
              />
            </Field>
            <VoicePreview
              voiceName={voiceName}
              voiceRate={voiceRate}
              voiceVolume={voiceVolume}
              autoPlayKey={autoPlayKey}
            />

            <Field label={t("Video Source")}>
              <Select
                value={videoSource}
                onValueChange={setVideoSource}
                options={VIDEO_SOURCES.map((source) => ({ value: source, label: source }))}
              />
            </Field>

            <Field label={t("Background Music")} hint={t("Book Music Hint")}>
              <Select
                value={bgmType}
                onValueChange={(value) => setBgmType(value as BookBgmType)}
                options={BOOK_BGM_TYPES.map((type) => ({
                  value: type,
                  label: t(`Book Music ${type || "none"}`),
                }))}
              />
            </Field>

            {bgmType === "custom" && (
              <div className="space-y-2">
                <Select
                  value={bgmFile}
                  onValueChange={setBgmFile}
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
                {!bgmFile && <Alert tone="warning">{t("Book Music Pick Required")}</Alert>}
              </div>
            )}

            {bgmType !== "" && (
              <>
                <Field label={t("Background Music Volume")}>
                  <Slider
                    value={bgmVolume}
                    min={0}
                    max={1}
                    step={0.05}
                    onValueChange={setBgmVolume}
                    format={(value) => value.toFixed(2)}
                  />
                </Field>
                <BgmPreview
                  bgmType={bgmType}
                  bgmFile={bgmFile}
                  bgmVolume={bgmVolume}
                  files={musics.data?.files ?? []}
                />
              </>
            )}
          </div>

          <p className="mt-2 text-xs text-muted">{t("Book Shorts Render Hint")}</p>

          {renderCounts && renderCounts.total > 0 && (rendering || renderCounts.complete > 0 || renderCounts.failed > 0) && (
            <div className="mt-4">
              <Progress value={renderCounts.progress} />
              <p className="mt-1 text-xs tabular-nums text-muted">
                {t("Book Complete Of", { complete: renderCounts.complete, total: renderCounts.total })}
              </p>
            </div>
          )}

          {renderMut.isError && (
            <Alert tone="warning">
              {shortsError(renderMut.error, t)}
            </Alert>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={busy || renderMut.isPending || !voiceName || selected.length === 0}
              onClick={() => renderMut.mutate(selected)}
            >
              {renderMut.isPending || rendering ? (
                <Loader2 className="animate-spin" size={14} />
              ) : (
                <Film size={14} />
              )}
              {t("Book Shorts Generate Selected")}
            </Button>
            <Button
              variant="default"
              disabled={busy || renderMut.isPending || !voiceName}
              onClick={() => renderMut.mutate(undefined)}
            >
              {t("Book Shorts Render All")}
            </Button>
          </div>
        </Card>
      )}

      <Card title={t("Book Shorts List")}>
        {shortsQuery.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted">
            <Loader2 className="animate-spin" size={16} /> {t("Loading")}
          </div>
        ) : shorts.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">{t("Book Shorts Empty")}</p>
        ) : (
          <div className="scroll-x">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="pb-2 pr-3 font-medium">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={(checked) => setSelected(checked ? shorts.map((short) => short.index) : [])}
                      aria-label={t("Book Shorts Keep")}
                    />
                  </th>
                  <th className="pb-2 pr-3 font-medium">#</th>
                  <th className="pb-2 pr-3 font-medium">{t("Book Shorts Clip Title")}</th>
                  <th className="pb-2 pr-3 font-medium">{t("Book Shorts Chapter")}</th>
                  <th className="pb-2 pr-3 font-medium">{t("Book Estimated Duration")}</th>
                  <th className="pb-2 pr-3 font-medium">{t("Task Status")}</th>
                  <th className="pb-2 font-medium">{t("Task Actions")}</th>
                </tr>
              </thead>
              <tbody>
                {shorts.map((short) => {
                  const state = liveStates?.[short.index] ?? short.state;
                  const active = state === "queued" || state === "rendering";
                  const open = openIndex === short.index;
                  const kept = selected.includes(short.index);
                  return (
                    <Fragment key={short._id}>
                      <tr className={cn("border-b border-border/60", !open && "last:border-0")}>
                        <td className="py-2.5 pr-3 align-middle">
                          <Checkbox
                            checked={kept}
                            disabled={active}
                            onCheckedChange={(checked) => toggleSelected(short.index, Boolean(checked))}
                            aria-label={t("Book Shorts Keep")}
                          />
                        </td>
                        <td className="py-2.5 pr-3 align-middle tabular-nums text-muted">
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              aria-expanded={open}
                              title={t(open ? "Book Hide Segment Text" : "Book Show Segment Text")}
                              onClick={() => setOpenIndex(open ? null : short.index)}
                              className={cn(
                                "-ml-1 rounded p-0.5 text-muted transition outline-none",
                                "hover:bg-border hover:text-text focus-visible:ring-2 focus-visible:ring-accent/40",
                              )}
                            >
                              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                            {short.index + 1}
                          </div>
                        </td>
                        <td className="py-2.5 pr-3 align-middle">
                          <div className="font-medium">{short.title}</div>
                          {short.hook && (
                            <p className="mt-0.5 line-clamp-2 text-xs text-muted">{short.hook}</p>
                          )}
                          {short.error && (
                            <div className="text-xs text-danger" title={short.error}>
                              <span className="line-clamp-2">{short.error}</span>
                            </div>
                          )}
                          <YoutubeUploadStatus
                            state={short.youtube_upload_state}
                            error={short.youtube_upload_error}
                            results={short.youtube_upload_results}
                          />
                        </td>
                        <td className="py-2.5 pr-3 align-middle text-muted">{short.chapter_title}</td>
                        <td className="py-2.5 pr-3 align-middle tabular-nums whitespace-nowrap">
                          {formatDuration(short.estimated_duration)}
                        </td>
                        <td className="py-2.5 pr-3 align-middle">
                          <Badge tone={stateTone(state)}>{t(`Book Segment State ${state}`)}</Badge>
                        </td>
                        <td className="py-2.5 align-middle">
                          <div className="flex items-center gap-1">
                            {short.video_url && (
                              <>
                                <a
                                  href={short.video_url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className={buttonClass({ variant: "ghost", size: "sm" })}
                                  title={t("Book Open Video")}
                                >
                                  <Film size={14} />
                                </a>
                                <FileDownloadLink
                                  href={short.video_url}
                                  title={short.title}
                                  label={t("Book Download Video")}
                                >
                                  <Download size={14} />
                                  {t("Download")}
                                </FileDownloadLink>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={
                                    youtubeUploadBusy(short.youtube_upload_state) ||
                                    youtubeAlreadyUploaded(short.youtube_upload_results)
                                  }
                                  title={
                                    youtubeAlreadyUploaded(short.youtube_upload_results)
                                      ? t("YouTube Already Uploaded")
                                      : t("YouTube Upload Title")
                                  }
                                  onClick={() =>
                                    setYoutubeDraft({
                                      source: "book_short",
                                      bookId,
                                      shortIndex: short.index,
                                      title: short.youtube_title || short.title,
                                      description: short.description || short.hook || "",
                                      tags: short.tags ?? [],
                                    })
                                  }
                                >
                                  {youtubeUploadBusy(short.youtube_upload_state) ? (
                                    <Loader2 className="animate-spin" size={14} />
                                  ) : (
                                    <Youtube size={14} />
                                  )}
                                </Button>
                              </>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={active || retryMut.isPending || busy}
                              title={t("Book Retry Segment")}
                              onClick={() => retryMut.mutate(short.index)}
                            >
                              {retryMut.isPending && retryMut.variables === short.index ? (
                                <Loader2 className="animate-spin" size={14} />
                              ) : (
                                <RotateCcw size={14} />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={active || dropMut.isPending || busy}
                              title={t("Book Shorts Drop")}
                              onClick={() => dropMut.mutate(short.index)}
                            >
                              {dropMut.isPending && dropMut.variables === short.index ? (
                                <Loader2 className="animate-spin" size={14} />
                              ) : (
                                <Trash2 size={14} className="text-danger" />
                              )}
                            </Button>
                          </div>
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-b border-border/60 last:border-0">
                          <td colSpan={7} className="py-0">
                            <ShortEditor
                              bookId={bookId}
                              short={short}
                              locked={busy || active}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {(progress?.shorts_logs?.length ?? 0) > 0 && (
          <div className="mt-4 space-y-1">
            <p className="text-xs font-medium text-muted">{t("Book Activity")}</p>
            <ul className="max-h-40 space-y-0.5 overflow-auto text-xs text-muted">
              {progress!.shorts_logs!.map((line, index) => (
                <li key={`${line.index}-${index}`} className="font-mono">
                  {line.index < 0 ? t("Book Shorts Plan Log") : `#${line.index + 1}`} · {line.line}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <YoutubeUploadDialog
        open={Boolean(youtubeDraft)}
        onOpenChange={(open) => !open && setYoutubeDraft(null)}
        draft={youtubeDraft}
      />
    </div>
  );
}

function tagsToInput(tags: string[] | undefined): string {
  return (tags ?? []).join(", ");
}

function tagsFromInput(value: string): string[] {
  return value
    .split(/[,;\n]+/)
    .map((tag) => tag.replace(/^#+/, "").trim())
    .filter(Boolean);
}

function ShortEditor({
  bookId,
  short,
  locked,
}: {
  bookId: string;
  short: BookShort;
  locked: boolean;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(short.title);
  const [hook, setHook] = useState(short.hook);
  const [script, setScript] = useState(short.script);
  const [youtubeTitle, setYoutubeTitle] = useState(short.youtube_title ?? short.title);
  const [description, setDescription] = useState(short.description ?? "");
  const [tagsText, setTagsText] = useState(tagsToInput(short.tags));

  useEffect(() => {
    setTitle(short.title);
    setHook(short.hook);
    setScript(short.script);
    setYoutubeTitle(short.youtube_title ?? short.title);
    setDescription(short.description ?? "");
    setTagsText(tagsToInput(short.tags));
  }, [short.title, short.hook, short.script, short.youtube_title, short.description, short.tags]);

  const save = useMutation({
    mutationFn: () =>
      bookApi.patchShort(bookId, short.index, {
        title,
        hook,
        script,
        youtube_title: youtubeTitle,
        description,
        tags: tagsFromInput(tagsText),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["book-shorts", bookId] });
    },
  });

  const rewrite = useMutation({
    mutationFn: () => bookApi.regenerateShort(bookId, short.index),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["book-shorts", bookId] });
    },
  });

  const rewriteListing = useMutation({
    mutationFn: () => bookApi.regenerateShortMetadata(bookId, short.index),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["book-shorts", bookId] });
    },
  });

  const dirty =
    title !== short.title ||
    hook !== short.hook ||
    script !== short.script ||
    youtubeTitle !== (short.youtube_title ?? short.title) ||
    description !== (short.description ?? "") ||
    tagsToInput(tagsFromInput(tagsText)) !== tagsToInput(short.tags);

  return (
    <div className="space-y-3 px-1 py-3">
      <Field label={t("Book Shorts Clip Title")}>
        <TextInput
          value={title}
          disabled={locked || save.isPending}
          maxLength={80}
          onChange={(event) => setTitle(event.target.value)}
        />
      </Field>
      <Field label={t("Book Shorts Hook")} hint={t("Book Shorts Hook Hint")}>
        <TextArea
          value={hook}
          disabled={locked || save.isPending}
          rows={2}
          onChange={(event) => setHook(event.target.value)}
        />
      </Field>
      <Field label={t("Book Shorts Script")} hint={t("Book Shorts Script Hint")}>
        <TextArea
          value={script}
          disabled={locked || save.isPending}
          rows={8}
          onChange={(event) => setScript(event.target.value)}
        />
      </Field>

      <p className="pt-1 text-xs font-medium text-muted">{t("Book Shorts Youtube Section")}</p>
      <Field label={t("Book Shorts Youtube Title")} hint={t("Book Shorts Youtube Title Hint")}>
        <TextInput
          value={youtubeTitle}
          disabled={locked || save.isPending}
          maxLength={100}
          onChange={(event) => setYoutubeTitle(event.target.value)}
        />
      </Field>
      <Field label={t("Book Shorts Youtube Description")} hint={t("Book Shorts Youtube Description Hint")}>
        <TextArea
          value={description}
          disabled={locked || save.isPending}
          rows={6}
          maxLength={5000}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
      <Field label={t("Book Shorts Youtube Tags")} hint={t("Book Shorts Youtube Tags Hint")}>
        <TextInput
          value={tagsText}
          disabled={locked || save.isPending}
          onChange={(event) => setTagsText(event.target.value)}
        />
      </Field>

      {save.isError && <Alert tone="danger">{shortsError(save.error, t)}</Alert>}
      {rewrite.isError && <Alert tone="danger">{shortsError(rewrite.error, t)}</Alert>}
      {rewriteListing.isError && <Alert tone="danger">{shortsError(rewriteListing.error, t)}</Alert>}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={locked || save.isPending || !dirty || !title.trim() || !script.trim() || !youtubeTitle.trim()}
          onClick={() => save.mutate()}
        >
          {save.isPending ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />}
          {t("Save")}
        </Button>
        <Button
          size="sm"
          variant="default"
          disabled={locked || rewrite.isPending}
          onClick={() => rewrite.mutate()}
        >
          {rewrite.isPending ? <Loader2 className="animate-spin" size={14} /> : <Sparkles size={14} />}
          {t("Book Shorts Rewrite")}
        </Button>
        <Button
          size="sm"
          variant="default"
          disabled={locked || rewriteListing.isPending}
          onClick={() => rewriteListing.mutate()}
        >
          {rewriteListing.isPending ? <Loader2 className="animate-spin" size={14} /> : <Tags size={14} />}
          {t("Book Shorts Rewrite Listing")}
        </Button>
      </div>
    </div>
  );
}

function FileDownloadLink({
  href,
  title,
  label,
  children,
}: {
  href: string;
  title: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <a
      href={taskDownloadUrl(href)}
      download={segmentDownloadName(title, href)}
      className={buttonClass({ variant: "ghost", size: "sm" })}
      title={label}
      aria-label={label}
    >
      {children}
    </a>
  );
}
