/**
 * Short-video generation screen.
 *
 * Three columns for script, video and audio/subtitle settings, then generate
 * with live progress, then the task history.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles, Upload, Wand2 } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, subscribeToTask, type Task } from "../api/client.ts";
import { useI18n } from "../i18n/index.tsx";
import { BgmPreview, VoicePreview, useVoiceSampleTrigger } from "../components/AudioPreview.tsx";
import { PageHeader } from "../components/page-header.tsx";
import { TaskManager } from "../components/TaskManager.tsx";
import { VoiceSelector } from "../components/voice-selector.tsx";
import { DEFAULT_TTS_SERVER, DEFAULT_VOICE_NAME, inferTtsServerFromVoice, voiceFromSettings } from "../lib/voices.ts";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../components/ui/accordion";
import { Checkbox } from "../components/ui/checkbox";
import { Separator } from "../components/ui/separator";
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
  TextArea,
  TextInput,
} from "../components/ui.tsx";

/** Mirrors the server-side VideoParams defaults. */
const DEFAULT_PARAMS: Record<string, unknown> = {
  video_subject: "",
  video_script: "",
  video_terms: "",
  video_aspect: "9:16",
  video_concat_mode: "random",
  video_transition_mode: null,
  video_clip_duration: 5,
  video_clip_speed: 1.0,
  match_materials_to_script: false,
  video_count: 1,
  video_source: "pexels",
  video_materials: [],
  video_language: "",
  voice_name: DEFAULT_VOICE_NAME,
  voice_volume: 1.0,
  voice_rate: 1.0,
  bgm_type: "random",
  bgm_file: "",
  bgm_volume: 0.2,
  video_music_prompt: "",
  subtitle_enabled: true,
  subtitle_position: "bottom",
  custom_position: 70,
  font_name: "MicrosoftYaHeiBold.ttc",
  text_fore_color: "#FFFFFF",
  text_background_color: false,
  rounded_subtitle_background: false,
  font_size: 60,
  stroke_color: "#000000",
  stroke_width: 1.5,
  n_threads: 2,
  paragraph_number: 1,
  video_script_prompt: "",
  custom_system_prompt: "",
};

