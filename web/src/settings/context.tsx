/**
 * Shared settings draft so switching LLM / APIs / cache / interface
 * does not discard unsaved edits.
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type Settings, type SettingsMetadata } from "@/api/client.ts";
import { useI18n } from "@/i18n/index.tsx";

interface SettingsDraftValue {
  draft: Settings | null;
  metadata: SettingsMetadata | undefined;
  fromEnv: (key: string, section?: keyof Settings) => boolean;
  setApp: (key: string, value: unknown) => void;
  setSection: (section: keyof Settings, key: string, value: unknown) => void;
  save: () => void;
  saving: boolean;
}

const SettingsDraftContext = createContext<SettingsDraftValue | null>(null);

export function SettingsDraftProvider({ children }: { children: ReactNode }) {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
  const metadataQuery = useQuery({ queryKey: ["settings-metadata"], queryFn: api.getSettingsMetadata });
  const [draft, setDraft] = useState<Settings | null>(null);

  useEffect(() => {
    if (settingsQuery.data) setDraft(structuredClone(settingsQuery.data));
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (patch: Partial<Settings>) => api.saveSettings(patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(["settings"], updated);
      setDraft(structuredClone(updated));
      toast.success(t("Save Successful"));
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const envManaged = useMemo(
    () => new Set(metadataQuery.data?.env_managed_fields ?? []),
    [metadataQuery.data],
  );

  const value = useMemo<SettingsDraftValue>(
    () => ({
      draft,
      metadata: metadataQuery.data,
      fromEnv: (key, section = "app") => envManaged.has(`${section}.${key}`),
      setApp: (key, next) =>
        setDraft((current) => (current ? { ...current, app: { ...current.app, [key]: next } } : current)),
      setSection: (section, key, next) =>
        setDraft((current) =>
          current ? { ...current, [section]: { ...(current[section] as object), [key]: next } } : current,
        ),
      save: () => {
        if (!draft) return;
        saveMutation.mutate({ ...draft, ui: { ...draft.ui, language } });
      },
      saving: saveMutation.isPending,
    }),
    [draft, envManaged, language, metadataQuery.data, saveMutation],
  );

  return <SettingsDraftContext.Provider value={value}>{children}</SettingsDraftContext.Provider>;
}

export function useSettingsDraft(): SettingsDraftValue {
  const context = useContext(SettingsDraftContext);
  if (!context) throw new Error("useSettingsDraft must be used inside SettingsDraftProvider");
  return context;
}

export function keysToText(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  return String(value ?? "");
}

export function textToKeys(value: string): string[] {
  return value
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
}
