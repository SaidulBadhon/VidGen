/**
 * The footage gallery's server side: poster generation and the read-only
 * HTTP surface over the clip library.
 *
 * Nothing here spawns ffmpeg, opens Mongo or reaches Qdrant, following the same
 * discipline as `footage-describe.test.ts`: `thumbFfmpegArgs` is the argv
 * `runFfmpeg` would be handed, and every filter, sort and mapper on the route
 * is a pure function that takes a parsed query and returns a value.
 *
 * Two groups carry most of the weight, and both are measurements rather than
 * preferences:
 *
 *  - **`resolveCacheClip`.** `storage/cache_videos` had never been reachable
 *    over HTTP before this router, so this function is the whole boundary
 *    between one directory of stock footage and the filesystem. The cases below
 *    are the payloads that were actually fired at the running server.
 *  - **The aspect filter.** `compare.ts` records that filtering the library on
 *    `"9:16"` matches zero points while `"portrait"` matches 756 of 1,512. The
 *    listing path has no `aspect` field to filter at all — a Mongo row stores
 *    only width and height — so the two paths derive the same three words by
 *    different means, and that agreement is asserted rather than assumed.
 */

import { describe, expect, test } from "bun:test";
import { basename } from "node:path";

import {
  buildListFilter,
  buildListSort,
  buildSearchFilter,
  footageListQuerySchema,
  itemFromPayload,
  itemFromRow,
  orientationOf,
  resolveCacheClip,
} from "../src/routes/v1/footage.ts";
import {
  THUMB_SEEK_SECONDS,
  THUMB_WIDTH,
  footageThumbsDir,
  thumbFfmpegArgs,
  thumbFileName,
} from "../src/services/footage/thumbs.ts";
import type { FootagePayload } from "../src/services/footage/qdrant.ts";
import type { FootageClipDescription, FootageIndexDocument } from "../src/db/types.ts";
import { UnsafePathError } from "../src/utils/fileSecurity.ts";
import { storageDir } from "../src/utils/paths.ts";

const DESCRIPTION: FootageClipDescription = {
  summary: "An empty hospital corridor with closed doors.",
  detailed_description: "A static shot down a lit corridor lined with doors.",
  use_cases: ["a segment on healthcare staffing"],
  mood: ["clinical", "still"],
  tags: ["hospital", "corridor", "empty"],
  setting: "indoor",
  time_of_day: "day",
  has_people: false,
  has_on_screen_text: false,
  camera_motion: "static",
  quality_flags: ["low light"],
};

function row(overrides: Partial<FootageIndexDocument> = {}): FootageIndexDocument {
  return {
    _id: "8de7a8cb-3933-5b77-9052-d4c92240b863",
    local_file: "vid-a.mp4",
    state: "indexed",
    description: DESCRIPTION,
    provider: "pexels",
    search_terms: ["hospital corridor"],
    asset_id: "123456",
    source_page: "https://www.pexels.com/video/123456/",
    creator: { id: "c1", name: "A Photographer", profile_page: "https://example.test/c1" },
    duration: 14.2,
    width: 1920,
    height: 1080,
    bytes: 2_577_020,
    describe_version: 1,
    embed_version: 1,
    attempts: 1,
    created_at: new Date("2026-08-01T00:00:00.000Z"),
    updated_at: new Date("2026-08-29T23:37:24.002Z"),
    ...overrides,
  };
}

function payload(overrides: Partial<FootagePayload> = {}): FootagePayload {
  return {
    local_file: "vid-a.mp4",
    provider: "pexels",
    search_terms: ["hospital corridor"],
    asset_id: "123456",
    source_page: "https://www.pexels.com/video/123456/",
    creator: { id: "c1", name: "A Photographer", profile_page: "https://example.test/c1" },
    duration: 14.2,
    width: 1920,
    height: 1080,
    aspect: "landscape",
    bytes: 2_577_020,
    ...DESCRIPTION,
    describe_model: "gemini-2.5-flash",
    describe_version: 1,
    embed_model: "gemini-embedding-001",
    embed_version: 1,
    indexed_at: "2026-08-29T23:37:24.002Z",
    ...overrides,
  };
}

