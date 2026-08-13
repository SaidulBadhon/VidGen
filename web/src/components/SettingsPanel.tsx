/**
 * Basic configuration, mirroring the four Streamlit settings tabs:
 * LLM, material APIs, cache management and interface preferences.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2 } from "lucide-react";
import { api, SECRET_PLACEHOLDER, type ConnectionTestResult, type Settings } from "../api/client.ts";
import { useI18n } from "../i18n/index.tsx";
import { Alert, Button, Card, Field, NumberInput, Select, Switch, TabContent, TabTrigger, Tabs, TabsList, TextInput } from "./ui.tsx";

/** Comma-separated text <-> key list, matching how the docs describe it. */
function keysToText(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  return String(value ?? "");
}

function textToKeys(value: string): string[] {
  return value
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
}

export function SettingsPanel() {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
  const metadataQuery = useQuery({ queryKey: ["settings-metadata"], queryFn: api.getSettingsMetadata });

  const [draft, setDraft] = useState<Settings | null>(null);
  const [testResult, setTestResult] = useState<(ConnectionTestResult & { provider?: string }) | null>(null);

  useEffect(() => {
    if (settingsQuery.data) setDraft(structuredClone(settingsQuery.data));
  }, [settingsQuery.data]);

  const save = useMutation({
    mutationFn: (patch: Partial<Settings>) => api.saveSettings(patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(["settings"], updated);
      setDraft(structuredClone(updated));
    },
  });

  const testLlm = useMutation({
    mutationFn: api.testLlm,
    onSuccess: (result) => setTestResult(result),
    onError: (error: Error) => setTestResult({ success: false, message: error.message }),
  });

  const provider = String(draft?.app.llm_provider ?? "gemini");
  const providerSpec = useMemo(
    () => metadataQuery.data?.llm_providers.find((entry) => entry.provider_id === provider),
    [metadataQuery.data, provider],
  );

  /**
   * Fields the server reads from `.env`. Editing one here would be discarded on
   * the next read, so the input is shown read-only rather than silently ignored.
   */
  const envManaged = useMemo(
    () => new Set(metadataQuery.data?.env_managed_fields ?? []),
    [metadataQuery.data],
  );
  const fromEnv = (key: string, section: keyof Settings = "app") => envManaged.has(`${section}.${key}`);

  if (!draft) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="animate-spin" size={16} /> {t("Loading")}
        </div>
      </Card>
    );
  }

  const setApp = (key: string, value: unknown) =>
    setDraft((current) => (current ? { ...current, app: { ...current.app, [key]: value } } : current));
  const setSection = (section: keyof Settings, key: string, value: unknown) =>
    setDraft((current) =>
      current ? { ...current, [section]: { ...(current[section] as object), [key]: value } } : current,
    );

  return (
    <Card
      title={t("Basic Settings")}
      action={
        <div className="flex items-center gap-2">
          {save.isSuccess && <span className="text-xs text-success">{t("Save Successful")}</span>}
          {save.isError && <span className="text-xs text-danger">{(save.error as Error).message}</span>}
          <Button variant="primary" size="sm" disabled={save.isPending} onClick={() => save.mutate(draft)}>
            {save.isPending && <Loader2 className="animate-spin" size={14} />}
            {t("Save")}
          </Button>
        </div>
      }
    >
      <Tabs defaultValue="llm">
        <TabsList>
          <TabTrigger value="llm">{t("LLM Settings Tab")}</TabTrigger>
          <TabTrigger value="material">{t("Material API Tab")}</TabTrigger>
          <TabTrigger value="cache">{t("Cache Management Tab")}</TabTrigger>
          <TabTrigger value="interface">{t("Interface Settings Tab")}</TabTrigger>
        </TabsList>

        {/* ---------------------------------------------------------------- */}
        <TabContent value="llm" className="grid gap-4 md:grid-cols-2">
          <div className="space-y-4">
            <Field label={t("LLM Provider")}>
              <Select
                value={provider}
                onValueChange={(value) => setApp("llm_provider", value)}
                options={(metadataQuery.data?.llm_providers ?? []).map((entry) => ({
                  value: entry.provider_id,
                  label: entry.label,
                }))}
              />
            </Field>

            {providerSpec?.show_api_key && (
              <Field
                label={`${providerSpec.label} API Key`}
                hint={fromEnv(`${provider}_api_key`) ? t("Set in .env") : undefined}
              >
                <TextInput
                  type="password"
                  disabled={fromEnv(`${provider}_api_key`)}
                  value={String(draft.app[`${provider}_api_key`] ?? "")}
                  placeholder={
                    draft.app[`${provider}_api_key`] === SECRET_PLACEHOLDER ? t("Saved") : "sk-..."
                  }
                  onChange={(event) => setApp(`${provider}_api_key`, event.target.value)}
                />
              </Field>
            )}

            {providerSpec?.show_base_url && (
              <Field label="Base URL" hint={providerSpec.default_base_url || t("Auto Detect")}>
                <TextInput
                  value={String(draft.app[`${provider}_base_url`] ?? "")}
                  placeholder={providerSpec.default_base_url || "http://localhost:11434/v1"}
                  onChange={(event) => setApp(`${provider}_base_url`, event.target.value)}
                />
              </Field>
            )}

            <Field label={t("Model Name")} hint={providerSpec?.default_model}>
              <TextInput
                value={String(draft.app[`${provider}_model_name`] ?? "")}
                placeholder={providerSpec?.default_model}
                onChange={(event) => setApp(`${provider}_model_name`, event.target.value)}
              />
            </Field>

            <div className="flex items-center gap-2">
              <Button size="sm" disabled={testLlm.isPending} onClick={() => testLlm.mutate()}>
                {testLlm.isPending && <Loader2 className="animate-spin" size={14} />}
                {t("Test Connection")}
              </Button>
              {providerSpec?.api_key_url && (
                <a
                  href={providerSpec.api_key_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                >
                  {t("Get API Key")} <ExternalLink size={12} />
                </a>
              )}
            </div>

            {testResult && (
              <Alert tone={testResult.success ? "success" : "danger"}>
                {testResult.success
                  ? `${t("Connection Successful")} — ${testResult.model ?? ""} (${(testResult.elapsedSeconds ?? 0).toFixed(1)}s)`
                  : testResult.message}
              </Alert>
            )}
          </div>

          <div className="space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{t("Subtitle Provider")}</h3>
            <Field label={t("Subtitle Provider")}>
              <Select
                value={String(draft.app.subtitle_provider ?? "edge")}
                onValueChange={(value) => setApp("subtitle_provider", value)}
                options={[
                  { value: "edge", label: "Edge (TTS timings)" },
                  { value: "whisper", label: "Whisper (transcribe)" },
                  { value: "", label: t("Disabled") },
                ]}
              />
            </Field>

            {draft.app.subtitle_provider === "whisper" && (
              <>
                <Field label={t("Transcription Backend")}>
                  <Select
                    value={String(draft.whisper.provider ?? "whisper-cpp")}
                    onValueChange={(value) => setSection("whisper", "provider", value)}
                    options={[
                      { value: "whisper-cpp", label: "whisper.cpp (local)" },
                      { value: "openai-api", label: "OpenAI-compatible endpoint" },
                    ]}
                  />
                </Field>
                <Field label={t("Whisper Model")}>
                  <Select
                    value={String(draft.whisper.model_size ?? "large-v3")}
                    onValueChange={(value) => setSection("whisper", "model_size", value)}
                    options={["tiny", "base", "small", "medium", "large-v3"].map((size) => ({
                      value: size,
                      label: size,
                    }))}
                  />
                </Field>
                {draft.whisper.provider === "openai-api" && (
                  <>
                    <Field label="Base URL">
                      <TextInput
                        value={String(draft.whisper.api_base_url ?? "")}
                        onChange={(event) => setSection("whisper", "api_base_url", event.target.value)}
                      />
                    </Field>
                    <Field label="API Key">
                      <TextInput
                        type="password"
                        value={String(draft.whisper.api_key ?? "")}
                        onChange={(event) => setSection("whisper", "api_key", event.target.value)}
                      />
                    </Field>
                  </>
                )}
              </>
            )}

            <Field label={t("Video Codec")}>
              <Select
                value={String(draft.app.video_codec ?? "")}
                onValueChange={(value) => setApp("video_codec", value)}
                options={(metadataQuery.data?.video_codecs ?? []).map((codec) => ({
                  value: codec,
                  label: codec || t("Default"),
                }))}
              />
            </Field>
          </div>
        </TabContent>

        {/* ---------------------------------------------------------------- */}
        <TabContent value="material" className="grid gap-4 md:grid-cols-2">
          <div className="space-y-4">
            {(
              [
                ["pexels_api_keys", "Pexels", "https://www.pexels.com/api/"],
                ["pixabay_api_keys", "Pixabay", "https://pixabay.com/api/docs/"],
                ["coverr_api_keys", "Coverr", "https://coverr.co/developers"],
              ] as const
            ).map(([key, label, url]) => (
              <Field
                key={key}
                label={
                  <span className="inline-flex items-center gap-2">
                    {label} API Keys
                    <a href={url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                      <ExternalLink size={11} />
                    </a>
                  </span>
                }
                hint={fromEnv(key) ? t("Set in .env") : t("Separate multiple keys with commas")}
              >
                <TextInput
                  disabled={fromEnv(key)}
                  value={keysToText(draft.app[key])}
                  onChange={(event) => setApp(key, textToKeys(event.target.value))}
                />
              </Field>
            ))}
          </div>

          <div className="space-y-4">
            <Field
              label="TwelveLabs API Keys"
              hint={fromEnv("twelvelabs_api_keys") ? t("Set in .env") : t("Optional semantic reranking")}
            >
              <TextInput
                disabled={fromEnv("twelvelabs_api_keys")}
                value={keysToText(draft.app.twelvelabs_api_keys)}
                onChange={(event) => setApp("twelvelabs_api_keys", textToKeys(event.target.value))}
              />
            </Field>
            <Switch
              checked={Boolean(draft.app.twelvelabs_rerank_terms)}
              onCheckedChange={(value) => setApp("twelvelabs_rerank_terms", value)}
              label={t("Rerank Search Terms")}
            />

            <Field label="Sonilo API Key" hint="https://platform.sonilo.com/dashboard">
              <TextInput
                type="password"
                value={String(draft.app.sonilo_api_key ?? "")}
                onChange={(event) => setApp("sonilo_api_key", event.target.value)}
              />
            </Field>
            <Field label="ElevenLabs API Key" hint={t("Used for both TTS and Video-to-Music")}>
              <TextInput
                type="password"
                value={String(draft.elevenlabs.api_key ?? "")}
                onChange={(event) => setSection("elevenlabs", "api_key", event.target.value)}
              />
            </Field>

            <h3 className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted">
              {t("Cross-platform Publishing")}
            </h3>
            <Switch
              checked={Boolean(draft.app.upload_post_enabled)}
              onCheckedChange={(value) => setApp("upload_post_enabled", value)}
              label={t("Enable Upload-Post")}
            />
            {Boolean(draft.app.upload_post_enabled) && (
              <>
                <Field label="Upload-Post API Key">
                  <TextInput
                    type="password"
                    value={String(draft.app.upload_post_api_key ?? "")}
                    onChange={(event) => setApp("upload_post_api_key", event.target.value)}
                  />
                </Field>
                <Field label={t("Username")}>
                  <TextInput
                    value={String(draft.app.upload_post_username ?? "")}
                    onChange={(event) => setApp("upload_post_username", event.target.value)}
                  />
                </Field>
                <Switch
                  checked={Boolean(draft.app.upload_post_auto_upload)}
                  onCheckedChange={(value) => setApp("upload_post_auto_upload", value)}
                  label={t("Auto Publish After Generation")}
                />
              </>
            )}
          </div>
        </TabContent>

        {/* ---------------------------------------------------------------- */}
        <TabContent value="cache">
          <CacheManagement />
        </TabContent>

        {/* ---------------------------------------------------------------- */}
        <TabContent value="interface" className="grid gap-4 md:grid-cols-2">
          <div className="space-y-4">
            <Switch
              checked={Boolean(draft.ui.hide_log)}
              onCheckedChange={(value) => setSection("ui", "hide_log", value)}
              label={t("Hide Log")}
            />
            <Field label={t("Max Concurrent Tasks")}>
              <NumberInput
                min={1}
                value={Number(draft.app.max_concurrent_tasks ?? 5)}
                onChange={(event) => setApp("max_concurrent_tasks", Number(event.target.value))}
              />
            </Field>
            <Field label={t("Max Queued Tasks")}>
              <NumberInput
                min={1}
                value={Number(draft.app.max_queued_tasks ?? 100)}
                onChange={(event) => setApp("max_queued_tasks", Number(event.target.value))}
              />
            </Field>
          </div>
          <div className="space-y-4">
            <Field
              label={t("Public Endpoint")}
              hint={fromEnv("endpoint") ? t("Set in .env") : t("Used to build download links")}
            >
              <TextInput
                disabled={fromEnv("endpoint")}
                value={String(draft.app.endpoint ?? "")}
                placeholder="https://videos.example.com"
                onChange={(event) => setApp("endpoint", event.target.value)}
              />
            </Field>
            <Field label={t("Material Directory")} hint='"" | "task" | /absolute/path'>
              <TextInput
                value={String(draft.app.material_directory ?? "")}
                onChange={(event) => setApp("material_directory", event.target.value)}
              />
            </Field>
            <Switch
              checked={Boolean(draft.app.tls_verify ?? true)}
              onCheckedChange={(value) => setApp("tls_verify", value)}
              label={t("Verify TLS Certificates")}
            />
          </div>
        </TabContent>
      </Tabs>
    </Card>
  );
}

function CacheManagement() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const stats = useQuery({ queryKey: ["cache-stats"], queryFn: api.cacheStats });

  const clear = useMutation({
    mutationFn: (scope: "all" | "videos" | "search") => api.clearCache(scope),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cache-stats"] }),
  });

  const megabytes = ((stats.data?.videos.bytes ?? 0) / 1024 / 1024).toFixed(1);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-surface-2 p-3">
          <div className="text-xs text-muted">{t("Cached Videos")}</div>
          <div className="mt-1 text-lg font-semibold tabular-nums">
            {stats.data?.videos.files ?? 0} <span className="text-sm font-normal text-muted">({megabytes} MB)</span>
          </div>
        </div>
        <div className="rounded-lg border border-border bg-surface-2 p-3">
          <div className="text-xs text-muted">{t("Cached Searches")}</div>
          <div className="mt-1 text-lg font-semibold tabular-nums">
            {stats.data?.search.entries ?? 0}{" "}
            <span className="text-sm font-normal text-muted">({stats.data?.search.assets ?? 0} assets)</span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={clear.isPending} onClick={() => clear.mutate("videos")}>
          {t("Clear Video Cache")}
        </Button>
        <Button size="sm" disabled={clear.isPending} onClick={() => clear.mutate("search")}>
          {t("Clear Search Cache")}
        </Button>
        <Button size="sm" variant="danger" disabled={clear.isPending} onClick={() => clear.mutate("all")}>
          {t("Clear All")}
        </Button>
      </div>

      {clear.isSuccess && (
        <Alert tone="success">
          {t("Removed")}: {clear.data.removed_files} files, {clear.data.removed_searches} searches
        </Alert>
      )}
    </div>
  );
}
