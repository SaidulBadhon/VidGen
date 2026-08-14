/**
 * Step 2: review every decision the filter made.
 *
 * This screen exists so nothing is deleted silently. Dropped blocks are shown,
 * struck through rather than hidden, each with the reason and rule that removed
 * it and how confident that rule was, and one keyboard-reachable button flips
 * any of them back. A reviewer's own overrides are marked so a second pass can
 * tell "the machine decided this" from "I decided this".
 */

import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Eye, EyeOff, Loader2, RotateCcw } from "lucide-react";
import { useI18n } from "../i18n/index.tsx";
import { Alert, Badge, Button, Card, Select, Switch, cn } from "../components/ui.tsx";
import {
  blockKindLabel,
  bookApi,
  errorText,
  isRenderConflict,
  ruleLabel,
  type BookBlock,
  type BookBlockPage,
  type BookDetail,
} from "./api.ts";

type BlockFilter = "all" | "dropped" | "kept" | "overridden";

const PAGE_SIZES = [25, 50, 100, 200];

/** Radix Select renders an empty value as a blank trigger, so "no filter" needs a name. */
const ALL_CHAPTERS = "__all__";

/** Long enough that the row would dominate the list before it is worth clamping. */
const CLAMP_CHARS = 320;

function confidenceTone(confidence: number): "muted" | "warning" | "danger" {
  if (confidence >= 0.9) return "muted";
  if (confidence >= 0.7) return "warning";
  return "danger";
}

