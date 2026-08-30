/**
 * Static media and SPA serving.
 *
 * Task media needs byte-range support so browsers can seek in generated MP4s,
 * and every path must stay inside the task directory — both behaviours are
 * ported from python-version/app/controllers/v1/video.py.
 */

import { closeSync, createReadStream, existsSync, openSync, readSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { extname, join } from "node:path";
import type { Context } from "hono";
import { resolvePathWithinDirectory, UnsafePathError } from "../utils/fileSecurity.ts";
import { logger } from "../utils/logger.ts";
import { taskDir, webDistDir } from "../utils/paths.ts";

const MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".srt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function contentType(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parses a single HTTP byte range, mapping anything invalid or out of bounds
 * to a 416.
 *
 * Multi-part ranges are rejected on purpose: honouring them would require a
 * multipart body, and returning one part with a mismatched Content-Range is
 * worse than refusing.
 */
export function parseByteRange(rangeHeader: string | null, fileSize: number): ByteRange | "unsatisfiable" {
  if (fileSize <= 0) return "unsatisfiable";
  if (!rangeHeader) return { start: 0, end: fileSize - 1 };

  if (!rangeHeader.startsWith("bytes=") || rangeHeader.includes(",")) return "unsatisfiable";

  const spec = rangeHeader.slice(6);
  const separator = spec.indexOf("-");
  if (separator < 0) return "unsatisfiable";

  const startText = spec.slice(0, separator);
  const endText = spec.slice(separator + 1);
  if (!startText && !endText) return "unsatisfiable";

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return "unsatisfiable";
    return { start: Math.max(fileSize - suffixLength, 0), end: fileSize - 1 };
  }

  const start = Number(startText);
  const end = endText ? Number(endText) : fileSize - 1;
  if (!Number.isInteger(start) || start < 0 || start >= fileSize) return "unsatisfiable";
  if (!Number.isInteger(end) || end < start) return "unsatisfiable";

  return { start, end: Math.min(end, fileSize - 1) };
}

/** Serves a file with Range support, streaming rather than buffering. */
export function serveFileWithRange(
  c: Context,
  filePath: string,
  forceDownload = false,
  /** Sent verbatim when given. Callers serving immutable content set it. */
  cacheControl?: string,
): Response {
  const size = statSync(filePath).size;
  const range = parseByteRange(c.req.header("Range") ?? null, size);

  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
    });
  }

  const { start, end } = range;
  const length = end - start + 1;
  const isPartial = c.req.header("Range") != null;

  const headers: Record<string, string> = {
    "Content-Type": contentType(filePath),
    "Content-Length": String(length),
    "Accept-Ranges": "bytes",
  };
  if (isPartial) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  if (cacheControl) headers["Cache-Control"] = cacheControl;
  if (forceDownload) {
    headers["Content-Disposition"] = `attachment; filename="${encodeURIComponent(filePath.split("/").pop() ?? "download")}"`;
  }

  return new Response(rangeBody(filePath, start, end), {
    status: isPartial ? 206 : 200,
    headers,
  });
}

/**
 * Largest range read into memory rather than streamed. Four mebibytes covers
 * the windows a video element actually asks for while seeking; a handful of
 * concurrent viewers at that size is megabytes resident, not gigabytes.
 */
const MAX_BUFFERED_RANGE = 4 * 1024 * 1024;

/**
 * A body for `[start, end]` that survives being re-wrapped.
 *
 * The obvious form — `Bun.file(path).slice(start, end + 1)` — is correct in
 * isolation and correct on `/tasks/*`, but silently wrong under `/api/*`, and
 * the reason is invisible from either side:
 *
 *   Hono's `Context`'s `res` setter re-wraps an assigned response as
 *   `new Response(_res.body, _res)` (hono 4.13.1, `dist/context.js`) once
 *   anything has touched `c.res` — which the CORS middleware mounted on
 *   `/api/*` does. Re-wrapping reads `.body`, and Bun's conversion of a
 *   *sliced* `BunFile` to a stream keeps the slice's start offset but loses
 *   its end, so the body runs to end-of-file.
 *
 * Measured before this fix, `Range: bytes=0-1023` on a 23,139,933-byte task
 * video through `/api/v1/stream/*`: status 206, `Content-Range: bytes
 * 0-1023/23139933`, and 23,139,933 bytes of body. Correct headers, whole file.
 * A player seeking on that receives bytes that do not match the range it was
 * promised, and nothing reports an error. `/tasks/*` escaped it only by being
 * registered on the root app, with no `/api/*` middleware to touch `c.res`.
 *
 * Two forms survive re-wrapping. Bytes, for a range small enough to hold:
 * re-wrapping preserves it exactly and `Content-Length` stays accurate, which
 * is what players handle best. A node read stream over `{ start, end }` for
 * anything larger, including a whole file: correct at any size and never
 * resident, at the cost of Bun serving it chunked, so the client learns the
 * total from `Content-Range` instead.
 *
 * The read is positional and synchronous so this function keeps its signature.
 * Making it async would push `await` through `serveTaskFile`, the two video
 * routes, the book cover route and the BGM preview — a far wider change than
 * the bug warrants. `Bun.file(p).slice(a, b).stream()` is not an option: it
 * hangs.
 */
function rangeBody(filePath: string, start: number, end: number): Uint8Array | ReadableStream<Uint8Array> {
  const length = end - start + 1;

  if (length > MAX_BUFFERED_RANGE) {
    return Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>;
  }

  const buffer = new Uint8Array(length);
  const fd = openSync(filePath, "r");
  try {
    // One positional read cannot be assumed to return everything it was asked
    // for, so fill until the range is covered or the file ends short.
    let filled = 0;
    while (filled < length) {
      const read = readSync(fd, buffer, filled, length - filled, start + filled);
      if (read <= 0) break;
      filled += read;
    }
    return filled === length ? buffer : buffer.subarray(0, filled);
  } finally {
    closeSync(fd);
  }
}

/**
 * Serves a file from storage/tasks.
 *
 * Task ids and filenames come from URLs, so the path is confined to the task
 * directory before anything is opened.
 */
export function serveTaskFile(c: Context, relativePath: string, forceDownload = false): Response {
  const tasksDir = taskDir();
  let resolved: string;
  try {
    resolved = resolvePathWithinDirectory(tasksDir, decodeURIComponent(relativePath));
  } catch (error) {
    if (error instanceof UnsafePathError) {
      const status = error.message === "file does not exist" ? 404 : 403;
      logger.warning(`rejected task file request: path=${relativePath}, reason=${error.message}`);
      return c.json({ status, message: "invalid file path" }, status);
    }
    throw error;
  }
  return serveFileWithRange(c, resolved, forceDownload);
}

/**
 * Serves the built SPA, falling back to index.html so client-side routes work.
 * Returns null when no build exists, letting the caller explain how to build.
 */
export function serveSpa(c: Context, requestPath: string): Response | null {
  const dist = webDistDir();
  const indexPath = join(dist, "index.html");
  if (!existsSync(indexPath)) return null;

  const relative = requestPath.replace(/^\/+/, "");
  if (relative) {
    try {
      const asset = resolvePathWithinDirectory(dist, relative);
      // Long cache for fingerprinted bundles, none for anything else.
      const immutable = /\/assets\//.test(asset);
      return new Response(Bun.file(asset), {
        headers: {
          "Content-Type": contentType(asset),
          "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        },
      });
    } catch {
      // Not a real asset — fall through to the SPA shell.
    }
  }

  return new Response(Bun.file(indexPath), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
