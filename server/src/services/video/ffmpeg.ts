/**
 * Thin process wrapper around the ffmpeg / ffprobe binaries.
 *
 * Every video and audio operation in the app funnels through here so binary
 * resolution, timeouts and error reporting behave the same everywhere. This
 * replaces MoviePy, which the Python version used for compositing.
 */

import { getFfmpegBinary, getFfprobeBinary } from "../../utils/paths.ts";
import { logger } from "../../utils/logger.ts";

/** Keeps only the tail of ffmpeg's stderr; failures report the last lines. */
const MAX_CAPTURED_STDERR = 16_000;

export class FfmpegError extends Error {
  readonly exitCode: number;
  readonly stderr: string;
  readonly args: string[];

  constructor(message: string, exitCode: number, stderr: string, args: string[]) {
    super(message);
    this.name = "FfmpegError";
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.args = args;
  }
}

export interface RunOptions {
  /** Kills the process after this many milliseconds. */
  timeoutMs?: number;
  /** Aborts the run when this signal fires, used for task cancellation. */
  signal?: AbortSignal;
  /** Capture stdout as text. Off by default; renders write to files. */
  captureStdout?: boolean;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(binary: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs, signal, captureStdout = false } = options;

  logger.debug(`spawn: ${binary} ${args.join(" ")}`);

  const proc = Bun.spawn([binary, ...args], {
    stdin: "ignore",
    stdout: captureStdout ? "pipe" : "ignore",
    stderr: "pipe",
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
  }

  const onAbort = () => proc.kill();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const [stdout, stderrRaw, exitCode] = await Promise.all([
      captureStdout && proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
      proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
      proc.exited,
    ]);

    const stderr =
      stderrRaw.length > MAX_CAPTURED_STDERR ? stderrRaw.slice(-MAX_CAPTURED_STDERR) : stderrRaw;

    if (timedOut) {
      throw new FfmpegError(`${binary} timed out after ${timeoutMs}ms`, exitCode, stderr, args);
    }
    if (signal?.aborted) {
      throw new FfmpegError(`${binary} was cancelled`, exitCode, stderr, args);
    }
    if (exitCode !== 0) {
      const detail = stderr.trim().split("\n").slice(-6).join("\n") || `exit code ${exitCode}`;
      throw new FfmpegError(detail, exitCode, stderr, args);
    }

    return { stdout, stderr, exitCode };
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Runs ffmpeg. `-nostdin` prevents it consuming the server's stdin, and
 * `-hide_banner` plus an error-only log keeps captured stderr to real problems.
 */
export function runFfmpeg(args: string[], options: RunOptions = {}): Promise<RunResult> {
  return run(getFfmpegBinary(), ["-nostdin", "-hide_banner", "-loglevel", "error", ...args], options);
}

/** Runs ffmpeg without forcing the log level, for capability probes. */
export function runFfmpegRaw(args: string[], options: RunOptions = {}): Promise<RunResult> {
  return run(getFfmpegBinary(), ["-nostdin", "-hide_banner", ...args], {
    ...options,
    captureStdout: true,
  });
}

export function runFfprobe(args: string[], options: RunOptions = {}): Promise<RunResult> {
  return run(getFfprobeBinary(), ["-v", "error", ...args], { ...options, captureStdout: true });
}

/**
 * Escapes a value used inside an ffmpeg filter argument.
 *
 * Filter graphs treat `:` as an option separator, `'` as a quote and `\` as an
 * escape, so file paths (notably the subtitles filter) must be escaped or the
 * graph fails to parse.
 */
export function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,");
}

/** Formats a number for a filter expression without scientific notation. */
export function num(value: number, decimals = 4): string {
  if (!Number.isFinite(value)) return "0";
  return Number(value.toFixed(decimals)).toString();
}
