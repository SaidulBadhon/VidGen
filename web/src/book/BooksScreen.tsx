/**
 * Books list: every imported book, and the way to bring a new one in.
 *
 * Opening a row leaves this page for that book's workspace. Importing does the
 * same the moment the file is accepted, so a scan that still needs OCR lands
 * on the book that is waiting rather than back here in a list that has not
 * moved yet.
 */

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, FileUp, Loader2, Trash2, Upload } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useI18n } from "../i18n/index.tsx";
import { PageHeader } from "../components/page-header.tsx";
import { Alert, Badge, Button, Card, Dialog, Progress } from "../components/ui.tsx";
import {
  ACCEPTED_BOOK_EXTENSIONS,
  bookApi,
  errorText,
  isOcrState,
  type BookListEntry,
  type BookState,
} from "./api.ts";

const ALLOWED_EXTENSIONS = ACCEPTED_BOOK_EXTENSIONS.split(",");

function stateTone(state: BookState): "muted" | "success" | "warning" | "danger" | "accent" {
  if (state === "complete") return "success";
  if (state === "failed") return "danger";
  if (state === "rendering" || isOcrState(state)) return "accent";
  return "muted";
}

/**
 * What a books-list row should call itself.
 *
 * `progress.state` is derived from segment rows, and a book still being
 * recognised has none — so it reads `ready`, which is the one thing it is not.
 * The book's own state wins whenever it describes the book rather than a render.
 */
function bookListState(book: BookListEntry): BookState {
  return isOcrState(book.state) || book.state === "failed" ? book.state : book.progress.state;
}

function hasAllowedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function BooksScreen() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BookListEntry | null>(null);

  const books = useQuery({
    queryKey: ["books"],
    queryFn: () => bookApi.list(1, 50),
    refetchInterval: (query) =>
      query.state.data?.books.some(
        (book) => book.progress.state === "rendering" || isOcrState(book.state),
      )
        ? 5000
        : false,
  });

  const upload = useMutation({
    mutationFn: (file: File) => bookApi.upload(file),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["books"] });
      navigate(`/books/${result.book._id}`);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => bookApi.remove(id),
    onSuccess: (_result, id) => {
      queryClient.invalidateQueries({ queryKey: ["books"] });
      queryClient.removeQueries({ queryKey: ["book", id] });
      setPendingDelete(null);
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
    <div className="space-y-5">
      <PageHeader title={t("Books")} description={t("Books Intro")} />

      <Card>
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
            "flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-4 py-8 text-center text-foreground transition sm:flex-row sm:text-left " +
            (dragging ? "border-primary bg-primary/5" : "border-border bg-muted/40")
          }
        >
          <FileUp size={26} className="shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{t("Book Drop Here")}</p>
            <p className="mt-1 text-xs text-foreground/70">{t("Book Drop Hint")}</p>
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
        {rejected && (
          <div className="mt-3">
            <Alert tone="warning">{rejected}</Alert>
          </div>
        )}
        {upload.isError && (
          <div className="mt-3">
            <Alert tone="danger">{errorText(upload.error, t)}</Alert>
          </div>
        )}
      </Card>

      {books.isLoading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="animate-spin" size={16} /> {t("Loading")}
        </div>
      ) : books.isError ? (
        <Alert tone="danger">{errorText(books.error, t)}</Alert>
      ) : entries.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t("Books Empty")}</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {entries.map((book) => {
            const state = bookListState(book);
            return (
              <li key={book._id}>
                <article className="flex h-full gap-3 rounded-xl border bg-card p-3 shadow-sm transition hover:border-primary/60 hover:bg-primary/5">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-start gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    onClick={() => navigate(`/books/${book._id}`)}
                  >
                    {book.has_cover ? (
                      <img
                        src={bookApi.coverUrl(book._id, book.revision)}
                        alt={t("Book Cover Alt", { title: book.title })}
                        className="h-[4.5rem] w-12 shrink-0 rounded-md object-cover"
                      />
                    ) : (
                      <div className="flex h-[4.5rem] w-12 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                        <BookOpen size={18} />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{book.title}</p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {book.author || t("Book Unknown Author")} · {book.format.toUpperCase()}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {t("Book Kept Of Blocks", {
                          kept: book.kept_block_count,
                          total: book.block_count,
                        })}
                      </p>
                      {book.progress.total > 0 && book.progress.state === "rendering" && (
                        <div className="mt-2">
                          <Progress value={book.progress.progress} />
                        </div>
                      )}
                      {isOcrState(book.state) && book.ocr && (
                        <p className="mt-1 truncate text-xs text-primary">
                          {t("Book Ocr Page Of", { done: book.ocr.pages_done, total: book.ocr.pages_total })}
                        </p>
                      )}
                      <div className="mt-2">
                        <Badge tone={stateTone(state)}>{t(`Book State ${state}`)}</Badge>
                      </div>
                    </div>
                  </button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 self-start"
                    title={t("Delete")}
                    aria-label={t("Delete")}
                    onClick={() => setPendingDelete(book)}
                  >
                    <Trash2 size={14} className="text-danger" />
                  </Button>
                </article>
              </li>
            );
          })}
        </ul>
      )}

      {remove.isError && <p className="text-xs text-danger">{errorText(remove.error, t)}</p>}

      {pendingDelete && (
        <Dialog
          open
          onOpenChange={(open) => !open && setPendingDelete(null)}
          title={t("Book Delete Title", { title: pendingDelete.title })}
        >
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{t("Book Delete Warning")}</p>
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
