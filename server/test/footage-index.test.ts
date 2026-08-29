/**
 * The work decision and the cache-file filter.
 *
 * `decideWork` is the one function that decides where Gemini spend happens: it
 * is the difference between a re-run costing nothing and a re-run re-describing
 * a thousand clips, and — in the other direction — between a hook-created row
 * being indexed and being written to Qdrant as an empty payload with no vector.
 * It is pure, so all of that is testable with no Mongo and no network.
 */

import { describe, expect, test } from "bun:test";

import {
  MAX_INDEX_ATTEMPTS,
  decideWork,
  isCacheClipName,
} from "../src/services/footage/index.ts";
import { DESCRIBE_VERSION, EMBED_VERSION } from "../src/services/footage/types.ts";
import type { FootageClipDescription, FootageIndexDocument } from "../src/db/types.ts";

const DESCRIPTION: FootageClipDescription = {
  summary: "A woman walks along a wet street.",
  detailed_description: "Medium shot, neon reflections.",
  use_cases: ["a segment on urban loneliness"],
  mood: ["melancholy"],
  tags: ["rain", "city"],
  setting: "outdoor",
  time_of_day: "night",
  has_people: true,
  has_on_screen_text: false,
  camera_motion: "handheld",
  quality_flags: [],
};

/** An indexed row at the current versions; cases override what they exercise. */
function row(overrides: Partial<FootageIndexDocument> = {}): FootageIndexDocument {
  return {
    _id: "8de7a8cb-3933-5b77-9052-d4c92240b863",
    local_file: "vid-a.mp4",
    state: "indexed",
    description: DESCRIPTION,
    provider: "pexels",
    search_terms: ["rain on window"],
    describe_version: DESCRIBE_VERSION,
    embed_version: EMBED_VERSION,
    attempts: 1,
    created_at: new Date(0),
    updated_at: new Date(0),
    ...overrides,
  };
}

/**
 * Exactly what `hook.ts` writes when a render downloads a clip: provenance and
 * nothing else. This row is the hazard `decideWork` exists to guard.
 */
function hookCreatedRow(): FootageIndexDocument {
  return row({
    state: "stale",
    describe_version: 0,
    embed_version: 0,
    description: null,
    attempts: 0,
  });
}

// ---------------------------------------------------------------------------

