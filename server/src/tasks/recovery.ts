/**
 * Startup reconciliation for work that cannot survive a restart.
 *
 * Generation and cross-posting run in-process. After a crash or restart their
 * records would otherwise sit in `processing`/`pending` forever, which also
 * blocks deletion because busy tasks are protected. This sweep fails exactly
 * those records whose owning process is provably gone, leaving already-produced
 * videos in place.
 *
 * Ported from `recover_interrupted_cross_posts` in
 * python-version/app/services/task.py, widened to cover generation too.
 */

import { tasksCollection } from "../db/client.ts";
import {
  CROSS_POST_STATE_FAILED,
  CROSS_POST_STATE_PENDING,
  CROSS_POST_STATE_PROCESSING,
  TASK_STATE_FAILED,
  TASK_STATE_PROCESSING,
} from "../models/const.ts";
import { logger } from "../utils/logger.ts";
import { isOwnerAlive } from "./owner.ts";

const INTERRUPTED_GENERATION_ERROR = "generation was interrupted before the process completed";
const INTERRUPTED_CROSS_POST_ERROR = "cross-posting was interrupted before the process completed";

export interface RecoveryResult {
  generation: number;
  crossPost: number;
}

export async function recoverInterruptedTasks(): Promise<RecoveryResult> {
  const collection = tasksCollection();
  const result: RecoveryResult = { generation: 0, crossPost: 0 };

  const candidates = await collection
    .find(
      {
        $or: [
          { state: TASK_STATE_PROCESSING },
          { cross_post_state: { $in: [CROSS_POST_STATE_PENDING, CROSS_POST_STATE_PROCESSING] } },
        ],
      },
      { projection: { _id: 1, state: 1, owner_id: 1, cross_post_state: 1, cross_post_owner: 1 } },
    )
    .toArray();

  for (const task of candidates) {
    const now = new Date();

    if (task.state === TASK_STATE_PROCESSING && !isOwnerAlive(task.owner_id)) {
      await collection.updateOne(
        { _id: task._id },
        {
          $set: {
            state: TASK_STATE_FAILED,
            failed_stage: "pipeline",
            error: INTERRUPTED_GENERATION_ERROR,
            owner_id: null,
            updated_at: now,
          },
        },
      );
      result.generation += 1;
    }

    const crossPostActive =
      task.cross_post_state === CROSS_POST_STATE_PENDING ||
      task.cross_post_state === CROSS_POST_STATE_PROCESSING;

    if (crossPostActive && !isOwnerAlive(task.cross_post_owner)) {
      await collection.updateOne(
        { _id: task._id },
        {
          $set: {
            cross_post_state: CROSS_POST_STATE_FAILED,
            cross_post_error: INTERRUPTED_CROSS_POST_ERROR,
            cross_post_owner: null,
            updated_at: now,
          },
        },
      );
      result.crossPost += 1;
    }
  }

  if (result.generation || result.crossPost) {
    logger.warning(
      `recovered interrupted tasks: generation=${result.generation}, cross_post=${result.crossPost}`,
    );
  }

  return result;
}
