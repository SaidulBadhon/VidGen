/**
 * TTS server dropdown and a searchable grid of voices.
 *
 * Settings, short video, and book render all share this so a saved voice is
 * picked with the same catalogue the generation forms send. Preview, rate and
 * volume stay with the caller — those differ per screen.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Search } from "lucide-react";
import { api } from "@/api/client.ts";
import { Field, Select, TextInput, cn } from "@/components/ui.tsx";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/i18n/index.tsx";
import { TTS_SERVERS, displayVoice, isNoVoice } from "@/lib/voices.ts";

export function VoiceSelector({
  ttsServer,
  voiceName,
  onTtsServerChange,
  onVoiceNameChange,
  onPreviewVoice,
  includeNoVoice = false,
  keepUnknownVoice = true,
  fill = false,
}: {
  ttsServer: string;
  voiceName: string;
  onTtsServerChange: (server: string) => void;
  onVoiceNameChange: (voice: string) => void;
  /** Fired on a user click so the caller can start a sample. Not used for auto-select. */
  onPreviewVoice?: (voice: string) => void;
  includeNoVoice?: boolean;
  /** Keep a stored voice listed even when it belongs to a different server. */
  keepUnknownVoice?: boolean;
  /** Grow the voice grid to fill leftover viewport height. */
  fill?: boolean;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const voices = useQuery({ queryKey: ["voices", ttsServer], queryFn: () => api.listVoices(ttsServer) });
  const catalogue = voices.data?.voices;

  const options = useMemo(() => {
    const list = [
      ...(includeNoVoice ? [{ value: "no-voice", label: t("No Voice") }] : []),
      ...(catalogue ?? []).map((voice) => ({ value: voice, label: voice })),
    ];
    if (voiceName && keepUnknownVoice && !list.some((option) => option.value === voiceName)) {
      list.unshift({ value: voiceName, label: voiceName });
    }
    return list;
  }, [catalogue, includeNoVoice, keepUnknownVoice, t, voiceName]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => {
      const display = displayVoice(option.value);
      return [option.value, option.label, display.title, display.locale, display.gender]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [options, query]);

  useEffect(() => {
    setQuery("");
  }, [ttsServer]);

  useEffect(() => {
    if (!voices.isSuccess || !catalogue) return;
    if (includeNoVoice && isNoVoice(voiceName)) return;
    if (voiceName && catalogue.includes(voiceName)) return;
    if (keepUnknownVoice && voiceName) return;
    const next = catalogue[0] ?? (includeNoVoice ? "no-voice" : "");
    if (next && next !== voiceName) onVoiceNameChange(next);
  }, [voices.isSuccess, catalogue, voiceName, includeNoVoice, keepUnknownVoice, onVoiceNameChange]);

  const gridClass = "grid w-full grid-cols-3 gap-2";

  return (
    <div className={cn("flex flex-col gap-4", fill && "min-h-0 flex-1")}>
      <Field label={t("TTS Server")} className="max-w-sm shrink-0">
        <Select
          value={ttsServer}
          onValueChange={onTtsServerChange}
          options={TTS_SERVERS.map((server) => ({ value: server, label: server }))}
        />
      </Field>
      <Field label={t("Speech Synthesis")} className={cn(fill && "flex min-h-0 flex-1 flex-col")}>
        {options.length > 8 && (
          <div className="relative max-w-sm shrink-0">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <TextInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("Search Voices")}
              className="pl-8"
            />
          </div>
        )}
        {voices.isLoading ? (
          <div className={gridClass}>
            {Array.from({ length: 12 }, (_, index) => (
              <Skeleton key={index} className="h-14 rounded-lg" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
            {t("No Voices Found")}
          </p>
        ) : (
          <div className={cn(fill && "min-h-0 flex-1 overflow-hidden")}>
            <ScrollArea className={cn("w-full rounded-lg border", fill ? "h-full" : "h-72")}>
              <div role="listbox" aria-label={t("Speech Synthesis")} className={cn(gridClass, "p-2")}>
                {filtered.map((option) => {
                  const selected = option.value === voiceName;
                  const silent = isNoVoice(option.value);
                  const display = silent
                    ? { title: option.label, locale: "", gender: "" }
                    : displayVoice(option.value);
                  const meta = [display.locale, display.gender ? t(display.gender) : ""]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      title={option.value}
                      onClick={() => {
                        onVoiceNameChange(option.value);
                        if (!silent) onPreviewVoice?.(option.value);
                      }}
                      className={cn(
                        "flex min-w-0 flex-col items-start gap-0.5 rounded-md border px-2.5 py-2 text-left transition-colors",
                        "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                        selected
                          ? "border-primary bg-primary/10 ring-1 ring-primary"
                          : "border-border bg-background hover:bg-accent",
                      )}
                    >
                      <span className="flex w-full items-center gap-1">
                        <span className="truncate text-sm font-medium">{display.title}</span>
                        {selected && <Check className="ml-auto size-3.5 shrink-0 text-primary" />}
                      </span>
                      {meta ? (
                        <span className="truncate text-[11px] text-muted-foreground">{meta}</span>
                      ) : silent ? (
                        <span className="truncate text-[11px] text-muted-foreground">{t("No Voiceover")}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          </div>
        )}
      </Field>
    </div>
  );
}
