/**
 * Bounded in-process task queue.
 * Ported from python-version/app/controllers/manager/base_manager.py.
 *
 * Concurrency is capped so several renders cannot starve each other of CPU, and
 * the backlog is capped too: without a ceiling an unauthenticated endpoint
 * could stack up work indefinitely and blow out memory and third-party spend.
 */

import { appConfig } from "../config/settings.ts";
import { logger, errorMessage } from "../utils/logger.ts";

export class TaskQueueFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskQueueFullError";
  }
}

interface QueuedTask {
  taskId: string;
  run: () => Promise<unknown>;
}

class TaskQueue {
  private running = 0;
  private readonly pending: QueuedTask[] = [];
  private readonly controllers = new Map<string, AbortController>();

  private get maxConcurrent(): number {
    return Math.max(1, Number(appConfig().max_concurrent_tasks) || 5);
  }

  private get maxQueued(): number {
    return Math.max(1, Number(appConfig().max_queued_tasks) || 100);
  }

  /** Accepts a task, running it now or queueing it. Throws when both are full. */
  add(taskId: string, run: (signal: AbortSignal) => Promise<unknown>): void {
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    const entry: QueuedTask = { taskId, run: () => run(controller.signal) };

    if (this.running < this.maxConcurrent) {
      logger.info(`add task: ${taskId}, current_tasks: ${this.running}`);
      this.start(entry);
      return;
    }

    if (this.pending.length >= this.maxQueued) {
      this.controllers.delete(taskId);
      logger.warning(
        `reject task: ${taskId}, queue_size: ${this.pending.length}, max_queued_tasks: ${this.maxQueued}`,
      );
      throw new TaskQueueFullError("task queue is full, please try again later");
    }

    logger.info(
      `enqueue task: ${taskId}, current_tasks: ${this.running}, queue_size: ${this.pending.length}`,
    );
    this.pending.push(entry);
  }

  private start(entry: QueuedTask): void {
    // Reserve the slot before the work starts; incrementing inside the async
    // body would let several concurrent calls all observe zero and exceed the
    // configured limit.
    this.running += 1;

    void entry
      .run()
      .catch((error) => {
        logger.exception(`task ${entry.taskId} failed`, error);
      })
      .finally(() => {
        this.running -= 1;
        this.controllers.delete(entry.taskId);
        this.drain();
      });
  }

  private drain(): void {
    while (this.running < this.maxConcurrent && this.pending.length > 0) {
      const next = this.pending.shift();
      if (next) this.start(next);
    }
  }

  /** Requests cancellation of a running or queued task. */
  cancel(taskId: string): boolean {
    const controller = this.controllers.get(taskId);
    if (controller) {
      controller.abort(new Error("task was cancelled"));
      return true;
    }

    const index = this.pending.findIndex((entry) => entry.taskId === taskId);
    if (index >= 0) {
      this.pending.splice(index, 1);
      return true;
    }
    return false;
  }

  isActive(taskId: string): boolean {
    return this.controllers.has(taskId) || this.pending.some((entry) => entry.taskId === taskId);
  }

  stats(): { running: number; queued: number; maxConcurrent: number; maxQueued: number } {
    return {
      running: this.running,
      queued: this.pending.length,
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
    };
  }
}

export const taskQueue = new TaskQueue();

/**
 * Fixed-size worker pool for cross-post uploads.
 *
 * Publishing can take minutes and must not hold a video-generation slot, so it
 * runs on its own bounded pool: the video is finished and visible immediately,
 * while uploads proceed at a controlled rate.
 */
export class BoundedPool {
  private running = 0;
  private readonly pending: (() => Promise<void>)[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxPending: () => number,
  ) {}

  submit(job: () => Promise<void>): boolean {
    if (this.running >= this.maxConcurrent && this.pending.length >= this.maxPending()) {
      return false;
    }

    if (this.running < this.maxConcurrent) {
      this.start(job);
    } else {
      this.pending.push(job);
    }
    return true;
  }

  private start(job: () => Promise<void>): void {
    this.running += 1;
    void job()
      .catch((error) => logger.error(`pool job failed: ${errorMessage(error)}`))
      .finally(() => {
        this.running -= 1;
        const next = this.pending.shift();
        if (next) this.start(next);
      });
  }
}
