/**
 * Workspace for one open book: import result, review, plan, render, and shorts.
 *
 * The panels are views of one book, so this container owns the live progress
 * stream they all read from — a stream per panel would mean several EventSources
 * for one book. The selected book and step live in the URL so a refresh or a
 * shared link lands on the same screen. The list of all books is a separate
 * page; this one is named after the book at the top.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Loader2, Pencil, X } from "lucide-react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useI18n } from "../i18n/index.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../components/ui/breadcrumb";
import { Alert, Badge, Button, Progress, TabContent, TabTrigger, Tabs, TabsList, TextInput } from "../components/ui.tsx";
import { ImportPanel } from "./ImportPanel.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { SegmentsPanel } from "./SegmentsPanel.tsx";
import { RenderPanel } from "./RenderPanel.tsx";
import { ShortsPanel } from "./ShortsPanel.tsx";
import {
  bookApi,
  errorText,
  isOcrState,
  isRenderConflict,
  subscribeToBook,
  type BookDetail,
  type BookEvent,
  type BookSegmentState,
  type BookState,
} from "./api.ts";

type Step = "import" | "review" | "segments" | "render" | "shorts";

const STEPS: Step[] = ["import", "review", "segments", "render", "shorts"];

function isStep(value: string | undefined): value is Step {
  return STEPS.includes(value as Step);
}

function bookPath(bookId: string, step: Step = "import"): string {
  if (step === "import") return `/books/${bookId}`;
  return `/books/${bookId}/${step}`;
}

/**
 * What the header should call the book.
 *
 * Two states describe the book itself rather than its segments — a scan being
 * recognised, and an extraction that failed — and both have to outrank the
 * state derived from segment rows, which for a book with no segments yet reads
 * `ready`.
 */
function headerState(detail: BookDetail, renderingActive: boolean): BookState {
  if (isOcrState(detail.book.state) || detail.book.state === "failed") return detail.book.state;
  return renderingActive ? "rendering" : detail.progress.state;
}

/**
 * The heading that names the open book, and the control that changes it.
 *
 * Clicking the pencil turns the title into a field; Enter saves, Escape
 * cancels. Refused while a render is in flight because the output folder is
 * named after this title.
 */
function BookTitleEditor({
  bookId,
  title,
  locked,
}: {
  bookId: string;
  title: string;
  locked: boolean;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [editing, title]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const rename = useMutation({
    mutationFn: (next: string) => bookApi.rename(bookId, next),
    onSuccess: (result) => {
      setEditing(false);
      queryClient.setQueryData(["book", bookId], (current: BookDetail | undefined) =>
        current ? { ...current, book: { ...current.book, title: result.title } } : current,
      );
      queryClient.invalidateQueries({ queryKey: ["book", bookId] });
      queryClient.invalidateQueries({ queryKey: ["books"] });
    },
  });

  const trimmed = draft.trim();

  const close = () => {
    setDraft(title);
    setEditing(false);
    rename.reset();
  };

  const save = () => {
    if (!trimmed) return;
    if (trimmed === title) {
      close();
      return;
    }
    rename.mutate(trimmed);
  };

  if (editing) {
    return (
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div className="flex items-center gap-1.5">
          <TextInput
            ref={inputRef}
            value={draft}
            disabled={rename.isPending}
            maxLength={300}
            autoComplete="off"
            aria-label={t("Book Title")}
            placeholder={t("Book Rename Placeholder")}
            className="h-10 min-w-0 flex-1 text-2xl font-semibold tracking-tight md:text-2xl"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !rename.isPending) {
                event.preventDefault();
                close();
              }
            }}
          />
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={rename.isPending || !trimmed}
            title={t("Save")}
            aria-label={t("Save")}
          >
            {rename.isPending ? <Loader2 className="animate-spin" size={14} /> : <Check size={14} />}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={rename.isPending}
            title={t("Cancel")}
            aria-label={t("Cancel")}
            onClick={close}
          >
            <X size={14} />
          </Button>
        </div>
        {rename.isError && (
          <Alert tone={isRenderConflict(rename.error) ? "warning" : "danger"}>{errorText(rename.error, t)}</Alert>
        )}
      </form>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <h2 className="min-w-0">
        <button
          type="button"
          disabled={locked}
          className="max-w-full truncate text-left text-2xl font-semibold tracking-tight disabled:cursor-not-allowed"
          title={locked ? t("Book Rename Locked") : t("Book Rename")}
          onClick={() => {
            setDraft(title);
            setEditing(true);
          }}
        >
          {title || t("Book Untitled")}
        </button>
      </h2>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="shrink-0"
        disabled={locked}
        title={locked ? t("Book Rename Locked") : t("Book Rename")}
        aria-label={locked ? t("Book Rename Locked") : t("Book Rename")}
        onClick={() => {
          setDraft(title);
          setEditing(true);
        }}
      >
        <Pencil size={14} />
      </Button>
    </div>
  );
}

