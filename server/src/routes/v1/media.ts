/**
 * Background music, local materials, voices and cache management.
 * Ported from the media half of python-version/app/controllers/v1/video.py
 * plus the Streamlit cache-management panel.
 */

import { Hono } from "hono";
import { existsSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { footageIndexCollection } from "../../db/client.ts";
import { ALLOWED_MATERIAL_SUFFIXES } from "../../models/const.ts";
import { voicePreviewRequestSchema } from "../../models/schema.ts";
import { badRequest, conflict, notFound } from "../../http/errors.ts";
import { serveFileWithRange } from "../../http/staticFiles.ts";
import {
  BgmServiceError,
  BgmUploadError,
  listBgmFiles,
  resolveBgmFile,
  saveBgmUpload,
  sanitizeBgmFilename,
  SUPPORTED_BGM_EXTENSIONS,
} from "../../services/bgm.ts";
import { clearMaterialSearchCache, getMaterialSearchCacheStats } from "../../services/material/cache.ts";
import { isLocked as isFootageIndexLocked } from "../../services/footage/lock.ts";
import {
  deletePoints as deleteFootagePoints,
  isAvailable as isQdrantAvailable,
} from "../../services/footage/qdrant.ts";
import { pointIdFor } from "../../services/footage/types.ts";
import { taskQueue } from "../../tasks/queue.ts";
import { isNoVoice, listVoicesForServer } from "../../services/voice/voices.ts";
import { synthesizeVoicePreview } from "../../services/voice/preview.ts";
import * as sonilo from "../../services/music/sonilo.ts";
import * as elevenlabsMusic from "../../services/music/elevenlabsMusic.ts";
import * as uploadPost from "../../services/uploadPost.ts";
import { resolveWhisperBinary } from "../../services/subtitle/whisper.ts";
import { sanitizeUploadFilename, UnsafePathError } from "../../utils/fileSecurity.ts";
import { logger, errorMessage } from "../../utils/logger.ts";
import { getResponse, parseExtension } from "../../utils/misc.ts";
import { cacheVideosDir, localVideosDir } from "../../utils/paths.ts";

export const mediaRouter = new Hono();

// ---------------------------------------------------------------------------
// Background music
// ---------------------------------------------------------------------------

mediaRouter.get("/musics", (c) => {
  const files = listBgmFiles().map((file) => ({
    name: basename(file),
    size: statSync(file).size,
    // Only the filename is returned; the server re-resolves it inside the two
    // allow-listed directories rather than exposing host paths.
    file: basename(file),
  }));
  return c.json(getResponse(200, { files }));
});

mediaRouter.post("/musics", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw badRequest("a file field is required");

  try {
    const storedName = await saveBgmUpload(file.name, await file.arrayBuffer());
    return c.json(getResponse(200, { file: storedName }));
  } catch (error) {
    if (error instanceof BgmUploadError) {
      // Recoverable by choosing a different file: report the specific reason
      // without echoing file contents or server paths.
      logger.warning(`background music upload rejected: ${error.message}`);
      throw badRequest(error.message);
    }
    if (error instanceof BgmServiceError) {
      // A toolchain or storage fault is a server problem and must not be
      // presented as if the user's file were invalid.
      logger.error(`background music upload failed: ${error.message}`);
      throw badRequest("background music validation is unavailable");
    }
    throw error;
  }
});

mediaRouter.get("/musics/formats", (c) =>
  c.json(getResponse(200, { extensions: SUPPORTED_BGM_EXTENSIONS })),
);

/** Streams a library track so the settings UI can preview the current selection. */
mediaRouter.get("/musics/:name", (c) => {
  let safeName: string;
  try {
    safeName = sanitizeBgmFilename(c.req.param("name"));
  } catch {
    throw notFound("background music not found");
  }

  try {
    return serveFileWithRange(c, resolveBgmFile(safeName));
  } catch (error) {
    if (error instanceof UnsafePathError) throw notFound("background music not found");
    throw error;
  }
});

// ---------------------------------------------------------------------------
// Local video materials
// ---------------------------------------------------------------------------

mediaRouter.get("/video_materials", (c) => {
  const directory = localVideosDir(true);
  const files = existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => (ALLOWED_MATERIAL_SUFFIXES as readonly string[]).includes(parseExtension(name)))
        // Filesystem order is unstable, which would make "sequential" concat
        // behave differently between machines.
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
        .map((name) => ({ name, size: statSync(join(directory, name)).size, file: name }))
    : [];

  return c.json(getResponse(200, { files }));
});

mediaRouter.post("/video_materials", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw badRequest("a file field is required");

  let safeName: string;
  try {
    safeName = sanitizeUploadFilename(file.name);
  } catch (error) {
    if (error instanceof UnsafePathError) throw badRequest(error.message);
    throw error;
  }

  // Match on the full extension so `.MOV` works and `photojpg` does not pass
  // as an image.
  const suffix = extname(safeName).toLowerCase().replace(/^\./, "");
  if (!(ALLOWED_MATERIAL_SUFFIXES as readonly string[]).includes(suffix)) {
    throw badRequest(
      `Only files with extensions ${ALLOWED_MATERIAL_SUFFIXES.join(", ")} can be uploaded`,
    );
  }

  await Bun.write(join(localVideosDir(true), safeName), await file.arrayBuffer());
  return c.json(getResponse(200, { file: safeName }));
});

