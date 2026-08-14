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

import { booksCollection, bookSegmentsCollection, tasksCollection } from "../db/client.ts";
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
  /** Books whose remaining segments were handed back to the queue. */
  booksResumed: number;
  segmentsResumed: number;
}

export async function recoverInterruptedTasks(): Promise<RecoveryResult> {
  const collection = tasksCollection();
  const result: RecoveryResult = {
    generation: 0,
    crossPost: 0,
    bookSegments: 0,
    booksResumed: 0,
    segmentsResumed: 0,
  };

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

  // Strictly last: resuming reads the segment states the two passes above have
  // just settled, so a segment failed a moment ago for a dead owner is picked
  // up here rather than left behind by a stale read.
  const resumed = await resumeInterruptedBookRenders();
  result.booksResumed = resumed.books;
  result.segmentsResumed = resumed.segments;

  if (result.generation || result.crossPost || result.bookSegments) {
    logger.warning(
      `recovered interrupted tasks: generation=${result.generation}, ` +
        `cross_post=${result.crossPost}, book_segments=${result.bookSegments}`,
    );
  }
  if (result.booksResumed) {
    logger.success(
      `resumed ${result.segmentsResumed} segment(s) across ${result.booksResumed} interrupted book render(s)`,
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

/**
 * Hands an interrupted book render back to the queue.
 *
 * The fan-out that feeds segments to the task queue lives in memory, so a
 * restart does not merely interrupt the segments that were in flight — it
 * abandons every segment still waiting behind them. Marking the in-flight ones
 * failed, as the sweep above does, leaves a book reading "62 pending" with
 * nothing on earth about to render them. On a sixteen-hour audiobook that is
 * the difference between a pause and a total loss.
 *
 * Only work that was demonstrably interrupted is resumed. A segment that failed
 * on its own merits — a voice that does not exist, an unreadable cover — would
 * fail again immediately, so it is left for the user to retry deliberately;
 * `render_params` must also already be stored, since without them there is no
 * voice or aspect to render with, and a book nobody ever started rendering has
 * none.
 */
export async function resumeInterruptedBookRenders(): Promise<{ books: number; segments: number }> {
  // Imported lazily: this module is loaded during startup reconciliation, and
  // the pipeline pulls in ffmpeg, TTS and the settings store behind it.
  const { renderBookSegments } = await import("./bookPipeline.ts");
  const books = booksCollection();
  const segments = bookSegmentsCollection();

  const candidates = await books
    .find({ state: "rendering", render_params: { $ne: null } }, { projection: { _id: 1, render_params: 1 } })
    .toArray();

  let resumedBooks = 0;
  let resumedSegments = 0;

  for (const book of candidates) {
    const params = book.render_params;
    if (!params) continue;

    const pending = await segments
      .find(
        {
          book_id: book._id,
          $or: [{ state: "pending" }, { state: "failed", error: INTERRUPTED_SEGMENT_ERROR }],
        },
        { projection: { index: 1 } },
      )
      .toArray();

    if (pending.length === 0) {
      // Nothing left to do; the book is finished or every remaining failure is
      // a real one. Let the usual reconciliation settle its state.
      await syncBookState(book._id);
      continue;
    }

    const indexes = pending.map((segment) => segment.index).sort((a, b) => a - b);
    try {
      await renderBookSegments(book._id, indexes, params);
      resumedBooks += 1;
      resumedSegments += indexes.length;
      logger.info(`resumed book render, book_id: ${book._id}, segments: ${indexes.length}`);
    } catch (error) {
      // One unresumable book must not stop the others, and must not stop
      // startup either.
      logger.warning(`failed to resume book render, book_id: ${book._id}, error: ${String(error)}`);
      await syncBookState(book._id);
    }
  }

  return { books: resumedBooks, segments: resumedSegments };
}
