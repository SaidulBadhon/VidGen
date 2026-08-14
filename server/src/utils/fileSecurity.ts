/**
 * Path confinement for user-supplied file references.
 * Ported from python-version/app/utils/file_security.py.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

/**
 * Resolves a real path and proves it still sits inside `baseDir`.
 *
 * User input reaches this as a bare filename, a relative path, an absolute
 * path, or something carrying `../`. Comparing fully resolved paths rather
 * than string prefixes covers symlinks, duplicate separators and traversal,
 * which is what the upload, material and task-artifact directories need.
 */
export function resolvePathWithinDirectory(
  baseDir: string,
  unsafePath: string,
  options: { requireFile?: boolean } = {},
): string {
  const { requireFile = true } = options;

  if (!unsafePath) {
    throw new UnsafePathError("empty path is not allowed");
  }

  // realpath only works on existing paths, so fall back to a lexical resolve
  // for the not-yet-created case; containment still holds either way.
  const baseDirReal = existsSync(baseDir) ? realpathSync(baseDir) : resolve(baseDir);

  const candidate = isAbsolute(unsafePath) ? unsafePath : join(baseDirReal, unsafePath);
  const resolved = existsSync(candidate) ? realpathSync(candidate) : resolve(candidate);

  if (!isWithin(baseDirReal, resolved)) {
    throw new UnsafePathError("path is outside the allowed directory");
  }

  if (requireFile) {
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      throw new UnsafePathError("file does not exist");
    }
  }

  return resolved;
}

/** True when `target` is `base` itself or lives underneath it. */
export function isWithin(base: string, target: string): boolean {
  if (target === base) return true;
  const prefix = base.endsWith(sep) ? base : base + sep;
  return target.startsWith(prefix);
}

/**
 * Reduces a browser-supplied filename to a bare name.
 *
 * Clients sometimes send directory components, occasionally including `../`.
 * Keeping only the final segment stops uploads landing outside the target
 * directory.
 */
export function sanitizeUploadFilename(filename: string | undefined | null): string {
  const normalized = String(filename ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.trim();

  if (!normalized || normalized === "." || normalized === "..") {
    throw new UnsafePathError("invalid filename");
  }
  return normalized;
}

const WINDOWS_INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

const MAX_OUTPUT_NAME_LENGTH = 120;

/**
 * Turns a book or segment title into a single filesystem path segment.
 *
 * Spaces and punctuation that are legal on disk are kept so Finder shows the
 * real chapter name; separators, control characters and Windows device names
 * are stripped so the folder cannot escape `storage/tasks`.
 */
export function sanitizeOutputName(name: string, fallback = "untitled"): string {
  let value = String(name ?? "")
    .replace(/[/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(WINDOWS_INVALID_NAME_CHARS, "")
    .replace(/^[. ]+/g, "")
    .replace(/[. ]+$/g, "");

  if (!value || value === "." || value === "..") value = fallback;

  const reserved = value.split(".")[0]!.toUpperCase();
  if (WINDOWS_RESERVED_NAMES.has(reserved)) value = `${fallback} ${value}`.trim();

  if (value.length > MAX_OUTPUT_NAME_LENGTH) {
    value = value.slice(0, MAX_OUTPUT_NAME_LENGTH).replace(/[. ]+$/g, "");
  }

  return value || fallback;
}
