/**
 * Step 3: how the kept text is cut into videos.
 *
 * The plan is derived, never edited by hand: changing an option re-plans the
 * whole book server-side, which is also why the form refuses a combination the
 * server would reject rather than round-tripping a 400.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, FileAudio, Film, Loader2, RotateCcw, Save, Sparkles } from "lucide-react";
import { useI18n } from "../i18n/index.tsx";
import { Alert, Badge, Button, Card, Field, NumberInput, Select, buttonClass } from "../components/ui.tsx";
import {
  MAX_SEGMENT_SECONDS,
  MAX_WORDS_PER_MINUTE,
  MIN_SEGMENT_SECONDS,
  MIN_WORDS_PER_MINUTE,
  bookApi,
  errorText,
  formatDuration,
  isRenderConflict,
  segmentDownloadName,
  taskDownloadUrl,
  SEGMENT_MODES,
  type BookDetail,
  type BookSegmentState,
  type SegmentMode,
  type SegmentOptions,
} from "./api.ts";

function stateTone(state: BookSegmentState): "muted" | "success" | "warning" | "danger" | "accent" {
  if (state === "complete") return "success";
  if (state === "failed") return "danger";
  if (state === "rendering" || state === "queued") return "accent";
  return "muted";
}

/** Mirrors bookSegmentOptionsSchema so an invalid plan is never submitted. */
function validate(options: SegmentOptions): string | null {
  const { target_duration_seconds: target, max_duration_seconds: max, words_per_minute: wpm } = options;
  for (const value of [target, max, wpm]) {
    if (!Number.isFinite(value)) return "invalid";
  }
  if (target < MIN_SEGMENT_SECONDS || max < MIN_SEGMENT_SECONDS) return "min";
  if (target > MAX_SEGMENT_SECONDS || max > MAX_SEGMENT_SECONDS) return "max";
  if (max < target) return "order";
  if (wpm < MIN_WORDS_PER_MINUTE || wpm > MAX_WORDS_PER_MINUTE) return "wpm";
  return null;
}

