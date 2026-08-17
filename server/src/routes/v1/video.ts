/**
 * Video task API.
 * Ported from python-version/app/controllers/v1/video.py.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { rm } from "node:fs/promises";
import { relative, join } from "node:path";
import { appConfig, resolveVoiceName } from "../../config/settings.ts";
import { badRequest, conflict, notFound, tooManyRequests } from "../../http/errors.ts";
import { serveTaskFile } from "../../http/staticFiles.ts";
import {
  audioRequestSchema,
  subtitleRequestSchema,
  videoParamsSchema,
  type VideoParams,
} from "../../models/schema.ts";
import type { StopAt } from "../../models/const.ts";
import { isTaskBusy, runPipeline } from "../../tasks/pipeline.ts";
import { TaskQueueFullError, taskQueue } from "../../tasks/queue.ts";
import { createTask, deleteTask, getAllTasks, getTask } from "../../tasks/state.ts";
import { resolvePathWithinDirectory } from "../../utils/fileSecurity.ts";
import { logger, errorMessage } from "../../utils/logger.ts";
import { getResponse, getUuid, sleep } from "../../utils/misc.ts";
import { taskDir } from "../../utils/paths.ts";
import type { TaskDocument } from "../../db/types.ts";

export const videoRouter = new Hono();

/**
 * Turns a stored absolute path into a link the browser can fetch.
 *
 * Task state should only ever hold paths inside the task directory; anything
 * else is left untouched rather than wrapped into a reachable URL, so stale or
 * malformed records cannot become an accidental file-read endpoint.
 */
function taskFileToUri(file: string, endpoint: string, tasksDir: string): string {
  if (typeof file !== "string") return file;
  if (file.startsWith("http://") || file.startsWith("https://")) return file;

  let resolved: string;
  try {
    resolved = resolvePathWithinDirectory(tasksDir, file);
  } catch (error) {
    logger.warning(`skip unsafe task output path, path: ${file}, error: ${errorMessage(error)}`);
    return file;
  }

  const uriPath = `tasks/${relative(tasksDir, resolved).replace(/\\/g, "/")}`;
  return endpoint ? `${endpoint.replace(/\/+$/, "")}/${uriPath}` : `/${uriPath}`;
}

/** Strips fields that exist only for server-side coordination. */
function publicTask(task: TaskDocument): Record<string, unknown> {
  const { cross_post_owner: _owner, owner_id: _ownerId, ...rest } = task;
  return rest;
}

function withMediaUris(task: TaskDocument): Record<string, unknown> {
  const endpoint = String(appConfig().endpoint ?? "").replace(/\/+$/, "");
  const tasksDir = taskDir();
  const result = publicTask(task);

  if (Array.isArray(task.videos)) {
    result.videos = task.videos.map((file) => taskFileToUri(file, endpoint, tasksDir));
  }
  if (Array.isArray(task.combined_videos)) {
    result.combined_videos = task.combined_videos.map((file) => taskFileToUri(file, endpoint, tasksDir));
  }
  return result;
}

/** Accepts a task and hands it to the queue. */
async function createGenerationTask(params: VideoParams, stopAt: StopAt, requestId: string) {
  const taskId = getUuid();
  const resolved: VideoParams = { ...params, voice_name: resolveVoiceName(params.voice_name) };

  await createTask(taskId, { params: resolved, stop_at: stopAt, request_id: requestId, progress: 0 });

  try {
    taskQueue.add(taskId, (signal) => runPipeline({ taskId, params: resolved, stopAt, signal }));
  } catch (error) {
    await deleteTask(taskId);
    if (error instanceof TaskQueueFullError) {
      logger.warning(`reject task because queue is full, request_id: ${requestId}, task_id: ${taskId}`);
      throw tooManyRequests(error.message, taskId);
    }
    throw badRequest(errorMessage(error), taskId);
  }

  logger.success(`Task created: ${taskId}`);
  return { task_id: taskId };
}

videoRouter.post("/videos", async (c) => {
  const body = videoParamsSchema.parse(await c.req.json());
  const data = await createGenerationTask(body, "video", c.req.header("x-request-id") ?? "");
  return c.json(getResponse(200, data));
});