/**
 * The author shown under the title, and the control that changes it.
 *
 * Empty is allowed: clearing the field stops the first video announcing a
 * leftover from the file's metadata. Locked while a render is in flight for
 * the same reason as the title — the first segment is marked unrendered.
 */
function BookAuthorEditor({
  bookId,
  author,
  locked,
}: {
  bookId: string;
  author: string;
  locked: boolean;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(author);
  const inputRef = useRef<HTMLInputElement>(null);
  const label = author || t("Book Unknown Author");

  useEffect(() => {
    if (!editing) setDraft(author);
  }, [editing, author]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const saveAuthor = useMutation({
    mutationFn: (next: string) => bookApi.patch(bookId, { author: next }),
    onSuccess: (result) => {
      setEditing(false);
      queryClient.setQueryData(["book", bookId], (current: BookDetail | undefined) =>
        current ? { ...current, book: { ...current.book, author: result.author } } : current,
      );
      queryClient.invalidateQueries({ queryKey: ["book", bookId] });
      queryClient.invalidateQueries({ queryKey: ["books"] });
    },
  });

  const close = () => {
    setDraft(author);
    setEditing(false);
    saveAuthor.reset();
  };

  const save = () => {
    if (draft.trim() === author) {
      close();
      return;
    }
    saveAuthor.mutate(draft.trim());
  };

  const startEdit = () => {
    setDraft(author);
    setEditing(true);
  };

  if (editing) {
    return (
      <form
        className="w-full basis-full space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div className="flex items-center gap-1.5">
          <TextInput
            ref={inputRef}
            value={draft}
            disabled={saveAuthor.isPending}
            maxLength={300}
            autoComplete="off"
            aria-label={t("Book Author")}
            placeholder={t("Book Edit Author Placeholder")}
            className="h-8 min-w-0 flex-1 text-sm"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !saveAuthor.isPending) {
                event.preventDefault();
                close();
              }
            }}
          />
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={saveAuthor.isPending}
            title={t("Save")}
            aria-label={t("Save")}
          >
            {saveAuthor.isPending ? <Loader2 className="animate-spin" size={14} /> : <Check size={14} />}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={saveAuthor.isPending}
            title={t("Cancel")}
            aria-label={t("Cancel")}
            onClick={close}
          >
            <X size={14} />
          </Button>
        </div>
        {saveAuthor.isError && (
          <Alert tone={isRenderConflict(saveAuthor.error) ? "warning" : "danger"}>
            {errorText(saveAuthor.error, t)}
          </Alert>
        )}
      </form>
    );
  }

  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-0.5">
      <button
        type="button"
        disabled={locked}
        className="min-w-0 truncate text-left disabled:cursor-not-allowed"
        title={locked ? t("Book Edit Author Locked") : t("Book Edit Author")}
        onClick={startEdit}
      >
        {label}
      </button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-6 w-6 shrink-0 p-0"
        disabled={locked}
        title={locked ? t("Book Edit Author Locked") : t("Book Edit Author")}
        aria-label={locked ? t("Book Edit Author Locked") : t("Book Edit Author")}
        onClick={startEdit}
      >
        <Pencil size={12} />
      </Button>
    </span>
  );
}

