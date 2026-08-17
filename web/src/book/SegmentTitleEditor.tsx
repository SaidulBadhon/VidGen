/**
 * Inline rename for one planned segment.
 *
 * Click the title or the pencil beside it. Enter saves, Escape cancels.
 * Locked while that segment is rendering because its output folder is named
 * after this title.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Pencil, X } from "lucide-react";
import { useI18n } from "../i18n/index.tsx";
import { Alert, Button, TextInput } from "../components/ui.tsx";
import { bookApi, errorText, isRenderConflict, type BookDetail } from "./api.ts";

export function SegmentTitleEditor({
  bookId,
  index,
  title,
  locked,
}: {
  bookId: string;
  index: number;
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
    mutationFn: (next: string) => bookApi.renameSegment(bookId, index, next),
    onSuccess: (result) => {
      setEditing(false);
      queryClient.setQueryData(["book", bookId], (current: BookDetail | undefined) => {
        if (!current) return current;
        return {
          ...current,
          segments: current.segments.map((segment) =>
            segment.index === result.index ? { ...segment, title: result.title } : segment,
          ),
        };
      });
      queryClient.invalidateQueries({ queryKey: ["book", bookId] });
    },
  });

  const trimmed = draft.trim();
  const label = title || t("Book Untitled Segment");

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

  const startEdit = () => {
    setDraft(title);
    setEditing(true);
  };

  if (editing) {
    return (
      <form
        className="space-y-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div className="flex items-center gap-1">
          <TextInput
            ref={inputRef}
            value={draft}
            disabled={rename.isPending}
            maxLength={300}
            autoComplete="off"
            aria-label={t("Book Segment Title")}
            placeholder={t("Book Rename Segment Placeholder")}
            className="h-8 min-w-0 flex-1"
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
    <div className="flex min-w-0 items-start gap-1">
      <button
        type="button"
        disabled={locked}
        className="line-clamp-2 min-w-0 text-left disabled:cursor-not-allowed"
        title={locked ? t("Book Rename Segment Locked") : t("Book Rename Segment")}
        onClick={startEdit}
      >
        {label}
      </button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="shrink-0"
        disabled={locked}
        title={locked ? t("Book Rename Segment Locked") : t("Book Rename Segment")}
        aria-label={locked ? t("Book Rename Segment Locked") : t("Book Rename Segment")}
        onClick={startEdit}
      >
        <Pencil size={14} />
      </Button>
    </div>
  );
}