/** Parses a query string the way the route does, so the tests share its coercions. */
function query(search: string) {
  const raw = Object.fromEntries(new URLSearchParams(search));
  const present = Object.fromEntries(Object.entries(raw).filter(([, v]) => v.trim() !== ""));
  return footageListQuerySchema.parse(present);
}

// ---------------------------------------------------------------------------
// Poster naming and argv
// ---------------------------------------------------------------------------

describe("thumbFileName", () => {
  test("swaps the clip extension for .jpg", () => {
    expect(thumbFileName("vid-80c59712ccbe9b529d871a33ac0d91b1.mp4")).toBe(
      "vid-80c59712ccbe9b529d871a33ac0d91b1.jpg",
    );
  });

  test("reduces a path to its final segment before naming a file", () => {
    // The argument reaches this function from a URL and the result names a file
    // that is about to be written. Anything that survived as a path here would
    // be a write outside the cache directory.
    expect(thumbFileName("../../../etc/passwd")).toBe("passwd.jpg");
    expect(thumbFileName("/absolute/vid-a.mp4")).toBe("vid-a.jpg");
    expect(basename(thumbFileName("a/b/c/vid-a.mp4"))).toBe(thumbFileName("a/b/c/vid-a.mp4"));
  });

  test("refuses names that are not names", () => {
    for (const name of ["", "   ", ".", "..", "/", "a/.."]) {
      expect(() => thumbFileName(name)).toThrow(UnsafePathError);
    }
  });
});

describe("thumbFfmpegArgs", () => {
  const source = "/clips/vid-a.mp4";
  const destination = "/thumbs/vid-a.jpg";

  test("puts -ss before -i, which is what makes this cheap enough to do on a request", () => {
    const args = thumbFfmpegArgs(source, destination, THUMB_SEEK_SECONDS);
    // Fast seek: ffmpeg jumps to the nearest keyframe instead of decoding every
    // frame it skips. After -i it would decode a second of video per poster.
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-ss") + 1]).toBe(String(THUMB_SEEK_SECONDS));
  });

  test("omits -ss entirely on the frame-0 fallback", () => {
    // A clip shorter than the seek has no frame at 1s, and `-ss 0` is not the
    // same instruction as no seek at all for every demuxer.
    expect(thumbFfmpegArgs(source, destination, 0)).not.toContain("-ss");
  });

  test("escapes the comma inside min(), which ffmpeg would otherwise read as a filter separator", () => {
    const filter = thumbFfmpegArgs(source, destination, 1)[
      thumbFfmpegArgs(source, destination, 1).indexOf("-vf") + 1
    ];
    expect(filter).toBe(`scale=min(${THUMB_WIDTH}\\,iw):-2`);
    // An unescaped comma parses as "scale=min(480" followed by "iw):-2", which
    // is a graph error rather than a wrong-sized poster.
    expect(filter).not.toBe(`scale=min(${THUMB_WIDTH},iw):-2`);
  });

  test("clamps rather than forces the width, so a small clip is never upscaled", () => {
    const filter = thumbFfmpegArgs(source, destination, 1).join(" ");
    expect(filter).toContain("min(");
    expect(filter).toContain(":-2"); // even height, which the JPEG encoder needs
  });

  test("asks for exactly one frame, no audio, and writes the destination last", () => {
    const args = thumbFfmpegArgs(source, destination, 1);
    expect(args.slice(args.indexOf("-frames:v"), args.indexOf("-frames:v") + 2)).toEqual([
      "-frames:v",
      "1",
    ]);
    expect(args).toContain("-an");
    expect(args.at(-1)).toBe(destination);
    expect(args[args.indexOf("-i") + 1]).toBe(source);
  });
});

