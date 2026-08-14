/**
 * Workspace for one open book: import result, review, plan, render.
 *
 * The four panels are steps of one book, so this container owns the live
 * progress stream they all read from — a stream per panel would mean three
 * EventSources for one book. The selected book and step live in the URL so a
 * refresh or a shared link lands on the same screen. The library of all books
 * is a separate page; this one is named after the book at the top.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useI18n } from "../i18n/index.tsx";
import { Alert, Badge, Button, Progress, TabContent, TabTrigger, Tabs, TabsList } from "../components/ui.tsx";
import { ImportPanel } from "./ImportPanel.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { SegmentsPanel } from "./SegmentsPanel.tsx";
import { RenderPanel } from "./RenderPanel.tsx";
import {
  bookApi,
  errorText,
  isOcrState,
  subscribeToBook,
  type BookDetail,
  type BookEvent,
  type BookSegmentState,
  type BookState,
} from "./api.ts";

type Step = "import" | "review" | "segments" | "render";

const STEPS: Step[] = ["import", "review", "segments", "render"];

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
      return streamFailed && counts && counts.queued + counts.rendering > 0 ? 3000 : false;
    },
  });

  // One EventSource per selected book, always closed on unmount or switch.
  useEffect(() => {
    setProgress(null);
    setStreamFailed(false);
    if (!bookId) return;

    let lastComplete: number | null = null;
    let sawRendering = false;
    const refresh = () => {
      queryClient.invalidateQueries({ queryKey: ["book", bookId] });
      queryClient.invalidateQueries({ queryKey: ["books"] });
    };

    return subscribeToBook(bookId, {
      onProgress: (event) => {
        setProgress(event);
        if (event.state === "rendering") sawRendering = true;
        // A finished segment has URLs the projection does not carry, so the
        // full document is refetched only when one actually lands.
        if (lastComplete !== null && event.counts.complete !== lastComplete) refresh();
        lastComplete = event.counts.complete;
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
      <div>
        <Button size="sm" variant="ghost" className="-ml-2 mb-3" onClick={() => navigate("/books")}>
          <ArrowLeft size={14} /> {t("Book Back To Library")}
        </Button>

        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1">
            {detailQuery.isLoading ? (
              <span className="inline-flex items-center gap-2 text-sm text-muted">
                <Loader2 className="animate-spin" size={14} /> {t("Loading")}
              </span>
            ) : (
              <>
                <h2 className="truncate text-2xl font-semibold tracking-tight">
                  {detail?.book.title ?? t("Book Untitled")}
                </h2>
                <p className="mt-1 truncate text-sm text-muted">
                  {detail?.book.author || t("Book Unknown Author")} ·{" "}
                  {t("Book Kept Of Blocks", {
                    kept: detail?.book.kept_block_count ?? 0,
                    total: detail?.book.block_count ?? 0,
                  })}{" "}
                  · {t("Book Revision", { revision: detail?.book.revision ?? 0 })}
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
            streamFailed={streamFailed}
            renderingActive={renderingActive}
            onRenderStarted={() => setStreamEpoch((current) => current + 1)}
          />
        </TabContent>
      </Tabs>
    </div>
  );
}
