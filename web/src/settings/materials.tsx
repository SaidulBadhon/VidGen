import { ExternalLink } from "lucide-react";
import { Card, Field, Switch, TextInput } from "@/components/ui.tsx";
import { useI18n } from "@/i18n/index.tsx";
import { keysToText, textToKeys, useSettingsDraft } from "./context.tsx";

export function MaterialsSettingsPage() {
  const { t } = useI18n();
  const { draft, fromEnv, setApp, setSection } = useSettingsDraft();

  if (!draft) return null;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
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
                  <a href={url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
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
      </Card>

      <Card title={t("Cross-platform Publishing")}>
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
      </Card>
    </div>
  );
}
