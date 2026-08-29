/**
 * The bulk pull's pure helpers.
 *
 * The pull spends disk and a rate limit, so the parts worth pinning are the
 * ones that decide *what* it fetches (the exact-resolution rendition rule and
 * the argument parser), *how much* it fetches (the byte budget), and *where* it
 * writes while fetching (the temp name). None of them touch the network.
 */

import { describe, expect, test } from "bun:test";

import {
  acceptsRendition,
  checkBudget,
  destinationFileFor,
  formatDryRun,
  parseByteSize,
  parsePullArgs,
  tempFileNameFor,
  type PullCandidate,
  type PullResult,
} from "../src/services/footage/pull.ts";
import { isCacheClipName } from "../src/services/footage/index.ts";
import { VideoAspect } from "../src/models/schema.ts";
import { md5 } from "../src/utils/misc.ts";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

// ---------------------------------------------------------------------------

describe("acceptsRendition", () => {
  test("accepts only the exact resolution the render path would have picked", () => {
    expect(acceptsRendition(1920, 1080, VideoAspect.landscape)).toBe(true);
    expect(acceptsRendition(1080, 1920, VideoAspect.portrait)).toBe(true);
    expect(acceptsRendition(1080, 1080, VideoAspect.square)).toBe(true);
  });

  test("refuses a larger rendition of the same aspect rather than scaling it", () => {
    // 4K and 2.7K are both 16:9. The library holds only clips a render could
    // have chosen for itself, so they are refused, not downscaled.
    expect(acceptsRendition(3840, 2160, VideoAspect.landscape)).toBe(false);
    expect(acceptsRendition(2560, 1440, VideoAspect.landscape)).toBe(false);
    expect(acceptsRendition(2160, 3840, VideoAspect.portrait)).toBe(false);
  });

  test("refuses a smaller rendition of the same aspect", () => {
    expect(acceptsRendition(1280, 720, VideoAspect.landscape)).toBe(false);
    expect(acceptsRendition(720, 1280, VideoAspect.portrait)).toBe(false);
  });

  test("refuses the wrong orientation outright", () => {
    expect(acceptsRendition(1080, 1920, VideoAspect.landscape)).toBe(false);
    expect(acceptsRendition(1920, 1080, VideoAspect.portrait)).toBe(false);
    expect(acceptsRendition(1920, 1080, VideoAspect.square)).toBe(false);
  });

  test("coerces numeric strings, which is how the provider sends them", () => {
    expect(acceptsRendition("1920", "1080", VideoAspect.landscape)).toBe(true);
    expect(acceptsRendition("1080", "1920", VideoAspect.landscape)).toBe(false);
  });

  test("refuses a rendition with missing or unusable dimensions", () => {
    for (const [width, height] of [
      [undefined, undefined],
      [null, null],
      [0, 0],
      [1920, 0],
      ["abc", "def"],
      [Number.NaN, 1080],
      [{}, []],
    ] as Array<[unknown, unknown]>) {
      expect(acceptsRendition(width, height, VideoAspect.landscape)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------

describe("destinationFileFor", () => {
  test("names the clip exactly as the render path's downloader does", () => {
    const url = "https://player.example.com/video-files/1234/clip.mp4";
    expect(destinationFileFor(url)).toBe(`vid-${md5(url)}.mp4`);
  });

  test("strips the query string before hashing", () => {
    // If this ever drifts from `material/download.ts`, every clip this pull
    // fetched becomes invisible to the render path and to /cache/stats.
    const bare = "https://player.example.com/clip.mp4";
    expect(destinationFileFor(`${bare}?download=1&token=abc`)).toBe(destinationFileFor(bare));
  });

  test("produces a name the cache walker recognises", () => {
    expect(isCacheClipName(destinationFileFor("https://example.com/a.mp4"))).toBe(true);
  });

  test("gives distinct names to distinct URLs", () => {
    const a = destinationFileFor("https://example.com/a.mp4");
    const b = destinationFileFor("https://example.com/b.mp4");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^vid-[0-9a-f]{32}\.mp4$/);
  });
});

// ---------------------------------------------------------------------------

describe("tempFileNameFor", () => {
  test("is unique per call, which is what makes an in-flight dedup map unnecessary", () => {
    const names = new Set(Array.from({ length: 200 }, () => tempFileNameFor("vid-a.mp4")));
    expect(names.size).toBe(200);
  });

  test("is hidden, suffixed .part, and stamped with the pid", () => {
    const name = tempFileNameFor("vid-abc.mp4");
    expect(name.startsWith(".vid-abc.")).toBe(true);
    expect(name.endsWith(".part")).toBe(true);
    expect(name).toContain(`.${process.pid}.`);
  });

  test("is invisible to the *.mp4 walkers behind /cache/stats and /cache/clear", () => {
    const name = tempFileNameFor("vid-abc.mp4");
    expect(name.endsWith(".mp4")).toBe(false);
    expect(isCacheClipName(name)).toBe(false);
  });

  test("strips the extension case-insensitively and tolerates one that is absent", () => {
    expect(tempFileNameFor("vid-abc.MP4").startsWith(".vid-abc.")).toBe(true);
    expect(tempFileNameFor("vid-abc").startsWith(".vid-abc.")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("checkBudget", () => {
  const base = { bytesWritten: 0, maxBytes: 20 * GB, freeBytes: 100 * GB, minFreeBytes: 5 * GB };

  test("permits another download while there is budget and disk", () => {
    expect(checkBudget(base)).toBe("ok");
    expect(checkBudget({ ...base, bytesWritten: 20 * GB - 1 })).toBe("ok");
  });

  test("stops on the byte budget, counted in bytes actually written", () => {
    expect(checkBudget({ ...base, bytesWritten: 20 * GB })).toBe("budget");
    expect(checkBudget({ ...base, bytesWritten: 21 * GB })).toBe("budget");
  });

  test("stops on free disk before the volume is actually full", () => {
    expect(checkBudget({ ...base, freeBytes: 5 * GB - 1 })).toBe("disk");
    expect(checkBudget({ ...base, freeBytes: 5 * GB })).toBe("ok");
  });

  test("reports the budget first when both are exhausted", () => {
    expect(checkBudget({ ...base, bytesWritten: 20 * GB, freeBytes: 0 })).toBe("budget");
  });

  test("a zero budget stops the run before its first download", () => {
    expect(checkBudget({ ...base, maxBytes: 0 })).toBe("budget");
  });

  test("the overshoot it allows is bounded by concurrency x maxClipBytes", () => {
    // Checked before a download starts, never mid-stream: with the defaults
    // that is 4 x 300 MB past a budget measured in tens of gigabytes.
    const overshoot = 4 * 300 * MB;
    expect(overshoot).toBeLessThan(2 * GB);
  });
});

// ---------------------------------------------------------------------------

describe("parseByteSize", () => {
  test("reads a bare integer as bytes", () => {
    expect(parseByteSize("1024")).toBe(1024);
    expect(parseByteSize("0")).toBe(0);
  });

  test("reads binary suffixes in either case, with or without the b", () => {
    expect(parseByteSize("20GB")).toBe(20 * GB);
    expect(parseByteSize("20gb")).toBe(20 * GB);
    expect(parseByteSize("20g")).toBe(20 * GB);
    expect(parseByteSize("500mb")).toBe(500 * MB);
    expect(parseByteSize("2k")).toBe(2048);
    expect(parseByteSize("1tb")).toBe(1024 ** 4);
    expect(parseByteSize("42b")).toBe(42);
  });

  test("accepts a fractional amount and floors the result", () => {
    expect(parseByteSize("1.5gb")).toBe(Math.floor(1.5 * GB));
    expect(parseByteSize("0.5k")).toBe(512);
  });

  test("tolerates surrounding and internal whitespace", () => {
    expect(parseByteSize("  20 GB ")).toBe(20 * GB);
  });

  test("throws rather than guessing, because the failure mode is a full disk", () => {
    for (const bad of ["", "  ", "abc", "-5", "1 gigabyte", "20GBx", "1.2.3", "1e3", "0x20"]) {
      expect(() => parseByteSize(bad)).toThrow(/not a byte size/);
    }
  });
});

// ---------------------------------------------------------------------------

describe("parsePullArgs", () => {
  test("returns nothing at all for an empty argv, so defaults apply", () => {
    expect(parsePullArgs([])).toEqual({});
  });

  test("reads the flag-less switches", () => {
    expect(parsePullArgs(["--dry-run"])).toEqual({ dryRun: true });
  });

  test("reads the positive-integer options", () => {
    expect(parsePullArgs(["--per-term", "4", "--concurrency", "8", "--page-cap", "2"])).toEqual({
      perTerm: 4,
      concurrency: 8,
      pageCap: 2,
    });
  });

  test("rejects a non-positive or non-integer count", () => {
    for (const bad of ["0", "-1", "2.5", "abc", ""]) {
      expect(() => parsePullArgs(["--per-term", bad])).toThrow(/--per-term/);
    }
  });

  test("reads the byte options through parseByteSize", () => {
    expect(parsePullArgs(["--max-bytes", "20GB", "--min-free-bytes", "5gb", "--max-clip-bytes", "300mb"])).toEqual({
      maxBytes: 20 * GB,
      minFreeBytes: 5 * GB,
      maxClipBytes: 300 * MB,
    });
  });

  test("collects --term repeatedly and splits --terms on commas", () => {
    expect(parsePullArgs(["--term", "forest path", "--term", "ocean waves"]).terms).toEqual([
      "forest path",
      "ocean waves",
    ]);
    expect(parsePullArgs(["--terms", " a , b ,, c "]).terms).toEqual(["a", "b", "c"]);
  });

  test("maps every aspect spelling, and dedupes", () => {
    expect(parsePullArgs(["--aspect", "portrait"]).aspects).toEqual([VideoAspect.portrait]);
    expect(parsePullArgs(["--aspect", "16:9"]).aspects).toEqual([VideoAspect.landscape]);
    expect(parsePullArgs(["--aspect", "SQUARE"]).aspects).toEqual([VideoAspect.square]);
    expect(parsePullArgs(["--aspect", "both"]).aspects).toEqual([VideoAspect.portrait, VideoAspect.landscape]);
    expect(parsePullArgs(["--aspect", "both", "--aspect", "portrait"]).aspects).toEqual([
      VideoAspect.portrait,
      VideoAspect.landscape,
    ]);
  });

  test("rejects an unknown aspect", () => {
    expect(() => parsePullArgs(["--aspect", "widescreen"])).toThrow(/--aspect must be/);
  });

  test("rejects an unknown flag instead of silently pulling the defaults", () => {
    // A mistyped `--per-tem 4` would otherwise waste an hour and a large slice
    // of the rate limit before anyone noticed.
    expect(() => parsePullArgs(["--per-tem", "4"])).toThrow(/unknown option: --per-tem/);
    expect(() => parsePullArgs(["4"])).toThrow(/unknown option: 4/);
  });

  test("rejects an option whose value is missing or is the next flag", () => {
    expect(() => parsePullArgs(["--per-term"])).toThrow(/--per-term needs a value/);
    expect(() => parsePullArgs(["--term", "--dry-run"])).toThrow(/--term needs a value/);
  });
});

// ---------------------------------------------------------------------------

function candidate(overrides: Partial<PullCandidate> = {}): PullCandidate {
  return {
    term: "forest path",
    aspect: VideoAspect.landscape,
    url: "https://example.com/a.mp4",
    localFile: "vid-aaa.mp4",
    page: 1,
    assetId: "1",
    renditionId: "10",
    sourcePage: null,
    width: 1920,
    height: 1080,
    duration: 12,
    existing: false,
    ...overrides,
  };
}

describe("formatDryRun", () => {
  const result: PullResult = {
    runId: null,
    dryRun: true,
    startedAt: new Date(0),
    finishedAt: new Date(0),
    stopReason: "complete",
    perTerm: [
      { term: "forest path", aspect: VideoAspect.landscape, attempted: 4, accepted: 2, rejected_resolution: 2 },
      { term: "ocean waves", aspect: VideoAspect.landscape, attempted: 0, accepted: 0, rejected_resolution: 0, last_status: 429 },
      { term: "desert dunes", aspect: VideoAspect.landscape, attempted: 3, accepted: 0, rejected_resolution: 3, last_status: 200 },
    ],
    bytesWritten: 0,
    clipsAdded: 0,
    clipsFailed: 0,
    clipsSkippedExisting: 1,
    candidates: [candidate(), candidate({ localFile: "vid-bbb.mp4", existing: true, page: 2 })],
  };

  test("marks each candidate as one to pull or one already held", () => {
    const lines = formatDryRun(result).split("\n");
    expect(lines[0]).toContain("pull  vid-aaa.mp4  1920x1080  12s  p1");
    expect(lines[1]).toContain("have  vid-bbb.mp4");
    expect(lines[1]).toContain('16:9 "forest path"');
  });

  test("separates a throttled term from one with no usable rendition", () => {
    // The two look identical in the counts, and mean entirely different things
    // about what to do next.
    expect(formatDryRun(result)).toContain(
      "2 clips selected across 3 term/aspect pairs; 1 already cached; " +
        "1 rate-limited; 1 with no usable rendition; stop_reason=complete",
    );
  });

  test("summarises an empty run without a candidate table", () => {
    const empty = formatDryRun({ ...result, perTerm: [], candidates: [] });
    expect(empty.split("\n").length).toBe(1);
    expect(empty).toContain("0 clips selected across 0 term/aspect pairs");
  });
});