describe("decideWork", () => {
  test("a missing row is full work", () => {
    expect(decideWork(undefined)).toEqual({ kind: "full", reason: "no row" });
  });

  test("an indexed row at the current versions is skipped", () => {
    expect(decideWork(row())).toEqual({
      kind: "skip",
      reason: "already indexed at the current versions",
    });
  });

  // -- the hazard -----------------------------------------------------------

  test("a hook-created row is full work, never payload-only", () => {
    // `state: "stale"` here means "the payload is not current", not "the
    // description is current and only the terms changed". Branching on the
    // state alone would write a Qdrant payload with no summary and no vector,
    // or fail the row on a 404 from `overwritePayload` that reads like a
    // Qdrant fault.
    const decision = decideWork(hookCreatedRow());
    expect(decision.kind).toBe("full");
    expect(decision.kind).not.toBe("payload");
    expect(decision.reason).toBe("describe_version 0");
  });

  test("a hook-created row stays full work under every option combination", () => {
    for (const options of [
      {},
      { force: true },
      { redescribe: true },
      { retryFailed: true },
      { force: true, redescribe: true, retryFailed: true },
    ]) {
      expect(decideWork(hookCreatedRow(), options).kind).toBe("full");
    }
  });

  test("a stale row missing only its vector is still full work", () => {
    // describe is current, embed is not: the payload branch must not take it.
    const decision = decideWork(row({ state: "stale", embed_version: 0 }));
    expect(decision).toEqual({ kind: "full", reason: "embed_version 0" });
  });

  test("a stale row with current versions but no description is full work", () => {
    expect(decideWork(row({ state: "stale", description: null }))).toEqual({
      kind: "full",
      reason: "no cached description",
    });
  });

  test("a stale row with an undefined description is full work", () => {
    expect(decideWork(row({ state: "stale", description: undefined })).kind).toBe("full");
  });

  // -- the payload branch ---------------------------------------------------

  test("a stale row at the current versions with a description is payload-only", () => {
    // The one cheap path: a new search term on an already-described clip
    // re-writes the payload without re-describing or re-embedding it.
    expect(decideWork(row({ state: "stale" }))).toEqual({
      kind: "payload",
      reason: "search terms changed",
    });
  });

  test("force and redescribe both override the payload shortcut", () => {
    expect(decideWork(row({ state: "stale" }), { force: true })).toEqual({
      kind: "full",
      reason: "forced",
    });
    expect(decideWork(row({ state: "stale" }), { redescribe: true })).toEqual({
      kind: "full",
      reason: "re-describe requested",
    });
  });

  test("redescribe wins over force, so the reason names the costlier request", () => {
    expect(decideWork(row(), { force: true, redescribe: true }).reason).toBe("re-describe requested");
  });

  test("force and redescribe both re-do an already-indexed row", () => {
    expect(decideWork(row(), { force: true }).kind).toBe("full");
    expect(decideWork(row(), { redescribe: true }).kind).toBe("full");
  });

  // -- versions -------------------------------------------------------------

  test("an out-of-date describe version is full work and names itself", () => {
    expect(decideWork(row({ describe_version: DESCRIBE_VERSION - 1 }))).toEqual({
      kind: "full",
      reason: `describe_version ${DESCRIBE_VERSION - 1}`,
    });
  });

  test("an out-of-date embed version is full work and names itself", () => {
    expect(decideWork(row({ embed_version: EMBED_VERSION + 1 }))).toEqual({
      kind: "full",
      reason: `embed_version ${EMBED_VERSION + 1}`,
    });
  });

  test("describe is reported before embed when both are stale", () => {
    expect(decideWork(row({ describe_version: 0, embed_version: 0 })).reason).toBe("describe_version 0");
  });

  // -- failures -------------------------------------------------------------

  test("a row at the attempt ceiling is skipped with the retry instruction", () => {
    expect(decideWork(row({ state: "failed", attempts: MAX_INDEX_ATTEMPTS }))).toEqual({
      kind: "skip",
      reason: `failed ${MAX_INDEX_ATTEMPTS} time(s); re-run with retryFailed to try again`,
    });
  });

  test("a row past the attempt ceiling is skipped too", () => {
    expect(decideWork(row({ state: "failed", attempts: MAX_INDEX_ATTEMPTS + 5 })).kind).toBe("skip");
  });

  test("a failed row below the ceiling is retried without a flag", () => {
    expect(decideWork(row({ state: "failed", attempts: MAX_INDEX_ATTEMPTS - 1 }))).toEqual({
      kind: "full",
      reason: "state failed",
    });
  });

  test("retryFailed re-opens a row that hit the ceiling", () => {
    expect(decideWork(row({ state: "failed", attempts: MAX_INDEX_ATTEMPTS }), { retryFailed: true })).toEqual({
      kind: "full",
      reason: "state failed",
    });
  });

  test("a failed row with no cached description says so rather than 'state failed'", () => {
    expect(decideWork(row({ state: "failed", attempts: 0, description: null })).reason).toBe(
      "no cached description",
    );
  });

  test("retryFailed does not disturb an indexed row", () => {
    expect(decideWork(row(), { retryFailed: true }).kind).toBe("skip");
  });

  test("three attempts is the ceiling", () => {
    // Each attempt costs an ffmpeg encode plus a Gemini call, so a permanently
    // broken clip must not become a recurring bill.
    expect(MAX_INDEX_ATTEMPTS).toBe(3);
  });

  test("only skip, payload and full are ever returned", () => {
    const rows: Array<FootageIndexDocument | undefined> = [
      undefined,
      row(),
      hookCreatedRow(),
      row({ state: "stale" }),
      row({ state: "failed", attempts: 9 }),
      row({ describe_version: 0 }),
      row({ embed_version: 0 }),
      row({ description: null }),
    ];
    for (const candidate of rows) {
      for (const options of [{}, { force: true }, { redescribe: true }, { retryFailed: true }]) {
        const decision = decideWork(candidate, options);
        expect(["skip", "payload", "full"]).toContain(decision.kind);
        expect(decision.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe("isCacheClipName", () => {
  test("accepts the name saveVideo and the pull both write", () => {
    expect(isCacheClipName("vid-d41d8cd98f00b204e9800998ecf8427e.mp4")).toBe(true);
  });

  test("is case-insensitive on the extension", () => {
    expect(isCacheClipName("VID-ABC.MP4")).toBe(true);
    expect(isCacheClipName("vid-abc.Mp4")).toBe(true);
  });

  test("rejects an in-flight download", () => {
    // `.vid-….part` lives elsewhere, but the pattern excludes it regardless,
    // which is what keeps the walker from needing to know about temp names.
    expect(isCacheClipName(".vid-abc.12345.deadbeef.part")).toBe(false);
    expect(isCacheClipName("vid-abc.mp4.part")).toBe(false);
  });

  test("rejects clips this library does not own", () => {
    for (const name of ["video.mp4", "vid.mp4", "clip-abc.mp4", "vid-abc.mov", "vid-abc.webm", ""]) {
      expect(isCacheClipName(name)).toBe(false);
    }
  });

  test("rejects anything carrying a path separator", () => {
    // The walker passes basenames; a name with a separator would let a match
    // escape the directory the three views of the cache agree on.
    expect(isCacheClipName("sub/vid-abc.mp4")).toBe(false);
    expect(isCacheClipName("vid-a/b.mp4")).toBe(false);
    expect(isCacheClipName("vid-a\\b.mp4")).toBe(false);
  });

  test("rejects surrounding whitespace and newline-smuggled names", () => {
    expect(isCacheClipName(" vid-abc.mp4")).toBe(false);
    expect(isCacheClipName("vid-abc.mp4 ")).toBe(false);
    expect(isCacheClipName("vid-abc.mp4\nnot-a-clip")).toBe(false);
  });
});
