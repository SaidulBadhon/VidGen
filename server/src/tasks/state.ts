/**
 * Task state, backed by MongoDB.
 * Ported from python-version/app/services/state.py.
 *
 * Replaces both the in-memory and the Redis implementations: Mongo gives
 * durability without the Redis-only serialisation quirks, and `patchTask` gets
 * its atomicity from a conditional update rather than a Lua script.
 */

import { tasksCollection } from "../db/client.ts";
import { TASK_STATE_PROCESSING, type CrossPostState } from "../models/const.ts";
import type { TaskDocument, TaskWarning, CrossPostResult } from "../db/types.ts";
import type { VideoParams } from "../models/schema.ts";
import { logger } from "../utils/logger.ts";

/** Per-task log lines kept for the UI. Older lines are dropped. */
const MAX_TASK_LOG_LINES = 500;

export interface TaskUpdate {
  state?: number;
  progress?: number;
  script?: string;
  terms?: string[];
  audio_file?: string;
  audio_duration?: number;
  subtitle_path?: string;
  materials?: string[];
  videos?: string[];
  combined_videos?: string[];
  failed_stage?: string | null;
  error?: string | null;
  warnings?: TaskWarning[] | null;
  cross_post_state?: CrossPostState | null;
  cross_post_results?: CrossPostResult[] | null;
  cross_post_error?: string | null;
  cross_post_owner?: string | null;
  owner_id?: string | null;
  params?: VideoParams;
  stop_at?: string;
  request_id?: string;
}

/** Creates the record for a newly accepted task. */
export async function createTask(
  taskId: string,
  fields: TaskUpdate & { params?: VideoParams } = {},
): Promise<void> {
  const now = new Date();
  await tasksCollection().insertOne({
    _id: taskId,
    task_id: taskId,
    state: fields.state ?? TASK_STATE_PROCESSING,
    progress: fields.progress ?? 0,
    logs: [],
    created_at: now,
    updated_at: now,
    ...stripUndefined(fields),
  } as TaskDocument);
}

/**
 * Writes task fields, creating the record if it is missing.
 *
 * Progress is clamped so a rounding error in a stage cannot push a task past
 * 100% and confuse the UI.
 */
export async function updateTask(taskId: string, fields: TaskUpdate): Promise<void> {
  const update = stripUndefined(fields);
  if (typeof update.progress === "number") {
    update.progress = Math.min(100, Math.max(0, Math.round(update.progress)));
  }

  await tasksCollection().updateOne(
    { _id: taskId },
    {
      $set: { ...update, task_id: taskId, updated_at: new Date() },
      $setOnInsert: { created_at: new Date(), logs: [] },
    },
    { upsert: true },
  );
}

/**
 * Updates only an existing task, returning false when it is gone.
 *
 * Background cross-posting must never resurrect a task the user deleted while
 * the upload was in flight, which a plain upsert would do.
 */
export async function patchTask(taskId: string, fields: TaskUpdate): Promise<boolean> {
  const update = stripUndefined(fields);
  if (Object.keys(update).length === 0) return false;

  const result = await tasksCollection().updateOne(
    { _id: taskId },
    { $set: { ...update, updated_at: new Date() } },
  );
  return result.matchedCount > 0;
}

export async function getTask(taskId: string): Promise<TaskDocument | null> {
  return tasksCollection().findOne({ _id: taskId });
}

export async function getAllTasks(
  page = 1,
  pageSize = 10,
): Promise<{ tasks: TaskDocument[]; total: number }> {
  const collection = tasksCollection();
  const skip = Math.max(0, (page - 1) * pageSize);

  const [tasks, total] = await Promise.all([
    collection.find({}).sort({ created_at: -1 }).skip(skip).limit(pageSize).toArray(),
    collection.countDocuments({}),
  ]);

  return { tasks, total };
}

export async function deleteTask(taskId: string): Promise<void> {
  await tasksCollection().deleteOne({ _id: taskId });
}

/**
 * Appends a log line for the UI's live log panel.
 *
 * `$slice` caps the array in the same update, so a long-running task cannot
 * grow its document without bound.
 */
export async function appendTaskLog(taskId: string, message: string): Promise<void> {
  try {
    await tasksCollection().updateOne(
      { _id: taskId },
      {
        $push: { logs: { $each: [message], $slice: -MAX_TASK_LOG_LINES } },
        $set: { updated_at: new Date() },
      },
    );
  } catch (error) {
    // Logging must never take down the pipeline it is reporting on.
    logger.debug(`failed to append task log: ${String(error)}`);
  }
}

export async function getTaskLogs(taskId: string): Promise<string[]> {
  const task = await tasksCollection().findOne({ _id: taskId }, { projection: { logs: 1 } });
  return task?.logs ?? [];
}

/**
 * The tail of several tasks' logs in one read.
 *
 * For a book the caller is polling on a timer and wants the last few lines of
 * whatever is running right now, not the 500 each task retains. `$slice` does
 * the trimming inside Mongo, so a book with a dozen active segments costs one
 * query of a few kilobytes per tick rather than a dozen of half a megabyte.
 */
export async function getRecentTaskLogs(
  taskIds: readonly string[],
  linesPerTask: number,
): Promise<Map<string, string[]>> {
  const wanted = [...new Set(taskIds.filter(Boolean))];
  if (wanted.length === 0 || linesPerTask < 1) return new Map();

  const tasks = await tasksCollection()
    .find({ _id: { $in: wanted } }, { projection: { logs: { $slice: -linesPerTask } } })
    .toArray();

  return new Map(tasks.map((task) => [task._id, task.logs ?? []]));
}

/**
 * Drops undefined fields so `$set` never overwrites a stored value with null.
 * Callers pass typed partials, hence the object rather than record parameter.
 */
function stripUndefined(value: object): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result;
}
