/**
 * Task queue admission and cancellation.
 *
 * Cancellation is the interesting case: a queued task holds an abort controller
 * just like a running one, so the two paths are easy to conflate.
 */

import { beforeAll, describe, expect, test } from "bun:test";

import { defaultSettings, settingsSchema } from "../src/config/schema.ts";
import { __setSettingsForTest } from "../src/config/settings.ts";
import { TaskQueue, TaskQueueFullError } from "../src/tasks/queue.ts";

/** Applies settings with the queue limits a case needs. */
function useQueueLimits(maxConcurrent: number, maxQueued: number): void {
  const base = defaultSettings();
  __setSettingsForTest(
    settingsSchema.parse({
      ...base,
      app: { ...base.app, max_concurrent_tasks: maxConcurrent, max_queued_tasks: maxQueued },
    }),
  );
}

/** A task that runs until it is released, so a slot can be held open. */
function blockingTask(): { run: (signal: AbortSignal) => Promise<void>; release: () => void; aborted: () => boolean } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  let signalRef: AbortSignal | undefined;
  return {
    run: async (signal) => {
      signalRef = signal;
      await gate;
    },
    release,
    aborted: () => Boolean(signalRef?.aborted),
  };
}

beforeAll(() => {
  __setSettingsForTest(defaultSettings());
});

describe("TaskQueue.cancel", () => {
  test("removes a queued task from the backlog instead of only aborting it", async () => {
    useQueueLimits(1, 10);
    const queue = new TaskQueue();

    const running = blockingTask();
    queue.add("running", running.run);

    // The slot is taken, so this one is queued rather than started.
    let queuedStarted = false;
    queue.add("queued", async () => {
      queuedStarted = true;
    });

    expect(queue.stats().running).toBe(1);
    expect(queue.stats().queued).toBe(1);

    expect(queue.cancel("queued")).toBe(true);
    expect(queue.stats().queued).toBe(0);
    expect(queue.isActive("queued")).toBe(false);

    // Draining the queue must not resurrect the cancelled task. Without the
    // pending-first check it stayed in the backlog and ran here on an already
    // aborted signal, doing real work before failing.
    running.release();
    await Bun.sleep(10);

    expect(queuedStarted).toBe(false);
    expect(queue.stats().running).toBe(0);
  });

  test("aborts a running task's signal", async () => {
    useQueueLimits(1, 10);
    const queue = new TaskQueue();

    const running = blockingTask();
    queue.add("running", running.run);
    await Bun.sleep(1);

    expect(queue.cancel("running")).toBe(true);
    expect(running.aborted()).toBe(true);

    running.release();
    await Bun.sleep(10);
  });

  test("reports failure for a task it never accepted", () => {
    useQueueLimits(1, 10);
    const queue = new TaskQueue();
    expect(queue.cancel("never-added")).toBe(false);
  });

  test("frees the slot so a cancelled backlog does not block later work", async () => {
    useQueueLimits(1, 10);
    const queue = new TaskQueue();

    const running = blockingTask();
    queue.add("running", running.run);

    let laterRan = false;
    queue.add("cancel-me", async () => {});
    queue.add("later", async () => {
      laterRan = true;
    });

    queue.cancel("cancel-me");
    running.release();
    await Bun.sleep(10);

    expect(laterRan).toBe(true);
  });
});

describe("TaskQueue admission", () => {
  test("rejects once running and queued are both at their limits", async () => {
    useQueueLimits(1, 1);
    const queue = new TaskQueue();

    const running = blockingTask();
    queue.add("running", running.run);
    queue.add("queued", async () => {});

    expect(() => queue.add("overflow", async () => {})).toThrow(TaskQueueFullError);
    // A rejected task must leave no trace, or it would leak a controller.
    expect(queue.isActive("overflow")).toBe(false);

    running.release();
    await Bun.sleep(10);
  });

  test("runs tasks concurrently up to the configured limit", async () => {
    useQueueLimits(2, 10);
    const queue = new TaskQueue();

    const first = blockingTask();
    const second = blockingTask();
    queue.add("first", first.run);
    queue.add("second", second.run);

    expect(queue.stats().running).toBe(2);
    expect(queue.stats().queued).toBe(0);

    first.release();
    second.release();
    await Bun.sleep(10);
  });
});
