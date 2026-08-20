/**
 * HyperFrames renderer logic that can be verified without a Chrome render.
 *
 * Almost everything here is the pure half of the service: the argument builder,
 * the `--json` progress parser and its throttle, and the `doctor` verdict
 * reader. The three cases that must touch a process — an already-cancelled
 * render, a hung render, and an uninstalled CLI — use a stub binary that
 * records its own invocation, so "did not spawn" is observed rather than
 * assumed. Nothing in this file needs `hyperframes` to be installed; the one
 * end-to-end render is skipped when it is not.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRenderArgs,
  createProgressThrottle,
  HyperframesError,
  hyperframesAvailable,
  hyperframesBinaryPath,
  isUnknownOptionError,
  parseDoctorOk,
  parseProgressFraction,
  renderComposition,
  resolutionPreset,
  __resetHyperframesAvailabilityForTest,
  type CompositionRenderOptions,
} from "../src/services/video/hyperframes.ts";
import { probe } from "../src/services/video/probe.ts";

/** A card render: the shape the book pipeline asks for once per segment. */
const cardOptions: CompositionRenderOptions = {
  templateDir: "/repo/resource/hyperframes/classic/card",
  variables: { bookTitle: "Me Before You", bookAuthor: "Jojo Moyes", accent: "#7aa2f7" },
  outputFile: "/tmp/card.mp4",
  width: 1920,
  height: 1080,
};

/** A bed render: once per accent, at the template's own frame rate. */
const bedOptions: CompositionRenderOptions = {
  templateDir: "/repo/resource/hyperframes/classic/bed",
  variables: { accent: "#e0af68" },
  outputFile: "/tmp/bed.mp4",
  width: 1920,
  height: 1080,
  fps: 15,
  quality: "draft",
  workers: 4,
};

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

// ---------------------------------------------------------------------------
// Scratch fixtures
// ---------------------------------------------------------------------------

const originalBinaryPath = process.env.HYPERFRAMES_PATH;

afterEach(() => {
  if (originalBinaryPath === undefined) delete process.env.HYPERFRAMES_PATH;
  else process.env.HYPERFRAMES_PATH = originalBinaryPath;
  __resetHyperframesAvailabilityForTest();
});

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "vidgen-hf-"));
}

/** Minimal project directory: renderComposition only insists on index.html. */
function stubTemplate(dir: string, duration = 1): string {
  const templateDir = join(dir, "template");
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(
    join(templateDir, "index.html"),
    `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>stub</title>
    <style>body { margin: 0; background: #10131a; }</style>
  </head>
  <body>
    <!--
      Every attribute here is load-bearing; the composition contract rejects or
      silently reinterprets a root that is missing any of them.

      data-composition-id is the one that bites. Without it the compiler cannot
      identify the root at all, falls back to a default frame size, and then
      rejects the render because the requested --resolution disagrees with a
      size this file never asked for. That produced a confusing
      "composition is portrait (1080x1920)" error from a file declaring
      1920x1080, and it went unnoticed because this test skipped on every host
      until the binary was installed.

      data-start="0" on the root and data-track-index on the clip are likewise
      required (lint: root_composition_missing_data_start), and a timed element
      needs class="clip" or it stays visible for the whole composition.
    -->
    <div id="root" data-composition-id="stub" data-start="0"
         data-width="1920" data-height="1080" data-duration="${duration}" data-no-timeline>
      <div id="stub-fill" class="clip" data-start="0" data-duration="${duration}" data-track-index="0"
           style="width:1920px;height:1080px;background:#2c3550"></div>
    </div>
  </body>
</html>
`,
  );
  return templateDir;
}

/**
 * A binary that records being run and then hangs.
 *
 * The marker file is what makes "returned without spawning" a real assertion
 * instead of an inference from the error type, and the hang is what the timeout
 * path needs to have something to kill.
 *
 * It is run once up front because macOS spends ~750ms scanning a newly written
 * executable the first time it is exec'd — long enough that a short test
 * timeout would kill the stub before it reached its own first line, and the
 * marker would then say "never ran" about a process that plainly did.
 */
