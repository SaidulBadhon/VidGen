/**
 * Renders a HyperFrames HTML composition to an mp4.
 *
 * HyperFrames rasterises every frame in headless Chrome, which is roughly 2.3×
 * slower than realtime at 1080p. So this renders *short* assets — a title card,
 * a looping motion bed — and ffmpeg still assembles the full-length timeline.
 * Nothing here should ever be handed a chapter's worth of narration.
 *
 * Shaped like still.ts on purpose: a pure argument builder that tests assert
 * against with no process spawned, and an async runner that probes its own
 * output instead of trusting the length it asked for.
 */

import { existsSync } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { probe, type MediaInfo } from "./probe.ts";
import { logger, errorMessage } from "../../utils/logger.ts";
import { rootDir } from "../../utils/paths.ts";

/** CLI default, and what every VidGen composition is authored against. */
const DEFAULT_FPS = 30;
const DEFAULT_QUALITY = "high";

/**
 * Each worker is its own Chrome at ~256 MB. Two book segments render
 * concurrently and ffmpeg jobs run alongside them, so the CLI's `auto` — which
 * sizes to the host's cores — would open a dozen browsers on a machine already
 * saturated with encoders.
 */
const DEFAULT_WORKERS = 2;

/** A 20s 1080p bed measured 48s on an M4 Pro; ten minutes is a wedged Chrome. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Grace between asking the process group to stop and forcing it. */
const KILL_GRACE_MS = 2_000;

/** Matches ffmpeg.ts: failures report the tail, not the whole log. */
const MAX_CAPTURED_STDERR = 16_000;

/**
 * Cap on an unterminated stdout line.
 *
 * Without `--json` the CLI paints a progress bar with carriage returns and no
 * newlines, which a line splitter would otherwise accumulate for the whole run.
 */
const MAX_STDOUT_LINE = 64_000;

/** Minimum wall time between two `onProgress` calls. */
const PROGRESS_INTERVAL_MS = 1_000;

/** Progress jump that reports immediately regardless of the interval. */
const PROGRESS_MIN_DELTA = 0.02;

/**
 * How long a successful `doctor` verdict is trusted.
 *
 * Deliberately short. See hyperframesAvailable().
 */
const AVAILABILITY_TTL_MS = 60_000;

/** `doctor` launches Chrome, so it is slower than an `ffmpeg -filters` probe. */
const DOCTOR_TIMEOUT_MS = 60_000;

export interface CompositionRenderOptions {
  /** Project directory holding `index.html`, e.g. resource/hyperframes/classic/bed. */
  templateDir: string;
  /** Values for the ids the composition declares in `data-composition-variables`. */
  variables: Record<string, string>;
  outputFile: string;
  /** Target frame size, normally from aspectToResolution(). */
  width: number;
  height: number;
  /** Output frame rate; defaults to DEFAULT_FPS. */
  fps?: number;
  quality?: "draft" | "high";
  /** Chrome instances the CLI may open; defaults to DEFAULT_WORKERS. */
  workers?: number;
  /** Hard kill after this long; defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Coalesced render progress, 0..1. Passing this turns on `--json`. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface CompositionRenderResult {
  outputFile: string;
  /** Probed length of the file on disk, not the composition's declared duration. */
  duration: number;
  /** True when a usable render already sat at `outputFile` and nothing was spawned. */
  cached: boolean;
}

/** Why a composition render did not produce a file. */
export type HyperframesFailure =
  | "missing-binary"
  | "missing-template"
  | "cancelled"
  | "timeout"
  | "exit-code"
  | "empty-output";

/**
 * A composition render that failed, carrying *why* as data.
 *
 * The pipeline treats these very differently — a cancellation is the user, a
 * timeout is a wedged Chrome worth retrying, a missing binary means the whole
 * feature is unavailable — and none of that survives string-matching a message.
 */
export class HyperframesError extends Error {
  readonly reason: HyperframesFailure;
  readonly exitCode: number;
  readonly stderr: string;
  readonly args: string[];

