/**
 * Step 1: bring a book in.
 *
 * Holds the library of already-imported books as well as the uploader, because
 * "start a new book" and "carry on with the one from yesterday" are the same
 * decision and belong on the same screen.
 */

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, FileUp, Loader2, Trash2, Upload } from "lucide-react";
import { useI18n } from "../i18n/index.tsx";
import { Alert, Badge, Button, Card, Dialog, Progress } from "../components/ui.tsx";
import {
  ACCEPTED_BOOK_EXTENSIONS,
  bookApi,
  errorText,
  ruleLabel,
  type BookDetail,
  type BookListEntry,
  type BookState,
} from "./api.ts";

const ALLOWED_EXTENSIONS = ACCEPTED_BOOK_EXTENSIONS.split(",");

function stateTone(state: BookState): "muted" | "success" | "warning" | "danger" | "accent" {
  if (state === "complete") return "success";
  if (state === "failed") return "danger";
  if (state === "rendering") return "accent";
  return "muted";
}

function hasAllowedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function ImportPanel({
  bookId,
  detail,
  onOpen,
  onReview,
}: {
  bookId: string | null;
  detail?: BookDetail;
  onOpen: (bookId: string | null) => void;
  onReview: (bookId: string) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BookListEntry | null>(null);

  const books = useQuery({
    queryKey: ["books"],
    queryFn: () => bookApi.list(1, 50),
    refetchInterval: (query) =>
      query.state.data?.books.some((book) => book.progress.state === "rendering") ? 5000 : false,
  });

  const upload = useMutation({
    mutationFn: (file: File) => bookApi.upload(file),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["books"] });
      onOpen(result.book._id);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => bookApi.remove(id),
    onSuccess: (_result, id) => {
      queryClient.invalidateQueries({ queryKey: ["books"] });
      queryClient.removeQueries({ queryKey: ["book", id] });
      setPendingDelete(null);
      if (id === bookId) onOpen(null);
    },
  });

  const accept = (file: File | undefined) => {
    setRejected(null);
    if (!file) return;
    if (!hasAllowedExtension(file.name)) {
      setRejected(t("Book Unsupported File", { name: file.name }));
      return;
    }
    upload.mutate(file);
  };

  const entries = books.data?.books ?? [];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <Card title={t("Book Import Title")}>
        <div className="space-y-3">
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              accept(event.dataTransfer.files?.[0]);
            }}
            className={
              "flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-4 py-8 text-center transition " +
              (dragging ? "border-accent bg-accent/5" : "border-border bg-surface-2")
            }
          >
            <FileUp size={26} className="text-muted" />
            <div>
              <p className="text-sm font-medium">{t("Book Drop Here")}</p>
              <p className="mt-1 text-xs text-muted">{t("Book Drop Hint")}</p>
            </div>
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              accept={ACCEPTED_BOOK_EXTENSIONS}
              onChange={(event) => {
                accept(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <Button disabled={upload.isPending} onClick={() => fileInput.current?.click()}>
              {upload.isPending ? <Loader2 className="animate-spin" size={14} /> : <Upload size={14} />}
              {upload.isPending ? t("Book Extracting") : t("Book Choose File")}
            </Button>
          </div>

          {rejected && <Alert tone="warning">{rejected}</Alert>}
          {upload.isError && <Alert tone="danger">{errorText(upload.error, t)}</Alert>}
        </div>
      </Card>

      <Card
        title={t("Book Library")}
        action={books.isFetching ? <Loader2 className="animate-spin text-muted" size={14} /> : undefined}
      >
        {books.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted">
            <Loader2 className="animate-spin" size={16} /> {t("Loading")}
          </div>
        ) : books.isError ? (
          <Alert tone="danger">{errorText(books.error, t)}</Alert>
        ) : entries.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">{t("Book Library Empty")}</p>
        ) : (
          <ul className="space-y-2">
            {entries.map((book) => (
              <li
                key={book._id}
                className={
                  "flex flex-wrap items-center gap-3 rounded-lg border p-2.5 " +
                  (book._id === bookId ? "border-accent bg-accent/5" : "border-border bg-surface-2")
                }
              >
                <BookOpen size={16} className="shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{book.title}</p>
                  <p className="truncate text-xs text-muted">
                    {book.author || t("Book Unknown Author")} · {book.format.toUpperCase()} ·{" "}
                    {t("Book Kept Of Blocks", { kept: book.kept_block_count, total: book.block_count })}
                  </p>
                  {book.progress.total > 0 && book.progress.state === "rendering" && (
                    <div className="mt-1.5">
                      <Progress value={book.progress.progress} />
                    </div>
                  )}
                </div>
                <Badge tone={stateTone(book.progress.state)}>{t(`Book State ${book.progress.state}`)}</Badge>
                <Button size="sm" onClick={() => onOpen(book._id)}>
                  {t("Book Open")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  title={t("Delete")}
                  aria-label={t("Delete")}
                  onClick={() => setPendingDelete(book)}
                >
                  <Trash2 size={14} className="text-danger" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {remove.isError && <p className="mt-2 text-xs text-danger">{errorText(remove.error, t)}</p>}
      </Card>

      {detail && (
        <Card className="lg:col-span-2" title={t("Book Extraction Result")}>
          <div className="space-y-4">
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
              <Button variant="primary" onClick={() => onReview(detail.book._id)}>
                {t("Book Review Decisions")}
              </Button>
              <span className="text-xs text-muted">
                {t("Book Source File", { name: detail.book.source_filename })}
              </span>
            </div>
          </div>
        </Card>
      )}

      {pendingDelete && (
        <Dialog
          open
          onOpenChange={(open) => !open && setPendingDelete(null)}
          title={t("Book Delete Title", { title: pendingDelete.title })}
        >
          <div className="space-y-4">
            <p className="text-sm text-muted">{t("Book Delete Warning")}</p>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setPendingDelete(null)}>{t("Cancel")}</Button>
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate(pendingDelete._id)}
              >
                {remove.isPending ? <Loader2 className="animate-spin" size={14} /> : <Trash2 size={14} />}
                {t("Delete")}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
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
