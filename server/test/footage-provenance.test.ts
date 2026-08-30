/**
 * Provenance: the write rule, the filename match, the report and the parser.
 *
 * Everything pinned here is pure — no Mongo, no network. That is the point of
 * `planProvenanceUpdate` and `matchRenditions` existing as separate functions:
 * the rules they carry are the ones that decide whether the library can
 * attribute a clip and whether recovering that costs a re-describe, and both
 * would otherwise only be observable through a database.
 */

import { describe, expect, test } from "bun:test";

import {
  formatBackfill,
  matchRenditions,
  parseBackfillArgs,
  planProvenanceUpdate,
  type BackfillResult,
  type ClipProvenance,
} from "../src/services/footage/provenance.ts";
import { destinationFileFor, type PexelsVideo } from "../src/services/footage/pull.ts";
import { pointIdFor } from "../src/services/footage/types.ts";
import { VideoAspect } from "../src/models/schema.ts";
import { md5 } from "../src/utils/misc.ts";

const NOW = new Date("2026-08-30T12:00:00.000Z");

function provenance(overrides: Partial<ClipProvenance> = {}): ClipProvenance {
  return {
    localFile: "vid-aaa.mp4",
    provider: "pexels",
    assetId: "1234",
    renditionId: "5678",
    sourcePage: "https://www.pexels.com/video/a-forest-path-1234/",
    creator: { id: "9", name: "A Contributor", profile_page: "https://www.pexels.com/@someone" },
    searchTerm: "forest path",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("planProvenanceUpdate", () => {
  test("keys the write by the same v5 uuid the indexer and qdrant use", () => {
    const plan = planProvenanceUpdate(provenance(), null, NOW);
    expect(plan.id).toBe(pointIdFor("vid-aaa.mp4"));
  });

  test("creates a never-described row as stale at version 0 with a null description", () => {
    // `state` has no value meaning *new*, and version 0 matches no current
    // constant, so the indexer sees work whichever field it tests.
    const plan = planProvenanceUpdate(provenance(), null, NOW);

    expect(plan.upsert).toBe(true);
    expect(plan.markedStale).toBe(false);
    expect(plan.setOnInsert).toMatchObject({
      local_file: "vid-aaa.mp4",
      state: "stale",
      description: null,
      describe_version: 0,
      embed_version: 0,
      attempts: 0,
      created_at: NOW,
    });
  });

  test("writes every provenance field it was given", () => {
    const plan = planProvenanceUpdate(provenance(), null, NOW);

    expect(plan.set).toMatchObject({
      provider: "pexels",
      asset_id: "1234",
      rendition_id: "5678",
      source_page: "https://www.pexels.com/video/a-forest-path-1234/",
      creator: { id: "9", name: "A Contributor", profile_page: "https://www.pexels.com/@someone" },
      updated_at: NOW,
    });
    expect(plan.addToSet).toEqual({ search_terms: "forest path" });
  });

  test("never overwrites a stored value with a blank one", () => {
    // A provider response that omitted a field must not erase a good value the
    // row already holds.
    const plan = planProvenanceUpdate(
      provenance({ assetId: "", renditionId: "", sourcePage: "", creator: null }),
      null,
      NOW,
    );

    expect(plan.set).not.toHaveProperty("asset_id");
    expect(plan.set).not.toHaveProperty("rendition_id");
    expect(plan.set).not.toHaveProperty("source_page");
    expect(plan.set).not.toHaveProperty("creator");
  });

  test("defaults search_terms on insert only when no term claims the field", () => {
    // Mongo rejects an update that writes one path from two operators.
    const withTerm = planProvenanceUpdate(provenance(), null, NOW);
    expect(withTerm.addToSet).toBeDefined();
    expect(withTerm.setOnInsert).not.toHaveProperty("search_terms");

    const withoutTerm = planProvenanceUpdate(provenance({ searchTerm: "  " }), null, NOW);
    expect(withoutTerm.addToSet).toBeUndefined();
    expect(withoutTerm.setOnInsert?.search_terms).toEqual([]);
  });

  test("defaults provider on insert only when the record has none", () => {
    const known = planProvenanceUpdate(provenance(), null, NOW);
    expect(known.setOnInsert).not.toHaveProperty("provider");

    const unknown = planProvenanceUpdate(provenance({ provider: "" }), null, NOW);
    expect(unknown.setOnInsert?.provider).toBe("");
  });

  test("a new term on an indexed row marks it stale and does not upsert", () => {
    // The whole point of the third state: the term changes the Qdrant payload
    // and nothing else, so this buys a payload-only refresh — no re-describe,
    // no re-embedding. Not upserting closes the window where a cache clear
    // between the read and this write would resurrect the row.
    const plan = planProvenanceUpdate(
      provenance(),
      { state: "indexed", search_terms: ["ocean waves"] },
      NOW,
    );

    expect(plan.markedStale).toBe(true);
    expect(plan.set.state).toBe("stale");
    expect(plan.upsert).toBe(false);
    expect(plan.setOnInsert).toBeUndefined();
    expect(plan.addToSet).toEqual({ search_terms: "forest path" });
  });

  test("a term the indexed row already carries leaves it indexed", () => {
    const plan = planProvenanceUpdate(
      provenance(),
      { state: "indexed", search_terms: ["forest path"] },
      NOW,
    );

    expect(plan.markedStale).toBe(false);
    expect(plan.set).not.toHaveProperty("state");
    // Still written: this is how a row that was built from the filesystem, and
    // so has no provider at all, gets one without being re-described.
    expect(plan.set.provider).toBe("pexels");
  });

  test("provenance with no term never marks an indexed row stale", () => {
    const plan = planProvenanceUpdate(
      provenance({ searchTerm: "" }),
      { state: "indexed", search_terms: [] },
      NOW,
    );

    expect(plan.markedStale).toBe(false);
    expect(plan.set).not.toHaveProperty("state");
  });

  test("a row that is already stale or failed is not re-stated", () => {
    for (const state of ["stale", "failed"] as const) {
      const plan = planProvenanceUpdate(provenance(), { state, search_terms: [] }, NOW);
      expect(plan.markedStale).toBe(false);
      expect(plan.set).not.toHaveProperty("state");
      // Failed rows still gain the term: the file is on disk and the next
      // retry should know what reached it.
      expect(plan.addToSet).toEqual({ search_terms: "forest path" });
    }
  });

  test("trims the term before comparing it, so whitespace is not a new term", () => {
    const plan = planProvenanceUpdate(
      provenance({ searchTerm: "  forest path  " }),
      { state: "indexed", search_terms: ["forest path"] },
      NOW,
    );

    expect(plan.markedStale).toBe(false);
    expect(plan.addToSet).toEqual({ search_terms: "forest path" });
  });
});

// ---------------------------------------------------------------------------

/** The URL shape the pull hashes: query string stripped before the md5. */
function renditionUrl(id: number): string {
  return `https://videos.pexels.com/video-files/${id}/${id}-hd_1080_1920_30fps.mp4?download=1`;
}

function video(overrides: Partial<PexelsVideo> = {}): PexelsVideo {
  return {
    id: 4321,
    url: "https://www.pexels.com/video/a-forest-path-4321/",
    user: { id: 7, name: "A Contributor", url: "https://www.pexels.com/@someone" },
    video_files: [
      { id: 11, width: 1080, height: 1920, link: renditionUrl(11) },
      { id: 12, width: 3840, height: 2160, link: renditionUrl(12) },
    ],
    ...overrides,
  };
}

describe("matchRenditions", () => {
  test("matches a rendition by the filename the pull would have written", () => {
    const wanted = new Set([destinationFileFor(renditionUrl(11))]);
    const matches = matchRenditions([video()], wanted);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({
      localFile: `vid-${md5(`https://videos.pexels.com/video-files/11/11-hd_1080_1920_30fps.mp4`)}.mp4`,
      assetId: "4321",
      renditionId: "11",
      sourcePage: "https://www.pexels.com/video/a-forest-path-4321/",
      creator: { id: "7", name: "A Contributor", profile_page: "https://www.pexels.com/@someone" },
    });
  });

  test("matches renditions the pull's resolution rule would have refused", () => {
    // The filename is derived from the rendition URL, so a hit is proof of
    // identity: ignoring the resolution rule only widens what can be recovered
    // and cannot produce a false positive.
    const wanted = new Set([destinationFileFor(renditionUrl(12))]);
    const matches = matchRenditions([video()], wanted);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.renditionId).toBe("12");
  });

  test("returns nothing when no rendition names a wanted file", () => {
    expect(matchRenditions([video()], new Set(["vid-nothing.mp4"]))).toEqual([]);
    expect(matchRenditions([], new Set(["vid-nothing.mp4"]))).toEqual([]);
  });

  test("skips a rendition with no link rather than hashing undefined", () => {
    const broken = video({ video_files: [{ id: 11, width: 1080, height: 1920 }] });
    expect(matchRenditions([broken], new Set([destinationFileFor(renditionUrl(11))]))).toEqual([]);
  });

  test("tolerates an asset with no video_files at all", () => {
    expect(matchRenditions([video({ video_files: undefined })], new Set(["vid-a.mp4"]))).toEqual([]);
  });

  test("drops a source page that is not a plain public http url", () => {
    // `safePublicUrl` is the allow-list: a signed or private-network URL must
    // never be persisted as provenance.
    const wanted = new Set([destinationFileFor(renditionUrl(11))]);
    const matches = matchRenditions([video({ url: "javascript:alert(1)" })], wanted);
    expect(matches[0]?.sourcePage).toBe("");
  });

  test("reduces an unusable creator to null rather than an empty object", () => {
    const wanted = new Set([destinationFileFor(renditionUrl(11))]);
    expect(matchRenditions([video({ user: undefined })], wanted)[0]?.creator).toBeNull();
    expect(matchRenditions([video({ user: {} })], wanted)[0]?.creator).toBeNull();
  });

  test("stringifies a numeric asset id, and keeps an absent one empty", () => {
    const wanted = new Set([destinationFileFor(renditionUrl(11))]);
    expect(matchRenditions([video()], wanted)[0]?.assetId).toBe("4321");
    expect(matchRenditions([video({ id: undefined })], wanted)[0]?.assetId).toBe("");
  });

  test("matches every wanted rendition across several assets", () => {
    const other = video({
      id: 999,
      video_files: [{ id: 21, width: 1920, height: 1080, link: renditionUrl(21) }],
    });
    const wanted = new Set([destinationFileFor(renditionUrl(11)), destinationFileFor(renditionUrl(21))]);

    const matches = matchRenditions([video(), other], wanted);
    expect(matches.map((match) => match.renditionId).sort()).toEqual(["11", "21"]);
  });
});

// ---------------------------------------------------------------------------

describe("parseBackfillArgs", () => {
  test("defaults to everything, which is what a recovery run wants", () => {
    expect(parseBackfillArgs([])).toEqual({});
  });

  test("reads the flags it owns", () => {
    expect(parseBackfillArgs(["--dry-run", "--per-page", "40", "--page-cap", "2"])).toEqual({
      dryRun: true,
      perPage: 40,
      pageCap: 2,
    });
  });

  test("collects repeated and comma-separated terms into one list", () => {
    expect(
      parseBackfillArgs(["--term", "forest path", "--terms", "ocean waves, city street"]),
    ).toEqual({ terms: ["forest path", "ocean waves", "city street"] });
  });

  test("accepts orientation words and aspect ratios, and de-duplicates them", () => {
    expect(parseBackfillArgs(["--aspect", "both"])).toEqual({
      aspects: [VideoAspect.portrait, VideoAspect.landscape],
    });
    expect(parseBackfillArgs(["--aspect", "portrait", "--aspect", "9:16"])).toEqual({
      aspects: [VideoAspect.portrait],
    });
  });

  test("rejects an unknown flag rather than silently running the default", () => {
    expect(() => parseBackfillArgs(["--page-cp", "2"])).toThrow(/unknown option: --page-cp/);
    expect(() => parseBackfillArgs(["--per-page", "0"])).toThrow(/--per-page needs a positive integer/);
    expect(() => parseBackfillArgs(["--aspect", "sideways"])).toThrow(/--aspect must be/);
    expect(() => parseBackfillArgs(["--term"])).toThrow(/--term needs a value/);
  });
});

// ---------------------------------------------------------------------------

function backfillResult(overrides: Partial<BackfillResult> = {}): BackfillResult {
  return {
    dryRun: false,
    rowsTotal: 1512,
    rowsMissingBefore: 1512,
    rowsMatched: 1400,
    rowsMissingAfter: 112,
    projected: false,
    pairsSearched: 252,
    pagesFetched: 252,
    throttled: 0,
    errored: 0,
    writeFailures: 0,
    aborted: false,
    elapsedMs: 90_000,
    ...overrides,
  };
}

describe("formatBackfill", () => {
  test("reports what was matched and what is still missing", () => {
    const report = formatBackfill(backfillResult());
    expect(report).toContain("without provenance     1512 before this run");
    expect(report).toContain("matched                1400 (filled)");
    expect(report).toContain("still without          112 (counted in mongo)");
  });

  test("says a remainder is expected rather than an error", () => {
    expect(formatBackfill(backfillResult())).toContain("it is not an error");
  });

  test("separates a rate-limited pair from a clip that simply no longer surfaces", () => {
    // The two look identical in the remainder and mean different things about
    // whether re-running would help.
    const report = formatBackfill(backfillResult({ throttled: 9 }));
    expect(report).toContain("rate-limited           9 pair(s)");
    expect(report).toContain("unmeasured rather than unrecoverable");
  });

  test("labels a dry run's remainder as projected and says nothing was written", () => {
    const report = formatBackfill(
      backfillResult({ dryRun: true, projected: true, rowsMissingAfter: 112 }),
    );
    expect(report).toContain("dry run — nothing was written");
    expect(report).toContain("matched                1400 (would be filled)");
    expect(report).toContain("still without          112 (projected)");
    // The follow-up only applies to a run that actually wrote something.
    expect(report).not.toContain("Run `footage index`");
  });

  test("tells a real run that qdrant payloads still need a refresh", () => {
    // The backfill writes Mongo. The vector store keeps the payload it was
    // last given, so the provenance is not searchable until those rows are
    // re-upserted.
    expect(formatBackfill(backfillResult())).toContain("Run `footage index`");
  });

  test("omits the remainder note when nothing is left unmatched", () => {
    const report = formatBackfill(backfillResult({ rowsMatched: 1512, rowsMissingAfter: 0 }));
    expect(report).not.toContain("it is not an error");
  });

  test("surfaces write failures and an early stop", () => {
    const report = formatBackfill(backfillResult({ writeFailures: 3, aborted: true }));
    expect(report).toContain("write failures         3");
    expect(report).toContain("run stopped early");
  });
});