test("posters live beside the other storage caches, not inside cache_videos", () => {
  // Writing them into the clip directory would make every poster look like an
  // unindexed clip to `listCacheClips`.
  expect(footageThumbsDir(false)).toBe(storageDir("footage_thumbs"));
  expect(footageThumbsDir(false)).not.toBe(storageDir("cache_videos"));
});

// ---------------------------------------------------------------------------
// The path boundary
// ---------------------------------------------------------------------------

describe("resolveCacheClip", () => {
  /**
   * Every one of these was fired at the running server; each answered 403 with
   * no filesystem access. They are kept as a list rather than prose because the
   * next person to touch the guard needs to re-run exactly these.
   */
  const TRAVERSAL = [
    "../../../etc/passwd",
    "..%2f..%2fetc%2fpasswd", // still encoded, in case a caller decodes twice
    "../../.env",
    "..\\..\\etc\\passwd",
    "/etc/passwd",
    "vid-../../../etc/passwd.mp4", // a valid-looking prefix around a traversal
    "vid-a.mp4/../../../etc/passwd",
    "\0vid-a.mp4",
    "vid-a.mp4\0.txt",
    "",
    "..",
    ".",
  ];

  test.each(TRAVERSAL)("refuses %j", (name) => {
    expect(() => resolveCacheClip(name)).toThrow(UnsafePathError);
  });

  test("refuses anything that is not one of the library's own clips", () => {
    // The allow-list is `vid-<md5>.mp4`, shared with the indexer and the cache
    // cleaner. A directory listing, a sibling file and a different extension
    // are all outside it even though none of them traverses anywhere.
    for (const name of ["passwd", "vid-a.txt", "vid-a.mp4.jpg", "notes.mp4", "vid-a"]) {
      expect(() => resolveCacheClip(name)).toThrow(UnsafePathError);
    }
  });

  test("refuses undefined, which is what an unmatched route parameter is", () => {
    expect(() => resolveCacheClip(undefined)).toThrow(UnsafePathError);
  });

  test("a well-formed name for a clip that is not there fails as missing, not as unsafe", () => {
    // The two are different answers — 404 against 403 — and the route tells
    // them apart by this message. Collapsing them would either hide a probe in
    // the noise of missing files or report every missing clip as an attack.
    expect(() => resolveCacheClip("vid-000000000000000000000000deadbeef.mp4")).toThrow(
      "file does not exist",
    );
  });
});

// ---------------------------------------------------------------------------
// The gallery query
// ---------------------------------------------------------------------------

describe("footageListQuerySchema", () => {
  test("takes the orientation word and rejects the ratio", () => {
    expect(query("aspect=portrait").aspect).toBe("portrait");
    // Measured, not assumed: `aspect = "9:16"` matches 0 of 1,512 points while
    // `"portrait"` matches 756. Accepting the ratio would answer an empty
    // gallery to a filter the caller believed had worked.
    expect(() => query("aspect=9:16")).toThrow();
    expect(() => query("aspect=16:9")).toThrow();
  });

  test("reads every spelling of a boolean a client might send", () => {
    expect(query("has_people=true").has_people).toBe(true);
    expect(query("has_people=1").has_people).toBe(true);
    expect(query("has_people=false").has_people).toBe(false);
    expect(query("has_people=0").has_people).toBe(false);
    // Absent is a third state: neither "with people" nor "without".
    expect(query("limit=5").has_people).toBeUndefined();
  });

  test("caps limit so one request cannot ask for the whole library's prose", () => {
    expect(query("limit=200").limit).toBe(200);
    expect(() => query("limit=201")).toThrow();
    expect(() => query("limit=0")).toThrow();
    expect(() => query("offset=-1")).toThrow();
  });

  test("an empty value is absent, not invalid", () => {
    // `?provider=&q=` is what a form with untouched inputs sends.
    expect(query("provider=&q=&limit=5")).toEqual({ limit: 5 });
  });
});

