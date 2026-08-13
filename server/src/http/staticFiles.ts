/**
 * Static media and SPA serving.
 *
 * Task media needs byte-range support so browsers can seek in generated MP4s,
 * and every path must stay inside the task directory — both behaviours are
 * ported from python-version/app/controllers/v1/video.py.
 */

import { existsSync, statSync } from "node:fs";
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
export function serveFileWithRange(c: Context, filePath: string, forceDownload = false): Response {
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
  if (forceDownload) {
    headers["Content-Disposition"] = `attachment; filename="${encodeURIComponent(filePath.split("/").pop() ?? "download")}"`;
  }

  // Bun streams a sliced BunFile without reading the whole file into memory.
  const body = Bun.file(filePath).slice(start, end + 1);
  return new Response(body, { status: isPartial ? 206 : 200, headers });
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
