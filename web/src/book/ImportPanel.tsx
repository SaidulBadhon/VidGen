/**
 * Step 1 of an open book: what import produced.
 *
 * The books list and the uploader live on their own page. This panel is the
 * record of the file that became this book — OCR progress while a scan is
 * still being read, then the extraction summary once there is text to review.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RotateCw, ScanText } from "lucide-react";
import { useI18n } from "../i18n/index.tsx";
import { Alert, Badge, Button, Card, Progress } from "../components/ui.tsx";
import { bookApi, errorText, isOcrState, ruleLabel, type BookDetail } from "./api.ts";

/** How often a book being recognised is re-read while the page is open. */
const OCR_POLL_MS = 2000;

export function ImportPanel({
  bookId,
  detail,
  onReview,
}: {
  bookId: string;
  detail?: BookDetail;
  onReview: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  // A book being recognised has no render to stream, so the progress stream the
  // workspace opens says "done" immediately and nothing would ever move. This
  // shares the workspace's own cache entry, so the poll updates every panel.
  const recognisingId = isOcrState(detail?.book.state) ? bookId : null;
  useQuery({
    queryKey: ["book", recognisingId],
    queryFn: () => bookApi.get(recognisingId as string),
    enabled: Boolean(recognisingId),
    refetchInterval: OCR_POLL_MS,
  });

  const resumeOcr = useMutation({
    mutationFn: () => bookApi.resumeOcr(bookId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["book", bookId] }),
  });

  if (!detail) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted">
        <Loader2 className="animate-spin" size={16} /> {t("Loading")}
      </div>
    );
  }

  if (isOcrState(detail.book.state)) {
    return (
      <Card title={t("Book Ocr Title")}>
        <OcrProgressCard
          detail={detail}
          onResume={() => resumeOcr.mutate()}
          resuming={resumeOcr.isPending}
          resumeError={resumeOcr.isError ? errorText(resumeOcr.error, t) : null}
        />
      </Card>
    );
  }

  return (
    <Card title={t("Book Extraction Result")}>
      <div className="space-y-4">
        {detail.book.ocr && (
          <Alert tone="warning">
            {t("Book Ocr Review Note", {
              pages: detail.book.ocr.pages_done,
              percent: Math.round(detail.book.ocr.mean_confidence * 100),
            })}
          </Alert>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label={t("Book Title")} value={detail.book.title} wide />
          <Stat label={t("Book Author")} value={detail.book.author || t("Book Unknown Author")} />
          <Stat label={t("Book Language")} value={detail.book.language || "—"} />
          <Stat label={t("Book Chapters")} value={String(detail.book.chapter_count)} />
          <Stat label={t("Book Blocks")} value={String(detail.book.block_count)} />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Counter tone="success" label={t("Book Kept")} value={detail.decisions.kept} />
          <Counter tone="warning" label={t("Book Dropped")} value={detail.decisions.dropped} />
          <Counter tone="accent" label={t("Book Your Overrides")} value={detail.overrides} />
        </div>

        {detail.decisions.dropped > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">{t("Book What Was Dropped")}</p>
            <ul className="space-y-1">
              {detail.decisions.rules
                .filter((rule) => rule.dropped > 0)
                .map((rule) => (
                  <li
                    key={rule.rule}
                    className="flex items-start gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2"
                  >
                    <Badge tone="warning">{rule.dropped}</Badge>
                    <div className="min-w-0">
                      <p className="text-sm">{ruleLabel(rule.rule, t)}</p>
                      <p className="text-xs text-muted">{rule.reason}</p>
                    </div>
                  </li>
                ))}
            </ul>
          </div>
        )}

        {(detail.book.warnings ?? []).map((warning) => (
          <Alert key={warning} tone="warning">
            {warning}
          </Alert>
        ))}

        {detail.book.error && <Alert tone="danger">{detail.book.error}</Alert>}

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={onReview}>
            {t("Book Review Decisions")}
          </Button>
          <span className="text-xs text-muted">
            {t("Book Source File", { name: detail.book.source_filename })}
          </span>
        </div>
      </div>
    </Card>
  );
}

/**
 * What a scanned book is doing while it cannot be reviewed yet.
 *
 * Recognition takes seconds a page, so a three-hundred-page scan is half an hour
 * during which the only honest thing to show is which page it is on. A spinner
 * alone here is indistinguishable from a hang, which is the exact confusion a
 * job this long cannot afford.
 */
function OcrProgressCard({
  detail,
  onResume,
  resuming,
  resumeError,
}: {
  detail: BookDetail;
  onResume: () => void;
  resuming: boolean;
  resumeError: string | null;
}) {
  const { t } = useI18n();
  const ocr = detail.book.ocr;
  const total = ocr?.pages_total ?? 0;
  const done = ocr?.pages_done ?? 0;
  const failed = ocr?.pages_failed ?? 0;
  const percent = total > 0 ? Math.round(((done + failed) / total) * 100) : 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <ScanText size={18} className="text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {detail.book.state === "ocr_pending" ? t("Book Ocr Queued") : t("Book Ocr Page Of", { done, total })}
          </p>
          <p className="text-xs text-muted">{t("Book Ocr Explain")}</p>
        </div>
        <Badge tone="accent">{percent}%</Badge>
      </div>

      <Progress value={percent} />

      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
        <span>{t("Book Ocr Pages Read", { done })}</span>
        <span>{t("Book Ocr Pages Failed", { failed })}</span>
        {done > 0 && (
          <span>{t("Book Ocr Mean Confidence", { percent: Math.round((ocr?.mean_confidence ?? 0) * 100) })}</span>
        )}
        {ocr?.provider && <span>{t("Book Ocr Engine", { provider: ocr.provider })}</span>}
      </div>

      {failed > 0 && <Alert tone="warning">{t("Book Ocr Some Pages Failed", { failed })}</Alert>}
      {ocr?.error && <Alert tone="danger">{ocr.error}</Alert>}

      <div className="flex flex-wrap items-center gap-3">
        {/* A pass runs in-process, so a restart leaves the book stalled here with
            its recognised pages safely on disk. Resuming costs only what is left. */}
        <Button size="sm" disabled={resuming} onClick={onResume}>
          {resuming ? <Loader2 className="animate-spin" size={14} /> : <RotateCw size={14} />}
          {t("Book Ocr Resume")}
        </Button>
        <span className="text-xs text-muted">{t("Book Ocr Resume Hint")}</span>
      </div>

      {resumeError && <Alert tone="danger">{resumeError}</Alert>}
    </div>
  );
}

function Stat({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2" : undefined}>
      <p className="text-xs text-muted">{label}</p>
      <p className="truncate text-sm font-medium" title={value}>
        {value}
      </p>
    </div>
  );
}

function Counter({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "success" | "warning" | "accent";
}) {
  const tones = {
    success: "border-success/40 bg-success/10 text-success",
    warning: "border-warning/40 bg-warning/10 text-warning",
    accent: "border-accent/40 bg-accent/10 text-accent",
  };
  return (
    <div className={`rounded-lg border px-3 py-2 ${tones[tone]}`}>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-xs opacity-80">{label}</p>
    </div>
  );
}
