/**
 * `footage compare` — the aspect mapping and the sweep arithmetic.
 *
 * Two things in this module can be wrong in a way that produces a confident,
 * readable, entirely false report, and both are pinned here.
 *
 * **The aspect filter.** The Qdrant payload stores `landscape`/`portrait`/
 * `square`; a render carries `16:9`/`9:16`/`1:1`. Passing the request value
 * matches zero points — verified against the live 1,512-clip collection, where
 * `aspect = "9:16"` counts 0 and `aspect = "portrait"` counts 756. The failure
 * is silent: every term reports "no library match", the sweep collapses to
 * zeros, and the conclusion drawn would be "the library is useless" when the
 * only broken thing is one string. So the filter is asserted structurally, and
 * a separate test asserts that a raw ratio never appears in a filter at all.
 *
 * **The sweep arithmetic.** It is the input to the `min_score` decision. The
 * dedupe in particular is load-bearing: a clip that wins three terms is one
 * clip a render can place, not three, and counting it three times would inflate
 * the reported coverage by whatever the term count happens to be.
 */

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_CLIP_DURATION,
  DEFAULT_LIBRARY_LIMIT,
  SWEEP_THRESHOLDS,
  TERMS_DEFAULT,
  TERMS_SCRIPT_ORDER,
  buildSweep,
  coveredTo,
  formatReport,
  libraryFilter,
  orientationFilterValue,
  parseAspect,
  runCompare,
  type CompareDeps,
  type LibraryCandidate,
  type TermComparison,
} from "../src/services/footage/compare.ts";
import { VideoAspect } from "../src/models/schema.ts";
import type { FootageMatch, FootagePayload } from "../src/services/footage/qdrant.ts";
import type { MaterialInfo } from "../src/models/schema.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function payload(overrides: Partial<FootagePayload> = {}): FootagePayload {
  return {
    local_file: "vid-a.mp4",
    provider: "pexels",
    search_terms: ["rain on window"],
    duration: 12,
    width: 1080,
    height: 1920,
    aspect: "portrait",
    summary: "Rain runs down a dark window at night.",
    detailed_description: "Close-up, neon reflections.",
    use_cases: ["a segment on urban loneliness"],
    mood: ["melancholy"],
    tags: ["rain", "window"],
    setting: "indoor",
    time_of_day: "night",
    has_people: false,
    has_on_screen_text: false,
    camera_motion: "static",
    quality_flags: [],
    describe_model: "gemini",
    describe_version: 1,
    embed_model: "gemini-embedding",
    embed_version: 1,
    indexed_at: new Date(0).toISOString(),
    ...overrides,
  };
}

function match(localFile: string, score: number, duration = 12): FootageMatch {
  return { id: localFile, score, payload: payload({ local_file: localFile, duration }) };
}

/** A `TermComparison` reduced to what `buildSweep` reads. */
function term(name: string, library: Partial<LibraryCandidate>[]): Pick<TermComparison, "term" | "library"> {
  return {
    term: name,
    library: library.map((entry) => ({
      local_file: entry.local_file ?? "vid-a.mp4",
      score: entry.score ?? 0.7,
      duration: entry.duration ?? 12,
      aspect: entry.aspect ?? "portrait",
      summary: entry.summary ?? "",
      provider: entry.provider ?? "pexels",
      asset_id: entry.asset_id ?? null,
    })),
  };
}