function stubBinary(dir: string): { path: string; marker: string } {
  const marker = join(dir, "invoked.log");
  const path = join(dir, "hyperframes-stub");
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "--warmup" ]; then exit 0; fi\necho "$@" >> ${JSON.stringify(marker)}\nexec sleep 30\n`,
  );
  chmodSync(path, 0o755);
  Bun.spawnSync([path, "--warmup"]);
  return { path, marker };
}

/**
 * A binary that forks a child of its own and then waits, standing in for the
 * Chrome tree the real Node CLI spawns.
 *
 * The child is a *grandchild* of this process, so it is exactly what a
 * `proc.kill()` on the direct child leaves running.
 */
function stubTreeBinary(dir: string): { path: string; childPidFile: string } {
  const childPidFile = join(dir, "child.pid");
  const path = join(dir, "hyperframes-tree-stub");
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "--warmup" ]; then exit 0; fi\nsleep 30 &\necho $! > ${JSON.stringify(childPidFile)}\nwait\n`,
  );
  chmodSync(path, 0o755);
  Bun.spawnSync([path, "--warmup"]);
  return { path, childPidFile };
}

/**
 * A binary that emits `--json` progress on stdout and exits 0 having written
 * nothing — the shape of a Chrome that died between frames.
 */
function stubProgressBinary(dir: string): string {
  const path = join(dir, "hyperframes-progress-stub");
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "--warmup" ]; then exit 0; fi\n` +
      `echo '{"type":"start","output":"bed.mp4"}'\n` +
      `echo '{"progress":0.5}'\n` +
      `echo '{"progress":1}'\n` +
      `exit 0\n`,
  );
  chmodSync(path, 0o755);
  Bun.spawnSync([path, "--warmup"]);
  return path;
}

/** Whether a pid is still alive; signal 0 only checks, it delivers nothing. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

describe("buildRenderArgs", () => {
  test("builds the card invocation with the documented defaults", () => {
    const args = buildRenderArgs(cardOptions);

    expect(args[0]).toBe("render");
    expect(flagValue(args, "--quality")).toBe("high");
    expect(flagValue(args, "--fps")).toBe("30");
    expect(flagValue(args, "--workers")).toBe("2");
    expect(flagValue(args, "--output")).toBe("/tmp/card.mp4");
  });

  test("passes the bed's own frame rate, quality and worker count through", () => {
    const args = buildRenderArgs(bedOptions);

    expect(flagValue(args, "--fps")).toBe("15");
    expect(flagValue(args, "--quality")).toBe("draft");
    expect(flagValue(args, "--workers")).toBe("4");
    expect(flagValue(args, "--output")).toBe("/tmp/bed.mp4");
  });

  test("names the frame size the CLI knows it by", () => {
    expect(flagValue(buildRenderArgs(cardOptions), "--resolution")).toBe("landscape");
    expect(flagValue(buildRenderArgs({ ...cardOptions, width: 1080, height: 1920 }), "--resolution")).toBe(
      "portrait",
    );
    // No preset covers it, so the composition's own size stands.
    expect(buildRenderArgs({ ...cardOptions, width: 1280, height: 720 })).not.toContain("--resolution");
  });

  test("sends variables as one JSON argument", () => {
    const args = buildRenderArgs(bedOptions);
    expect(JSON.parse(flagValue(args, "--variables")!)).toEqual({ accent: "#e0af68" });
  });

  test("encodes quotes and non-ASCII in a book title without corrupting them", () => {
    const variables = {
      bookTitle: 'The "Great" Escape \\ Vol. 1',
      chapterTitle: "第一章 — Café Ünïcode 日本語",
      hookText: "line one\nline two\ttabbed",
    };
    const args = buildRenderArgs({ ...cardOptions, variables });

    const encoded = flagValue(args, "--variables")!;
    // A single argv entry, so the round trip is the whole contract: there is no
    // shell in the way and nothing may be pre-escaped for one.
    expect(JSON.parse(encoded)).toEqual(variables);
    expect(encoded).toContain("第一章");
  });

  test("omits --variables when there is nothing to override", () => {
    expect(buildRenderArgs({ ...cardOptions, variables: {} })).not.toContain("--variables");
  });

  test("asks for --json only when a progress consumer is listening", () => {
    expect(buildRenderArgs(cardOptions)).not.toContain("--json");
    expect(buildRenderArgs({ ...cardOptions, onProgress: () => {} })).toContain("--json");
  });

  test("is pure: two calls with the same options agree", () => {
    expect(buildRenderArgs(cardOptions)).toEqual(buildRenderArgs(cardOptions));
  });
});

describe("resolutionPreset", () => {
  test("covers every size aspectToResolution can produce", () => {
    expect(resolutionPreset(1920, 1080)).toBe("landscape");
    expect(resolutionPreset(1080, 1920)).toBe("portrait");
    expect(resolutionPreset(1080, 1080)).toBe("square");
  });

  test("returns null rather than guessing at an unknown size", () => {
    expect(resolutionPreset(1280, 720)).toBeNull();
    expect(resolutionPreset(0, 0)).toBeNull();
  });
});

describe("parseProgressFraction", () => {
  test("reads a fraction, a percentage and a frame count", () => {
    expect(parseProgressFraction('{"progress":0.42}')).toBeCloseTo(0.42, 5);
    expect(parseProgressFraction('{"percent":42}')).toBeCloseTo(0.42, 5);
    expect(parseProgressFraction('{"frame":150,"totalFrames":300}')).toBeCloseTo(0.5, 5);
  });

  test("rescales a progress key that is really a percentage", () => {
    expect(parseProgressFraction('{"progress":75}')).toBeCloseTo(0.75, 5);
    expect(parseProgressFraction('{"progress":1}')).toBe(1);
  });

  test("clamps values outside 0..1", () => {
    expect(parseProgressFraction('{"percent":140}')).toBe(1);
    expect(parseProgressFraction('{"progress":-0.5}')).toBe(0);
  });

  test("treats anything it does not recognise as noise", () => {
    expect(parseProgressFraction("Rendering 12/300 frames")).toBeNull();
    expect(parseProgressFraction('{"type":"start","output":"bed.mp4"}')).toBeNull();
    expect(parseProgressFraction("{not json")).toBeNull();
    expect(parseProgressFraction("")).toBeNull();
  });
});

describe("createProgressThrottle", () => {
  test("coalesces a frame-by-frame stream into a handful of reports", () => {
    const seen: number[] = [];
    // An unreachable interval leaves the delta as the only trigger after the
    // first report, which always goes out so the bar starts moving at once.
    const report = createProgressThrottle((f) => seen.push(f), 60_000, 0.25);

    for (let frame = 1; frame <= 300; frame += 1) report(frame / 300);

    expect(seen).toHaveLength(5);
    expect(seen[0]).toBeCloseTo(1 / 300, 5);
    expect(seen.at(-1)).toBe(1);
    for (let i = 1; i < seen.length - 1; i += 1) {
      expect(seen[i]! - seen[i - 1]!).toBeGreaterThanOrEqual(0.25);
    }
  });

  test("always reports completion, however recently it reported", () => {
    const seen: number[] = [];
    const report = createProgressThrottle((f) => seen.push(f), 60_000, 0.9);

    report(0.05);
    report(1);

    expect(seen.at(-1)).toBe(1);
  });

  test("never walks the bar backwards when workers finish out of order", () => {
    const seen: number[] = [];
    const report = createProgressThrottle((f) => seen.push(f), 0, 0);

    report(0.6);
    report(0.3);
    report(0.7);

    expect(seen).toEqual([0.6, 0.7]);
  });

  test("survives a callback that throws", () => {
    const report = createProgressThrottle(() => {
      throw new Error("mongo is down");
    }, 0, 0);

    expect(() => report(0.5)).not.toThrow();
  });
});

describe("parseDoctorOk", () => {
  test("gates on the payload, which is the only place the verdict lives", () => {
    expect(parseDoctorOk('{"ok":true,"checks":[]}')).toBe(true);
    expect(parseDoctorOk('{"ok":false,"checks":[{"name":"Chrome","status":"fail"}]}')).toBe(false);
  });

  test("finds the payload behind a warning line", () => {
    expect(parseDoctorOk('npm warn deprecated foo\n{"ok":true}\n')).toBe(true);
  });

  test("reads unparseable or absent output as unhealthy", () => {
    expect(parseDoctorOk("")).toBe(false);
    expect(parseDoctorOk("Segmentation fault")).toBe(false);
    expect(parseDoctorOk('{"checks":[]}')).toBe(false);
  });
});

describe("isUnknownOptionError", () => {
  test("recognises an argument the CLI refused", () => {
    expect(isUnknownOptionError("error: unknown option '--json'")).toBe(true);
    expect(isUnknownOptionError("Unrecognized option --json")).toBe(true);
  });

  test("does not mistake a render failure for one", () => {
    expect(isUnknownOptionError("Chrome exited with code 133")).toBe(false);
    expect(isUnknownOptionError("")).toBe(false);
  });
});

describe("hyperframesAvailable", () => {
  test("is false when the pinned binary is absent, without falling back to npx", async () => {
    process.env.HYPERFRAMES_PATH = join(scratchDir(), "definitely-not-here");

    expect(hyperframesBinaryPath()).toBeNull();
    expect(await hyperframesAvailable()).toBe(false);
  });
});

describe("renderComposition", () => {
  test("returns without spawning when the signal is already aborted", async () => {
    const dir = scratchDir();
    const { path, marker } = stubBinary(dir);
    process.env.HYPERFRAMES_PATH = path;

    const controller = new AbortController();
    controller.abort();

    const failure = await renderComposition({
      ...cardOptions,
      templateDir: stubTemplate(dir),
      outputFile: join(dir, "card.mp4"),
      signal: controller.signal,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HyperframesError);
    expect((failure as HyperframesError).reason).toBe("cancelled");
    // The warmed stub records itself within a few ms, so an absent marker after
    // this pause means no process was ever started rather than a slow one.
    await Bun.sleep(60);
    expect(existsSync(marker)).toBe(false);
  });

  test("reports a hung render as a typed timeout and leaves no partial file", async () => {
    const dir = scratchDir();
    const { path, marker } = stubBinary(dir);
    process.env.HYPERFRAMES_PATH = path;
    const outputFile = join(dir, "bed.mp4");

    const failure = await renderComposition({
      ...bedOptions,
      templateDir: stubTemplate(dir),
      outputFile,
      timeoutMs: 500,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HyperframesError);
    expect((failure as HyperframesError).reason).toBe("timeout");
    expect((failure as HyperframesError).message).toContain("500ms");
    // It really did run — the timeout is not a disguised argument error.
    expect(existsSync(marker)).toBe(true);
    // Nothing was renamed into place, so no later segment can reuse a stub.
    expect(existsSync(outputFile)).toBe(false);
  }, 15_000);

  test("reports progress from --json and refuses an exit-0 render that wrote nothing", async () => {
    const dir = scratchDir();
    process.env.HYPERFRAMES_PATH = stubProgressBinary(dir);
    const outputFile = join(dir, "bed.mp4");
    const seen: number[] = [];

    const failure = await renderComposition({
      ...bedOptions,
      templateDir: stubTemplate(dir),
      outputFile,
      onProgress: (fraction) => seen.push(fraction),
    }).catch((error: unknown) => error);

    // The events reached the callback, and the non-progress line was ignored.
    expect(seen).toEqual([0.5, 1]);
    // Exit 0 is a claim about the process, not about the file it was asked for.
    expect(failure).toBeInstanceOf(HyperframesError);
    expect((failure as HyperframesError).reason).toBe("empty-output");
    expect(existsSync(outputFile)).toBe(false);
  }, 15_000);

  test("kills the whole process tree, not just the CLI it spawned", async () => {
    const dir = scratchDir();
    const { path, childPidFile } = stubTreeBinary(dir);
    process.env.HYPERFRAMES_PATH = path;

    const failure = await renderComposition({
      ...bedOptions,
      templateDir: stubTemplate(dir),
      outputFile: join(dir, "bed.mp4"),
      timeoutMs: 500,
    }).catch((error: unknown) => error);

    expect((failure as HyperframesError).reason).toBe("timeout");

    const childPid = Number((await Bun.file(childPidFile).text()).trim());
    expect(Number.isInteger(childPid)).toBe(true);

    // The signal goes to the group, so the grandchild dies with its parent.
    // Killing the direct pid — which is what runFfmpeg does, correctly, for
    // ffmpeg — would leave this one holding memory and the output file.
    await Bun.sleep(200);
    expect(isAlive(childPid)).toBe(false);
  }, 15_000);

  test("fails with a typed error rather than reaching for npx when nothing is installed", async () => {
    const dir = scratchDir();
    process.env.HYPERFRAMES_PATH = join(dir, "definitely-not-here");

    const failure = await renderComposition({
      ...cardOptions,
      templateDir: stubTemplate(dir),
      outputFile: join(dir, "card.mp4"),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HyperframesError);
    expect((failure as HyperframesError).reason).toBe("missing-binary");
  });

  test("refuses a directory that holds no composition", async () => {
    const dir = scratchDir();
    process.env.HYPERFRAMES_PATH = stubBinary(dir).path;

    const failure = await renderComposition({
      ...cardOptions,
      templateDir: dir,
      outputFile: join(dir, "card.mp4"),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HyperframesError);
    expect((failure as HyperframesError).reason).toBe("missing-template");
  });
});

describe("renderComposition end to end", () => {
  /**
   * The only test here that renders. It is skipped wherever `hyperframes` is
   * not installed and healthy, which includes every machine before T5 lands the
   * dependency — so it must never be the thing that proves this suite green.
   */
  test("renders a one-second composition and probes it as real video", async () => {
    if (!(await hyperframesAvailable())) {
      console.log("skipping: hyperframes is not installed or reports an unhealthy environment");
      return;
    }

    const dir = scratchDir();
    const outputFile = join(dir, "spike.mp4");

    const result = await renderComposition({
      templateDir: stubTemplate(dir, 1),
      variables: {},
      outputFile,
      width: 1920,
      height: 1080,
      fps: 15,
      quality: "draft",
      timeoutMs: 180_000,
    });

    expect(result.cached).toBe(false);
    expect(result.outputFile).toBe(outputFile);
    expect(existsSync(outputFile)).toBe(true);

    const info = await probe(outputFile);
    expect(info.hasVideo).toBe(true);
    expect(info.duration).toBeGreaterThan(0.5);
    expect(info.duration).toBeLessThan(3);
    // The duration is the file's, not the composition's declaration.
    expect(result.duration).toBeCloseTo(info.duration, 3);

    // A second call must reuse it rather than pay for Chrome again.
    const reused = await renderComposition({
      templateDir: join(dir, "template"),
      variables: {},
      outputFile,
      width: 1920,
      height: 1080,
      fps: 15,
      quality: "draft",
    });
    expect(reused.cached).toBe(true);
  }, 240_000);
});