export function BookScreen() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { bookId, step: stepParam } = useParams<{ bookId: string; step?: string }>();

  const step: Step = isStep(stepParam) ? stepParam : "import";
  /** Bumped to reopen the stream after a render is started. */
  const [streamEpoch, setStreamEpoch] = useState(0);
  const [progress, setProgress] = useState<BookEvent | null>(null);
  const [streamFailed, setStreamFailed] = useState(false);

  const detailQuery = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => bookApi.get(bookId as string),
    enabled: Boolean(bookId),
    // Only when the live stream is unavailable; otherwise SSE drives updates.
    // The test is the segment counts rather than the derived state: a book whose
    // remaining segments have all failed reports `ready`, and polling that stops
    // the moment the last one dies is how a dead render keeps looking alive.
    refetchInterval: (query) => {
      const counts = query.state.data?.progress;
      const shortsPlan = query.state.data?.book.shorts?.state;
      const planning = shortsPlan === "planning";
      const segmentBusy = Boolean(counts && counts.queued + counts.rendering > 0);
      const youtubeBusy = Boolean(
        query.state.data?.segments.some(
          (segment) => segment.youtube_upload_state === "pending" || segment.youtube_upload_state === "processing",
        ),
      );
      if (youtubeBusy) return 3000;
      return streamFailed && (segmentBusy || planning) ? 3000 : false;
    },
  });

  // One EventSource per selected book, always closed on unmount or switch.
  useEffect(() => {
    setProgress(null);
    setStreamFailed(false);
    if (!bookId) return;

    let lastComplete: number | null = null;
    let lastShortComplete: number | null = null;
    let lastShortsPlanState: string | null = null;
    let sawRendering = false;
    const refresh = () => {
      queryClient.invalidateQueries({ queryKey: ["book", bookId] });
      queryClient.invalidateQueries({ queryKey: ["books"] });
      queryClient.invalidateQueries({ queryKey: ["book-shorts", bookId] });
    };

    return subscribeToBook(bookId, {
      onProgress: (event) => {
        setProgress(event);
        if (event.state === "rendering" || event.shorts?.state === "planning" || event.shorts?.state === "rendering") {
          sawRendering = true;
        }
        // A finished segment has URLs the projection does not carry, so the
        // full document is refetched only when one actually lands.
        if (lastComplete !== null && event.counts.complete !== lastComplete) refresh();
        lastComplete = event.counts.complete;
        const shortComplete = event.shorts?.counts.complete;
        if (lastShortComplete !== null && shortComplete !== undefined && shortComplete !== lastShortComplete) {
          refresh();
        }
        if (shortComplete !== undefined) lastShortComplete = shortComplete;
        const planState = event.shorts?.state ?? null;
        if (lastShortsPlanState === "planning" && planState !== "planning") refresh();
        lastShortsPlanState = planState;
      },
      onDone: (event) => {
        setProgress(event);
        if (sawRendering) refresh();
      },
      onError: () => setStreamFailed(true),
    });
  }, [bookId, streamEpoch, queryClient]);

  const detail = detailQuery.data;

  // The stream stops moving once it says "done", so its last payload has to be
  // dated. It carries the revision it described, and a decision or a re-plan
  // bumps that revision and resets the segments underneath it — so a snapshot
  // from before the bump describes a plan that no longer exists.
  //
  // A dropped connection dates it just as surely, and does so without touching
  // the revision. That is how a server restart mid-render used to freeze this
  // screen on "rendering: 2, failed: 0" forever: the segments were failed by
  // startup recovery seconds later, the refetched document said so, and the
  // frozen payload went on outranking it. A payload from a stream that is gone
  // describes the moment the wire broke, and nothing since.
  const detailCounts = detail?.progress ?? null;
  const live =
    progress && !streamFailed && (!detail || progress.revision >= detail.book.revision)
      ? progress
      : null;
  const counts = live?.counts ?? detailCounts;
  const percent = live?.progress ?? detail?.progress.progress ?? 0;
  // Either source reporting work in flight locks the editing screens. Only
  // over-reporting is possible here, and that merely locks them a beat too long.
  const renderingActive =
    Boolean(counts && counts.queued + counts.rendering > 0) ||
    Boolean(detailCounts && detailCounts.queued + detailCounts.rendering > 0);

  const liveStates = useMemo(() => {
    if (!live) return null;
    const states: Record<number, BookSegmentState> = {};
    for (const segment of live.segments) states[segment.index] = segment.state;
    return states;
  }, [live]);

  if (!bookId) {
    return <Navigate to="/books" replace />;
  }

  if (stepParam && !isStep(stepParam)) {
    return <Navigate to={bookPath(bookId)} replace />;
  }

  if (stepParam === "import") {
    return <Navigate to={bookPath(bookId)} replace />;
  }

  return (
    <div className="space-y-5">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/books">{t("Books")}</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{detail?.book.title ?? t("Book Untitled")}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div>
        <Button size="sm" variant="ghost" className="-ml-2 mb-3" onClick={() => navigate("/books")}>
          <ArrowLeft size={14} /> {t("Book Back To Books")}
        </Button>

        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1">
            {detailQuery.isLoading ? (
              <span className="inline-flex items-center gap-2 text-sm text-muted">
                <Loader2 className="animate-spin" size={14} /> {t("Loading")}
              </span>
            ) : (
              <>
                {detail ? (
                  <BookTitleEditor bookId={bookId} title={detail.book.title} locked={renderingActive} />
                ) : (
                  <h2 className="truncate text-2xl font-semibold tracking-tight">{t("Book Untitled")}</h2>
                )}
                <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1 text-sm text-muted">
                  {detail ? (
                    <BookAuthorEditor bookId={bookId} author={detail.book.author} locked={renderingActive} />
                  ) : (
                    t("Book Unknown Author")
                  )}
                  <span>·</span>
                  <span>
                    {t("Book Kept Of Blocks", {
                      kept: detail?.book.kept_block_count ?? 0,
                      total: detail?.book.block_count ?? 0,
                    })}
                  </span>
                  <span>·</span>
                  <span>{t("Book Revision", { revision: detail?.book.revision ?? 0 })}</span>
                </p>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {counts && counts.total > 0 && (
              <div className="w-40">
                <Progress value={percent} />
                <p className="mt-1 text-right text-xs tabular-nums text-muted">
                  {t("Book Complete Of", { complete: counts.complete, total: counts.total })}
                </p>
              </div>
            )}

            {counts && counts.failed > 0 && (
              <Badge tone="danger">{t("Book Segments Failed", { count: counts.failed })}</Badge>
            )}

            {detail && (
              <Badge
                tone={
                  detail.progress.state === "complete"
                    ? "success"
                    : detail.book.state === "failed"
                      ? "danger"
                      : renderingActive || isOcrState(detail.book.state)
                        ? "accent"
                        : "muted"
                }
              >
                {t(`Book State ${headerState(detail, renderingActive)}`)}
              </Badge>
            )}
          </div>
        </div>
      </div>

      {detailQuery.isError && <Alert tone="danger">{errorText(detailQuery.error, t)}</Alert>}

      <Tabs value={step} onValueChange={(value) => navigate(bookPath(bookId, value as Step))}>
        <TabsList>
          <TabTrigger value="import">{t("Book Step Import")}</TabTrigger>
          <TabTrigger value="review">{t("Book Step Review")}</TabTrigger>
          <TabTrigger value="segments">{t("Book Step Segments")}</TabTrigger>
          <TabTrigger value="render">{t("Book Step Render")}</TabTrigger>
          <TabTrigger value="shorts">{t("Book Step Shorts")}</TabTrigger>
        </TabsList>

        <TabContent value="import">
          <ImportPanel bookId={bookId} detail={detail} onReview={() => navigate(bookPath(bookId, "review"))} />
        </TabContent>

        <TabContent value="review">
          <ReviewPanel bookId={bookId} detail={detail} renderingActive={renderingActive} />
        </TabContent>

        <TabContent value="segments">
          <SegmentsPanel
            bookId={bookId}
            detail={detail}
            liveStates={liveStates}
            renderingActive={renderingActive}
            onRenderStarted={() => setStreamEpoch((current) => current + 1)}
          />
        </TabContent>

        <TabContent value="render">
          <RenderPanel
            bookId={bookId}
            detail={detail}
            progress={live}
            liveStates={liveStates}
            streamFailed={streamFailed}
            renderingActive={renderingActive}
            onRenderStarted={() => setStreamEpoch((current) => current + 1)}
          />
        </TabContent>

        <TabContent value="shorts">
          <ShortsPanel
            bookId={bookId}
            detail={detail}
            progress={live}
            streamFailed={streamFailed}
            onWorkStarted={() => setStreamEpoch((current) => current + 1)}
          />
        </TabContent>
      </Tabs>
    </div>
  );
}