videoRouter.post("/subtitle", async (c) => {
  const parsed = subtitleRequestSchema.parse(await c.req.json());
  const body = videoParamsSchema.parse(parsed);
  const data = await createGenerationTask(body, "subtitle", c.req.header("x-request-id") ?? "");
  return c.json(getResponse(200, data));
});

videoRouter.post("/audio", async (c) => {
  const parsed = audioRequestSchema.parse(await c.req.json());
  const body = videoParamsSchema.parse(parsed);
  const data = await createGenerationTask(body, "audio", c.req.header("x-request-id") ?? "");
  return c.json(getResponse(200, data));
});

videoRouter.get("/tasks", async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const pageSize = Math.max(1, Math.min(100, Number(c.req.query("page_size") ?? 10)));

  const { tasks, total } = await getAllTasks(page, pageSize);
  return c.json(
    getResponse(200, {
      tasks: tasks.map((task) => withMediaUris(task)),
      total,
      page,
      page_size: pageSize,
    }),
  );
});

videoRouter.get("/tasks/:taskId", async (c) => {
  const taskId = c.req.param("taskId");
  const task = await getTask(taskId);
  if (!task) throw notFound("task not found", taskId);
  return c.json(getResponse(200, withMediaUris(task)));
});

/**
 * Live progress over SSE.
 *
 * The Streamlit UI polled for this; streaming keeps the browser current without
 * a request per second per open task.
 */
videoRouter.get("/tasks/:taskId/events", async (c) => {
  const taskId = c.req.param("taskId");

  return streamSSE(c, async (stream) => {
    let lastPayload = "";
    let lastLogCount = 0;

    while (!stream.closed) {
      const task = await getTask(taskId);
      if (!task) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: "task not found" }) });
        return;
      }

      const logs = task.logs ?? [];
      if (logs.length > lastLogCount) {
        await stream.writeSSE({ event: "logs", data: JSON.stringify(logs.slice(lastLogCount)) });
        lastLogCount = logs.length;
      }

      // Only emit when something actually changed, so an idle task costs
      // nothing on the wire.
      const payload = JSON.stringify(withMediaUris(task));
      if (payload !== lastPayload) {
        await stream.writeSSE({ event: "task", data: payload });
        lastPayload = payload;
      }

      if (task.state !== 4) {
        await stream.writeSSE({ event: "done", data: payload });
        return;
      }

      await sleep(1000);
    }
  });
});

videoRouter.delete("/tasks/:taskId", async (c) => {
  const taskId = c.req.param("taskId");
  const task = await getTask(taskId);
  if (!task) throw notFound("task not found", taskId);

  // Generation and publishing both keep reading the task directory, so a busy
  // task cannot be deleted from any entry point.
  if (isTaskBusy(task) || taskQueue.isActive(taskId)) {
    logger.warning(
      `refuse to delete busy task, task_id: ${taskId}, state: ${task.state}, cross_post_state: ${task.cross_post_state}`,
    );
    throw conflict("task is still running", taskId);
  }

  await rm(join(taskDir(), taskId), { recursive: true, force: true });
  await deleteTask(taskId);
  logger.success(`video deleted: ${taskId}`);
  return c.json(getResponse(200));
});

/** Cancels a running task without deleting its record. */
videoRouter.post("/tasks/:taskId/cancel", async (c) => {
  const taskId = c.req.param("taskId");
  const cancelled = taskQueue.cancel(taskId);
  if (!cancelled) throw notFound("task is not running", taskId);
  return c.json(getResponse(200, { task_id: taskId, cancelled: true }));
});

videoRouter.get("/stream/*", (c) => {
  const path = c.req.path.replace(/^\/api\/v1\/stream\/?/, "");
  return serveTaskFile(c, path);
});

videoRouter.get("/download/*", (c) => {
  const path = c.req.path.replace(/^\/api\/v1\/download\/?/, "");
  return serveTaskFile(c, path, true);
});

/** Queue depth, so the UI can explain why a task is waiting. */
videoRouter.get("/queue", (c) => c.json(getResponse(200, taskQueue.stats())));
