/**
 * The download-time provenance hook's directory guard.
 *
 * `isCacheVideoPath` is the whole reason the hook only ever speaks about the
 * shared cache: a render configured with its own `material_directory` writes
 * clips the library does not own and the indexer would never find again. The
 * guard is a literal comparison of `dirname(savedPath)` against
 * `cacheVideosDir(false)`, and every case here pins one half of that.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { isCacheVideoPath } from "../src/services/footage/hook.ts";
import { cacheVideosDir, storageDir } from "../src/utils/paths.ts";

const CACHE_DIR = cacheVideosDir(false);

// ---------------------------------------------------------------------------

describe("isCacheVideoPath", () => {
  test("accepts a clip saveVideo wrote into the shared cache", () => {
    expect(isCacheVideoPath(join(CACHE_DIR, "vid-d41d8cd98f00b204e9800998ecf8427e.mp4"))).toBe(true);
  });

  test("accepts any basename in that directory, not only vid-*.mp4", () => {
    // The clip-name filter is `index.ts`'s job; this guard is about location.
    expect(isCacheVideoPath(join(CACHE_DIR, "anything.mp4"))).toBe(true);
  });

  test("rejects an empty path", () => {
    expect(isCacheVideoPath("")).toBe(false);
  });

  test("rejects a clip in a caller-configured material directory", () => {
    expect(isCacheVideoPath(join(storageDir(), "local_videos", "vid-abc.mp4"))).toBe(false);
    expect(isCacheVideoPath("/tmp/other-materials/vid-abc.mp4")).toBe(false);
  });

  test("rejects a nested path below the cache directory", () => {
    // `saveVideo` builds `join(directory, "vid-….mp4")`, so anything deeper was
    // written by something else.
    expect(isCacheVideoPath(join(CACHE_DIR, "sub", "vid-abc.mp4"))).toBe(false);
  });

  test("rejects the cache directory itself and its parent", () => {
    expect(isCacheVideoPath(CACHE_DIR)).toBe(false);
    expect(isCacheVideoPath(storageDir())).toBe(false);
  });

  test("rejects a bare filename with no directory", () => {
    // `dirname("vid-abc.mp4")` is ".", which is not the cache directory.
    expect(isCacheVideoPath("vid-abc.mp4")).toBe(false);
  });

  test("rejects a sibling directory whose name merely starts the same way", () => {
    expect(isCacheVideoPath(`${CACHE_DIR}_old/vid-abc.mp4`)).toBe(false);
  });

  test("compares literally, so an unnormalised path is refused", () => {
    // Not a security boundary — the hook writes provenance, it does not open
    // the file — but it does mean the guard only ever fires for the exact path
    // `saveVideo` builds.
    // Built by concatenation rather than `join`, which would normalise it away.
    const unnormalised = `${CACHE_DIR}/../cache_videos/vid-abc.mp4`;
    expect(resolve(dirname(unnormalised))).toBe(CACHE_DIR);
    expect(isCacheVideoPath(unnormalised)).toBe(false);
  });

  test("asking does not create the directory it asks about", () => {
    const existedBefore = existsSync(CACHE_DIR);
    isCacheVideoPath(join(CACHE_DIR, "vid-abc.mp4"));
    // `cacheVideosDir(false)`: a guard must have no side effect.
    expect(existsSync(CACHE_DIR)).toBe(existedBefore);
  });
});
