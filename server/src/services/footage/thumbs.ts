/**
 * Poster frames for the footage gallery.
 *
 * A grid of 1,512 clips cannot be a grid of 1,512 `<video>` elements — that is
 * twenty gigabytes of range requests to paint one screen. So each clip gets one
 * small JPEG, and this module is the whole of how it comes to exist.
 *
 * Three properties, in the order they matter:
 *
 * **1. On demand, never as a batch.** There is no build step, no migration and
 * no "generate thumbnails" command to forget to run. The first request for a
 * clip's poster makes it; every later one is a file read. Deleting
 * `storage/footage_thumbs` is therefore a supported operation rather than a
 * corruption — the cache refills itself one visible clip at a time, which also
 * makes it the fix for a bad frame.
 *
 * **2. Bounded.** ffmpeg is spawned with a timeout. A truncated download or a
 * file whose moov atom never arrived can hold a decoder open indefinitely, and
 * an unbounded spawn on a request path means one bad clip wedges a worker for
 * as long as the process lives. The timeout converts that into one 500 for one
 * tile.
 *
 * **3. Atomic.** Two browsers scrolling the same row ask for the same missing
 * poster at the same time. Both may run ffmpeg — wasteful, not harmful — but
 * neither can be served a half-written JPEG, because each writes a uniquely
 * named temp file and renames it into place. `saveVideo` does the same thing
 * for the same reason. Within one process an in-flight map collapses the
 * duplicates so the common case costs a single encode.
 */

import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import { resolvePathWithinDirectory, UnsafePathError } from "../../utils/fileSecurity.ts";
import { errorMessage, logger } from "../../utils/logger.ts";
import { cacheVideosDir, storageDir } from "../../utils/paths.ts";
import { FfmpegError, runFfmpeg } from "../video/ffmpeg.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Long edge of the poster, in pixels.
 *
 * Sized for a gallery tile on a retina display and nothing more. The scale
 * filter clamps rather than fixes the width, so a clip narrower than this is
 * never upscaled into a bigger file than its own source frame.
 */
export const THUMB_WIDTH = 480;

/**
 * Where ffmpeg is told to seek, in seconds.
 *
 * Frame 0 of stock footage is routinely a fade-in from black, which makes a
 * grid of black squares. One second in is past the fade on essentially every
 * clip and still inside the shortest ones the library holds.
 */
export const THUMB_SEEK_SECONDS = 1;

/**
 * Wall-clock ceiling for one encode.
 *
 * A single frame off a local file takes tens of milliseconds; anything near
 * this bound is a file that will never decode. Generous enough that a cold page
 * cache on a spinning disk is not mistaken for corruption.
 */
const THUMB_TIMEOUT_MS = 20_000;

/** JPEG quality for `-q:v`. 2–5 is visually clean; 3 is ~30 kB at this width. */
const THUMB_QUALITY = 3;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The poster cache. Created on demand, like every other storage directory. */
export function footageThumbsDir(create = true): string {
  return storageDir("footage_thumbs", create);
}

/**
 * The poster filename for a clip.
 *
 * `basename` is not decoration: this value names a file that is about to be
 * written, and the argument reaches it from a URL. Reducing to the final path
 * segment before the extension is swapped means no input can name a path.
 */
