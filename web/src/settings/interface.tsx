import { Card, Field, NumberInput, Switch, TextInput } from "@/components/ui.tsx";
import { ThemeToggle } from "@/components/theme-toggle.tsx";
import { useI18n } from "@/i18n/index.tsx";
import { useSettingsDraft } from "./context.tsx";

export function InterfaceSettingsPage() {
  const { t } = useI18n();
  const { draft, fromEnv, setApp, setSection } = useSettingsDraft();

  if (!draft) return null;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title={t("Appearance")}>
        <div className="space-y-4">
          <Field label={t("Appearance")}>
            <ThemeToggle compact={false} />
          </Field>
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
      </Card>

      <Card title={t("Public Endpoint")}>
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
      </Card>
    </div>
  );
}
