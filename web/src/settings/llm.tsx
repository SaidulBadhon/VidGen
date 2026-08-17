import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ExternalLink, Loader2 } from "lucide-react";
import { api, SECRET_PLACEHOLDER, type ConnectionTestResult } from "@/api/client.ts";
import { Alert, Button, Card, Field, Select, TextInput } from "@/components/ui.tsx";
import { useI18n } from "@/i18n/index.tsx";
import { useSettingsDraft } from "./context.tsx";

export function LlmSettingsPage() {
  const { t } = useI18n();
  const { draft, metadata, fromEnv, setApp, setSection } = useSettingsDraft();
  const [testResult, setTestResult] = useState<(ConnectionTestResult & { provider?: string }) | null>(null);

  const testLlm = useMutation({
    mutationFn: api.testLlm,
    onSuccess: (result) => setTestResult(result),
    onError: (error: Error) => setTestResult({ success: false, message: error.message }),
  });

  const provider = String(draft?.app.llm_provider ?? "gemini");
  const providerSpec = useMemo(
    () => metadata?.llm_providers.find((entry) => entry.provider_id === provider),
    [metadata, provider],
  );

  if (!draft) return null;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title={t("LLM Provider")}>
        <div className="space-y-4">
          <Field label={t("LLM Provider")}>
            <Select
              value={provider}
              onValueChange={(value) => setApp("llm_provider", value)}
              options={(metadata?.llm_providers ?? []).map((entry) => ({
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
                placeholder={draft.app[`${provider}_api_key`] === SECRET_PLACEHOLDER ? t("Saved") : "sk-..."}
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
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
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
      </Card>

      <Card title={t("Subtitle Provider")}>
        <div className="space-y-4">
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
              options={(metadata?.video_codecs ?? []).map((codec) => ({
                value: codec,
                label: codec || t("Default"),
              }))}
            />
          </Field>
        </div>
      </Card>
    </div>
  );
}
