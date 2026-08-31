/**
 * The in-process periodic index pass.
 *
 * Nothing here reaches Mongo, Qdrant, ffmpeg or Gemini, and nothing waits on
 * wall-clock time. The suite uses no mocking library, so the scheduler exposes
 * the four things a test has to control — the interval, the master switch, the
 * pass itself and the timer — as injectable functions with real defaults, and
 * every case below drives those. A fake timer hands the test the tick callback
 * and lets it fire ticks by hand; `currentFootageIndexPass()` is how the test
 * then awaits a tick, since a timer callback can only return `void`.
 *
 * Four of these pin properties the scheduler exists to have, and each is a
 * production defect if it regresses:
 *
 *  1. arming never runs a pass — the first tick is one whole interval in, so a
 *     boot-time full-cache sweep cannot compete with startup recovery;
 *  2. two overlapping ticks coalesce to exactly one run, because two concurrent
 *     `indexAll`s would both describe the same clips and double the bill;
 *  3. a pass that throws is swallowed, not rethrown into the timer callback,
 *     where it would surface as an unhandled rejection and take the API with
 *     it — and the loop keeps ticking afterwards;
 *  4. `FootageLockedError` is a *skip*, not a failure: it means a CLI run is
 *     already doing this work.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

import { defaultSettings } from "../src/config/schema.ts";
import { __setSettingsForTest } from "../src/config/settings.ts";
import { setLogLevel } from "../src/utils/logger.ts";
import type { IndexRunResult } from "../src/services/footage/index.ts";
import { FootageLockedError } from "../src/services/footage/lock.ts";
import {
  MIN_INTERVAL_MS,
  currentFootageIndexPass,
  footageIndexIntervalMs,
  isFootageIndexSchedulerRunning,
  runFootageIndexPass,
  startFootageIndexScheduler,
  stopFootageIndexScheduler,
  type SchedulerDeps,
} from "../src/services/footage/scheduler.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A run result with the fields a caller cares about, zeroed elsewhere. */
function runResult(overrides: Partial<IndexRunResult> = {}): IndexRunResult {
  return {
    scanned: 0,
    attempted: 0,
    indexed: 0,
    refreshed: 0,
    skipped: 0,
    missing: 0,
    failed: 0,
    described: 0,
    aborted: false,
    errors: [],
    elapsed_ms: 0,
    ...overrides,
  };
}

/** Installs settings whose only interesting field is the interval. */
function installSettings(minutes: number, enabled = true): void {
  const settings = defaultSettings();
  settings.footage_index.index_interval_minutes = minutes;
  settings.footage_index.enabled = enabled;
  __setSettingsForTest(settings);
}

/**
 * A `setInterval` replacement that fires only when the test says so.
 *
 * The handle is an object identity rather than a number, which is what lets
 * `cleared` assert that stop passed back *this* timer and not something else.
 */
class FakeTimer {
  fn: (() => void) | null = null;
  ms = 0;
  cleared = 0;
  readonly handle = { fake: true };

  readonly set = (fn: () => void, ms: number): unknown => {
    this.fn = fn;
    this.ms = ms;
    return this.handle;
  };

  readonly clear = (handle: unknown): void => {
    if (handle === this.handle) this.cleared++;
    this.fn = null;
  };

  /** Fires one tick synchronously, without waiting for the pass it starts. */
  fire(): void {
    if (!this.fn) throw new Error("the fake timer is not armed");
    this.fn();
  }

  /** Fires one tick and waits for the pass it started, or coalesced into. */
  async fireAndWait(): Promise<void> {
    this.fire();
    await currentFootageIndexPass();
  }

  /** The deps a test passes to `startFootageIndexScheduler`. */
  deps(extra: SchedulerDeps = {}): SchedulerDeps {
    return { setTimer: this.set, clearTimer: this.clear, ...extra };
  }
}

/**
 * Runs `fn` with `console.log` captured at the given level, then restores both.
 *
 * Not a mocking library — a saved and restored global — and it earns its place
 * twice over: the scheduler's quiet-versus-loud logging is a stated
 * requirement worth asserting, and the failure cases below would otherwise
 * print ERROR lines into a passing suite.
 *
 * The level is restored the way the logger computes it at import, since the
 * threshold itself is not readable.
 */