describe("buildListFilter", () => {
  test("restricts the gallery to clips that can be described to a viewer", () => {
    // A row that has only ever failed keeps its bytes — nothing in this library
    // deletes a clip — but has no summary and nothing to render in a tile.
    expect(buildListFilter(query("")).description).toEqual({ $type: "object" });
  });

  test("derives orientation from the shape, because a row has no aspect field", () => {
    const landscape = buildListFilter(query("aspect=landscape")) as Record<string, unknown>;
    expect(landscape.$expr).toEqual({ $gt: ["$width", "$height"] });
    expect(landscape.width).toEqual({ $gt: 0 });
    expect(landscape.height).toEqual({ $gt: 0 });

    expect((buildListFilter(query("aspect=portrait")) as Record<string, unknown>).$expr).toEqual({
      $lt: ["$width", "$height"],
    });
    expect((buildListFilter(query("aspect=square")) as Record<string, unknown>).$expr).toEqual({
      $eq: ["$width", "$height"],
    });
  });

  test("leaves shape out of it when no aspect was asked for", () => {
    const filter = buildListFilter(query("provider=pexels")) as Record<string, unknown>;
    expect(filter.$expr).toBeUndefined();
    expect(filter.width).toBeUndefined();
    expect(filter.provider).toBe("pexels");
  });

  test("has_people is a description field, not a row field", () => {
    expect(
      (buildListFilter(query("has_people=true")) as Record<string, unknown>)["description.has_people"],
    ).toBe(true);
    expect(
      (buildListFilter(query("has_people=false")) as Record<string, unknown>)["description.has_people"],
    ).toBe(false);
  });

  test("min_duration is a floor, and zero is a real floor", () => {
    expect((buildListFilter(query("min_duration=5.5")) as Record<string, unknown>).duration).toEqual({
      $gte: 5.5,
    });
    // `?min_duration=0` parses to 0, which must not be dropped as falsy.
    expect((buildListFilter(query("min_duration=0")) as Record<string, unknown>).duration).toEqual({
      $gte: 0,
    });
  });
});

describe("buildListSort", () => {
  test("newest first by default", () => {
    expect(buildListSort(undefined)).toEqual({ updated_at: -1, _id: 1 });
  });

  test("every order carries an _id tiebreak", () => {
    // The library was indexed in one pass, so hundreds of rows share a
    // timestamp to the millisecond. Without the tiebreak Mongo may order ties
    // differently between two calls, and a paging gallery would show one clip
    // twice and skip another.
    for (const sort of ["newest", "oldest", "longest", "shortest"] as const) {
      expect(buildListSort(sort)._id).toBe(1);
    }
    expect(buildListSort("oldest")).toEqual({ updated_at: 1, _id: 1 });
    expect(buildListSort("longest")).toEqual({ duration: -1, _id: 1 });
    expect(buildListSort("shortest")).toEqual({ duration: 1, _id: 1 });
  });
});

describe("buildSearchFilter", () => {
  test("is undefined when nothing was asked for, rather than an empty must", () => {
    expect(buildSearchFilter(query("q=corridor"))).toBeUndefined();
  });

  test("filters at Qdrant, in the payload's own vocabulary", () => {
    expect(buildSearchFilter(query("q=corridor&aspect=portrait"))).toEqual({
      must: [{ key: "aspect", match: { value: "portrait" } }],
    });
    expect(buildSearchFilter(query("q=corridor&has_people=false"))).toEqual({
      must: [{ key: "has_people", match: { value: false } }],
    });
    expect(buildSearchFilter(query("q=corridor&min_duration=10"))).toEqual({
      must: [{ key: "duration", range: { gte: 10 } }],
    });
  });

  test("filters compose in one must clause", () => {
    const filter = buildSearchFilter(query("q=corridor&aspect=portrait&provider=pexels&has_people=true"));
    expect(filter?.must).toHaveLength(3);
  });

  test("the aspect key matches the listing path's derivation", () => {
    // A gallery filtered to portrait and a search filtered to portrait must be
    // filtering on the same word, or the two views disagree about the same clip.
    const must = buildSearchFilter(query("q=x&aspect=portrait"))?.must as Array<{
      key: string;
      match: { value: string };
    }>;
    expect(must[0]!.key).toBe("aspect");
    expect(must[0]!.match.value).toBe(orientationOf(1080, 1920));
  });
});

