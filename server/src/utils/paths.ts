/**
 * Filesystem layout and external binary resolution.
 * Ported from python-version/app/utils/utils.py.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.ts";

/**
 * Repository root. `import.meta.dir` points at server/src/utils, so three
 * levels up is the workspace root that owns resource/ and storage/.
 *
 * APP_ROOT overrides it for deployments that relocate the compiled server.
 */
const DERIVED_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ROOT = process.env.APP_ROOT ? resolve(process.env.APP_ROOT) : DERIVED_ROOT;

export function rootDir(): string {
  return ROOT;
}

function ensure(dir: string): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function storageDir(subDir = "", create = false): string {
  const dir = subDir ? join(ROOT, "storage", subDir) : join(ROOT, "storage");
  return create ? ensure(dir) : dir;
}

export function resourceDir(subDir = ""): string {
  return subDir ? join(ROOT, "resource", subDir) : join(ROOT, "resource");
}

/** Task output directory. Always created, matching `utils.task_dir()`. */
export function taskDir(subDir = ""): string {
  const base = join(storageDir(), "tasks");
  return ensure(subDir ? join(base, subDir) : base);
}

/**
 * Book storage directory, mirroring `taskDir()`.
 *
 * A book's extracted structure is far too large for a Mongo document, so it
 * lives here as `<bookId>/structure.json` alongside the cover image, and the
 * database keeps only pointers to it.
 */
export function booksDir(subDir = ""): string {
  const base = join(storageDir(), "books");
  return ensure(subDir ? join(base, subDir) : base);
}

export function fontDir(subDir = ""): string {
  const base = resourceDir("fonts");
  return ensure(subDir ? join(base, subDir) : base);
}

export function songDir(subDir = ""): string {
  const base = resourceDir("songs");
  return ensure(subDir ? join(base, subDir) : base);
}

/** Uploaded background music, kept apart from the read-only built-in songs. */
export function uploadedBgmDir(create = true): string {
  const dir = join(storageDir(), "bgm");
  return create ? ensure(dir) : dir;
}

export function localVideosDir(create = true): string {
  const dir = join(storageDir(), "local_videos");
  return create ? ensure(dir) : dir;
}

export function cacheVideosDir(create = true): string {
  const dir = join(storageDir(), "cache_videos");
  return create ? ensure(dir) : dir;
}

/** Whisper model cache. Mirrors the Python app's models/ directory. */
export function modelsDir(create = true): string {
  const dir = join(ROOT, "models");
  return create ? ensure(dir) : dir;
}

/** Built SPA served in production. */
export function webDistDir(): string {
  return process.env.WEB_DIST ? resolve(process.env.WEB_DIST) : join(ROOT, "web", "dist");
}

// ---------------------------------------------------------------------------
// External binaries
// ---------------------------------------------------------------------------

function resolveBinary(explicitEnv: string | undefined, name: string): string {
  if (explicitEnv) return explicitEnv;

  // Bun.which searches PATH the way shutil.which does in the Python version.
  const onPath = Bun.which(name);
  if (onPath) return onPath;

  logger.warning(
    `${name} was not found on PATH; falling back to bare "${name}". ` +
      `Install it, or set ${name.toUpperCase()}_PATH.`,
  );
  return name;
}

let cachedFfmpeg: string | undefined;
let cachedFfprobe: string | undefined;

/**
 * FFmpeg drives every video and audio operation, so all call sites resolve it
 * here. Priority: explicit FFMPEG_PATH, then PATH, then the bare name so the
 * spawn failure surfaces the real error.
 */
export function getFfmpegBinary(): string {
  cachedFfmpeg ??= resolveBinary(process.env.FFMPEG_PATH, "ffmpeg");
  return cachedFfmpeg;
}

export function getFfprobeBinary(): string {
  cachedFfprobe ??= resolveBinary(process.env.FFPROBE_PATH, "ffprobe");
  return cachedFfprobe;
}

/** Test seam so suites can point the binaries at fixtures. */
export function __setBinariesForTest(ffmpeg?: string, ffprobe?: string): void {
  cachedFfmpeg = ffmpeg;
  cachedFfprobe = ffprobe;
}