export function SegmentsPanel({
  bookId,
  detail,
  liveStates,
  renderingActive,
  onRenderStarted,
}: {
  bookId: string;
  detail?: BookDetail;
  liveStates: Record<number, BookSegmentState> | null;
  renderingActive: boolean;
  onRenderStarted: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [options, setOptions] = useState<SegmentOptions | null>(null);
  const syncedRef = useRef("");

  const serverOptions = detail?.book.segment_options;
  const serverKey = serverOptions ? JSON.stringify(serverOptions) : "";

  // Re-seeded only when the stored plan actually changes, so a background
  // refetch cannot wipe half-typed numbers out from under the reviewer.
  useEffect(() => {
    if (!serverOptions) return;
    const key = `${bookId}:${serverKey}`;
    if (syncedRef.current === key) return;
    syncedRef.current = key;
    setOptions({ ...serverOptions });
  }, [bookId, serverKey, serverOptions]);

  const apply = useMutation({
    mutationFn: (next: SegmentOptions) => bookApi.setSegmentOptions(bookId, next),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["book", bookId] }),
  });

  const retry = useMutation({
    mutationFn: (index: number) => bookApi.renderSegment(bookId, index),
    onSuccess: () => {
      // A retry is a render too, so the progress stream has to be reopened.
      onRenderStarted();
      queryClient.invalidateQueries({ queryKey: ["book", bookId] });
    },
  });

  const segments = detail?.segments ?? [];
  const totalDuration = segments.reduce((sum, segment) => sum + (segment.estimated_duration || 0), 0);
  const problem = options ? validate(options) : "invalid";
  const dirty = Boolean(options) && JSON.stringify(options) !== serverKey;
  const canRetry = Boolean(detail?.book.render_params);

  const set = <K extends keyof SegmentOptions>(key: K, value: SegmentOptions[K]) => {
    setOptions((current) => (current ? { ...current, [key]: value } : current));
  };

  return (
    <div className="space-y-4">
      <Card title={t("Book Segment Plan")}>
        {options ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t("Book Segment Mode")} hint={t(`Book Segment Mode Hint ${options.mode}`)}>
                <Select
                  value={options.mode}
                  onValueChange={(value) => set("mode", value as SegmentMode)}
                  options={SEGMENT_MODES.map((mode) => ({
                    value: mode,
                    label: t(`Book Segment Mode ${mode}`),
                  }))}
                  disabled={renderingActive}
                />
              </Field>

              <Field
                label={t("Book Target Duration")}
                hint={formatDuration(options.target_duration_seconds)}
              >
                <NumberInput
                  min={MIN_SEGMENT_SECONDS}
                  max={MAX_SEGMENT_SECONDS}
                  step={30}
                  disabled={renderingActive}
                  value={options.target_duration_seconds}
                  onChange={(event) => {
                    const value = Math.round(Number(event.target.value));
                    setOptions((current) =>
                      current
                        ? {
                            ...current,
                            target_duration_seconds: value,
                            // The maximum follows the target up, so the pair can
                            // never be left in the combination the server rejects.
                            max_duration_seconds: Math.max(current.max_duration_seconds, value),
                          }
                        : current,
                    );
                  }}
                />
              </Field>

              <Field label={t("Book Max Duration")} hint={formatDuration(options.max_duration_seconds)}>
                <NumberInput
                  min={Math.max(MIN_SEGMENT_SECONDS, options.target_duration_seconds)}
                  max={MAX_SEGMENT_SECONDS}
                  step={30}
                  disabled={renderingActive}
                  value={options.max_duration_seconds}
                  onChange={(event) => set("max_duration_seconds", Math.round(Number(event.target.value)))}
                />
              </Field>

              <Field label={t("Book Words Per Minute")} hint={t("Book Words Per Minute Hint")}>
                <NumberInput
                  min={MIN_WORDS_PER_MINUTE}
                  max={MAX_WORDS_PER_MINUTE}
                  disabled={renderingActive}
                  value={options.words_per_minute}
                  onChange={(event) => set("words_per_minute", Math.round(Number(event.target.value)))}
                />
              </Field>
            </div>

            {problem && <Alert tone="warning">{t(`Book Segment Invalid ${problem}`)}</Alert>}
            {renderingActive && <Alert tone="warning">{t("Book Plan Locked")}</Alert>}
            {apply.isError && (
              <Alert tone={isRenderConflict(apply.error) ? "warning" : "danger"}>
                {errorText(apply.error, t)}
              </Alert>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                disabled={!dirty || Boolean(problem) || apply.isPending || renderingActive}
                onClick={() => options && apply.mutate(options)}
              >
                {apply.isPending ? (
                  <Loader2 className="animate-spin" size={14} />
                ) : options.mode === "smart" ? (
                  <Sparkles size={14} />
                ) : (
                  <Save size={14} />
                )}
                {t(options.mode === "smart" ? "Book Apply Plan Smart" : "Book Apply Plan")}
              </Button>
              <span className="text-xs text-muted">
                {t("Book Plan Summary", {
                  count: segments.length,
                  duration: formatDuration(totalDuration),
                })}
              </span>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 py-6 text-sm text-muted">
            <Loader2 className="animate-spin" size={16} /> {t("Loading")}
          </div>
        )}
      </Card>

      <Card title={t("Book Segments")}>
        {segments.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">{t("Book No Segments")}</p>
        ) : (
          <div className="scroll-x">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="pb-2 pr-3 font-medium">#</th>
                  <th className="pb-2 pr-3 font-medium">{t("Book Segment Title")}</th>
                  <th className="pb-2 pr-3 font-medium">{t("Book Blocks")}</th>
                  <th className="pb-2 pr-3 font-medium">{t("Book Estimated Duration")}</th>
                  <th className="pb-2 pr-3 font-medium">{t("Task Status")}</th>
                  <th className="pb-2 font-medium">{t("Task Actions")}</th>
                </tr>
              </thead>
              <tbody>
                {segments.map((segment) => {
                  const state = liveStates?.[segment.index] ?? segment.state;
                  const active = state === "queued" || state === "rendering";
                  return (
                    <tr key={segment._id} className="border-b border-border/60 last:border-0">
                      <td className="py-2.5 pr-3 align-middle tabular-nums text-muted">{segment.index + 1}</td>
                      <td className="py-2.5 pr-3 align-middle" title={segment.title}>
                        <span className="line-clamp-2">{segment.title || t("Book Untitled Segment")}</span>
                        {segment.error && (
                          <div className="text-xs text-danger" title={segment.error}>
                            <span className="line-clamp-2">{segment.error}</span>
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 align-middle tabular-nums text-muted">{segment.block_count}</td>
                      <td className="py-2.5 pr-3 align-middle tabular-nums whitespace-nowrap">
                        {formatDuration(segment.estimated_duration)}
                      </td>
                      <td className="py-2.5 pr-3 align-middle">
                        <Badge tone={stateTone(state)}>{t(`Book Segment State ${state}`)}</Badge>
                      </td>
                      <td className="py-2.5 align-middle">
                        <div className="flex items-center gap-1">
                          {segment.video_url && (
                            <>
                              <a
                                href={segment.video_url}
                                target="_blank"
                                rel="noreferrer"
                                className={buttonClass({ variant: "ghost", size: "sm" })}
                                title={t("Book Open Video")}
                                aria-label={t("Book Open Video")}
                              >
                                <Film size={14} />
                              </a>
                              <FileDownloadLink
                                href={segment.video_url}
                                title={segment.title || t("Book Untitled Segment")}
                                label={t("Book Download Video")}
                              >
                                <Download size={14} />
                                {t("Download")}
                              </FileDownloadLink>
                            </>
                          )}
                          {segment.audio_url && (
                            <FileDownloadLink
                              href={segment.audio_url}
                              title={segment.title || t("Book Untitled Segment")}
                              label={t("Book Download Audio")}
                            >
                              <FileAudio size={14} />
                              {!segment.video_url && t("Download")}
                            </FileDownloadLink>
                          )}
                          {segment.subtitle_url && (
                            <FileDownloadLink
                              href={segment.subtitle_url}
                              title={segment.title || t("Book Untitled Segment")}
                              label={t("Book Download Subtitle")}
                            >
                              <Download size={14} />
                            </FileDownloadLink>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={active || retry.isPending || !canRetry}
                            title={canRetry ? t("Book Retry Segment") : t("Book Retry Needs Render")}
                            onClick={() => retry.mutate(segment.index)}
                          >
                            {retry.isPending && retry.variables === segment.index ? (
                              <Loader2 className="animate-spin" size={14} />
                            ) : (
                              <RotateCcw size={14} />
                            )}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {retry.isError && (
          <div className="mt-3">
            <Alert tone={isRenderConflict(retry.error) ? "warning" : "danger"}>
              {errorText(retry.error, t)}
            </Alert>
          </div>
        )}
      </Card>
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