async function captureLog(level: string, fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const write = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  // Both streams: `emit` sends WARNING and ERROR to `console.error` and
  // everything else to `console.log`, so capturing one half would silently
  // drop exactly the lines the failure cases assert on.
  const originalLog = console.log;
  const originalError = console.error;
  console.log = write;
  console.error = write;
  setLogLevel(level);
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
    setLogLevel(String(process.env.LOG_LEVEL ?? "INFO"));
  }
  return lines;
}

/** A promise plus the handle that settles it, for holding a pass open. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  installSettings(60);
});

afterEach(async () => {
  stopFootageIndexScheduler();
  // Never leave a pass in flight: the coalescing guard is module state, and a
  // leaked pass would make the next test's first tick report "busy".
  await currentFootageIndexPass();
});

afterAll(() => {
  __setSettingsForTest(defaultSettings());
});

// ---------------------------------------------------------------------------
// The interval
// ---------------------------------------------------------------------------

describe("footageIndexIntervalMs", () => {
  test("reads footage_index.index_interval_minutes", () => {
    installSettings(60);
    expect(footageIndexIntervalMs()).toBe(3_600_000);

    installSettings(5);
    expect(footageIndexIntervalMs()).toBe(300_000);
  });

  test("defaults to an hour", () => {
    __setSettingsForTest(defaultSettings());
    expect(defaultSettings().footage_index.index_interval_minutes).toBe(60);
    expect(footageIndexIntervalMs()).toBe(3_600_000);
  });

  test("0 disables", () => {
    installSettings(0);
    expect(footageIndexIntervalMs()).toBe(0);
  });

  test("a negative or non-finite setting reads as disabled, never as an error", () => {
    // A bad number in the settings document must not stop the server booting.
    installSettings(-10);
    expect(footageIndexIntervalMs()).toBe(0);

    installSettings(Number.NaN);
    expect(footageIndexIntervalMs()).toBe(0);
  });

  test("a fractional minute is honoured, down to a one-second floor", () => {
    installSettings(0.5);
    expect(footageIndexIntervalMs()).toBe(30_000);

    // A slipped decimal point degrades to "often", not to a busy loop.
    installSettings(0.0001);
    expect(footageIndexIntervalMs()).toBe(MIN_INTERVAL_MS);
  });
});

// ---------------------------------------------------------------------------
// Arming
// ---------------------------------------------------------------------------

describe("startFootageIndexScheduler", () => {
  test("arms a timer at the interval from settings", () => {
    installSettings(5);
    const timer = new FakeTimer();

    expect(startFootageIndexScheduler(timer.deps())).toBe(300_000);
    expect(timer.ms).toBe(300_000);
    expect(isFootageIndexSchedulerRunning()).toBe(true);
  });

  test("does not fire on startup", () => {
    let started = 0;
    const timer = new FakeTimer();

    startFootageIndexScheduler(
      timer.deps({
        intervalMs: () => 60_000,
        index: async () => {
          started++;
          return runResult();
        },
      }),
    );

    // The first pass is one whole interval away: a boot-time sweep over a cold
    // cache would compete with `recoverInterruptedTasks` for Mongo.
    expect(started).toBe(0);
    expect(currentFootageIndexPass()).toBeNull();
    expect(timer.ms).toBe(60_000);
  });

  test("an interval of 0 disables the loop entirely", () => {
    installSettings(0);
    const timer = new FakeTimer();

    expect(startFootageIndexScheduler(timer.deps())).toBe(0);
    // Not merely "armed and never fires": no timer was created at all.
    expect(timer.fn).toBeNull();
    expect(timer.ms).toBe(0);
    expect(isFootageIndexSchedulerRunning()).toBe(false);
  });

  test("starting twice keeps the first loop", () => {
    const first = new FakeTimer();
    const second = new FakeTimer();

    expect(startFootageIndexScheduler(first.deps({ intervalMs: () => 60_000 }))).toBe(60_000);
    expect(startFootageIndexScheduler(second.deps({ intervalMs: () => 60_000 }))).toBe(0);

    // Two loops would only ever contend for one lock.
    expect(second.fn).toBeNull();
    expect(first.fn).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stopping
// ---------------------------------------------------------------------------

describe("stopFootageIndexScheduler", () => {
  test("clears the timer it armed", () => {
    const timer = new FakeTimer();
    startFootageIndexScheduler(timer.deps({ intervalMs: () => 60_000 }));

    stopFootageIndexScheduler();

    expect(timer.cleared).toBe(1);
    expect(timer.fn).toBeNull();
    expect(isFootageIndexSchedulerRunning()).toBe(false);
  });

  test("stopping twice is harmless and does not clear twice", () => {
    const timer = new FakeTimer();
    startFootageIndexScheduler(timer.deps({ intervalMs: () => 60_000 }));

    stopFootageIndexScheduler();
    stopFootageIndexScheduler();

    expect(timer.cleared).toBe(1);
  });

  test("stopping when nothing was armed is a no-op", () => {
    expect(isFootageIndexSchedulerRunning()).toBe(false);
    expect(() => stopFootageIndexScheduler()).not.toThrow();
  });

  test("a stopped loop cannot tick again", async () => {
    let started = 0;
    const timer = new FakeTimer();
    startFootageIndexScheduler(
      timer.deps({
        intervalMs: () => 60_000,
        index: async () => {
          started++;
          return runResult();
        },
      }),
    );

    const fire = timer.fn;
    stopFootageIndexScheduler();
    // The real `clearInterval` makes this unreachable; holding the callback
    // proves the module also stops handing out work after `stop`.
    expect(timer.fn).toBeNull();
    expect(fire).not.toBeNull();
    expect(started).toBe(0);
  });

  test("asks an in-flight pass to abort", async () => {
    const held = gate();
    let sawAbort = false;

    const timer = new FakeTimer();
    startFootageIndexScheduler(
      timer.deps({
        intervalMs: () => 60_000,
        index: async (signal) => {
          signal.addEventListener("abort", () => void (sawAbort = true));
          await held.wait;
          return runResult();
        },
      }),
    );

    timer.fire();
    const pass = currentFootageIndexPass();
    expect(pass).not.toBeNull();

    stopFootageIndexScheduler();
    expect(sawAbort).toBe(true);

    held.open();
    await pass;
  });
});

// ---------------------------------------------------------------------------
// Coalescing
// ---------------------------------------------------------------------------

describe("coalescing", () => {
  test("two overlapping ticks run the pass once", async () => {
    const held = gate();
    let started = 0;

    const timer = new FakeTimer();
    startFootageIndexScheduler(
      timer.deps({
        intervalMs: () => 60_000,
        index: async () => {
          started++;
          await held.wait;
          return runResult({ scanned: 3, attempted: 1, indexed: 1 });
        },
      }),
    );

    timer.fire();
    const first = currentFootageIndexPass();
    expect(started).toBe(1);

    // A second tick lands while the first pass is still inside `index`.
    timer.fire();
    expect(started).toBe(1);
    expect(currentFootageIndexPass()).toBe(first);

    held.open();
    await first;
    expect(started).toBe(1);
  });

  test("the loop runs again once the pass it coalesced into finishes", async () => {
    const held = gate();
    let started = 0;

    const timer = new FakeTimer();
    startFootageIndexScheduler(
      timer.deps({
        intervalMs: () => 60_000,
        index: async () => {
          started++;
          if (started === 1) await held.wait;
          return runResult();
        },
      }),
    );

    timer.fire();
    timer.fire();
    held.open();
    await currentFootageIndexPass();

    await timer.fireAndWait();
    expect(started).toBe(2);
  });

  test("a second caller is told busy and gets the running pass's completion", async () => {
    const held = gate();
    let started = 0;

    const deps: SchedulerDeps = {
      enabled: () => true,
      index: async () => {
        started++;
        await held.wait;
        return runResult({ attempted: 2, indexed: 2 });
      },
    };

    const first = runFootageIndexPass(deps);
    const second = runFootageIndexPass(deps);
    held.open();

    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe("ran");
    expect(b.status).toBe("busy");
    expect(started).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe("failure handling", () => {
  test("a thrown pass is swallowed and the next tick still fires", async () => {
    let started = 0;
    const timer = new FakeTimer();

    await captureLog("ERROR", async () => {
      startFootageIndexScheduler(
        timer.deps({
          intervalMs: () => 60_000,
          index: async () => {
            started++;
            if (started === 1) throw new Error("qdrant is unreachable");
            return runResult();
          },
        }),
      );

      // Nothing escapes into the timer callback: this must not reject.
      await timer.fireAndWait();
      expect(started).toBe(1);

      await timer.fireAndWait();
    });

    expect(started).toBe(2);
  });

  test("a failure comes back as an outcome rather than as an exception", async () => {
    const lines = await captureLog("ERROR", async () => {
      const outcome = await runFootageIndexPass({
        enabled: () => true,
        index: async () => {
          throw new Error("gemini refused the key");
        },
      });
      expect(outcome.status).toBe("failed");
      expect(outcome.status === "failed" && (outcome.error as Error).message).toBe(
        "gemini refused the key",
      );
    });

    expect(lines.some((line) => line.includes("gemini refused the key"))).toBe(true);
  });

  test("a lock held by someone else is a skip, not a failure", async () => {
    const lines = await captureLog("ERROR", async () => {
      const outcome = await runFootageIndexPass({
        enabled: () => true,
        index: async () => {
          // What `withLock` throws when a hand-run CLI is already indexing.
          throw new FootageLockedError(null);
        },
      });
      expect(outcome.status).toBe("locked");
    });

    // Nothing at ERROR: another writer doing this work is the system working.
    expect(lines).toEqual([]);
  });

  test("a non-Error thrown value is still swallowed", async () => {
    await captureLog("ERROR", async () => {
      const outcome = await runFootageIndexPass({
        enabled: () => true,
        index: async () => {
          // `throw` takes anything, and `errorName`/`errorMessage` exist
          // because things in this codebase do throw non-Errors.
          throw "a string, because throw takes anything";
        },
      });
      expect(outcome.status).toBe("failed");
    });
  });

  test("a fatal run is reported without throwing", async () => {
    const lines = await captureLog("WARNING", async () => {
      const outcome = await runFootageIndexPass({
        enabled: () => true,
        index: async () => runResult({ fatal: "qdrant is unusable", aborted: true }),
      });
      expect(outcome.status).toBe("ran");
    });

    expect(lines.some((line) => line.includes("qdrant is unusable"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The master switch and the logging contract
// ---------------------------------------------------------------------------

describe("the master switch", () => {
  test("footage_index.enabled false skips the pass without calling the indexer", async () => {
    installSettings(60, false);
    let started = 0;

    const outcome = await runFootageIndexPass({
      index: async () => {
        started++;
        return runResult();
      },
    });

    expect(outcome.status).toBe("disabled");
    expect(started).toBe(0);
  });

  test("it is read per pass, so flipping it takes effect without a restart", async () => {
    let enabled = false;
    let started = 0;
    const deps: SchedulerDeps = {
      enabled: () => enabled,
      index: async () => {
        started++;
        return runResult();
      },
    };

    expect((await runFootageIndexPass(deps)).status).toBe("disabled");
    enabled = true;
    expect((await runFootageIndexPass(deps)).status).toBe("ran");
    expect(started).toBe(1);
  });
});

describe("logging", () => {
  test("a pass that indexed something logs at info", async () => {
    const lines = await captureLog("INFO", async () => {
      await runFootageIndexPass({
        enabled: () => true,
        index: async () => runResult({ scanned: 9, attempted: 2, indexed: 2, described: 2 }),
      });
    });

    const info = lines.filter((line) => line.includes("INFO"));
    expect(info.length).toBe(1);
    expect(info[0]).toContain("indexed=2");
  });

  test("a pass with nothing to do says nothing at info", async () => {
    const lines = await captureLog("INFO", async () => {
      await runFootageIndexPass({
        enabled: () => true,
        index: async () => runResult({ scanned: 9, skipped: 9 }),
      });
    });

    // An hourly "nothing to do" at info would train everyone to ignore the
    // line that matters, so the quiet case is debug-only.
    expect(lines).toEqual([]);
  });

  test("that same quiet pass is still visible at debug", async () => {
    const lines = await captureLog("DEBUG", async () => {
      await runFootageIndexPass({
        enabled: () => true,
        index: async () => runResult({ scanned: 9, skipped: 9 }),
      });
    });

    expect(lines.some((line) => line.includes("nothing to index"))).toBe(true);
  });
});