export function VideoScreen() {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();

  const [params, setParams] = useState<Record<string, unknown>>({ ...DEFAULT_PARAMS });
  const [ttsServer, setTtsServer] = useState<string>(DEFAULT_TTS_SERVER);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [promptPreview, setPromptPreview] = useState<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const restoredRef = useRef(false);
  const settingsAppliedRef = useRef(false);

  const set = useCallback((key: string, value: unknown) => {
    setParams((current) => ({ ...current, [key]: value }));
  }, []);
  const setVoiceName = useCallback((value: string) => set("voice_name", value), [set]);
  const { autoPlayKey, requestSample } = useVoiceSampleTrigger();

  const metadata = useQuery({ queryKey: ["settings-metadata"], queryFn: api.getSettingsMetadata });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
  const musics = useQuery({ queryKey: ["musics"], queryFn: api.listMusics });
  const materials = useQuery({ queryKey: ["materials"], queryFn: api.listMaterials });

  // Stop listening when the component unmounts so a closed tab does not leave
  // an open SSE connection behind.
  useEffect(() => () => unsubscribeRef.current?.(), []);

  useEffect(() => {
    const restored = (location.state as { restoreParams?: Record<string, unknown> } | null)?.restoreParams;
    if (!restored) return;
    restoredRef.current = true;
    setParams({ ...DEFAULT_PARAMS, ...restored });
    const restoredVoice = String(restored.voice_name ?? "").trim();
    if (restoredVoice) setTtsServer(inferTtsServerFromVoice(restoredVoice));
    navigate(".", { replace: true, state: {} });
  }, [location.state, navigate]);

  useEffect(() => {
    if (restoredRef.current || settingsAppliedRef.current || !settings.isSuccess) return;
    settingsAppliedRef.current = true;
    const { voiceName, ttsServer: server } = voiceFromSettings(settings.data.ui);
    setParams((current) => ({ ...current, voice_name: voiceName }));
    setTtsServer(server);
  }, [settings.isSuccess, settings.data]);

  const generateScript = useMutation({
    mutationFn: () =>
      api.generateScript({
        video_subject: String(params.video_subject ?? ""),
        video_language: language,
        paragraph_number: Number(params.paragraph_number ?? 1),
        video_script_prompt: String(params.video_script_prompt ?? ""),
        custom_system_prompt: String(params.custom_system_prompt ?? ""),
      }),
    onSuccess: (data) => set("video_script", data.video_script),
  });

  const generateTerms = useMutation({
    mutationFn: () =>
      api.generateTerms({
        video_subject: String(params.video_subject ?? ""),
        video_script: String(params.video_script ?? ""),
        amount: 5,
        match_materials_to_script: Boolean(params.match_materials_to_script),
      }),
    onSuccess: (data) => set("video_terms", data.video_terms.join(", ")),
  });

  const previewPrompt = useMutation({
    mutationFn: () =>
      api.previewPrompt({
        video_subject: String(params.video_subject ?? ""),
        video_language: language,
        paragraph_number: Number(params.paragraph_number ?? 1),
        video_script_prompt: String(params.video_script_prompt ?? ""),
        custom_system_prompt: String(params.custom_system_prompt ?? ""),
      }),
    onSuccess: (data) => setPromptPreview(data.prompt),
  });

  const createVideo = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { ...params, video_language: language };
      // Local mode sends the chosen filenames; the server resolves them inside
      // the materials directory.
      if (body.video_source === "local") {
        body.video_materials = (body.video_materials as string[] | undefined)?.map((url) => ({ url })) ?? [];
      } else {
        delete body.video_materials;
      }
      return api.createVideo(body);
    },
    onSuccess: ({ task_id }) => {
      setLogs([]);
      setActiveTask({ task_id, state: 4, progress: 0 });
      unsubscribeRef.current?.();
      unsubscribeRef.current = subscribeToTask(task_id, {
        onTask: setActiveTask,
        onLogs: (lines) => setLogs((current) => [...current, ...lines]),
        onDone: (task) => {
          setActiveTask(task);
          queryClient.invalidateQueries({ queryKey: ["tasks"] });
        },
      });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  const uploadMaterial = useMutation({
    mutationFn: (file: File) => api.uploadMaterial(file),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["materials"] }),
  });

  const uploadMusic = useMutation({
    mutationFn: (file: File) => api.uploadMusic(file),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["musics"] }),
  });

  const isGenerating = activeTask?.state === 4;
  const canGenerate =
    String(params.video_subject ?? "").trim().length > 0 || String(params.video_script ?? "").trim().length > 0;

  return (
    <>
      <PageHeader title={t("Mode Short Video")} description={t("Studio Description")} />

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ---------------------------------------------------------------- */}
        <Card title={t("Video Script Settings")}>
          <div className="space-y-3">
            <Field label={t("Video Subject")}>
              <TextInput
                value={String(params.video_subject ?? "")}
                placeholder={t("Video Subject Placeholder")}
                onChange={(event) => set("video_subject", event.target.value)}
              />
            </Field>

            <Accordion type="single" collapsible className="rounded-lg border bg-muted/40 px-3">
              <AccordionItem value="advanced" className="border-0">
                <AccordionTrigger className="py-3 text-xs text-muted-foreground hover:no-underline">
                  {t("Advanced Script Settings")}
                </AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-3">
                    <Field label={t("Script Paragraph Number")}>
                      <NumberInput
                        min={1}
                        max={10}
                        value={Number(params.paragraph_number ?? 1)}
                        onChange={(event) => set("paragraph_number", Number(event.target.value))}
                      />
                    </Field>
                    <Field label={t("Custom Script Requirements")}>
                      <TextArea
                        rows={3}
                        value={String(params.video_script_prompt ?? "")}
                        placeholder={t("Custom Script Requirements Placeholder")}
                        onChange={(event) => set("video_script_prompt", event.target.value)}
                      />
                    </Field>
                    <Field label={t("Custom System Prompt")}>
                      <TextArea
                        rows={4}
                        value={String(params.custom_system_prompt ?? "")}
                        onChange={(event) => set("custom_system_prompt", event.target.value)}
                      />
                    </Field>
                    <Button size="sm" disabled={previewPrompt.isPending} onClick={() => previewPrompt.mutate()}>
                      {t("Preview Final Prompt")}
                    </Button>
                    {promptPreview && (
                      <pre className="scroll-x max-h-52 overflow-auto rounded-lg border bg-card p-2 text-xs whitespace-pre-wrap">
                        {promptPreview}
                      </pre>
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            <Button
              className="w-full"
              disabled={generateScript.isPending || !String(params.video_subject ?? "").trim()}
              onClick={() => generateScript.mutate()}
            >
              {generateScript.isPending ? <Loader2 className="animate-spin" size={14} /> : <Wand2 size={14} />}
              {t("Generate Video Script and Keywords")}
            </Button>
            {generateScript.isError && <Alert tone="danger">{(generateScript.error as Error).message}</Alert>}

            <Field label={t("Video Script")} hint={t("Video Script Help")}>
              <TextArea
                rows={8}
                value={String(params.video_script ?? "")}
                onChange={(event) => set("video_script", event.target.value)}
              />
            </Field>

            <Button
              className="w-full"
              size="sm"
              disabled={generateTerms.isPending || !String(params.video_script ?? "").trim()}
              onClick={() => generateTerms.mutate()}
            >
              {generateTerms.isPending ? <Loader2 className="animate-spin" size={14} /> : <Sparkles size={14} />}
              {t("Generate Video Keywords")}
            </Button>

            <Field label={t("Video Keywords")}>
              <TextArea
                rows={2}
                value={String(params.video_terms ?? "")}
                onChange={(event) => set("video_terms", event.target.value)}
              />
            </Field>
          </div>
        </Card>

        {/* ---------------------------------------------------------------- */}
        <Card title={t("Video Settings")}>
          <div className="space-y-3">
            <Field label={t("Video Source")}>
              <Select
                value={String(params.video_source ?? "pexels")}
                onValueChange={(value) => set("video_source", value)}
                options={(metadata.data?.video_sources ?? ["pexels", "pixabay", "coverr", "local"]).map((source) => ({
                  value: source,
                  label: source,
                }))}
              />
            </Field>

            {params.video_source === "local" && (
              <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">{t("Local Materials")}</span>
                  <label className="cursor-pointer">
                    <input
                      type="file"
                      className="hidden"
                      accept=".mp4,.mov,.avi,.flv,.mkv,.jpg,.jpeg,.png"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) uploadMaterial.mutate(file);
                      }}
                    />
                    <span className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                      <Upload size={12} /> {t("Upload")}
                    </span>
                  </label>
                </div>
                <div className="max-h-40 space-y-1 overflow-auto">
                  {(materials.data?.files ?? []).map((file) => {
                    const selected = (params.video_materials as string[] | undefined) ?? [];
                    const isSelected = selected.includes(file.file);
                    return (
                      <label key={file.file} className="flex cursor-pointer items-center gap-2 text-xs">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() =>
                            set(
                              "video_materials",
                              isSelected ? selected.filter((name) => name !== file.file) : [...selected, file.file],
                            )
                          }
                        />
                        <span className="truncate">{file.name}</span>
                        <span className="ml-auto shrink-0 text-muted-foreground">
                          {(file.size / 1024 / 1024).toFixed(1)} MB
                        </span>
                      </label>
                    );
                  })}
                  {(materials.data?.files ?? []).length === 0 && (
                    <p className="text-xs text-muted-foreground">{t("No local materials uploaded yet")}</p>
                  )}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Field label={t("Video Ratio")}>
                <Select
                  value={String(params.video_aspect ?? "9:16")}
                  onValueChange={(value) => set("video_aspect", value)}
                  options={[
                    { value: "9:16", label: "9:16 (Portrait)" },
                    { value: "16:9", label: "16:9 (Landscape)" },
                    { value: "1:1", label: "1:1 (Square)" },
                  ]}
                />
              </Field>
              <Field label={t("Video Concat Mode")}>
                <Select
                  value={String(params.video_concat_mode ?? "random")}
                  onValueChange={(value) => set("video_concat_mode", value)}
                  options={[
                    { value: "random", label: t("Random") },
                    { value: "sequential", label: t("Sequential") },
                  ]}
                />
              </Field>
            </div>

            <Field label={t("Video Transition Mode")}>
              <Select
                value={String(params.video_transition_mode ?? "none")}
                onValueChange={(value) => set("video_transition_mode", value === "none" ? null : value)}
                options={[
                  { value: "none", label: t("None") },
                  { value: "Shuffle", label: "Shuffle" },
                  { value: "FadeIn", label: "FadeIn" },
                  { value: "FadeOut", label: "FadeOut" },
                  { value: "SlideIn", label: "SlideIn" },
                  { value: "SlideOut", label: "SlideOut" },
                  { value: "ZoomIn", label: "ZoomIn" },
                  { value: "ZoomOut", label: "ZoomOut" },
                ]}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label={t("Clip Duration")}>
                <NumberInput
                  min={1}
                  max={30}
                  value={Number(params.video_clip_duration ?? 5)}
                  onChange={(event) => set("video_clip_duration", Number(event.target.value))}
                />
              </Field>
              <Field label={t("Number of Videos Generated Simultaneously")}>
                <NumberInput
                  min={1}
                  max={5}
                  value={Number(params.video_count ?? 1)}
                  onChange={(event) => set("video_count", Number(event.target.value))}
                />
              </Field>
            </div>

            <Field label={t("Clip Speed")}>
              <Slider
                value={Number(params.video_clip_speed ?? 1)}
                min={0.5}
                max={2}
                step={0.05}
                onValueChange={(value) => set("video_clip_speed", value)}
                format={(value) => `${value.toFixed(2)}x`}
              />
            </Field>

            <Switch
              checked={Boolean(params.match_materials_to_script)}
              onCheckedChange={(value) => set("match_materials_to_script", value)}
              label={t("Match Materials to Script Order")}
            />

            <Field label={t("Threads")}>
              <NumberInput
                min={1}
                max={16}
                value={Number(params.n_threads ?? 2)}
                onChange={(event) => set("n_threads", Number(event.target.value))}
              />
            </Field>
          </div>
        </Card>

        {/* ---------------------------------------------------------------- */}
        <Card title={t("Audio Settings")}>
          <div className="space-y-3">
            <VoiceSelector
              ttsServer={ttsServer}
              voiceName={String(params.voice_name ?? "")}
              onTtsServerChange={setTtsServer}
              onVoiceNameChange={setVoiceName}
              onPreviewVoice={requestSample}
              includeNoVoice
            />

            <Field label={t("Speech Volume")}>
              <Slider
                value={Number(params.voice_volume ?? 1)}
                min={0}
                max={2}
                step={0.05}
                onValueChange={(value) => set("voice_volume", value)}
                format={(value) => value.toFixed(2)}
              />
            </Field>
            <Field label={t("Speech Rate")}>
              <Slider
                value={Number(params.voice_rate ?? 1)}
                min={0.5}
                max={2}
                step={0.05}
                onValueChange={(value) => set("voice_rate", value)}
                format={(value) => `${value.toFixed(2)}x`}
              />
            </Field>

            <VoicePreview
              voiceName={String(params.voice_name ?? "")}
              voiceRate={Number(params.voice_rate ?? 1)}
              voiceVolume={Number(params.voice_volume ?? 1)}
              script={String(params.video_script ?? "")}
              autoPlayKey={autoPlayKey}
            />

            <Field label={t("Background Music")}>
              <Select
                value={String(params.bgm_type ?? "random")}
                onValueChange={(value) => set("bgm_type", value)}
                options={[
                  { value: "", label: t("No Background Music") },
                  { value: "random", label: t("Random Background Music") },
                  { value: "custom", label: t("Custom Background Music") },
                  { value: "sonilo", label: "Sonilo (AI)" },
                  { value: "elevenlabs", label: "ElevenLabs (AI)" },
                ]}
              />
            </Field>

            {params.bgm_type === "custom" && (
              <div className="space-y-2">
                <Select
                  value={String(params.bgm_file ?? "")}
                  onValueChange={(value) => set("bgm_file", value)}
                  options={(musics.data?.files ?? []).map((file) => ({ value: file.file, label: file.name }))}
                  placeholder={t("Select Background Music")}
                />
                <label className="cursor-pointer">
                  <input
                    type="file"
                    className="hidden"
                    accept=".mp3,.m4a,.aac,.wav,.flac,.ogg,.opus,.wma"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) uploadMusic.mutate(file);
                    }}
                  />
                  <span className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                    <Upload size={12} /> {t("Upload")}
                  </span>
                </label>
                {uploadMusic.isError && <Alert tone="danger">{(uploadMusic.error as Error).message}</Alert>}
              </div>
            )}

            {(params.bgm_type === "sonilo" || params.bgm_type === "elevenlabs") && (
              <Field label={t("Music Prompt")}>
                <TextArea
                  rows={2}
                  value={String(params.video_music_prompt ?? "")}
                  onChange={(event) => set("video_music_prompt", event.target.value)}
                />
              </Field>
            )}

            <Field label={t("Background Music Volume")}>
              <Slider
                value={Number(params.bgm_volume ?? 0.2)}
                min={0}
                max={1}
                step={0.05}
                onValueChange={(value) => set("bgm_volume", value)}
                format={(value) => value.toFixed(2)}
              />
            </Field>

            <BgmPreview
              bgmType={String(params.bgm_type ?? "")}
              bgmFile={String(params.bgm_file ?? "")}
              bgmVolume={Number(params.bgm_volume ?? 0.2)}
              files={musics.data?.files ?? []}
            />

            <Separator />

            <Switch
              checked={Boolean(params.subtitle_enabled)}
              onCheckedChange={(value) => set("subtitle_enabled", value)}
              label={t("Enable Subtitles")}
            />

            {Boolean(params.subtitle_enabled) && (
              <>
                <Field label={t("Font")}>
                  <Select
                    value={String(params.font_name ?? "")}
                    onValueChange={(value) => set("font_name", value)}
                    options={(metadata.data?.fonts ?? []).map((font) => ({ value: font, label: font }))}
                  />
                </Field>

                <div className="grid grid-cols-2 gap-3">
                  <Field label={t("Font Size")}>
                    <NumberInput
                      min={20}
                      max={120}
                      value={Number(params.font_size ?? 60)}
                      onChange={(event) => set("font_size", Number(event.target.value))}
                    />
                  </Field>
                  <Field label={t("Position")}>
                    <Select
                      value={String(params.subtitle_position ?? "bottom")}
                      onValueChange={(value) => set("subtitle_position", value)}
                      options={[
                        { value: "top", label: t("Top") },
                        { value: "center", label: t("Center") },
                        { value: "bottom", label: t("Bottom") },
                        { value: "custom", label: t("Custom") },
                      ]}
                    />
                  </Field>
                </div>

                {params.subtitle_position === "custom" && (
                  <Field label={t("Custom Position")}>
                    <Slider
                      value={Number(params.custom_position ?? 70)}
                      min={0}
                      max={100}
                      step={1}
                      onValueChange={(value) => set("custom_position", value)}
                      format={(value) => `${value.toFixed(0)}%`}
                    />
                  </Field>
                )}

                <Field label={t("Font Color")}>
                  <ColorInput
                    value={String(params.text_fore_color ?? "#FFFFFF")}
                    onChange={(value) => set("text_fore_color", value)}
                  />
                </Field>

                <Switch
                  checked={params.text_background_color !== false}
                  onCheckedChange={(value) => set("text_background_color", value ? "#000000" : false)}
                  label={t("Subtitle Background")}
                />

                {params.text_background_color !== false && (
                  <>
                    <ColorInput
                      value={String(params.text_background_color || "#000000")}
                      onChange={(value) => set("text_background_color", value)}
                    />
                    <Switch
                      checked={Boolean(params.rounded_subtitle_background)}
                      onCheckedChange={(value) => set("rounded_subtitle_background", value)}
                      label={t("Rounded Subtitle Background")}
                    />
                  </>
                )}

                <Field label={t("Stroke Width")}>
                  <Slider
                    value={Number(params.stroke_width ?? 1.5)}
                    min={0}
                    max={6}
                    step={0.5}
                    onValueChange={(value) => set("stroke_width", value)}
                  />
                </Field>
                <Field label={t("Stroke Color")}>
                  <ColorInput
                    value={String(params.stroke_color ?? "#000000")}
                    onChange={(value) => set("stroke_color", value)}
                  />
                </Field>
              </>
            )}
          </div>
        </Card>
      </div>

      {/* ------------------------------------------------------------------ */}
      <div className="mt-5 space-y-4">
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          disabled={!canGenerate || createVideo.isPending || isGenerating}
          onClick={() => createVideo.mutate()}
        >
          {createVideo.isPending || isGenerating ? (
            <Loader2 className="animate-spin" size={18} />
          ) : (
            <Sparkles size={18} />
          )}
          {t("Generate Video")}
        </Button>

        {createVideo.isError && <Alert tone="danger">{(createVideo.error as Error).message}</Alert>}

        {activeTask && (
          <Card
            title={
              <span className="inline-flex items-center gap-2">
                {t("Generation Progress")}
                <Badge tone={activeTask.state === 1 ? "success" : activeTask.state === -1 ? "danger" : "accent"}>
                  {activeTask.state === 1
                    ? t("Task Status Complete")
                    : activeTask.state === -1
                      ? t("Task Status Failed")
                      : t("Task Status Processing")}
                </Badge>
              </span>
            }
          >
            <div className="space-y-3">
              <Progress value={activeTask.progress} />

              {activeTask.error && (
                <Alert tone="danger">
                  [{activeTask.failed_stage}] {activeTask.error}
                </Alert>
              )}

              {(activeTask.warnings ?? []).map((warning) => (
                <Alert key={`${warning.code}-${warning.video_index}`} tone="warning">
                  {t(warning.code)} (video {warning.video_index})
                </Alert>
              ))}

              {activeTask.videos?.map((video) => (
                <div key={video} className="space-y-2">
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <video src={video} controls className="max-h-[70vh] w-full rounded-lg bg-black" />
                  <a href={video} download className="inline-block text-xs text-primary hover:underline">
                    {t("Download")}
                  </a>
                </div>
              ))}

              {logs.length > 0 && (
                <details open={activeTask.state === 4}>
                  <summary className="cursor-pointer text-xs text-muted">{t("Log")}</summary>
                  <pre className="scroll-x mt-2 max-h-56 overflow-auto rounded-lg border border-border bg-surface-2 p-2 text-xs">
                    {logs.join("\n")}
                  </pre>
                </details>
              )}
            </div>
          </Card>
        )}

        <TaskManager
          onRestoreParams={(restored) => {
            setParams({ ...DEFAULT_PARAMS, ...restored });
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        />
      </div>
    </>
  );
}