mediaRouter.delete("/video_materials/:name", async (c) => {
  const name = sanitizeUploadFilename(c.req.param("name"));
  const target = join(localVideosDir(true), name);
  if (!existsSync(target)) throw notFound("material not found");
  await rm(target, { force: true });
  return c.json(getResponse(200));
});

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

mediaRouter.get("/voices", async (c) => {
  const server = c.req.query("server") ?? "azure-tts-v1";
  const voices = await listVoicesForServer(server);
  return c.json(getResponse(200, { server, voices }));
});

mediaRouter.post("/voices/preview", async (c) => {
  const body = voicePreviewRequestSchema.parse(await c.req.json());
  if (isNoVoice(body.voice_name)) {
    throw badRequest("voice preview is not available when narration is disabled");
  }

  const preview = await synthesizeVoicePreview({
    text: body.text,
    voiceName: body.voice_name,
    voiceRate: body.voice_rate,
    voiceVolume: body.voice_volume,
    signal: c.req.raw.signal,
  });

  if (!preview) {
    throw badRequest(
      "The TTS service did not return preview audio. Check its settings and the application logs.",
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": preview.mimeType,
    "Content-Length": String(preview.bytes.byteLength),
    "Cache-Control": "no-store",
  };
  if (preview.duration != null) headers["X-Audio-Duration"] = preview.duration.toFixed(3);

  return new Response(preview.bytes, { status: 200, headers });
});

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

/**
 * Whether a cache-directory entry is a finished cached clip.
 *
 * `saveVideo` writes downloads to a `.vid-<hash>.<pid>.<rand>.part` temp in
 * this same directory and only renames it to `vid-<hash>.mp4` once it has been
 * probed. Both walkers below filter on the final name so an in-progress
 * download is neither counted as a cached clip nor deleted out from under the
 * render that is still writing it.
 */
function isCachedVideoName(name: string): boolean {
  return name.startsWith("vid-") && name.endsWith(".mp4");
}

mediaRouter.get("/cache/stats", async (c) => {
  const directory = cacheVideosDir(true);
  let files = 0;
  let bytes = 0;

  if (existsSync(directory)) {
    for (const name of readdirSync(directory)) {
      if (!isCachedVideoName(name)) continue;
      const stats = statSync(join(directory, name));
      if (!stats.isFile()) continue;
      files += 1;
      bytes += stats.size;
    }
  }

  const search = await getMaterialSearchCacheStats();
  return c.json(getResponse(200, { videos: { files, bytes }, search }));
});

/** Files deleted per `Promise.all` wave. Bounds open file descriptors. */
const CLEAR_UNLINK_CONCURRENCY = 32;

/** Mongo `_id`s per `deleteMany`. One round trip per chunk, not per clip. */
const CLEAR_MONGO_CHUNK_SIZE = 500;

mediaRouter.post("/cache/clear", async (c) => {
  const scope = c.req.query("scope") ?? "all";
  let removedFiles = 0;
  let removedSearches = 0;
  let removedRows = 0;
  let submittedPoints = 0;
  /** Whether the vector store was actually cleaned up, and if not, why not. */
  let qdrantCleanup: "not_needed" | "ok" | "unavailable" | "failed" = "not_needed";

  if (scope === "all" || scope === "videos") {
    // --- refuse to race an indexing run ------------------------------------
    // The indexer walks this directory and writes a row and a point per file.
    // Deleting underneath it produces points for files that no longer exist and
    // rows the next run will fail on, so the clear waits rather than competing.
    const lock = await isFootageIndexLocked().catch((error: unknown) => {
      // A Mongo outage is not "the lock is free": failing open here is how a
      // clear ends up running concurrently with an indexer anyway.
      logger.warning(`could not read the footage index lock: ${errorMessage(error)}`);
      throw conflict("the footage index lock could not be read; try again shortly");
    });
    if (lock) {
      throw conflict(
        `a footage index run is in progress (${lock.label}, ${lock.hostname} pid ${lock.pid}, ` +
          `held since ${lock.acquired_at.toISOString()}); try again when it finishes`,
      );
    }

    // --- refuse to race a live render --------------------------------------
    // A render resolves its materials from this directory and reads them for
    // the length of an ffmpeg encode. Clearing mid-render deletes clips out
    // from under it, and the failure surfaces minutes later as a broken
    // concat rather than as anything connected to this request.
    const queue = taskQueue.stats();
    if (queue.running > 0 || queue.queued > 0) {
      throw conflict(
        `the task queue is not idle (${queue.running} running, ${queue.queued} queued); ` +
          `clearing the cache now would delete clips out from under a render`,
      );
    }

    const directory = cacheVideosDir(true);
    // Age-based pruning: 0 or missing means "everything".
    const maxAgeDays = Number(c.req.query("max_age_days") ?? 0);
    const cutoff = maxAgeDays > 0 ? Date.now() - maxAgeDays * 86_400_000 : Infinity;

    // Collected first, deleted in batches. The per-file `rm`/`deleteOne`/
    // `delete` loop this replaced was three round trips per clip; at the ~1,000
    // clips this library is sized for that is thousands of sequential awaits in
    // one request, which is minutes of held connection.
    const doomed: string[] = [];
    if (existsSync(directory)) {
      for (const name of readdirSync(directory)) {
        if (!isCachedVideoName(name)) continue;
        const stats = statSync(join(directory, name));
        if (!stats.isFile()) continue;
        if (maxAgeDays > 0 && stats.mtimeMs > cutoff) continue;
        doomed.push(name);
      }
    }

    for (let start = 0; start < doomed.length; start += CLEAR_UNLINK_CONCURRENCY) {
      const wave = doomed.slice(start, start + CLEAR_UNLINK_CONCURRENCY);
      await Promise.all(wave.map((name) => rm(join(directory, name), { force: true })));
      removedFiles += wave.length;
    }

    // --- Mongo: one delete per chunk ---------------------------------------
    // The row is keyed by the same uuidv5 the point is, so the ids are derived
    // rather than looked up: no `find` pass, and no way for the two deletes to
    // disagree about which clip they are about.
    const ids = doomed.map((name) => pointIdFor(name));

    for (let start = 0; start < ids.length; start += CLEAR_MONGO_CHUNK_SIZE) {
      const chunk = ids.slice(start, start + CLEAR_MONGO_CHUNK_SIZE);
      try {
        const result = await footageIndexCollection().deleteMany({ _id: { $in: chunk } });
        removedRows += result.deletedCount ?? 0;
      } catch (error) {
        // The files are already gone, so the clear has happened. A stranded row
        // costs a re-describe at worst; `reconcile` unlinks it either way.
        logger.error(`cache clear could not drop footage rows: ${errorMessage(error)}`);
        break;
      }
    }

    // --- Qdrant: batched, and never fatal ----------------------------------
    // `deletePoints` chunks internally. A dead Qdrant must not fail a clear
    // whose files are already unlinked — the points it leaves behind are
    // orphans, which is exactly the drift `footage reconcile` exists to repair,
    // and which `GET /footage/stats` reports in the meantime.
    if (ids.length > 0) {
      try {
        if (await isQdrantAvailable()) {
          // `deletePoints` answers with the number of ids it submitted, not the
          // number of points that turned out to exist — Qdrant's delete is
          // idempotent and does not report per-id hits. The field below is
          // named for that, so a reader cannot mistake it for a measurement of
          // what the collection held.
          submittedPoints = await deleteFootagePoints(ids);
          qdrantCleanup = "ok";
        } else {
          qdrantCleanup = "unavailable";
          logger.warning(
            `cache clear removed ${ids.length} clip(s) but qdrant is unavailable; ` +
              `run \`footage reconcile\` to drop the orphaned points`,
          );
        }
      } catch (error) {
        qdrantCleanup = "failed";
        logger.error(
          `cache clear could not delete footage points: ${errorMessage(error)}; ` +
            `run \`footage reconcile\` to drop the orphaned points`,
        );
      }
    }
  }

  if (scope === "all" || scope === "search") {
    removedSearches = await clearMaterialSearchCache();
  }

  logger.info(
    `cache cleared: scope=${scope}, files=${removedFiles}, searches=${removedSearches}, ` +
      `footage_rows=${removedRows}, qdrant=${qdrantCleanup} (${submittedPoints} point id(s))`,
  );
  return c.json(
    getResponse(200, {
      removed_files: removedFiles,
      removed_searches: removedSearches,
      removed_footage_rows: removedRows,
      /** Point ids handed to Qdrant for deletion — not a count of stored points. */
      qdrant_points_submitted: submittedPoints,
      qdrant_cleanup: qdrantCleanup,
    }),
  );
});

// ---------------------------------------------------------------------------
// Provider connection tests
// ---------------------------------------------------------------------------

mediaRouter.post("/providers/:provider/test", async (c) => {
  const provider = c.req.param("provider");

  switch (provider) {
    case "sonilo":
      return c.json(getResponse(200, await sonilo.testConnection()));
    case "elevenlabs-music":
      return c.json(getResponse(200, await elevenlabsMusic.testConnection()));
    case "upload-post": {
      const status = await uploadPost.getUploadStatus();
      return c.json(
        getResponse(200, {
          success: status.success !== false,
          message: status.success !== false ? "Upload-Post account reachable" : String(status.error ?? "failed"),
        }),
      );
    }
    case "whisper": {
      const binary = resolveWhisperBinary();
      return c.json(
        getResponse(200, {
          success: Boolean(binary),
          message: binary
            ? `whisper.cpp found at ${binary}`
            : "whisper.cpp not found; install it or switch to an OpenAI-compatible endpoint",
        }),
      );
    }
    default:
      throw badRequest(`unknown provider: ${provider}`);
  }
});

export { errorMessage };
