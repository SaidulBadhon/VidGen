/**
 * Audiobook workspace: import, review, plan, render.
 *
 * The four panels are steps rather than independent pages, so the container
 * owns the selected book, the step, and the one live progress stream they all
 * read from — a stream per panel would mean three EventSources for one book.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Library, Loader2 } from "lucide-react";
import { useI18n } from "../i18n/index.tsx";
import { Alert, Badge, Button, Card, Progress, TabContent, TabTrigger, Tabs, TabsList } from "../components/ui.tsx";
import { ImportPanel } from "./ImportPanel.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { SegmentsPanel } from "./SegmentsPanel.tsx";
import { RenderPanel } from "./RenderPanel.tsx";
import { bookApi, errorText, subscribeToBook, type BookEvent, type BookSegmentState } from "./api.ts";

type Step = "import" | "review" | "segments" | "render";

export function BookScreen() {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const [bookId, setBookId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("import");
  /** Bumped to reopen the stream after a render is started. */
  const [streamEpoch, setStreamEpoch] = useState(0);
  const [progress, setProgress] = useState<BookEvent | null>(null);
  const [streamFailed, setStreamFailed] = useState(false);

  const detailQuery = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => bookApi.get(bookId as string),
    enabled: Boolean(bookId),
    // Only when the live stream is unavailable; otherwise SSE drives updates.
    refetchInterval: (query) =>
      streamFailed && query.state.data?.progress.state === "rendering" ? 3000 : false,
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
  const detailCounts = detail?.progress ?? null;
  const live = progress && (!detail || progress.revision >= detail.book.revision) ? progress : null;
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

  const open = (id: string | null) => {
    setBookId(id);
    if (!id) setStep("import");
  };

  const review = (id: string) => {
    setBookId(id);
    setStep("review");
  };

  return (
    <div className="space-y-4">
      {bookId && (
        <Card>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <BookOpen size={18} className="text-muted" />
            <div className="min-w-0 flex-1">
              {detailQuery.isLoading ? (
                <span className="inline-flex items-center gap-2 text-sm text-muted">
                  <Loader2 className="animate-spin" size={14} /> {t("Loading")}
                </span>
              ) : (
                <>
                  <p className="truncate text-sm font-semibold">{detail?.book.title}</p>
                  <p className="truncate text-xs text-muted">
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

            {counts && counts.total > 0 && (
              <div className="w-40">
                <Progress value={percent} />
                <p className="mt-1 text-right text-xs tabular-nums text-muted">
                  {t("Book Complete Of", { complete: counts.complete, total: counts.total })}
                </p>
              </div>
            )}

            {detail && (
              <Badge
                tone={
                  detail.progress.state === "complete"
                    ? "success"
                    : detail.progress.state === "failed"
                      ? "danger"
                      : renderingActive
                        ? "accent"
                        : "muted"
                }
              >
                {t(`Book State ${renderingActive ? "rendering" : detail.progress.state}`)}
              </Badge>
            )}

            <Button size="sm" onClick={() => open(null)}>
              <Library size={14} /> {t("Book Library")}
            </Button>
          </div>
        </Card>
      )}

      {bookId && detailQuery.isError && (
        <Alert tone="danger">{errorText(detailQuery.error, t)}</Alert>
      )}

      <Tabs value={step} onValueChange={(value) => setStep(value as Step)}>
        <TabsList>
          <TabTrigger value="import">{t("Book Step Import")}</TabTrigger>
          {bookId && <TabTrigger value="review">{t("Book Step Review")}</TabTrigger>}
          {bookId && <TabTrigger value="segments">{t("Book Step Segments")}</TabTrigger>}
          {bookId && <TabTrigger value="render">{t("Book Step Render")}</TabTrigger>}
        </TabsList>

        <TabContent value="import">
          <ImportPanel bookId={bookId} detail={detail} onOpen={open} onReview={review} />
        </TabContent>

        {bookId && (
          <>
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
          </>
        )}
      </Tabs>
    </div>
  );
}