export function ReviewPanel({
  bookId,
  detail,
  renderingActive,
}: {
  bookId: string;
  detail?: BookDetail;
  renderingActive: boolean;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [filter, setFilter] = useState<BlockFilter>("all");
  const [chapterId, setChapterId] = useState(ALL_CHAPTERS);
  const [ruleFilter, setRuleFilter] = useState<string | null>(null);
  const [lowConfidenceFirst, setLowConfidenceFirst] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [chapters, setChapters] = useState<{ id: string; title: string }[]>([]);

  const blocksKey = useMemo(() => ["book-blocks", bookId, page, pageSize] as const, [bookId, page, pageSize]);

  const blocks = useQuery({
    queryKey: blocksKey,
    queryFn: () => bookApi.blocks(bookId, page, pageSize),
    placeholderData: keepPreviousData,
  });

  // A book has no chapter index endpoint, so the list is built from the pages
  // that have actually been looked at rather than by walking the whole book.
  useEffect(() => {
    setChapters([]);
    setPage(1);
    setChapterId(ALL_CHAPTERS);
    setRuleFilter(null);
    setExpanded({});
  }, [bookId]);

  const loaded = blocks.data?.blocks;
  useEffect(() => {
    if (!loaded) return;
    setChapters((current) => {
      const seen = new Map(current.map((chapter) => [chapter.id, chapter]));
      let added = false;
      for (const block of loaded) {
        if (!block.chapter_id || seen.has(block.chapter_id)) continue;
        seen.set(block.chapter_id, { id: block.chapter_id, title: block.chapter_title || block.chapter_id });
        added = true;
      }
      return added ? [...seen.values()] : current;
    });
  }, [loaded]);

  const toggle = useMutation({
    mutationFn: (variables: { blockId: string; keep: boolean }) =>
      bookApi.setDecision(bookId, variables.blockId, variables.keep),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: blocksKey });
      const previousBlocks = queryClient.getQueryData<BookBlockPage>(blocksKey);
      const previousBook = queryClient.getQueryData<BookDetail>(["book", bookId]);
      const previous = previousBlocks?.blocks.find((block) => block.id === variables.blockId);

      queryClient.setQueryData<BookBlockPage>(blocksKey, (current) =>
        current
          ? {
              ...current,
              blocks: current.blocks.map((block) =>
                block.id === variables.blockId
                  ? {
                      ...block,
                      keep: variables.keep,
                      source: "user" as const,
                      rule: "user_override",
                      confidence: 1,
                      reason: t(variables.keep ? "Book Override Reason Kept" : "Book Override Reason Dropped"),
                    }
                  : block,
              ),
            }
          : current,
      );
      queryClient.setQueryData<BookDetail>(["book", bookId], (current) => {
        if (!current) return current;
        const delta = variables.keep === previous?.keep ? 0 : variables.keep ? 1 : -1;
        const kept = Math.max(0, current.book.kept_block_count + delta);
        return {
          ...current,
          book: { ...current.book, kept_block_count: kept },
          decisions: {
            ...current.decisions,
            kept,
            dropped: Math.max(0, current.decisions.total - kept),
          },
          overrides: previous?.source === "user" ? current.overrides : current.overrides + 1,
        };
      });

      return { previousBlocks, previousBook };
    },
    onError: (_error, _variables, context) => {
      if (context?.previousBlocks) queryClient.setQueryData(blocksKey, context.previousBlocks);
      if (context?.previousBook) queryClient.setQueryData(["book", bookId], context.previousBook);
    },
    onSuccess: (result) => {
      queryClient.setQueryData<BookBlockPage>(blocksKey, (current) =>
        current
          ? {
              ...current,
              blocks: current.blocks.map((block) =>
                block.id === result.block_id
                  ? {
                      ...block,
                      keep: result.keep,
                      source: "user" as const,
                      rule: "user_override",
                      confidence: 1,
                      reason: t(result.keep ? "Book Override Reason Kept" : "Book Override Reason Dropped"),
                    }
                  : block,
              ),
            }
          : current,
      );
      queryClient.setQueryData<BookDetail>(["book", bookId], (current) =>
        current
          ? {
              ...current,
              book: {
                ...current.book,
                kept_block_count: result.kept_block_count,
                revision: result.revision,
              },
              decisions: {
                ...current.decisions,
                kept: result.kept_block_count,
                dropped: Math.max(0, current.decisions.total - result.kept_block_count),
              },
            }
          : current,
      );
      queryClient.invalidateQueries({ queryKey: ["book", bookId] });
    },
  });

  const total = blocks.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const rows = blocks.data?.blocks ?? [];

  const visible = useMemo(() => {
    let result = rows.filter((block) => {
      if (chapterId !== ALL_CHAPTERS && block.chapter_id !== chapterId) return false;
      if (ruleFilter && block.rule !== ruleFilter) return false;
      if (filter === "dropped") return !block.keep;
      if (filter === "kept") return block.keep;
      if (filter === "overridden") return block.source === "user";
      return true;
    });
    if (lowConfidenceFirst) {
      result = [...result].sort((a, b) => a.confidence - b.confidence || a.order - b.order);
    }
    return result;
  }, [rows, chapterId, ruleFilter, filter, lowConfidenceFirst]);

  const droppedRules = (detail?.decisions.rules ?? []).filter((rule) => rule.dropped > 0);
  const conflict = toggle.isError && isRenderConflict(toggle.error);
  const disabled = renderingActive;

  return (
    <div className="space-y-4">
      <Card title={t("Book Review Title")}>
        <div className="space-y-3">
          <p className="text-sm text-muted">{t("Book Review Intro")}</p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Summary
              tone="success"
              label={t("Book Kept")}
              value={detail?.decisions.kept ?? detail?.book.kept_block_count ?? 0}
            />
            <Summary tone="warning" label={t("Book Dropped")} value={detail?.decisions.dropped ?? 0} />
            <Summary tone="accent" label={t("Book Your Overrides")} value={detail?.overrides ?? 0} />
            <Summary tone="muted" label={t("Book Blocks")} value={detail?.book.block_count ?? total} />
          </div>

          {droppedRules.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted">{t("Book Filter By Rule")}</p>
              <div className="flex flex-wrap gap-1.5">
                {droppedRules.map((rule) => {
                  const active = ruleFilter === rule.rule;
                  return (
                    <button
                      key={rule.rule}
                      type="button"
                      aria-pressed={active}
                      title={rule.reason}
                      onClick={() => setRuleFilter(active ? null : rule.rule)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition outline-none",
                        "focus-visible:ring-2 focus-visible:ring-accent/40",
                        active
                          ? "border-accent bg-accent/15 text-accent"
                          : "border-border bg-surface-2 text-muted hover:bg-border",
                      )}
                    >
                      {ruleLabel(rule.rule, t)}
                      <span className="tabular-nums opacity-70">{rule.dropped}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {renderingActive && <Alert tone="warning">{t("Book Review Locked")}</Alert>}
          {toggle.isError && (
            <Alert tone={conflict ? "warning" : "danger"}>{errorText(toggle.error, t)}</Alert>
          )}
        </div>
      </Card>

      <Card
        title={t("Book Blocks")}
        action={
          <div className="flex items-center gap-2">
            {blocks.isFetching && <Loader2 className="animate-spin text-muted" size={14} />}
            <span className="text-xs text-muted">
              {t("Book Showing On Page", { shown: visible.length, size: rows.length })}
            </span>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Select
              value={filter}
              onValueChange={(value) => setFilter(value as BlockFilter)}
              options={[
                { value: "all", label: t("Book Filter All") },
                { value: "dropped", label: t("Book Filter Dropped") },
                { value: "kept", label: t("Book Filter Kept") },
                { value: "overridden", label: t("Book Filter Overridden") },
              ]}
            />
            <Select
              value={chapterId}
              onValueChange={setChapterId}
              options={[
                { value: ALL_CHAPTERS, label: t("Book All Chapters") },
                ...chapters.map((chapter) => ({ value: chapter.id, label: chapter.title })),
              ]}
            />
            <Select
              value={String(pageSize)}
              onValueChange={(value) => {
                setPageSize(Number(value));
                setPage(1);
              }}
              options={PAGE_SIZES.map((size) => ({ value: String(size), label: t("Book Per Page", { size }) }))}
            />
            <div className="flex items-center">
              <Switch
                checked={lowConfidenceFirst}
                onCheckedChange={setLowConfidenceFirst}
                label={t("Book Low Confidence First")}
              />
            </div>
          </div>

          {blocks.isLoading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted">
              <Loader2 className="animate-spin" size={16} /> {t("Loading")}
            </div>
          ) : blocks.isError ? (
            <Alert tone="danger">{errorText(blocks.error, t)}</Alert>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted">{t("Book No Blocks")}</p>
          ) : visible.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted">{t("Book No Blocks Match")}</p>
          ) : (
            <ul className="space-y-2">
              {visible.map((block) => (
                <BlockRow
                  key={block.id}
                  block={block}
                  disabled={disabled}
                  pending={toggle.isPending && toggle.variables?.blockId === block.id}
                  expanded={Boolean(expanded[block.id])}
                  onExpand={() =>
                    setExpanded((current) => ({ ...current, [block.id]: !current[block.id] }))
                  }
                  onToggle={() => toggle.mutate({ blockId: block.id, keep: !block.keep })}
                />
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <span className="text-xs text-muted">{t("Book Page Of", { page, pages: pageCount })}</span>
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
                <ChevronLeft size={14} /> {t("Book Previous")}
              </Button>
              <Button
                size="sm"
                disabled={page >= pageCount}
                onClick={() => setPage((current) => current + 1)}
              >
                {t("Book Next")} <ChevronRight size={14} />
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function BlockRow({
  block,
  disabled,
  pending,
  expanded,
  onExpand,
  onToggle,
}: {
  block: BookBlock;
  disabled: boolean;
  pending: boolean;
  expanded: boolean;
  onExpand: () => void;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const overridden = block.source === "user";
  const clamped = block.text.length > CLAMP_CHARS && !expanded;
  const text = clamped ? `${block.text.slice(0, CLAMP_CHARS)}…` : block.text;

  return (
    <li
      className={cn(
        "rounded-lg border p-3",
        overridden ? "border-accent/60 bg-accent/5" : "border-border bg-surface-2",
        !block.keep && "border-dashed",
      )}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          aria-pressed={block.keep}
          disabled={disabled || pending}
          onClick={onToggle}
          title={block.keep ? t("Book Drop This Block") : t("Book Keep This Block")}
          className={cn(
            "inline-flex w-24 shrink-0 items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs",
            "transition outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
            "disabled:cursor-not-allowed disabled:opacity-50",
            block.keep
              ? "border-success/40 bg-success/10 text-success hover:bg-success/20"
              : "border-warning/40 bg-warning/10 text-warning hover:bg-warning/20",
          )}
        >
          {pending ? (
            <Loader2 className="animate-spin" size={13} />
          ) : block.keep ? (
            <Eye size={13} />
          ) : (
            <EyeOff size={13} />
          )}
          {block.keep ? t("Book Kept") : t("Book Dropped")}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <span className="tabular-nums">#{block.order}</span>
            <Badge>
              {blockKindLabel(block.kind, t)}
              {block.level ? ` ${block.level}` : ""}
            </Badge>
            {block.chapter_title && <span className="truncate">{block.chapter_title}</span>}
            {overridden && (
              <Badge tone="accent">
                <RotateCcw size={11} className="mr-1 inline" />
                {t("Book Your Override")}
              </Badge>
            )}
          </div>

          <p
            className={cn(
              "mt-1.5 text-sm whitespace-pre-wrap",
              !block.keep && "line-through decoration-1 opacity-60",
            )}
          >
            {text}
          </p>

          {block.text.length > CLAMP_CHARS && (
            <Button variant="ghost" size="sm" className="mt-1 px-0" onClick={onExpand}>
              {expanded ? t("Book Show Less") : t("Book Show More")}
            </Button>
          )}

          {!block.keep && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge tone={overridden ? "accent" : "muted"}>{ruleLabel(block.rule, t)}</Badge>
              {!overridden && (
                <Badge tone={confidenceTone(block.confidence)}>
                  {t("Book Confidence", { percent: Math.round(block.confidence * 100) })}
                </Badge>
              )}
              {block.reason && <span className="text-xs text-muted">{block.reason}</span>}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function Summary({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "success" | "warning" | "accent" | "muted";
}) {
  const tones = {
    success: "border-success/40 bg-success/10 text-success",
    warning: "border-warning/40 bg-warning/10 text-warning",
    accent: "border-accent/40 bg-accent/10 text-accent",
    muted: "border-border bg-surface-2 text-muted",
  };
  return (
    <div className={cn("rounded-lg border px-3 py-2", tones[tone])}>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-xs opacity-80">{label}</p>
    </div>
  );
}