describe("orientationOf", () => {
  test("returns the three words the payload stores", () => {
    expect(orientationOf(1920, 1080)).toBe("landscape");
    expect(orientationOf(1080, 1920)).toBe("portrait");
    expect(orientationOf(1080, 1080)).toBe("square");
  });

  test("a clip that never probed has no orientation, not a wrong one", () => {
    expect(orientationOf(undefined, undefined)).toBe("");
    expect(orientationOf(0, 0)).toBe("");
    expect(orientationOf(1920, undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The wire shape
// ---------------------------------------------------------------------------

describe("itemFromRow", () => {
  test("flattens the cached description onto the item", () => {
    const item = itemFromRow(row());
    expect(item.summary).toBe(DESCRIPTION.summary);
    expect(item.tags).toEqual(DESCRIPTION.tags);
    expect(item.quality_flags).toEqual(["low light"]);
    expect(item.has_people).toBe(false);
    expect(item.camera_motion).toBe("static");
  });

  test("derives the aspect a Mongo row does not store", () => {
    expect(itemFromRow(row()).aspect).toBe("landscape");
    expect(itemFromRow(row({ width: 1080, height: 1920 })).aspect).toBe("portrait");
  });

  test("indexed_at is the row's own clock, as an ISO string", () => {
    expect(itemFromRow(row()).indexed_at).toBe("2026-08-29T23:37:24.002Z");
  });

  test("keeps the credit down to what a tile can show", () => {
    expect(itemFromRow(row()).creator).toEqual({
      name: "A Photographer",
      profile_page: "https://example.test/c1",
    });
    expect(itemFromRow(row({ creator: null })).creator).toBeUndefined();
    expect(itemFromRow(row({ creator: { id: "only-an-id" } })).creator).toBeUndefined();
  });

  test("a row with no shape and no description still produces a renderable item", () => {
    // `description` is filtered out by the query, but the mapper must not throw
    // on one that slipped through — a blank tile beats a 500 for the whole page.
    const item = itemFromRow(
      row({ description: null, duration: undefined, width: undefined, height: undefined, bytes: undefined }),
    );
    expect(item).toMatchObject({
      duration: 0,
      width: 0,
      height: 0,
      bytes: 0,
      aspect: "",
      summary: "",
      tags: [],
      has_people: false,
    });
  });

  test("carries no score, because a listing has no relevance", () => {
    expect(itemFromRow(row()).score).toBeUndefined();
  });
});

describe("itemFromPayload", () => {
  test("carries the score that ordered it", () => {
    expect(itemFromPayload(payload(), 0.8254).score).toBe(0.8254);
  });

  test("prefers the stored aspect but recomputes one that is missing", () => {
    expect(itemFromPayload(payload(), 1).aspect).toBe("landscape");
    const legacy = payload();
    delete legacy.aspect;
    expect(itemFromPayload(legacy, 1).aspect).toBe("landscape");
  });

  test("produces the same shape as the listing path for the same clip", () => {
    // The web renders one component for both, so a field present on one path
    // and absent on the other is a tile that changes when you type in a search
    // box. Compared by key set, with `score` the single documented difference.
    const searched = Object.keys(itemFromPayload(payload(), 0.5)).sort();
    const listed = Object.keys(itemFromRow(row())).sort();
    expect(searched.filter((key) => key !== "score")).toEqual(listed);
  });

  test("indexed_at comes from the payload's own stamp", () => {
    expect(itemFromPayload(payload(), 1).indexed_at).toBe("2026-08-29T23:37:24.002Z");
  });
});
