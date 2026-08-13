/**
 * Task history table with status filtering and per-task actions.
 * Mirrors the Streamlit task-manager panel.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, Play, RotateCcw, Trash2, XCircle } from "lucide-react";
import { api, type Task } from "../api/client.ts";
import { useI18n } from "../i18n/index.tsx";
import { Badge, Button, Card, Dialog, Progress, Select } from "./ui.tsx";

const TASK_STATE_FAILED = -1;
const TASK_STATE_COMPLETE = 1;
const TASK_STATE_PROCESSING = 4;

type StatusFilter = "all" | "complete" | "failed" | "processing";

function statusOf(task: Task): StatusFilter {
  if (task.state === TASK_STATE_PROCESSING) return "processing";
  if (task.state === TASK_STATE_FAILED) return "failed";
  if (task.state === TASK_STATE_COMPLETE) return "complete";
  return "all";
}

function formatTime(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function truncate(value: string, max = 40): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function TaskManager({ onRestoreParams }: { onRestoreParams?: (params: Record<string, unknown>) => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [preview, setPreview] = useState<Task | null>(null);

  const tasksQuery = useQuery({
    queryKey: ["tasks"],
    queryFn: () => api.listTasks(1, 50),
    // Any task still running needs the list to keep moving.
    refetchInterval: (query) =>
      query.state.data?.tasks.some((task) => task.state === TASK_STATE_PROCESSING) ? 3000 : false,
  });

  const remove = useMutation({
    mutationFn: (taskId: string) => api.deleteTask(taskId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tasks"] }),
  });

  const cancel = useMutation({
    mutationFn: (taskId: string) => api.cancelTask(taskId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tasks"] }),
  });

  const tasks = tasksQuery.data?.tasks ?? [];
  const filtered = useMemo(
    () => (filter === "all" ? tasks : tasks.filter((task) => statusOf(task) === filter)),
    [tasks, filter],
  );

  const processingCount = tasks.filter((task) => task.state === TASK_STATE_PROCESSING).length;

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          {t("Task Manager")}
          {processingCount > 0 && <Badge tone="accent">{processingCount} {t("Task Status Processing")}</Badge>}
        </span>
      }
      action={
        <div className="w-44">
          <Select
            value={filter}
            onValueChange={(value) => setFilter(value as StatusFilter)}
            options={[
              { value: "all", label: t("All Tasks") },
              { value: "complete", label: t("Task Status Complete") },
              { value: "failed", label: t("Task Status Failed") },
              { value: "processing", label: t("Task Status Processing") },
            ]}
          />
        </div>
      }
    >
      {tasksQuery.isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted">
          <Loader2 className="animate-spin" size={16} /> {t("Loading")}
        </div>
      ) : filtered.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">
          {tasks.length === 0 ? t("No Tasks Yet") : t("No Tasks Match Filter")}
        </p>
      ) : (
        <div className="scroll-x">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="pb-2 pr-3 font-medium">{t("Task Status")}</th>
                <th className="pb-2 pr-3 font-medium">{t("Task Updated At")}</th>
                <th className="pb-2 pr-3 font-medium">{t("Task Subject")}</th>
                <th className="pb-2 pr-3 font-medium">{t("Task Progress")}</th>
                <th className="pb-2 font-medium">{t("Task Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((task) => {
                const status = statusOf(task);
                const subject = String(task.params?.video_subject ?? task.script ?? task.task_id);
                const video = task.videos?.[0];

                return (
                  <tr key={task.task_id} className="border-b border-border/60 last:border-0">
                    <td className="py-2.5 pr-3 align-middle">
                      <Badge
                        tone={
                          status === "complete" ? "success" : status === "failed" ? "danger" : "accent"
                        }
                      >
                        {status === "complete"
                          ? t("Task Status Complete")
                          : status === "failed"
                            ? t("Task Status Failed")
                            : t("Task Status Processing")}
                      </Badge>
                    </td>
                    <td className="py-2.5 pr-3 align-middle whitespace-nowrap text-xs text-muted">
                      {formatTime(task.updated_at)}
                    </td>
                    <td className="py-2.5 pr-3 align-middle" title={subject}>
                      {truncate(subject)}
                      {task.error && <div className="text-xs text-danger">{truncate(task.error, 60)}</div>}
                    </td>
                    <td className="w-28 py-2.5 pr-3 align-middle">
                      <Progress value={task.progress} />
                      <span className="text-xs tabular-nums text-muted">{task.progress}%</span>
                    </td>
                    <td className="py-2.5 align-middle">
                      <div className="flex items-center gap-1">
                        {video && (
                          <>
                            <Button variant="ghost" size="sm" title={t("Play")} onClick={() => setPreview(task)}>
                              <Play size={14} />
                            </Button>
                            <a href={video} download className="inline-flex">
                              <Button variant="ghost" size="sm" title={t("Download")}>
                                <Download size={14} />
                              </Button>
                            </a>
                          </>
                        )}
                        {task.params && onRestoreParams && (
                          <Button
                            variant="ghost"
                            size="sm"
                            title={t("Restore Parameters")}
                            onClick={() => onRestoreParams(task.params!)}
                          >
                            <RotateCcw size={14} />
                          </Button>
                        )}
                        {status === "processing" ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            title={t("Cancel")}
                            onClick={() => cancel.mutate(task.task_id)}
                          >
                            <XCircle size={14} />
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            title={t("Delete")}
                            onClick={() => remove.mutate(task.task_id)}
                          >
                            <Trash2 size={14} className="text-danger" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {remove.isError && <p className="mt-2 text-xs text-danger">{(remove.error as Error).message}</p>}

      {preview && (
        <Dialog
          open
          onOpenChange={(open) => !open && setPreview(null)}
          title={String(preview.params?.video_subject ?? preview.task_id)}
        >
          <div className="space-y-3">
            {preview.videos?.map((video) => (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video key={video} src={video} controls className="max-h-[60vh] w-full rounded-lg bg-black" />
            ))}
            {preview.subtitle_path && (
              <a
                href={`/tasks/${preview.task_id}/subtitle.srt`}
                download
                className="inline-block text-xs text-accent hover:underline"
              >
                {t("Download")} subtitle.srt
              </a>
            )}
          </div>
        </Dialog>
      )}
    </Card>
  );
}