/** Every dependency stubbed; individual tests override the one they exercise. */
function deps(overrides: CompareDeps = {}): CompareDeps {
  return {
    generateTerms: async () => ["term one", "term two"],
    searchFootage: async () => [],
    getProviderSearch: () => ({ provider: "pexels", search: async () => [] }),
    searchWithCache: async () => [],
    qdrantAvailable: async () => true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The aspect mapping
// ---------------------------------------------------------------------------

describe("libraryFilter", () => {
  test("maps 9:16 to the payload's orientation word, not the request ratio", () => {
    const filter = libraryFilter(VideoAspect.portrait, 0);
    expect(filter).toEqual({ must: [{ key: "aspect", match: { value: "portrait" } }] });
  });

  test("maps 16:9 to landscape", () => {
    const filter = libraryFilter(VideoAspect.landscape, 0);
    expect(filter).toEqual({ must: [{ key: "aspect", match: { value: "landscape" } }] });
  });

  /**
   * The whole failure mode in one assertion. If a request ratio ever reaches
   * the filter, Qdrant answers zero for every term and the report lies in the
   * library's disfavour while looking completely normal.
   */
  test("never emits a request ratio as a filter value", () => {
    for (const aspect of [VideoAspect.portrait, VideoAspect.landscape, VideoAspect.square]) {
      const serialised = JSON.stringify(libraryFilter(aspect, 5) ?? {});
      expect(serialised).not.toContain("9:16");
      expect(serialised).not.toContain("16:9");
      expect(serialised).not.toContain("1:1");
    }
  });

  /**
   * Square deliberately does not filter, mirroring the provider path, which
   * accepts every orientation for 1:1 and crops at render time. Filtering to
   * `square` would exclude nearly the whole library for a reason that has
   * nothing to do with retrieval quality.
   */
  test("square filters on duration only, mirroring the provider path", () => {
    expect(libraryFilter(VideoAspect.square, 5)).toEqual({
      must: [{ key: "duration", range: { gte: 5 } }],
    });
    expect(libraryFilter(VideoAspect.square, 0)).toBeUndefined();
  });

  test("adds the minimum-duration clause the provider search also applies", () => {
    expect(libraryFilter(VideoAspect.portrait, 5)).toEqual({
      must: [
        { key: "aspect", match: { value: "portrait" } },
        { key: "duration", range: { gte: 5 } },
      ],
    });
  });

  test("orientationFilterValue reports null exactly when nothing is filtered", () => {
    expect(orientationFilterValue(VideoAspect.portrait)).toBe("portrait");
    expect(orientationFilterValue(VideoAspect.landscape)).toBe("landscape");
    expect(orientationFilterValue(VideoAspect.square)).toBeNull();
  });
});

describe("parseAspect", () => {
  test("accepts the request form a render uses", () => {
    expect(parseAspect("9:16")).toBe(VideoAspect.portrait);
    expect(parseAspect("16:9")).toBe(VideoAspect.landscape);
    expect(parseAspect("1:1")).toBe(VideoAspect.square);
  });

  /**
   * `footage search --aspect` takes the orientation word and a render takes the
   * ratio; this command sits between them, so both spellings resolve rather
   * than handing the operator the exact confusion the module documents.
   */
  test("also accepts the orientation word `footage search` uses", () => {
    expect(parseAspect("portrait")).toBe(VideoAspect.portrait);
    expect(parseAspect("LANDSCAPE")).toBe(VideoAspect.landscape);
    expect(parseAspect(" square ")).toBe(VideoAspect.square);
  });

  test("rejects anything else rather than guessing", () => {
    expect(() => parseAspect("4:3")).toThrow(/unknown aspect/);
  });
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

describe("buildSweep", () => {
  test("counts a term as covered when any single match clears the threshold", () => {
    const rows = buildSweep(
      [
        term("a", [{ local_file: "vid-1.mp4", score: 0.71 }]),
        term("b", [{ local_file: "vid-2.mp4", score: 0.58 }]),
      ],
      { thresholds: [0.55, 0.65, 0.75] },
    );

    expect(rows.map((row) => `${row.threshold}:${row.terms_covered}/${row.terms_total}`)).toEqual([
      "0.55:2/2",
      "0.65:1/2",
      "0.75:0/2",
    ]);
  });

  /**
   * The dedupe. One clip winning three terms is one clip a render can place —
   * the per-render reuse ban in the plan's §3.3 — so `matches` and
   * `unique_clips` must diverge, and duration must follow the second.
   */
  test("counts matches per term but clips once, and charges duration once", () => {
    const rows = buildSweep(
      [
        term("a", [{ local_file: "vid-1.mp4", score: 0.8, duration: 12 }]),
        term("b", [{ local_file: "vid-1.mp4", score: 0.8, duration: 12 }]),
        term("c", [{ local_file: "vid-2.mp4", score: 0.8, duration: 12 }]),
      ],
      { thresholds: [0.7], maxClipDuration: 5 },
    );

    expect(rows[0]!.matches).toBe(3);
    expect(rows[0]!.unique_clips).toBe(2);
    expect(rows[0]!.duration).toBe(10); // 2 clips x min(12, 5)
  });

  /** `min(clipDuration, maxClipDuration)` — the download loop's accounting. */
  test("charges a short clip its real length, not the cap", () => {
    const rows = buildSweep(
      [term("a", [
        { local_file: "vid-short.mp4", score: 0.9, duration: 3 },
        { local_file: "vid-long.mp4", score: 0.9, duration: 40 },
      ])],
      { thresholds: [0.7], maxClipDuration: 5 },
    );

    expect(rows[0]!.duration).toBe(8); // 3 + min(40, 5)
  });

  test("reports coverage against an audio target, and null without one", () => {
    const entries = [term("a", [{ local_file: "vid-1.mp4", score: 0.9, duration: 40 }])];

    expect(buildSweep(entries, { thresholds: [0.7], maxClipDuration: 5, audioDuration: 20 })[0]!.coverage)
      .toBeCloseTo(0.25, 5);
    expect(buildSweep(entries, { thresholds: [0.7], maxClipDuration: 5 })[0]!.coverage).toBeNull();
  });

  test("a library that answers nothing produces an all-zero sweep, not an empty one", () => {
    const rows = buildSweep([term("a", []), term("b", [])]);
    expect(rows).toHaveLength(SWEEP_THRESHOLDS.length);
    for (const row of rows) {
      expect(row.terms_covered).toBe(0);
      expect(row.matches).toBe(0);
      expect(row.duration).toBe(0);
    }
  });

  test("thresholds default to the plan's sweep", () => {
    expect(buildSweep([term("a", [])]).map((row) => row.threshold)).toEqual([...SWEEP_THRESHOLDS]);
  });
});

describe("coveredTo", () => {
  test("names the highest threshold a term still clears", () => {
    expect(coveredTo(0.83)).toBe(0.75);
    expect(coveredTo(0.63)).toBe(0.62);
    expect(coveredTo(0.6)).toBe(0.6);
  });

  /** The interesting case: a term no usable threshold can serve. */
  test("returns null for a best score below every threshold", () => {
    expect(coveredTo(0.51)).toBeNull();
    expect(coveredTo(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

describe("runCompare", () => {
  test("asks the LLM with the pipeline's own arguments", async () => {
    const seen: unknown[] = [];
    await runCompare(
      { videoSubject: "why cities feel lonely", videoScript: "script text" },
      deps({
        generateTerms: async (options) => {
          seen.push(options);
          return ["a"];
        },
      }),
    );

    expect(seen[0]).toEqual({
      videoSubject: "why cities feel lonely",
      videoScript: "script text",
      amount: TERMS_DEFAULT,
      matchScriptOrder: false,
    });
  });

  test("--match-script-order asks for the pipeline's larger ordered set", async () => {
    const seen: { amount?: number; matchScriptOrder?: boolean }[] = [];
    await runCompare(
      { videoSubject: "s", matchScriptOrder: true },
      deps({
        generateTerms: async (options) => {
          seen.push(options);
          return ["a"];
        },
      }),
    );

    expect(seen[0]!.amount).toBe(TERMS_SCRIPT_ORDER);
    expect(seen[0]!.matchScriptOrder).toBe(true);
  });

  test("--terms skips the LLM entirely", async () => {
    let called = false;
    const report = await runCompare(
      { videoSubject: "s", terms: ["one", "two"] },
      deps({
        generateTerms: async () => {
          called = true;
          return [];
        },
      }),
    );

    expect(called).toBe(false);
    expect(report.terms).toEqual(["one", "two"]);
    expect(report.terms_source).toBe("given");
  });

  /**
   * The query must reach the embedder bare. Wrapping it ("footage for a video
   * about …") dilutes the subject and invalidates every threshold in the sweep,
   * because the documents were embedded with `RETRIEVAL_DOCUMENT` and the
   * asymmetry is already absorbed by the task types.
   */
  test("queries the library with the bare term and the mapped filter", async () => {
    const calls: { query: string; limit?: number; filter?: unknown }[] = [];
    await runCompare(
      {
        videoSubject: "s",
        terms: ["rain on window"],
        videoAspect: VideoAspect.portrait,
        maxClipDuration: 5,
        libraryLimit: 7,
      },
      deps({
        searchFootage: async (query, limit, filter) => {
          calls.push({ query, limit, filter });
          return [];
        },
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toBe("rain on window");
    expect(calls[0]!.limit).toBe(7);
    expect(calls[0]!.filter).toEqual({
      must: [
        { key: "aspect", match: { value: "portrait" } },
        { key: "duration", range: { gte: 5 } },
      ],
    });
  });

  test("runs the provider through the real cached-search seam, at the download loop's minimum duration", async () => {
    const calls: Record<string, unknown>[] = [];
    await runCompare(
      { videoSubject: "s", terms: ["a"], source: "coverr", maxClipDuration: 6 },
      deps({
        getProviderSearch: () => ({ provider: "coverr", search: async () => [] }),
        searchWithCache: async (options) => {
          calls.push(options as unknown as Record<string, unknown>);
          return [];
        },
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.provider).toBe("coverr");
    expect(calls[0]!.searchTerm).toBe("a");
    expect(calls[0]!.minimumDuration).toBe(6);
    expect(calls[0]!.videoAspect).toBe(VideoAspect.portrait);
  });

  test("--no-provider spends no quota and says so", async () => {
    let called = false;
    const report = await runCompare(
      { videoSubject: "s", terms: ["a", "b"], useProvider: false },
      deps({
        searchWithCache: async () => {
          called = true;
          return [];
        },
        getProviderSearch: () => {
          called = true;
          return { provider: "pexels", search: async () => [] };
        },
      }),
    );

    expect(called).toBe(false);
    expect(report.provider_consulted).toBe(false);
    expect(report.per_term[0]!.provider_note).toContain("--no-provider");
  });

  /**
   * §3.3: one cached probe before the loop. Without it a hung Qdrant costs the
   * query timeout and a warning *per term*.
   */
  test("probes qdrant once for the whole run, not once per term", async () => {
    let probes = 0;
    await runCompare(
      { videoSubject: "s", terms: ["a", "b", "c", "d"] },
      deps({
        qdrantAvailable: async () => {
          probes++;
          return true;
        },
      }),
    );

    expect(probes).toBe(1);
  });

  test("an unreachable qdrant is reported as unknown, never as an empty library", async () => {
    let searched = false;
    const report = await runCompare(
      { videoSubject: "s", terms: ["a"] },
      deps({
        qdrantAvailable: async () => false,
        searchFootage: async () => {
          searched = true;
          return [];
        },
      }),
    );

    expect(searched).toBe(false);
    expect(report.qdrant_available).toBe(false);
    expect(report.per_term[0]!.library_note).toBe("qdrant unreachable");
  });

  test("a library failure on one term does not abort the comparison", async () => {
    const report = await runCompare(
      { videoSubject: "s", terms: ["boom", "fine"] },
      deps({
        searchFootage: async (query) => {
          if (query === "boom") throw new Error("qdrant said no");
          return [match("vid-1.mp4", 0.7)];
        },
      }),
    );

    expect(report.per_term[0]!.library_note).toContain("qdrant said no");
    expect(report.per_term[1]!.library).toHaveLength(1);
  });

  test("summarises both sides and drops the provider download URL", async () => {
    const item: MaterialInfo = {
      provider: "pexels",
      url: "https://player.example/secret-token.mp4",
      duration: 19,
      source_info: {
        provider: "pexels",
        search_term: "a",
        asset_id: "5896379",
        rendition: { id: "9", width: 1080, height: 1920 },
      },
    };

    const report = await runCompare(
      { videoSubject: "s", terms: ["a"], audioDuration: 30 },
      deps({
        searchWithCache: async () => [item],
        searchFootage: async () => [match("vid-1.mp4", 0.7412, 19)],
      }),
    );

    expect(report.per_term[0]!.provider[0]).toEqual({
      provider: "pexels",
      asset_id: "5896379",
      width: 1080,
      height: 1920,
      duration: 19,
    });
    expect(JSON.stringify(report)).not.toContain("secret-token");

    expect(report.per_term[0]!.best_score).toBe(0.7412);
    expect(report.totals.library_unique_clips).toBe(1);
    expect(report.audio_duration).toBe(30);
  });

  test("names the terms the library could not serve at all", async () => {
    const report = await runCompare(
      { videoSubject: "s", terms: ["served", "unserved"] },
      deps({
        searchFootage: async (query) => (query === "served" ? [match("vid-1.mp4", 0.7)] : []),
      }),
    );

    expect(report.totals.terms_with_no_library_match).toEqual(["unserved"]);
    expect(report.per_term[1]!.best_score).toBeNull();
  });

  test("records the aspect mapping it used, so the report is self-evidencing", async () => {
    const report = await runCompare(
      { videoSubject: "s", terms: ["a"], videoAspect: VideoAspect.landscape },
      deps(),
    );

    expect(report.video_aspect).toBe("16:9");
    expect(report.orientation_filter).toBe("landscape");
  });

  test("defaults match the pipeline's and the module's documented values", async () => {
    const report = await runCompare({ videoSubject: "s", terms: ["a"] }, deps());
    expect(report.video_aspect).toBe(VideoAspect.portrait);
    expect(report.max_clip_duration).toBe(DEFAULT_CLIP_DURATION);
    expect(report.library_limit).toBe(DEFAULT_LIBRARY_LIMIT);
    expect(report.source).toBe("pexels");
  });

  test("refuses an empty subject rather than embedding whitespace", async () => {
    await expect(runCompare({ videoSubject: "   " }, deps())).rejects.toThrow(/video subject/);
  });

  test("refuses to report on zero terms", async () => {
    await expect(
      runCompare({ videoSubject: "s" }, deps({ generateTerms: async () => [] })),
    ).rejects.toThrow(/no search terms/);
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("formatReport", () => {
  test("prints every sweep row and both sides of every term", async () => {
    const report = await runCompare(
      { videoSubject: "why cities feel lonely", terms: ["rain on window"], audioDuration: 30 },
      deps({
        searchWithCache: async () => [
          {
            provider: "pexels",
            url: "https://player.example/x.mp4",
            duration: 19,
            source_info: { asset_id: "5896379", rendition: { id: "1", width: 1080, height: 1920 } },
          },
        ],
        searchFootage: async () => [match("vid-1.mp4", 0.7412, 19)],
      }),
    );

    const text = formatReport(report);

    for (const threshold of SWEEP_THRESHOLDS) expect(text).toContain(threshold.toFixed(2));
    expect(text).toContain("min_score sweep");
    expect(text).toContain("per-term library coverage");
    expect(text).toContain("rain on window");
    expect(text).toContain("5896379");
    expect(text).toContain("vid-1.mp4");
    expect(text).toContain("0.7412");
    // The mapping is stated in the header, so a reader can confirm from the
    // output alone that the library was actually filtered correctly.
    expect(text).toContain('aspect="portrait"');
  });

  /**
   * A saturated sweep is the one way this report can mislead while looking
   * healthy: if every returned match clears the lowest threshold, the low rows
   * counted `--limit`, not the library, and they understate it — the wrong
   * direction for a decision about how low `min_score` can safely go. Observed
   * for real at `--limit 8`, where 0.55 through 0.65 were identical.
   */
  test("warns when --limit, not the library, is what stopped the low rows", async () => {
    const full = Array.from({ length: 4 }, (_, index) => match(`vid-${index}.mp4`, 0.9));

    const saturated = await runCompare(
      { videoSubject: "s", terms: ["a"], libraryLimit: 4 },
      deps({ searchFootage: async () => full }),
    );
    expect(formatReport(saturated)).toContain("capped by --limit");

    // One match below the lowest threshold proves the page was not truncated.
    const headroom = await runCompare(
      { videoSubject: "s", terms: ["a"], libraryLimit: 4 },
      deps({ searchFootage: async () => [...full.slice(0, 3), match("vid-low.mp4", 0.4)] }),
    );
    expect(formatReport(headroom)).not.toContain("capped by --limit");
  });

  test("an empty library side renders as an explicit verdict, not a blank", async () => {
    const report = await runCompare(
      { videoSubject: "s", terms: ["nothing here"] },
      deps({ searchFootage: async () => [] }),
    );

    const text = formatReport(report);
    expect(text).toContain("NO MATCH");
    expect(text).toContain("terms the library returned nothing for");
  });
});