export function thumbFileName(localFile: string): string {
  const file = basename(String(localFile ?? "").trim());
  if (!file || file === "." || file === "..") {
    throw new UnsafePathError("invalid clip name");
  }
  const extension = extname(file);
  const stem = extension ? file.slice(0, -extension.length) : file;
  return `${stem}.jpg`;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Filter graph for the poster.
 *
 * `min(480,iw)` clamps instead of forcing, so a small clip is not upscaled, and
 * `-2` keeps the aspect ratio while rounding the height to an even number that
 * the JPEG encoder accepts. The comma inside `min()` is escaped because ffmpeg
 * parses a bare comma as the separator between two filters.
 */
const SCALE_FILTER = `scale=min(${THUMB_WIDTH}\\,iw):-2`;

/**
 * ffmpeg arguments for one poster.
 *
 * `-ss` before `-i` is the fast seek: ffmpeg jumps to the nearest keyframe
 * without decoding the frames it skips, which is what keeps this cheap enough
 * to do on a request. `-an` drops the audio stream so no decoder is started for
 * it, and `-frames:v 1` stops after the single frame.
 */
export function thumbFfmpegArgs(source: string, destination: string, seekSeconds: number): string[] {
  const args: string[] = [];
  if (seekSeconds > 0) args.push("-ss", String(seekSeconds));
  args.push(
    "-i",
    source,
    "-frames:v",
    "1",
    "-an",
    "-vf",
    SCALE_FILTER,
    "-q:v",
    String(THUMB_QUALITY),
    "-f",
    "image2",
    "-y",
    destination,
  );
  return args;
}

/** True when the path names a file with bytes in it. */
function hasBytes(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

/**
 * Runs one encode into a temp file and renames it over the target.
 *
 * The rename is the publication step, and it is atomic within a filesystem, so
 * a reader either sees no poster or sees a complete one. Never a partial file,
 * which is the failure a naive "write straight to the cache path" would hand to
 * whichever browser asked second.
 */
async function encodeThumb(source: string, destination: string, seekSeconds: number): Promise<void> {
  const temporary = join(
    footageThumbsDir(),
    `.${basename(destination)}.${process.pid}.${randomBytes(6).toString("hex")}.part`,
  );

  try {
    await runFfmpeg(thumbFfmpegArgs(source, temporary, seekSeconds), {
      timeoutMs: THUMB_TIMEOUT_MS,
    });

    // ffmpeg can exit 0 having written nothing — a seek past the last frame is
    // the usual way. An empty file renamed into the cache would be a permanent
    // broken image, so it is treated as the failure it is.
    if (!hasBytes(temporary)) {
      throw new Error("ffmpeg produced an empty frame");
    }

    await rename(temporary, destination);
  } finally {
    // A no-op after a successful rename. Swallowed so a cleanup failure cannot
    // mask the real error on the way out.
    await unlink(temporary).catch(() => {});
  }
}

/** In-flight generations, keyed by destination, so one process encodes once. */
const inFlight = new Map<string, Promise<string>>();

/**
 * The poster for a clip, generating it if this is the first request.
 *
 * The source is resolved through `resolvePathWithinDirectory`, so a caller
 * cannot name a file outside the cache directory however the argument was
 * spelled; an `UnsafePathError` from here means either traversal or a clip that
 * is not on disk, and the route distinguishes them by message the same way
 * `serveTaskFile` does.
 */
export async function ensureThumb(localFile: string): Promise<string> {
  const source = resolvePathWithinDirectory(cacheVideosDir(false), localFile);
  const destination = join(footageThumbsDir(), thumbFileName(localFile));

  if (hasBytes(destination)) return destination;

  const existing = inFlight.get(destination);
  if (existing) return existing;

  const generation = (async () => {
    try {
      await encodeThumb(source, destination, THUMB_SEEK_SECONDS);
    } catch (error) {
      // Two clips reach here: one shorter than the seek, where frame 0 is the
      // only frame there is, and one whose keyframe at 1 s is unreadable. Both
      // are answered the same way, and only a second failure is a real one.
      logger.debug(
        `footage thumb: seek to ${THUMB_SEEK_SECONDS}s failed for ${basename(source)}, ` +
          `falling back to frame 0 (${errorMessage(error)})`,
      );
      try {
        await encodeThumb(source, destination, 0);
      } catch (fallbackError) {
        const detail =
          fallbackError instanceof FfmpegError
            ? fallbackError.message.split("\n").slice(-2).join(" ")
            : errorMessage(fallbackError);
        logger.warning(`footage thumb failed for ${basename(source)}: ${detail}`);
        throw fallbackError;
      }
    }
    return destination;
  })().finally(() => {
    inFlight.delete(destination);
  });

  inFlight.set(destination, generation);
  return generation;
}

/**
 * Whether a poster is already cached, without generating one.
 *
 * Exists for callers that want to report cache state rather than pay for a
 * miss — nothing on the serving path needs it, and nothing on the serving path
 * should use it as a pre-check, because the answer can change underneath.
 */
export function thumbIsCached(localFile: string): boolean {
  if (!existsSync(footageThumbsDir(false))) return false;
  try {
    return hasBytes(join(footageThumbsDir(false), thumbFileName(localFile)));
  } catch {
    return false;
  }
}