  constructor(
    reason: HyperframesFailure,
    message: string,
    details: { exitCode?: number; stderr?: string; args?: string[] } = {},
  ) {
    super(message);
    this.name = "HyperframesError";
    this.reason = reason;
    this.exitCode = details.exitCode ?? -1;
    this.stderr = details.stderr ?? "";
    this.args = details.args ?? [];
  }
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/**
 * Candidate locations for the pinned CLI.
 *
 * Never `npx`, and never `@latest`: a network fetch in the middle of a book
 * would let the renderer change between two segments of the same chapter, and
 * the bed rendered for segment 1 would stop matching the one rendered for
 * segment 40. Bun hoists workspace dependencies to the repo root but keeps a
 * per-workspace tree as well, so both are checked.
 */
function binaryCandidates(): string[] {
  const root = rootDir();
  return [
    join(root, "node_modules", ".bin", "hyperframes"),
    join(root, "server", "node_modules", ".bin", "hyperframes"),
  ];
}

/**
 * Path to the CLI, or null when it is not installed.
 *
 * `HYPERFRAMES_PATH` overrides the search the way `FFMPEG_PATH` does in
 * paths.ts — an operator relocating the binary is not the same thing as
 * falling back to a network fetch. The override is still stat'd: an env var
 * pointing at nothing must read as unavailable, not as a spawn failure later.
 *
 * Not memoised. The install can appear (a fresh `bun install`) or vanish under
 * a long-running server, and a stat is cheaper than being wrong about it.
 */
export function hyperframesBinaryPath(): string | null {
  const override = process.env.HYPERFRAMES_PATH;
  if (override) return existsSync(override) ? override : null;
  return binaryCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * Frame sizes the CLI can be asked for by name.
 *
 * `--resolution` is the only lever over output size: a composition's real
 * dimensions come from `data-width` / `data-height`, which are read at compile
 * time and cannot be driven by `--variables`. The CLI supersamples through
 * Chrome's deviceScaleFactor, so it refuses an aspect that does not match the
 * composition or a scale that is not an integer.
 */
const RESOLUTION_PRESETS: ReadonlyArray<[number, number, string]> = [
  [1920, 1080, "landscape"],
  [1080, 1920, "portrait"],
  [1080, 1080, "square"],
  [3840, 2160, "landscape-4k"],
  [2160, 3840, "portrait-4k"],
  [2160, 2160, "square-4k"],
];

/** Preset name for a frame size, or null when the CLI has no name for it. */
export function resolutionPreset(width: number, height: number): string | null {
  return RESOLUTION_PRESETS.find(([w, h]) => w === width && h === height)?.[2] ?? null;
}

/**
 * Full `hyperframes` argument list for one composition. Pure, for testability.
 *
 * The project directory is not an argument: it is the process's cwd, which is
 * the invocation the T0 spike proved end to end. `--output` therefore has to be
 * absolute or the file lands inside the template directory — renderComposition
 * resolves it before calling here, and this function passes it through verbatim
 * so an assertion can compare it against exactly what the caller asked for.
 */
export function buildRenderArgs(options: CompositionRenderOptions): string[] {
  const fps = options.fps && options.fps > 0 ? options.fps : DEFAULT_FPS;
  const workers = options.workers && options.workers > 0 ? options.workers : DEFAULT_WORKERS;

  const args = [
    "render",
    "--quality",
    options.quality ?? DEFAULT_QUALITY,
    "--fps",
    String(fps),
    "--workers",
    String(workers),
  ];

  const preset = resolutionPreset(options.width, options.height);
  // Asking by name means a template authored at the wrong aspect fails while the
  // CLI is still parsing arguments, before Chrome starts. Staying silent instead
  // would produce a correctly-named, wrongly-shaped asset that the caller caches
  // and every later segment reuses.
  if (preset) args.push("--resolution", preset);

  // Values are handed to the process as one argv entry, so there is no shell to
  // quote for; JSON.stringify is the whole encoding. A book title carrying
  // quotes, backslashes or non-Latin script is therefore already correct.
  const variables = options.variables ?? {};
  if (Object.keys(variables).length > 0) args.push("--variables", JSON.stringify(variables));

  // Only asked for when someone is listening: without a progress consumer the
  // command line stays byte-identical to the one the spike verified.
  if (options.onProgress) args.push("--json");

  args.push("--output", options.outputFile);
  return args;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * Reads a render-progress fraction out of one `--json` event line.
 *
 * Deliberately forgiving about the key names and about percent-versus-fraction:
 * progress is a nicety, and the render must not fail — or stall — because the
 * CLI renamed a field. Anything unrecognised is noise and returns null.
 */
export function parseProgressFraction(line: string): number | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }

  // A percent key is unambiguous; a "progress" key is 0..1 in some emitters and
  // 0..100 in others, so it is only rescaled once it exceeds 1.
  for (const key of ["percent", "percentage", "progressPercent"]) {
    const value = Number(event[key]);
    if (Number.isFinite(value)) return clampFraction(value / 100);
  }
  for (const key of ["progress", "fraction", "ratio"]) {
    const value = Number(event[key]);
    if (Number.isFinite(value)) return clampFraction(value > 1 ? value / 100 : value);
  }

  const done = firstFiniteNumber(event, ["frame", "frames", "framesRendered", "completed", "current"]);
  const total = firstFiniteNumber(event, ["totalFrames", "frameCount", "total"]);
  if (done !== null && total !== null && total > 0) return clampFraction(done / total);

  return null;
}

function firstFiniteNumber(event: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = Number(event[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Wraps an `onProgress` callback so a frame-by-frame event stream cannot become
 * a write-by-write database load.
 *
 * `updateTask()` is an unthrottled Mongo upsert, and a 20s bed at 15 fps emits
 * 300 events. Reports are coalesced to one per interval, except when progress
 * jumps by `minDelta` or reaches the end — a stalled bar is worse than a chatty
 * one. Callback failures are swallowed for the same reason the fraction parser
 * is forgiving: nothing about progress may sink a render.
 */
export function createProgressThrottle(
  onProgress: (fraction: number) => void,
  intervalMs = PROGRESS_INTERVAL_MS,
  minDelta = PROGRESS_MIN_DELTA,
): (fraction: number) => void {
  let lastReportedAt = 0;
  let lastFraction = -1;

  return (fraction: number) => {
    // Workers finish out of order, so a raw event stream is not monotonic and
    // would otherwise walk the UI's progress bar backwards.
    if (fraction <= lastFraction) return;

    const now = Date.now();
    const dueByTime = now - lastReportedAt >= intervalMs;
    const dueByDelta = fraction - lastFraction >= minDelta;
    if (!dueByTime && !dueByDelta && fraction < 1) return;

    lastReportedAt = now;
    lastFraction = fraction;
    try {
      onProgress(fraction);
    } catch (error) {
      logger.warning(`composition progress callback failed: ${errorMessage(error)}`);
    }
  };
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

interface AvailabilityVerdict {
  ok: boolean;
  checkedAt: number;
}

let availability: AvailabilityVerdict | undefined;
let availabilityInFlight: Promise<boolean> | undefined;

/**
 * The checks that decide whether this host can render a composition.
 *
 * Deliberately NOT the payload's own `.ok`, which is the aggregate of every
 * check the CLI knows how to run — including three optional local media
 * fallbacks (`whisper-cpp`, `TTS (Kokoro)`, `BGM (MusicGen)`) that VidGen
 * supplies itself and will therefore never satisfy, plus `Docker` / `Docker
 * running`, which matter only for `render --docker`.
 *
 * Gating on `.ok` looks right and is catastrophically wrong here: on this
 * repo's own development machine, and inside the image built for it, every one
 * of the four checks below passes while `.ok` is false. Reading `.ok` would
 * make hyperframesAvailable() answer false on essentially every real host and
 * silently disable the whole feature — a book would render as today's still and
 * nothing would look broken.
 */
const REQUIRED_DOCTOR_CHECKS = ["Node.js", "Chrome", "FFmpeg", "FFprobe"] as const;

/**
 * Reads `doctor --json`'s verdict out of its stdout.
 *
 * The command always exits 0 — it reports a broken environment as a payload,
 * not as a status — so the exit code says nothing. The payload is located
 * rather than parsed off the whole stream, because a warning line ahead of it
 * must not read as a failed environment.
 *
 * A payload carrying none of the required checks (an older or future CLI whose
 * check names moved) falls back to `.ok`, which is wrong in the permissive
 * direction rather than the fatal one: a render that should not have been
 * attempted fails loudly and degrades, where a feature switched off by a
 * missing optional dependency fails silently and forever.
 */
export function parseDoctorOk(stdout: string): boolean {
  const text = String(stdout ?? "");
  const candidates = [text];

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const payload = JSON.parse(candidate) as {
        ok?: unknown;
        checks?: { name?: unknown; ok?: unknown }[];
      };

      const checks = Array.isArray(payload?.checks) ? payload.checks : [];
      const required = checks.filter(
        (check) => typeof check?.name === "string" && (REQUIRED_DOCTOR_CHECKS as readonly string[]).includes(check.name),
      );
      if (required.length > 0) return required.every((check) => check.ok === true);

      return payload?.ok === true;
    } catch {
      // Try the next framing.
    }
  }
  return false;
}

/**
 * Whether a composition can actually be rendered on this host right now.
 *
 * Not a process-lifetime memo, which is what supportsAssBurn() uses and what is
 * right for a static ffmpeg binary. The thing being probed here is Chrome, and
 * Chrome dies: an OOM-killed browser behind a cached `true` fails every
 * remaining segment of a book with no way back. Hence a short TTL, plus
 * invalidateHyperframesAvailability() on any render failure.
 *
 * An absent binary answers without spawning and without caching — there is
 * nothing to ask, and a `bun install` may put it there a second from now.
 */
export async function hyperframesAvailable(): Promise<boolean> {
  const binary = hyperframesBinaryPath();
  if (!binary) return false;

  const cached = availability;
  if (cached && Date.now() - cached.checkedAt < AVAILABILITY_TTL_MS) return cached.ok;

  // Shared so a book starting 2 segments at once pays for one doctor run.
  availabilityInFlight ??= runDoctor(binary).finally(() => {
    availabilityInFlight = undefined;
  });
  return availabilityInFlight;
}

async function runDoctor(binary: string): Promise<boolean> {
  let ok = false;
  try {
    const proc = Bun.spawn([binary, "doctor", "--json"], {
      env: rendererEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      // Detached for the same reason a render is: doctor launches Chrome to
      // check it, and only a group leader makes a negative pid mean its own
      // tree rather than whatever group happens to share that number.
      detached: true,
    });

    const timer = setTimeout(() => signalGroup(proc.pid, "SIGKILL"), DOCTOR_TIMEOUT_MS);

    try {
      const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      ok = parseDoctorOk(stdout);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    logger.warning(`hyperframes doctor failed to run: ${errorMessage(error)}`);
    ok = false;
  }

  if (!ok) logger.warning("hyperframes reported an unhealthy environment; composition renders are off");
  availability = { ok, checkedAt: Date.now() };
  return ok;
}

/** Drops the cached verdict so the next caller re-probes. */
export function invalidateHyperframesAvailability(): void {
  availability = undefined;
}

/** Test seam, mirroring __resetCapabilityCacheForTest(). */
export function __resetHyperframesAvailabilityForTest(): void {
  availability = undefined;
  availabilityInFlight = undefined;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * Environment for every CLI invocation.
 *
 * `HYPERFRAMES_SKIP_SKILLS` suppresses a skills-registry check that has nothing
 * to do with rendering and that a sealed container cannot satisfy.
 */
function rendererEnv(): Record<string, string | undefined> {
  return { ...process.env, HYPERFRAMES_SKIP_SKILLS: "1" };
}

/**
 * Signals the child's whole process group.
 *
 * This is the one place this module must not copy runFfmpeg(), which kills the
 * direct child. ffmpeg *is* the direct child; `hyperframes` is a Node process
 * that forks a Chrome tree, and killing the pid alone orphans several browsers
 * that go on holding a GB of RAM and a lock on the output file. The child is
 * spawned detached — `setsid()`, so it leads its own group — which is what
 * makes a negative pid mean "everything it started".
 */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is already gone, which is the outcome we wanted.
  }
}

/**
 * Tears the child down, group and all.
 *
 * Measured under a real aborted render (T10): the tree is one CLI plus six
 * `chrome-headless-shell` processes, and all seven are gone within three
 * seconds of the abort, attributed per-pid rather than by process name.
 *
 * An explicit descendant sweep was added here on the strength of a reported
 * Chrome leak and then removed again: the "leak" was another process on the
 * same machine, and this group kill was already reaping the whole tree. What is
 * NOT tested is replacing it with a plain `proc.kill()` on the direct child —
 * that is the runFfmpeg shape, and the reasoning in signalGroup() above says why
 * it would not be enough for a Node process that forks a browser. Treat that as
 * argued, not as measured, before anyone "simplifies" this.
 */
function terminateGroup(pid: number): void {
  signalGroup(pid, "SIGTERM");
  // Chrome mid-capture does not always act on SIGTERM, and a hung renderer that
  // ignored the polite ask is exactly the case a timeout exists for.
  const escalation = setTimeout(() => signalGroup(pid, "SIGKILL"), KILL_GRACE_MS);
  escalation.unref?.();
}

/** Streams a piped stdout to a line callback without buffering the whole run. */
async function forEachLine(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      onLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (buffer.length > MAX_STDOUT_LINE) buffer = buffer.slice(-MAX_STDOUT_LINE);
  }

  if (buffer.trim()) onLine(buffer);
}

/**
 * Whether a failure was the CLI rejecting an argument rather than a bad render.
 *
 * `--json` on a plain (non-batch) render is documented inconsistently across
 * CLI versions. Rather than pin behaviour we cannot verify here, a render that
 * dies at argument parsing is retried once without it — which costs nothing,
 * because nothing has been rendered yet at that point.
 */
export function isUnknownOptionError(stderr: string): boolean {
  return /unknown (option|argument|flag|command)|unrecognized option|too many arguments/i.test(
    String(stderr ?? ""),
  );
}

/** Probes a file and returns its info only if it is a real, non-empty video. */
async function probeUsableVideo(filePath: string): Promise<MediaInfo | null> {
  if (!existsSync(filePath)) return null;
  try {
    const info = await probe(filePath);
    return info.hasVideo && info.duration > 0 ? info : null;
  } catch {
    return null;
  }
}

interface SpawnOutcome {
  exitCode: number;
  stderr: string;
  args: string[];
}

/**
 * Runs the CLI once and waits for it. Throws HyperframesError on a timeout or a
 * cancellation; a non-zero exit is returned as data so the caller can decide
 * whether it is worth another attempt.
 */
async function runRender(
  binary: string,
  templateDir: string,
  args: string[],
  options: CompositionRenderOptions,
): Promise<SpawnOutcome> {
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const report = options.onProgress ? createProgressThrottle(options.onProgress) : undefined;

  logger.debug(`spawn: ${binary} ${args.join(" ")} (cwd ${templateDir})`);

  const proc = Bun.spawn([binary, ...args], {
    cwd: templateDir,
    env: rendererEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // See signalGroup(): this is what makes the Chrome tree killable.
    detached: true,
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminateGroup(proc.pid);
  }, timeoutMs);

  const onAbort = () => terminateGroup(proc.pid);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const [, stderrRaw, exitCode] = await Promise.all([
      // Always drained, whether or not anyone reads it: a full pipe would block
      // the renderer with no error and no output.
      forEachLine(proc.stdout, (line) => {
        if (!report) return;
        const fraction = parseProgressFraction(line);
        if (fraction !== null) report(fraction);
      }),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const stderr =
      stderrRaw.length > MAX_CAPTURED_STDERR ? stderrRaw.slice(-MAX_CAPTURED_STDERR) : stderrRaw;

    if (timedOut) {
      throw new HyperframesError("timeout", `composition render timed out after ${timeoutMs}ms`, {
        exitCode,
        stderr,
        args,
      });
    }
    if (options.signal?.aborted) {
      throw new HyperframesError("cancelled", "composition render was cancelled", {
        exitCode,
        stderr,
        args,
      });
    }

    return { exitCode, stderr, args };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Renders one composition to `outputFile`.
 *
 * Reuses an existing render when one is already there and *probes as playable*
 * — an `existsSync` check alone would happily reuse a file truncated by a
 * previous crash, and a truncated file sitting at a valid cache key is reused
 * by every later segment of the book forever. New renders are written to a temp
 * name beside the target and renamed into place for the same reason: the
 * destination path never exists until the bytes behind it are complete.
 */
export async function renderComposition(
  options: CompositionRenderOptions,
): Promise<CompositionRenderResult> {
  // Checked before anything else, so a cancelled task spawns nothing at all.
  if (options.signal?.aborted) {
    throw new HyperframesError("cancelled", "composition render was cancelled before it started");
  }

  const templateDir = resolve(options.templateDir);
  const outputFile = resolve(options.outputFile);

  const existing = await probeUsableVideo(outputFile);
  if (existing) {
    logger.debug(`reusing composition render: ${outputFile}`);
    return { outputFile, duration: existing.duration, cached: true };
  }

  const binary = hyperframesBinaryPath();
  if (!binary) {
    throw new HyperframesError(
      "missing-binary",
      "hyperframes is not installed; expected node_modules/.bin/hyperframes",
    );
  }
  if (!existsSync(join(templateDir, "index.html"))) {
    throw new HyperframesError("missing-template", `composition has no index.html: ${templateDir}`);
  }

  await mkdir(dirname(outputFile), { recursive: true });

  // Same directory, so the rename is atomic on ordinary filesystems and Docker
  // mounts; same extension, because the CLI picks its container from it.
  const tempFile = join(
    dirname(outputFile),
    `.hf-${crypto.randomUUID().slice(0, 8)}-${basename(outputFile)}`,
  );
  const renderOptions: CompositionRenderOptions = { ...options, outputFile: tempFile };

  logger.info(
    `rendering composition: ${basename(templateDir)}, ${options.width}x${options.height} => ${outputFile}`,
  );

  try {
    let outcome = await runRender(binary, templateDir, buildRenderArgs(renderOptions), renderOptions);

    if (outcome.exitCode !== 0 && renderOptions.onProgress && isUnknownOptionError(outcome.stderr)) {
      logger.warning("hyperframes rejected --json; re-running this render without progress events");
      const withoutProgress: CompositionRenderOptions = { ...renderOptions, onProgress: undefined };
      outcome = await runRender(binary, templateDir, buildRenderArgs(withoutProgress), withoutProgress);
    }

    if (outcome.exitCode !== 0) {
      const detail = outcome.stderr.trim().split("\n").slice(-6).join("\n") || `exit code ${outcome.exitCode}`;
      throw new HyperframesError("exit-code", detail, {
        exitCode: outcome.exitCode,
        stderr: outcome.stderr,
        args: outcome.args,
      });
    }

    // The CLI can exit 0 having written nothing usable — a composition that
    // never registered a timeline, a Chrome that died between frames. Trusting
    // the status here is what puts an empty file at a valid cache key.
    const rendered = await probeUsableVideo(tempFile);
    if (!rendered) {
      throw new HyperframesError("empty-output", `composition render produced no usable video: ${templateDir}`, {
        exitCode: outcome.exitCode,
        stderr: outcome.stderr,
        args: outcome.args,
      });
    }

    if (rendered.width !== options.width || rendered.height !== options.height) {
      logger.warning(
        `composition rendered at ${rendered.width}x${rendered.height}, not the requested ` +
          `${options.width}x${options.height}: ${templateDir}`,
      );
    }

    await rename(tempFile, outputFile);
    logger.success(`composition rendered: ${rendered.duration.toFixed(2)}s => ${outputFile}`);
    return { outputFile, duration: rendered.duration, cached: false };
  } catch (error) {
    await unlink(tempFile).catch(() => {});
    // A user cancelling says nothing about the renderer's health; every other
    // failure might mean the Chrome behind a cached `true` has died.
    if (!(error instanceof HyperframesError && error.reason === "cancelled")) {
      invalidateHyperframesAvailability();
    }
    throw error;
  }
}
