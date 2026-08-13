/**
 * Background cross-posting of finished videos.
 * Ported from the cross-post half of python-version/app/services/task.py.
 *
 * Publishing runs after the task is already marked complete: an upload can take
 * minutes and must never delay the generated video, nor can a publishing
 * failure invalidate a video that rendered correctly.
 */

import { appConfig } from "../config/settings.ts";
import {
  CROSS_POST_STATE_COMPLETE,
  CROSS_POST_STATE_FAILED,
  CROSS_POST_STATE_PROCESSING,
} from "../models/const.ts";
import { logger, errorMessage } from "../utils/logger.ts";
import { sleep } from "../utils/misc.ts";
import * as llm from "../services/llm/index.ts";
import * as uploadPost from "../services/uploadPost.ts";
import type { CrossPostResult } from "../db/types.ts";
import { BoundedPool } from "./queue.ts";
import { PROCESS_OWNER_ID } from "./owner.ts";
import { patchTask } from "./state.ts";

const STATE_WRITE_ATTEMPTS = 3;
const STATE_RETRY_DELAY_MS = 100;

const pool = new BoundedPool(2, () => Math.max(1, Number(appConfig().upload_post_max_pending_tasks) || 10));

/**
 * Writes cross-post fields with limited retries.
 *
 * A brief database outage must not strand a task in `pending` forever. These
 * writes are rare, so a few short retries cover transient failures without
 * blocking the worker indefinitely.
 */
async function patchCrossPostState(
  taskId: string,
  fields: Parameters<typeof patchTask>[1],
): Promise<boolean | null> {
  for (let attempt = 1; attempt <= STATE_WRITE_ATTEMPTS; attempt++) {
    try {
      return await patchTask(taskId, fields);
    } catch (error) {
      if (attempt >= STATE_WRITE_ATTEMPTS) {
        logger.exception(
          `failed to update cross-post state after retries, task_id: ${taskId}, ` +
            `fields: ${Object.keys(fields).join(", ")}`,
          error,
        );
        return null;
      }
      logger.warning(
        `retry cross-post state update, task_id: ${taskId}, attempt: ${attempt}, error: ${errorMessage(error)}`,
      );
      await sleep(STATE_RETRY_DELAY_MS);
    }
  }
  return null;
}

async function recordFailure(taskId: string, error: unknown, results?: CrossPostResult[]): Promise<void> {
  const updated = await patchCrossPostState(taskId, {
    cross_post_state: CROSS_POST_STATE_FAILED,
    cross_post_results: results && results.length > 0 ? results : null,
    cross_post_error: errorMessage(error),
    cross_post_owner: null,
  });
  if (updated === false) logger.warning(`discard cross-post failure for missing task: ${taskId}`);
}

export interface CrossPostJob {
  taskId: string;
  videoPaths: string[];
  videoSubject: string;
  videoScript: string;
  videoLanguage: string;
  platforms: string[];
  youtubePrivacyStatus: string;
}

async function runCrossPost(job: CrossPostJob): Promise<void> {
  const results: CrossPostResult[] = [];

  try {
    const stateUpdated = await patchCrossPostState(job.taskId, {
      cross_post_state: CROSS_POST_STATE_PROCESSING,
      cross_post_error: null,
      cross_post_owner: PROCESS_OWNER_ID,
    });

    if (stateUpdated !== true) {
      // false = the task was deleted, null = the database is unavailable.
      // Neither justifies calling a third-party API the user could no longer
      // observe or control.
      if (stateUpdated === false) {
        logger.warning(`skip cross-post for missing task: ${job.taskId}`);
      } else {
        await recordFailure(job.taskId, new Error("failed to persist cross-post processing state"));
      }
      return;
    }

    logger.info(`cross-post started, task_id: ${job.taskId}, platforms: ${job.platforms.join(", ")}`);

    let youtubeExtra: uploadPost.YoutubeExtra | undefined;
    if (job.platforms.some((platform) => platform.startsWith("youtube"))) {
      const metadata = await llm.generateSocialMetadata({
        videoSubject: job.videoSubject,
        videoScript: job.videoScript,
        language: job.videoLanguage,
        platform: "youtube_shorts",
      });
      youtubeExtra = {
        youtube_title: metadata.title || job.videoSubject,
        youtube_description: metadata.caption,
        tags: metadata.hashtags,
        privacyStatus: job.youtubePrivacyStatus,
        containsSyntheticMedia: true,
      };
    }

    for (const videoPath of job.videoPaths) {
      const result = await uploadPost.uploadVideo({
        videoPath,
        title: job.videoSubject || "Check out this video! #shorts #viral",
        platforms: job.platforms,
        youtubeExtra,
      });
      results.push(result ?? { success: false, error: "Upload-Post returned an invalid response" });
    }

    const failures = results.filter((result) => !result.success);
    const state = failures.length > 0 ? CROSS_POST_STATE_FAILED : CROSS_POST_STATE_COMPLETE;
    const error =
      failures.length > 0
        ? failures.map((result) => String(result.error ?? result.message ?? "unknown upload error")).join("; ")
        : null;

    if (failures.length > 0) {
      logger.warning(
        `cross-post completed with failures, task_id: ${job.taskId}, failed: ${failures.length}, total: ${results.length}`,
      );
    } else {
      logger.success(`cross-post completed, task_id: ${job.taskId}, videos: ${results.length}`);
    }

    const finalUpdate = await patchCrossPostState(job.taskId, {
      cross_post_state: state,
      cross_post_results: results,
      cross_post_error: error,
      cross_post_owner: null,
    });

    if (finalUpdate === false) {
      logger.warning(`discard cross-post result for missing task: ${job.taskId}`);
    } else if (finalUpdate === null) {
      // The upload finished but the outcome was not persisted; leaving the task
      // in `processing` would be worse than recording a definite failure.
      await recordFailure(job.taskId, new Error("failed to persist final cross-post result"), results);
    }
  } catch (error) {
    // A publishing failure must not reach back and invalidate a finished video.
    logger.exception(`cross-post failed, task_id: ${job.taskId}`, error);
    await recordFailure(job.taskId, error, results);
  }
}

/**
 * Queues a publishing job.
 * Returns an error string when scheduling itself failed, otherwise null.
 */
export function scheduleCrossPost(job: CrossPostJob): string | null {
  const accepted = pool.submit(() => runCrossPost(job));
  if (accepted) return null;

  const error = "cross-post queue is full; publishing was skipped";
  logger.warning(`skip cross-post because queue is full, task_id: ${job.taskId}`);
  void patchCrossPostState(job.taskId, {
    cross_post_state: CROSS_POST_STATE_FAILED,
    cross_post_error: error,
    cross_post_owner: null,
  });
  return error;
}
