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

import { bookSegmentsCollection, tasksCollection } from "../db/client.ts";
import { syncBookState } from "../db/books.ts";
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
const INTERRUPTED_SEGMENT_ERROR = "the segment render was interrupted before the process completed";

export interface RecoveryResult {
  generation: number;
  crossPost: number;
  bookSegments: number;
}

export async function recoverInterruptedTasks(): Promise<RecoveryResult> {
  const collection = tasksCollection();
  const result: RecoveryResult = { generation: 0, crossPost: 0, bookSegments: 0 };

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

  // Runs after the task pass so it can simply read the outcome above: a segment
  // whose task was just failed for a dead owner is failed here in the same
  // sweep, without repeating the liveness check.
  result.bookSegments = await recoverInterruptedBookSegments();

  if (result.generation || result.crossPost || result.bookSegments) {
    logger.warning(
      `recovered interrupted tasks: generation=${result.generation}, ` +
        `cross_post=${result.crossPost}, book_segments=${result.bookSegments}`,
    );
  }

  return result;
}

/**
 * Fails book segments whose owning task did not survive the restart.
 *
 * A segment is not a task, so the sweep above never touches it: its row would
 * sit in `queued`/`rendering` forever, the book would report a render in
 * flight that nothing is working on, and the review UI would refuse every
 * change on that basis. A segment is failed when its task is gone, already
 * failed, or still marked processing with no live owner — and the book's state
 * is then recomputed from its children rather than patched by hand.
 */
export async function recoverInterruptedBookSegments(): Promise<number> {
  const segments = bookSegmentsCollection();
  const tasks = tasksCollection();

  const candidates = await segments
    .find(
      { state: { $in: ["queued", "rendering"] } },
      { projection: { _id: 1, book_id: 1, index: 1, task_id: 1 } },
    )
    .toArray();

  const affectedBooks = new Set<string>();
  let recovered = 0;

  for (const segment of candidates) {
    const task = segment.task_id
      ? await tasks.findOne({ _id: segment.task_id }, { projection: { state: 1, owner_id: 1 } })
      : null;

    const alive =
      task !== null &&
      task.state === TASK_STATE_PROCESSING &&
      isOwnerAlive(task.owner_id);
    if (alive) continue;

    await segments.updateOne(
      { _id: segment._id },
      { $set: { state: "failed", error: INTERRUPTED_SEGMENT_ERROR, updated_at: new Date() } },
    );
    affectedBooks.add(segment.book_id);
    recovered += 1;
  }

  for (const bookId of affectedBooks) {
    await syncBookState(bookId);
  }

  return recovered;
}
