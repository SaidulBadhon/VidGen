/**
 * The scene-matching engine: its arithmetic, its scene cutting, its response
 * validation, its collision pass, and the orchestration driven through its own
 * seams.
 *
 * Nothing here reaches Qdrant, a model, ffprobe or the filesystem. `buildScenes`,
 * `durationBand`, `sceneFilter`, `validateJudgeResponse`, `assign`, `chunk` and
 * `buildJudgePrompt` are pure; `shortlistFor`, `judgeBatch` and `matchScenes`
 * take their search, probe, path resolution and generation as injected
 * functions, which is the only reason the orchestration is testable at all in a
 * suite that uses no mocking library.
 *
 * **No case asserts that a particular clip is chosen for a particular scene.**
 * The judge is a model and its picks are not reproducible — the same candidates
 * have been rejected in a batch and accepted when judged alone. What is asserted
 * is the structure around it: which scenes are asked, in what order, what a
 * malformed answer degrades to, and what happens when two scenes want one file.
 *
 * Five of the rules below are review findings that were paid for once already,
 * and each one is a defect if it regresses:
 *
 *  1. speed is normalized exactly once, in `durationBand`, before any duration
 *     arithmetic — raw `10` is 2.0 and raw `-1` is 1.0;
 *  2. a cue span merges up to the slot and a single over-long cue is not split;
 *  3. `assign` dedupes by resolved file, **never** by candidate index;
 *  4. every malformed judge answer degrades to `none`, one per input scene;
 *  5. the aspect filter carries the payload's orientation, not the request's
 *     ratio, and square is left unfiltered.
 */

import { beforeAll, describe, expect, test } from "bun:test";

import { defaultSettings } from "../src/config/schema.ts";
import { __setSettingsForTest } from "../src/config/settings.ts";
import { VideoAspect } from "../src/models/schema.ts";
import type { MediaInfo } from "../src/services/video/probe.ts";
import type { FootageFilter, FootageMatch, FootagePayload } from "../src/services/footage/qdrant.ts";
import {
  DEFAULT_SLOT_SECONDS,
  JUDGE_NONE,
  SCENE_FOOTAGE_DEFAULTS,
  assign,
  buildJudgePrompt,
  buildScenes,
  chunk,
  durationBand,
  isCancellation,
  judgeBatch,
  matchScenes,
  sceneFilter,
  sceneFootageOptions,
  shortlistFor,
  validateJudgeResponse,
  type Candidate,
  type JudgeDeps,
  type JudgeProposal,
  type MatchDeps,
  type Scene,
  type SceneProposal,
  type ShortlistDeps,
} from "../src/services/footage/sceneMatch.ts";

beforeAll(() => {
  __setSettingsForTest(defaultSettings());
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function payloadFor(localFile: string, overrides: Partial<FootagePayload> = {}): FootagePayload {
  return {
    local_file: localFile,
    provider: "pexels",
    search_terms: ["rain on window"],
    duration: 10,
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
    describe_model: "stub",
    describe_version: 1,
    embed_model: "stub",
    embed_version: 1,
    indexed_at: "1970-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A shortlist entry. `file` is the dedupe key, so it is always distinct here. */
function candidate(name: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    file: `/cache/${name}`,
    local_file: name,
    score: 0.5,
    duration: 10,
    payload: payloadFor(name),
    ...overrides,
  };
}

function sceneAt(index: number, text = `narration ${index}`): Scene {
  return { id: `scene-${index + 1}`, index, text, start: index * 5, end: (index + 1) * 5 };
}

function proposal(scene: Scene, candidates: Candidate[], choice: number | null, reason = "because"): SceneProposal {
  return { scene, candidates, choice, reason };
}

function match(localFile: string, score = 0.5, overrides: Partial<FootagePayload> = {}): FootageMatch {
  return { id: localFile, score, payload: payloadFor(localFile, overrides) };
}

function media(duration: number, overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    duration,
    width: 1080,
    height: 1920,
    fps: 30,
    hasVideo: true,
    hasAudio: false,
    audioSampleRate: 0,
    ...overrides,
  };
}

/** Shortlists as `judgeBatch`/`validateJudgeResponse` want them. */
function shortlistMap(entries: Record<string, Candidate[]>): Map<string, Candidate[]> {
  return new Map(Object.entries(entries));
}

// ---------------------------------------------------------------------------

describe("durationBand", () => {
  test("is the floor the renderer consumes and the ceiling the judge may read", () => {
    // `slot * speed` mirrors `combine.ts`'s `sourceClipDuration` exactly; the
    // ceiling is `slot * ratio`, which is what keeps the judged footage and the
    // rendered footage approximately the same footage.
    expect(durationBand(5, 1)).toEqual({ min: 5, max: 20, speed: 1 });
    expect(durationBand(8, 1, 3)).toEqual({ min: 8, max: 24, speed: 1 });
  });

  test("uses the schema's own ratio as the default ceiling", () => {
    expect(durationBand(5, 1).max).toBe(5 * SCENE_FOOTAGE_DEFAULTS.duration_ratio);
  });

  // -- speed normalization, the finding this function exists for -------------

  test("clamps a raw speed of 10 to 2.0, so the floor is 10s and not 50s", () => {
    // The request schema accepts unbounded speed while the renderer clamps to
    // 0.5-2.0. Demanding 50s of source would empty the shortlist for a request
    // the renderer is perfectly happy to serve.
    const band = durationBand(5, 10);
    expect(band.speed).toBe(2);
    expect(band.min).toBe(10);
    expect(band.min).not.toBe(50);
  });

  test("clamps a negative speed to 1.0 rather than asking for negative source", () => {
    expect(durationBand(5, -1)).toEqual({ min: 5, max: 20, speed: 1 });
  });

  test("clamps a speed below the renderer's floor up to 0.5", () => {
    expect(durationBand(5, 0.1)).toEqual({ min: 2.5, max: 20, speed: 0.5 });
  });

  test("coerces and defaults the speeds a request can actually carry", () => {
    for (const raw of [undefined, null, "", NaN, 0, "not a number", {}]) {
      expect(durationBand(5, raw).speed).toBe(1);
    }
    expect(durationBand(5, "2").speed).toBe(2);
    expect(durationBand(5, 1.5).speed).toBe(1.5);
  });

  test("normalizes exactly once, so the reported speed explains the floor", () => {
    for (const raw of [10, -1, 0.1, 1.25, "3"]) {
      const band = durationBand(5, raw);
      expect(band.min).toBe(5 * band.speed);
    }
  });

  // -- the ratio ------------------------------------------------------------

  test("accepts a fractional ratio, which is a legitimate band", () => {
    // 2.5 is valid configuration; truncating it to 2 would silently narrow the
    // window on every scene.
    expect(durationBand(4, 1, 2.5)).toEqual({ min: 4, max: 10, speed: 1 });
    expect(durationBand(5, 1, 1.5).max).toBe(7.5);
  });

  test("raises a ratio below the speed to the speed instead of inverting the band", () => {
    // ratio 1 at 2x would ask for 10s..5s — a window that ends before it begins
    // and matches nothing. It collapses to a single duration instead.
    const band = durationBand(5, 2, 1);
    expect(band).toEqual({ min: 10, max: 10, speed: 2 });
    expect(band.max).toBeGreaterThanOrEqual(band.min);
  });

  test("never returns an inverted band for any speed and ratio the schema allows", () => {
    for (const speed of [0.1, 0.5, 1, 1.7, 2, 10, -3]) {
      for (const ratio of [1, 1.5, 2, 2.5, 4, 9]) {
        const band = durationBand(5, speed, ratio);
        expect(band.max).toBeGreaterThanOrEqual(band.min);
      }
    }
  });

  test("falls back to the default ratio when the ratio is unusable", () => {
    // Below 1 the band inverts, so the schema's floor is 1; a stored value that
    // somehow got past it is replaced rather than honoured.
    for (const ratio of [0.5, 0, -2, NaN, Infinity]) {
      expect(durationBand(5, 1, ratio).max).toBe(5 * SCENE_FOOTAGE_DEFAULTS.duration_ratio);
    }
  });

  // -- the slot -------------------------------------------------------------

  test("falls back to the default slot when the slot is nonsensical", () => {
    for (const slot of [0, -5, NaN, Infinity]) {
      expect(durationBand(slot, 1)).toEqual({
        min: DEFAULT_SLOT_SECONDS,
        max: DEFAULT_SLOT_SECONDS * SCENE_FOOTAGE_DEFAULTS.duration_ratio,
        speed: 1,
      });
    }
  });

  test("the default slot is five seconds, matching video_clip_duration's default", () => {
    expect(DEFAULT_SLOT_SECONDS).toBe(5);
  });
});

// ---------------------------------------------------------------------------

describe("SCENE_FOOTAGE_DEFAULTS", () => {
  test("is the schema's own defaults, frozen, so it cannot drift from settings", () => {
    expect(SCENE_FOOTAGE_DEFAULTS).toEqual(defaultSettings().scene_footage);
    expect(Object.isFrozen(SCENE_FOOTAGE_DEFAULTS)).toBe(true);
  });

  test("sceneFootageOptions reads the installed settings group", () => {
    expect(sceneFootageOptions()).toEqual(defaultSettings().scene_footage);
  });
});

// ---------------------------------------------------------------------------

describe("buildScenes", () => {
  const words = (count: number, from = 0) =>
    Array.from({ length: count }, (_, index) => ({
      start: from + index,
      end: from + index + 1,
      text: `w${from + index}`,
    }));

  test("merges adjacent cues until the span reaches the slot", () => {
    expect(buildScenes(words(6), 3)).toEqual([
      { id: "scene-1", index: 0, text: "w0 w1 w2", start: 0, end: 3 },
      { id: "scene-2", index: 1, text: "w3 w4 w5", start: 3, end: 6 },
    ]);
  });

  test("emits the trailing partial group, which is shorter than the slot", () => {
    // Dropping it would lose the tail of the narration entirely.
    const scenes = buildScenes(words(4), 3);
    expect(scenes).toHaveLength(2);
    expect(scenes[1]).toEqual({ id: "scene-2", index: 1, text: "w3", start: 3, end: 4 });
  });

  test("tiles a single cue longer than the slot across slots", () => {
    // The renderer caps every assigned clip at one slot, so one scene per cue
    // would give 5s of picture for 30s of narration and the combiner would
    // loop from the start — the closing narration over the opening footage.
    // The cue's text belongs to every tile because it is spoken across all of
    // them; the reuse ban then gives each tile a different clip.
    const scenes = buildScenes([{ start: 0, end: 30, text: "one long line" }], 5);
    expect(scenes).toHaveLength(6);
    expect(scenes.every((scene) => scene.text === "one long line")).toBe(true);
    expect(scenes[0]!.start).toBe(0);
    expect(scenes.at(-1)!.end).toBe(30);
  });

  test("counts silence toward the span, so a pause does not lengthen a scene", () => {
    // A gap between cues is time the clip still has to cover. Ignoring it would
    // systematically produce fewer, longer scenes than the narration needs.
    const scenes = buildScenes(
      [
        { start: 0, end: 1, text: "a" },
        { start: 9, end: 10, text: "b" },
      ],
      5,
    );
    // Silence is still time the picture must cover, so the tiling spans it.
    expect(scenes).toHaveLength(2);
    expect(scenes[0]!.start).toBe(0);
    expect(scenes.at(-1)!.end).toBe(10);
  });

  test("gives stable, deterministic, one-based ids with zero-based indices", () => {
    const scenes = buildScenes(words(9), 3);
    expect(scenes.map((scene) => scene.id)).toEqual(["scene-1", "scene-2", "scene-3"]);
    expect(scenes.map((scene) => scene.index)).toEqual([0, 1, 2]);
  });

  test("is pure: the same cues produce byte-identical scenes every time", () => {
    // The ids are carried through judging and back into assignment, so a run
    // that renumbered them would misattribute every pick.
    const cues = words(7);
    expect(buildScenes(cues, 3)).toEqual(buildScenes(cues, 3));
    expect(buildScenes(cues, 3)).toEqual(buildScenes([...cues], 3));
  });

  test("reads either cue spelling, because the two producers disagree", () => {
    // `TtsCue` spells it `content`, `SubtitleCue` spells it `text`.
    const scenes = buildScenes(
      [
        { start: 0, end: 1, content: "from tts" },
        { start: 1, end: 2, text: "from subtitles" },
      ],
      5,
    );
    expect(scenes[0]!.text).toBe("from tts from subtitles");
  });

  test("collapses whitespace inside the merged narration", () => {
    const scenes = buildScenes([{ start: 0, end: 6, text: "  a\n\n  b\tc  " }], 5);
    expect(scenes[0]!.text).toBe("a b c");
  });

  // -- degenerate input -----------------------------------------------------

  test("returns nothing for no cues at all", () => {
    expect(buildScenes([], 5)).toEqual([]);
    expect(buildScenes(undefined as unknown as [], 5)).toEqual([]);
    expect(buildScenes(null as unknown as [], 5)).toEqual([]);
  });

  test("still emits a group that ended up with no text", () => {
    // A silent span keeps the scene count honest against the narration's
    // length; `shortlistFor` short-circuits it without a network call.
    const scenes = buildScenes([{ start: 0, end: 6 }], 5);
    expect(scenes).toHaveLength(2);
    expect(scenes.every((scene) => scene.text === "")).toBe(true);
  });

  test("skips holes in the cue list rather than throwing", () => {
    const scenes = buildScenes(
      [null as unknown as { start: number; end: number }, { start: 0, end: 6, text: "a" }],
      5,
    );
    expect(scenes).toHaveLength(2);
    expect(scenes.every((scene) => scene.text === "a")).toBe(true);
    expect(scenes.at(-1)!.end).toBe(6);
  });

  test("continues from the last end when a cue carries no usable start", () => {
    // Cue timings arrive from TTS adapters and from approximate long-form
    // alignment, so a missing start must keep the span monotonic rather than
    // reset it to zero and produce a negative-length scene.
    const scenes = buildScenes(
      [
        { start: 0, end: 4, text: "a" },
        { start: NaN, end: NaN, text: "b" },
        { start: "oops" as unknown as number, end: 9, text: "c" },
      ],
      5,
    );
    // The point is a monotonic timeline, not a scene count: a reset to zero
    // would produce a negative-length span and a tiling that never terminates.
    expect(scenes.length).toBeGreaterThan(0);
    expect(scenes.every((scene) => scene.end >= scene.start)).toBe(true);
    expect(scenes.every((scene, k) => k === 0 || scene.start >= scenes[k - 1]!.start)).toBe(true);
    // The unusable cue is absorbed into the timeline rather than resetting it,
    // so the tiling still spans 0..9 exactly once.
    expect(scenes[0]!.start).toBe(0);
    expect(scenes.at(-1)!.end).toBe(9);
  });

  test("never lets a cue end before it starts", () => {
    const scenes = buildScenes([{ start: 8, end: 2, text: "reversed" }], 5);
    expect(scenes[0]!.start).toBe(8);
    expect(scenes[0]!.end).toBe(8);
  });

  test("falls back to the default slot rather than degenerating", () => {
    // Zero or NaN would otherwise merge the whole narration into one scene, or
    // emit one scene per cue — both silently wrong until the render.
    for (const slot of [0, -1, NaN, Infinity]) {
      expect(buildScenes(words(10), slot)).toEqual(buildScenes(words(10), DEFAULT_SLOT_SECONDS));
    }
    expect(buildScenes(words(10), 0)).toHaveLength(2);
  });

  test("every scene's index is its position in the output", () => {
    const scenes = buildScenes(words(20), 2);
    scenes.forEach((scene, index) => {
      expect(scene.index).toBe(index);
      expect(scene.id).toBe(`scene-${index + 1}`);
    });
  });
});

// ---------------------------------------------------------------------------

describe("sceneFilter", () => {
  const band = { min: 5, max: 20, speed: 1 };

  test("filters on the payload's orientation, never the request's ratio", () => {
    // Verified against the live collection: `aspect = "9:16"` matches zero
    // points while `aspect = "portrait"` matches 756 of 1,512. Sending the
    // request value would empty every shortlist and look like an empty gallery.
    const filter = sceneFilter(VideoAspect.portrait, band) as FootageFilter;
    expect(filter.must).toContainEqual({ key: "aspect", match: { value: "portrait" } });
    expect(JSON.stringify(filter)).not.toContain("9:16");
  });

  test("maps landscape to the landscape orientation", () => {
    const filter = sceneFilter(VideoAspect.landscape, band) as FootageFilter;
    expect(filter.must).toContainEqual({ key: "aspect", match: { value: "landscape" } });
    expect(JSON.stringify(filter)).not.toContain("16:9");
  });

  test("leaves square unfiltered, mirroring the provider path", () => {
    // A square render may receive portrait footage, which `buildFitFilter`
    // pads. That is today's behaviour for square and is accepted in §7.5.
    const filter = sceneFilter(VideoAspect.square, band) as FootageFilter;
    expect(JSON.stringify(filter)).not.toContain("aspect");
    expect(JSON.stringify(filter)).not.toContain("square");
    expect(filter.must).toHaveLength(1);
  });

  test("carries the band as a duration range, both ends", () => {
    const filter = sceneFilter(VideoAspect.portrait, { min: 7.5, max: 30, speed: 1.5 }) as FootageFilter;
    expect(filter.must).toContainEqual({ key: "duration", range: { gte: 7.5, lte: 30 } });
  });

  test("omits the duration clause when the band is not usable", () => {
    for (const bad of [
      { min: 0, max: 20, speed: 1 },
      { min: NaN, max: 20, speed: 1 },
      { min: 5, max: NaN, speed: 1 },
      { min: 5, max: Infinity, speed: 1 },
    ]) {
      const filter = sceneFilter(VideoAspect.portrait, bad) as FootageFilter;
      expect(JSON.stringify(filter)).not.toContain("duration");
    }
  });

  test("returns undefined when there is nothing at all to filter on", () => {
    // Square with an unusable band leaves no clause; an empty `must` would be a
    // filter that matches nothing.
    expect(sceneFilter(VideoAspect.square, { min: 0, max: 0, speed: 1 })).toBeUndefined();
  });

  test("every aspect the request schema allows produces a filter it can use", () => {
    for (const aspect of Object.values(VideoAspect)) {
      const must = sceneFilter(aspect, band)?.must;
      expect(Array.isArray(must)).toBe(true);
      expect(must).not.toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------

describe("shortlistFor", () => {
  const options = { slotSeconds: 5, speed: 1, videoAspect: VideoAspect.portrait };

  function deps(overrides: Partial<ShortlistDeps> = {}, matches: FootageMatch[] = []): ShortlistDeps {
    return {
      search: async () => matches,
      probeFile: async () => media(10),
      resolveFile: (localFile: string) => `/cache/${localFile}`,
      ...overrides,
    };
  }

  test("never searches for a silent scene", async () => {
    // `searchFootage` would reject a blank query, and at run level that aborts
    // the whole match — for a scene that is simply a pause.
    let calls = 0;
    const result = await shortlistFor(
      { ...sceneAt(0), text: "   " },
      options,
      deps({
        search: async () => {
          calls++;
          return [];
        },
      }),
    );
    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });

  test("passes the band-derived filter and the shortlist size to the search", async () => {
    const seen: Array<{ query: string; limit: number; filter?: FootageFilter }> = [];
    await shortlistFor(
      sceneAt(0, "a wet street at night"),
      { ...options, speed: 2, limit: 4, durationRatio: 3 },
      deps({
        search: async (query, limit, filter) => {
          seen.push({ query, limit, filter });
          return [];
        },
      }),
    );

    expect(seen[0]!.query).toBe("a wet street at night");
    expect(seen[0]!.limit).toBe(4);
    expect(seen[0]!.filter!.must).toContainEqual({ key: "aspect", match: { value: "portrait" } });
    // slot 5 at 2x, ratio 3: 10..15.
    expect(seen[0]!.filter!.must).toContainEqual({ key: "duration", range: { gte: 10, lte: 15 } });
  });

  test("defaults the limit to the configured shortlist size and floors it at one", async () => {
    const limits: number[] = [];
    const capture = deps({
      search: async (_query, limit) => {
        limits.push(limit);
        return [];
      },
    });

    await shortlistFor(sceneAt(0), options, capture);
    await shortlistFor(sceneAt(0), { ...options, limit: 0 }, capture);
    await shortlistFor(sceneAt(0), { ...options, limit: -3 }, capture);
    expect(limits).toEqual([SCENE_FOOTAGE_DEFAULTS.shortlist_size, 1, 1]);
  });

  test("keeps the search order and carries score, duration and payload through", async () => {
    const result = await shortlistFor(
      sceneAt(0),
      options,
      deps({ probeFile: async () => media(12) }, [match("vid-a.mp4", 0.9), match("vid-b.mp4", 0.7)]),
    );

    expect(result.map((entry) => entry.local_file)).toEqual(["vid-a.mp4", "vid-b.mp4"]);
    expect(result[0]).toMatchObject({ file: "/cache/vid-a.mp4", score: 0.9, duration: 12 });
    expect(result[0]!.payload.summary).toBe("A woman walks along a wet street.");
  });

  test("drops a hit whose path will not resolve inside the cache directory", async () => {
    // The containment check is the render's own; a path it would refuse must
    // never reach the judge as an option.
    const result = await shortlistFor(
      sceneAt(0),
      options,
      deps(
        {
          resolveFile: (localFile: string) => {
            if (localFile.includes("..")) throw new Error("escapes the directory");
            return `/cache/${localFile}`;
          },
        },
        [match("../etc/passwd.mp4"), match("vid-ok.mp4")],
      ),
    );
    expect(result.map((entry) => entry.local_file)).toEqual(["vid-ok.mp4"]);
  });

  test("drops a hit with no payload or no local_file", async () => {
    const result = await shortlistFor(sceneAt(0), options, {
      ...deps(),
      search: async () => [
        { id: "1", score: 0.9, payload: null },
        { id: "2", score: 0.8, payload: payloadFor("  ") },
        match("vid-ok.mp4"),
      ],
    });
    expect(result.map((entry) => entry.local_file)).toEqual(["vid-ok.mp4"]);
  });

  test("offers the same file only once, so the judge cannot choose between identicals", async () => {
    const result = await shortlistFor(
      sceneAt(0),
      options,
      deps({}, [match("vid-a.mp4"), match("vid-a.mp4"), match("vid-b.mp4")]),
    );
    expect(result.map((entry) => entry.local_file)).toEqual(["vid-a.mp4", "vid-b.mp4"]);
  });

  test("drops what the probe cannot vouch for", async () => {
    const result = await shortlistFor(sceneAt(0), options, {
      ...deps({}, [match("vid-throws.mp4"), match("vid-audio.mp4"), match("vid-zero.mp4"), match("vid-ok.mp4")]),
      probeFile: async (path: string) => {
        if (path.includes("throws")) throw new Error("ffprobe failed");
        if (path.includes("audio")) return media(10, { hasVideo: false });
        if (path.includes("zero")) return media(0);
        return media(10);
      },
    });
    expect(result.map((entry) => entry.local_file)).toEqual(["vid-ok.mp4"]);
  });

  test("re-checks the probed duration against the floor only", async () => {
    // The floor is a render-correctness bound and must hold for the file as it
    // is on disk now. The ceiling is a judge-agreement bound tied to a
    // description written at index time, so re-imposing it on a probe would
    // drop clips for a disagreement that says nothing about the judge.
    const result = await shortlistFor(sceneAt(0), options, {
      ...deps({}, [match("vid-short.mp4"), match("vid-long.mp4")]),
      probeFile: async (path: string) => media(path.includes("short") ? 2 : 600),
    });
    expect(result.map((entry) => entry.local_file)).toEqual(["vid-long.mp4"]);
  });

  test("allows a frame or two of slack below the floor", async () => {
    // `probe()` prefers the container duration over the stream's and the two
    // disagree by a frame on plenty of stock encodes; dropping a 4.98s clip
    // from a 5.00s floor costs a real candidate for a rounding difference.
    const result = await shortlistFor(sceneAt(0), options, {
      ...deps({}, [match("vid-4.98.mp4"), match("vid-4.90.mp4")]),
      probeFile: async (path: string) => media(path.includes("4.98") ? 4.98 : 4.9),
    });
    expect(result.map((entry) => entry.local_file)).toEqual(["vid-4.98.mp4"]);
  });

  test("probes a file once per run, however many shortlists it appears in", async () => {
    // A 30-scene short shortlists 450 candidates and the same popular clip
    // recurs across many of them; each recurrence would be another ffprobe.
    const probed: string[] = [];
    const probeCache = new Map<string, MediaInfo | null>();
    const shared = deps(
      {
        probeFile: async (path: string) => {
          probed.push(path);
          return media(10);
        },
        probeCache,
      },
      [match("vid-a.mp4")],
    );

    await shortlistFor(sceneAt(0), options, shared);
    await shortlistFor(sceneAt(1), options, shared);
    expect(probed).toEqual(["/cache/vid-a.mp4"]);
    expect(probeCache.size).toBe(1);
  });

  test("remembers a failed probe too, so a broken file is not retried per scene", async () => {
    let probes = 0;
    const probeCache = new Map<string, MediaInfo | null>();
    const shared = deps(
      {
        probeFile: async () => {
          probes++;
          throw new Error("ffprobe failed");
        },
        probeCache,
      },
      [match("vid-broken.mp4")],
    );

    expect(await shortlistFor(sceneAt(0), options, shared)).toEqual([]);
    expect(await shortlistFor(sceneAt(1), options, shared)).toEqual([]);
    expect(probes).toBe(1);
    expect(probeCache.get("/cache/vid-broken.mp4")).toBeNull();
  });

  test("stops consuming matches once the run is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await shortlistFor(
      sceneAt(0),
      { ...options, signal: controller.signal },
      deps({}, [match("vid-a.mp4"), match("vid-b.mp4")]),
    );
    expect(result).toEqual([]);
  });

  test("lets a search failure escape, because it is a configuration fault", async () => {
    // `searchFootage` throws for a missing key or a bad embedding model. That is
    // not a property of one scene, so the run level turns it into "no scene
    // matching happened" rather than repeating it thirty times.
    const failing = shortlistFor(
      sceneAt(0),
      options,
      deps({
        search: async () => {
          throw new Error("embedding model is not configured");
        },
      }),
    );
    await expect(failing).rejects.toThrow("embedding model is not configured");
  });
});

// ---------------------------------------------------------------------------

describe("validateJudgeResponse", () => {
  const scenes = [sceneAt(0), sceneAt(1), sceneAt(2)];
  const shortlists = shortlistMap({
    "scene-1": [candidate("vid-a.mp4"), candidate("vid-b.mp4"), candidate("vid-c.mp4")],
    "scene-2": [candidate("vid-d.mp4"), candidate("vid-e.mp4")],
    "scene-3": [candidate("vid-f.mp4")],
  });

  test("returns exactly one proposal per input scene, in input order", () => {
    const result = validateJudgeResponse(scenes, shortlists, [
      { scene_id: "scene-3", choice: 0, reason: "third" },
      { scene_id: "scene-1", choice: 2, reason: "first" },
      { scene_id: "scene-2", choice: 1, reason: "second" },
    ]);

    expect(result.map((entry) => entry.scene_id)).toEqual(["scene-1", "scene-2", "scene-3"]);
    expect(result.map((entry) => entry.choice)).toEqual([2, 1, 0]);
    expect(result.map((entry) => entry.reason)).toEqual(["first", "second", "third"]);
  });

  test("degrades an omitted scene to none", () => {
    const result = validateJudgeResponse(scenes, shortlists, [{ scene_id: "scene-1", choice: 0, reason: "ok" }]);
    expect(result.map((entry) => entry.choice)).toEqual([0, null, null]);
    expect(result[1]!.reason).toBe("judge omitted this scene");
  });

  test("degrades a scene answered twice to none, not to the first answer", () => {
    // Two answers for one scene means the model lost track of the list. Picking
    // one of them is exactly the confidently-wrong clip this exists to prevent.
    const result = validateJudgeResponse(scenes, shortlists, [
      { scene_id: "scene-1", choice: 0, reason: "first answer" },
      { scene_id: "scene-1", choice: 2, reason: "second answer" },
      { scene_id: "scene-2", choice: 0, reason: "fine" },
      { scene_id: "scene-3", choice: 0, reason: "fine" },
    ]);

    expect(result[0]!.choice).toBeNull();
    expect(result[0]!.reason).toBe("judge answered this scene more than once");
    // The scenes it answered once are untouched.
    expect(result[1]!.choice).toBe(0);
    expect(result[2]!.choice).toBe(0);
  });

  test("discards answers for scenes that were never in the batch", () => {
    const result = validateJudgeResponse(scenes, shortlists, [
      { scene_id: "scene-99", choice: 0, reason: "invented" },
      { scene_id: "", choice: 1, reason: "nameless" },
      { scene_id: "scene-1", choice: 1, reason: "real" },
      { scene_id: "scene-2", choice: 0, reason: "real" },
      { scene_id: "scene-3", choice: 0, reason: "real" },
    ]);

    expect(result).toHaveLength(3);
    expect(result.map((entry) => entry.choice)).toEqual([1, 0, 0]);
    expect(JSON.stringify(result)).not.toContain("invented");
  });

  test("degrades an index outside that scene's own shortlist to none", () => {
    // Shortlists differ in length after probing drops candidates, so the bound
    // is per scene and never a shared one: 2 is valid for scene-1 and out of
    // range for scene-3, whose shortlist holds one clip.
    const result = validateJudgeResponse(scenes, shortlists, [
      { scene_id: "scene-1", choice: 2, reason: "in range" },
      { scene_id: "scene-2", choice: 5, reason: "past the end" },
      { scene_id: "scene-3", choice: 2, reason: "past its own end" },
    ]);

    expect(result.map((entry) => entry.choice)).toEqual([2, null, null]);
    expect(result[1]!.reason).toContain("invalid choice (5, shortlist has 2)");
    expect(result[2]!.reason).toContain("shortlist has 1");
    // The model's own words are kept alongside the diagnosis.
    expect(result[1]!.reason).toContain("past the end");
  });

  test("degrades a negative or fractional index to none", () => {
    const result = validateJudgeResponse(scenes, shortlists, [
      { scene_id: "scene-1", choice: -4, reason: "negative" },
      { scene_id: "scene-2", choice: 1.5, reason: "fractional" },
      { scene_id: "scene-3", choice: undefined, reason: "absent" },
    ]);
    expect(result.map((entry) => entry.choice)).toEqual([null, null, null]);
  });

  test("honours -1 as a refusal and keeps the judge's reason for it", () => {
    // The refusal and a malformed answer both become none, but they are
    // different events: the first is the judge working as asked.
    const result = validateJudgeResponse(scenes, shortlists, [
      { scene_id: "scene-1", choice: JUDGE_NONE, reason: "nothing here is about rain" },
      { scene_id: "scene-2", choice: JUDGE_NONE, reason: "   " },
      { scene_id: "scene-3", choice: 0, reason: "fine" },
    ]);

    expect(result[0]).toEqual({
      scene_id: "scene-1",
      choice: null,
      reason: "nothing here is about rain",
    });
    expect(result[1]!.reason).toBe("judge found nothing suitable");
    expect(result[0]!.reason).not.toContain("invalid");
  });

  test("-1 is the refusal convention the prompt asks for", () => {
    expect(JUDGE_NONE).toBe(-1);
  });

  test("says a scene with no candidates was never asked, not that it was omitted", () => {
    // `judgeBatch` withholds such a scene rather than invite an index into an
    // empty list, so it must not be logged as the judge's omission.
    const withEmpty = shortlistMap({ "scene-1": [candidate("vid-a.mp4")], "scene-2": [], "scene-3": [] });
    const result = validateJudgeResponse(scenes, withEmpty, [
      { scene_id: "scene-1", choice: 0, reason: "fine" },
      { scene_id: "scene-3", choice: 0, reason: "answered anyway" },
    ]);

    expect(result[1]).toEqual({
      scene_id: "scene-2",
      choice: null,
      reason: "no candidates survived shortlisting",
    });
    // Even an answer for it is refused: there was no list to index into.
    expect(result[2]!.choice).toBeNull();
    expect(result[2]!.reason).toBe("no candidates survived shortlisting");
  });

  test("survives a missing, empty or malformed picks list", () => {
    for (const picks of [[], undefined as unknown as [], null as unknown as []]) {
      const result = validateJudgeResponse(scenes, shortlists, picks);
      expect(result).toHaveLength(3);
      expect(result.every((entry) => entry.choice === null)).toBe(true);
    }
  });

  test("every degraded path yields one proposal per scene and never another scene's clip", () => {
    const picks = [
      { scene_id: "scene-1", choice: 99, reason: "out of range" },
      { scene_id: "scene-1", choice: 0, reason: "duplicate" },
      { scene_id: "scene-9", choice: 0, reason: "extra" },
      { scene_id: "scene-3", choice: JUDGE_NONE, reason: "refused" },
    ];
    const result = validateJudgeResponse(scenes, shortlists, picks);

    expect(result).toHaveLength(scenes.length);
    expect(result.map((entry) => entry.scene_id)).toEqual(scenes.map((scene) => scene.id));
    for (const entry of result) {
      expect(entry.choice).toBeNull();
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------

describe("buildJudgePrompt", () => {
  const scene = sceneAt(0, "the bells rang across the city");
  const shortlists = shortlistMap({
    "scene-1": [
      candidate("vid-a.mp4"),
      candidate("vid-b.mp4", {
        payload: payloadFor("vid-b.mp4", {
          summary: "A\nbell\ttower  at dusk.",
          quality_flags: ["watermark", "heavy blur"],
        }),
      }),
    ],
  });

  const prompt = buildJudgePrompt([scene], shortlists);

  test("numbers candidates from zero, which is what the indices mean", () => {
    expect(prompt).toContain("[0]");
    expect(prompt).toContain("[1]");
    expect(prompt).toContain("SCENE scene-1");
    expect(prompt).toContain("narration: the bells rang across the city");
  });

  test("prints quality flags, which retrieval deliberately does not embed", () => {
    // Retrieval must not push watermarked clips apart in vector space, but a
    // judge choosing between fifteen plausible options needs to know.
    expect(prompt).toContain("quality flags: watermark, heavy blur");
    expect(prompt).toContain("quality flags: none");
  });

  test("flattens multi-line description text so one candidate stays one block", () => {
    expect(prompt).toContain("A bell tower at dusk.");
    expect(prompt).not.toContain("A\nbell");
  });

  test("states the scene count and the refusal convention", () => {
    expect(prompt).toContain("Choose one clip for each of the 1 scene(s)");
    expect(prompt).toContain("-1 for none");
  });

  test("prints every scene in the batch", () => {
    const batch = [sceneAt(0), sceneAt(1)];
    const built = buildJudgePrompt(
      batch,
      shortlistMap({ "scene-1": [candidate("vid-a.mp4")], "scene-2": [candidate("vid-b.mp4")] }),
    );
    expect(built).toContain("SCENE scene-1");
    expect(built).toContain("SCENE scene-2");
    expect(built).toContain("for each of the 2 scene(s)");
  });
});

// ---------------------------------------------------------------------------

describe("judgeBatch", () => {
  const scenes = [sceneAt(0), sceneAt(1)];
  const shortlists = shortlistMap({
    "scene-1": [candidate("vid-a.mp4"), candidate("vid-b.mp4")],
    "scene-2": [candidate("vid-c.mp4")],
  });

  /** A judge that never reaches a model: the generator is the whole seam. */
  function judgeDeps(generate: JudgeDeps["generate"], overrides: Partial<JudgeDeps> = {}): JudgeDeps {
    return { model: "stub-model", generate, ...overrides };
  }

  test("returns one validated proposal per input scene", async () => {
    const result = await judgeBatch(
      scenes,
      shortlists,
      judgeDeps(async () => ({
        picks: [
          { scene_id: "scene-2", choice: 0, reason: "b" },
          { scene_id: "scene-1", choice: 1, reason: "a" },
        ],
      })),
    );

    expect(result.map((entry) => entry.scene_id)).toEqual(["scene-1", "scene-2"]);
    expect(result).toHaveLength(scenes.length);
  });

  test("withholds a scene with no candidates from the prompt but still answers for it", async () => {
    // Including it would invite the model to invent an index for an empty list.
    let prompt = "";
    const result = await judgeBatch(
      scenes,
      shortlistMap({ "scene-1": [candidate("vid-a.mp4")], "scene-2": [] }),
      judgeDeps(async (request) => {
        prompt = request.prompt;
        return { picks: [{ scene_id: "scene-1", choice: 0, reason: "ok" }] };
      }),
    );

    expect(prompt).toContain("SCENE scene-1");
    expect(prompt).not.toContain("SCENE scene-2");
    expect(result).toHaveLength(2);
    expect(result[1]!.reason).toBe("no candidates survived shortlisting");
  });

  test("does not call the model at all when no scene has candidates", async () => {
    let calls = 0;
    const result = await judgeBatch(
      scenes,
      shortlistMap({ "scene-1": [], "scene-2": [] }),
      judgeDeps(async () => {
        calls++;
        return { picks: [] };
      }),
    );

    expect(calls).toBe(0);
    expect(result.every((entry) => entry.choice === null)).toBe(true);
  });

  test("passes the system prompt and the batch prompt to the generator", async () => {
    const seen: Array<{ system: string; prompt: string }> = [];
    await judgeBatch(
      scenes,
      shortlists,
      judgeDeps(async (request) => {
        seen.push({ system: request.system, prompt: request.prompt });
        return { picks: [] };
      }),
    );

    expect(seen[0]!.system).toContain("video editor");
    expect(seen[0]!.system).toContain("-1");
    expect(seen[0]!.prompt).toBe(buildJudgePrompt(scenes, shortlists));
  });

  test("degrades a failed model call to none for the whole batch, never a throw", async () => {
    // A render must not fail because a judge was down.
    const result = await judgeBatch(
      scenes,
      shortlists,
      judgeDeps(async () => {
        throw new Error("503 Service Unavailable");
      }),
    );

    expect(result).toHaveLength(2);
    expect(result.every((entry) => entry.choice === null)).toBe(true);
    expect(result[0]!.reason).toContain("judge call failed");
    expect(result[0]!.reason).toContain("503");
  });

  test("degrades to none when the judge model cannot be built", async () => {
    // No key is configured in the test settings, so `resolveJudgeModel` throws.
    // That is a fallback, not a render failure.
    let calls = 0;
    const result = await judgeBatch(scenes, shortlists, {
      generate: async () => {
        calls++;
        return { picks: [] };
      },
    });

    expect(calls).toBe(0);
    expect(result.every((entry) => entry.choice === null)).toBe(true);
    expect(result[0]!.reason).toContain("judge unavailable");
  });

  test("rethrows cancellation instead of swallowing it into a fallback", async () => {
    // Swallowing it would let an aborted task keep spending on judge calls.
    const controller = new AbortController();
    const caught = await judgeBatch(
      scenes,
      shortlists,
      judgeDeps(
        async () => {
          controller.abort();
          throw new Error("The operation was aborted");
        },
        { signal: controller.signal },
      ),
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("aborted");
  });

  test("forwards the signal to the generator", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    await judgeBatch(
      scenes,
      shortlists,
      judgeDeps(
        async (request) => {
          seen = request.signal;
          return { picks: [] };
        },
        { signal: controller.signal },
      ),
    );
    expect(seen).toBe(controller.signal);
  });
});

// ---------------------------------------------------------------------------

describe("assign", () => {
  test("gives each scene its own pick when the files differ", () => {
    // Two scenes both answering `0` normally mean two different clips: indices
    // are per-scene and are never the dedupe key.
    const result = assign([
      proposal(sceneAt(0), [candidate("vid-a.mp4"), candidate("vid-b.mp4")], 0),
      proposal(sceneAt(1), [candidate("vid-c.mp4"), candidate("vid-d.mp4")], 0),
    ]);

    expect(result.map((entry) => entry.local_file)).toEqual(["vid-a.mp4", "vid-c.mp4"]);
    expect(result.every((entry) => entry.substituted === false)).toBe(true);
  });

  test("dedupes by resolved file across different indices, and the loser falls forward", () => {
    // The same clip is index 0 for one scene and index 2 for another. Deduping
    // on the index would both reject clips that were never taken and admit the
    // same clip twice.
    const shared = candidate("vid-shared.mp4");
    const result = assign([
      proposal(sceneAt(0), [shared, candidate("vid-x.mp4")], 0),
      proposal(
        sceneAt(1),
        [candidate("vid-p.mp4"), candidate("vid-q.mp4"), shared, candidate("vid-r.mp4")],
        2,
      ),
      proposal(sceneAt(2), [candidate("vid-m.mp4"), candidate("vid-n.mp4"), shared], 2),
    ]);

    expect(result[0]).toMatchObject({ local_file: "vid-shared.mp4", substituted: false });
    // Falls forward past the taken clip to the next entry.
    expect(result[1]).toMatchObject({ local_file: "vid-r.mp4", substituted: true });
    // Nothing after the taken clip, so it contributes none.
    expect(result[2]).toMatchObject({ file: null, local_file: null, substituted: false });
    expect(result[2]!.reason).toContain("already used");
  });

  test("falls forward only, never back over candidates the judge passed over", () => {
    // The entries before the judged one are the higher-scoring candidates it
    // looked at and rejected; walking back would override a real decision.
    const shared = candidate("vid-shared.mp4");
    const result = assign([
      proposal(sceneAt(0), [shared], 0),
      proposal(sceneAt(1), [candidate("vid-free.mp4"), shared], 1),
    ]);

    expect(result[1]!.file).toBeNull();
    expect(result[1]!.local_file).not.toBe("vid-free.mp4");
  });

  test("keys on the resolved absolute path, not the basename", () => {
    // `Candidate.file` is the realpath-resolved path the render will open; two
    // files that merely share a basename are two different clips.
    const result = assign([
      proposal(sceneAt(0), [candidate("vid-a.mp4", { file: "/cache/one/vid-a.mp4" })], 0),
      proposal(sceneAt(1), [candidate("vid-a.mp4", { file: "/cache/two/vid-a.mp4" })], 0),
    ]);

    expect(result.map((entry) => entry.file)).toEqual(["/cache/one/vid-a.mp4", "/cache/two/vid-a.mp4"]);
  });

  test("resolves collisions in the order given, so the earlier scene wins", () => {
    const shared = candidate("vid-shared.mp4");
    const [first, second] = assign([
      proposal(sceneAt(0), [shared, candidate("vid-late.mp4")], 0),
      proposal(sceneAt(1), [shared, candidate("vid-other.mp4")], 0),
    ]);

    expect(first!.local_file).toBe("vid-shared.mp4");
    expect(second!.local_file).toBe("vid-other.mp4");
    expect(second!.substituted).toBe(true);
  });

  test("turns a refusal into none and keeps the judge's reason", () => {
    const [entry] = assign([
      proposal(sceneAt(0), [candidate("vid-a.mp4")], null, "nothing here is about rain"),
    ]);
    expect(entry).toEqual({
      scene_id: "scene-1",
      file: null,
      local_file: null,
      reason: "nothing here is about rain",
      substituted: false,
    });
  });

  test("turns an out-of-range or non-integer index into none rather than a clip", () => {
    for (const choice of [5, -2, 1.5, NaN]) {
      const [entry] = assign([proposal(sceneAt(0), [candidate("vid-a.mp4")], choice, "")]);
      expect(entry!.file).toBeNull();
      expect(entry!.reason).toBe("no clip chosen");
    }
  });

  test("returns none for a scene with an empty shortlist", () => {
    const [entry] = assign([proposal(sceneAt(0), [], 0, "")]);
    expect(entry!.file).toBeNull();
  });

  test("returns exactly one assignment per proposal, in order", () => {
    const proposals = [
      proposal(sceneAt(0), [candidate("vid-a.mp4")], 0),
      proposal(sceneAt(1), [], null),
      proposal(sceneAt(2), [candidate("vid-a.mp4")], 0),
    ];
    const result = assign(proposals);

    expect(result.map((entry) => entry.scene_id)).toEqual(["scene-1", "scene-2", "scene-3"]);
    // One clip, claimed once: the third scene wanted the same file.
    expect(result.filter((entry) => entry.file !== null)).toHaveLength(1);
  });

  test("never places one file twice, however the proposals collide", () => {
    const pool = [candidate("vid-a.mp4"), candidate("vid-b.mp4"), candidate("vid-c.mp4")];
    const result = assign([
      proposal(sceneAt(0), pool, 0),
      proposal(sceneAt(1), pool, 0),
      proposal(sceneAt(2), pool, 1),
      proposal(sceneAt(3), pool, 2),
      proposal(sceneAt(4), pool, 0),
    ]);

    const placed = result.map((entry) => entry.file).filter((file): file is string => file !== null);
    expect(new Set(placed).size).toBe(placed.length);
    expect(placed).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------

describe("matchScenes", () => {
  const cues = Array.from({ length: 6 }, (_, index) => ({
    start: index,
    end: index + 1,
    text: `word${index}`,
  }));

  /** Every expensive seam answered locally: no Qdrant, no ffprobe, no model. */
  function matchDeps(overrides: Partial<MatchDeps> = {}): MatchDeps {
    return {
      available: async () => true,
      search: async () => [match("vid-a.mp4"), match("vid-b.mp4")],
      probeFile: async () => media(10),
      resolveFile: (localFile: string) => `/cache/${localFile}`,
      judge: async (scenes) => scenes.map((scene) => ({ scene_id: scene.id, choice: 0, reason: "ok" })),
      ...overrides,
    };
  }

  const input = { cues, slotSeconds: 3, speed: 1, videoAspect: VideoAspect.portrait };

  test("skips with a reason and no clips when there are no cues", async () => {
    const result = await matchScenes({ ...input, cues: [] }, matchDeps());
    expect(result.ordered).toEqual([]);
    expect(result.scenes).toEqual([]);
    expect(result.skipped).toContain("no narration cues");
  });

  test("checks Qdrant explicitly, because an outage looks like an empty gallery", async () => {
    // `queryPoints` swallows every failure into `[]`. Without the preflight an
    // outage would push every scene into provider fallback instead of into
    // today's untouched path.
    let searches = 0;
    const result = await matchScenes(
      input,
      matchDeps({
        available: async () => false,
        search: async () => {
          searches++;
          return [];
        },
      }),
    );

    expect(searches).toBe(0);
    expect(result.ordered).toEqual([]);
    expect(result.skipped).toContain("qdrant is unavailable");
    // The scenes are still reported, so the caller can name what went unserved.
    expect(result.unmatched).toEqual(["scene-1", "scene-2"]);
    expect(result.scenes).toHaveLength(2);
  });

  test("returns one clip per scene in narrative order", async () => {
    const result = await matchScenes(
      input,
      matchDeps({
        search: async (query) => (query.includes("word0") ? [match("vid-a.mp4")] : [match("vid-b.mp4")]),
      }),
    );

    expect(result.ordered).toEqual(["/cache/vid-a.mp4", "/cache/vid-b.mp4"]);
    expect(result.unmatched).toEqual([]);
    expect(result.assignments.map((entry) => entry.scene_id)).toEqual(["scene-1", "scene-2"]);
    expect(result.skipped).toBeUndefined();
  });

  test("never places the same clip twice, even when every scene retrieves it", async () => {
    // Both scenes are offered the same single clip; `assign` disposes serially.
    const result = await matchScenes(input, matchDeps({ search: async () => [match("vid-a.mp4")] }));

    expect(result.ordered).toEqual(["/cache/vid-a.mp4"]);
    expect(result.unmatched).toEqual(["scene-2"]);
    expect(new Set(result.ordered).size).toBe(result.ordered.length);
  });

  test("ordered and unmatched together account for every scene", async () => {
    const result = await matchScenes(
      input,
      matchDeps({
        judge: async (scenes) =>
          scenes.map((scene, index) => ({ scene_id: scene.id, choice: index === 0 ? 0 : null, reason: "" })),
      }),
    );

    expect(result.ordered.length + result.unmatched.length).toBe(result.scenes.length);
    expect(result.assignments).toHaveLength(result.scenes.length);
  });

  test("honours option overrides without touching the stored settings", async () => {
    const limits: number[] = [];
    await matchScenes(
      { ...input, options: { shortlist_size: 3 } },
      matchDeps({
        search: async (_query, limit) => {
          limits.push(limit);
          return [];
        },
      }),
    );

    expect(new Set(limits)).toEqual(new Set([3]));
    expect(sceneFootageOptions().shortlist_size).toBe(SCENE_FOOTAGE_DEFAULTS.shortlist_size);
  });

  test("degrades a configuration fault to 'scene matching did not happen'", async () => {
    // A missing embedding key throws out of `searchFootage`. The render must
    // see an empty match and run today's path, not an exception.
    const result = await matchScenes(
      input,
      matchDeps({
        search: async () => {
          throw new Error("embedding model is not configured");
        },
      }),
    );

    expect(result.ordered).toEqual([]);
    expect(result.unmatched).toEqual(["scene-1", "scene-2"]);
    expect(result.skipped).toContain("scene matching failed");
    expect(result.skipped).toContain("embedding model is not configured");
  });

  test("survives a judge that raises, and the scenes simply fall back", async () => {
    const result = await matchScenes(
      input,
      matchDeps({
        judge: async () => {
          throw new Error("the judge exploded");
        },
      }),
    );

    expect(result.ordered).toEqual([]);
    expect(result.unmatched).toEqual(["scene-1", "scene-2"]);
    // Not a skipped run: shortlisting worked, only the picks were lost.
    expect(result.skipped).toBeUndefined();
  });

  test("survives a probe that raises for every candidate", async () => {
    const result = await matchScenes(
      input,
      matchDeps({
        probeFile: async () => {
          throw new Error("ffprobe is not installed");
        },
      }),
    );

    expect(result.ordered).toEqual([]);
    expect(result.skipped).toBeUndefined();
  });

  test("rethrows cancellation rather than handing back an empty match", async () => {
    // An aborted task must not be told "nothing matched" and carry on into a
    // provider fetch.
    const controller = new AbortController();
    controller.abort();
    const caught = await matchScenes({ ...input, signal: controller.signal }, matchDeps()).catch(
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toHaveProperty("ordered");
  });

  test("rethrows a cancellation raised from inside the judge", async () => {
    const controller = new AbortController();
    const caught = await matchScenes(
      { ...input, signal: controller.signal },
      matchDeps({
        judge: async () => {
          controller.abort();
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          throw error;
        },
      }),
    ).catch((error: unknown) => error);

    expect((caught as Error).name).toBe("AbortError");
  });

  test("judges in batches of the configured size", async () => {
    const batches: string[][] = [];
    await matchScenes(
      {
        cues: Array.from({ length: 10 }, (_, index) => ({ start: index, end: index + 1, text: `w${index}` })),
        slotSeconds: 1,
        speed: 1,
        videoAspect: VideoAspect.portrait,
        options: { judge_batch: 3 },
      },
      matchDeps({
        judge: async (scenes) => {
          batches.push(scenes.map((scene) => scene.id));
          return scenes.map((scene) => ({ scene_id: scene.id, choice: null, reason: "" }));
        },
      }),
    );

    expect(batches.flat()).toHaveLength(10);
    expect(batches.map((batch) => batch.length).sort()).toEqual([1, 3, 3, 3]);
  });

  test("shares one probe memo across the whole run", async () => {
    // The same popular clip appears in many shortlists; a memo already holding
    // it must spare every later scene the ffprobe. Seeded here rather than
    // counted, because the scenes shortlist concurrently and two of them can
    // legitimately be in flight for one file at the same instant.
    const probed: string[] = [];
    const probeCache = new Map([["/cache/vid-a.mp4", media(10)]]);
    const result = await matchScenes(
      input,
      matchDeps({
        probeCache,
        probeFile: async (path: string) => {
          probed.push(path);
          return media(10);
        },
      }),
    );

    expect(probed).not.toContain("/cache/vid-a.mp4");
    expect(probed).toContain("/cache/vid-b.mp4");
    // The memoised clip is still a candidate: the memo is a cache, not a filter.
    expect(result.ordered).toContain("/cache/vid-a.mp4");
    expect(probeCache.has("/cache/vid-b.mp4")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("chunk", () => {
  test("splits into fixed-size groups, preserving order", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2, 3], 8)).toEqual([[1, 2, 3]]);
    expect(chunk([], 4)).toEqual([]);
  });

  test("floors the size at one rather than looping forever", () => {
    for (const size of [0, -3, NaN, 0.4]) {
      expect(chunk([1, 2], size)).toEqual([[1], [2]]);
    }
  });
});

// ---------------------------------------------------------------------------

describe("isCancellation", () => {
  test("an aborted signal is authoritative, whatever was thrown", () => {
    // A library may have reshaped the rejection into something unrecognisable
    // by the time it arrives.
    const controller = new AbortController();
    controller.abort();
    expect(isCancellation(new Error("connection reset"), controller.signal)).toBe(true);
    expect(isCancellation(undefined, controller.signal)).toBe(true);
  });

  test("a bare AbortError counts, because it can come from a signal we never held", () => {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    expect(isCancellation(error)).toBe(true);
  });

  test("an ordinary failure is not a cancellation", () => {
    // Widening this would start rethrowing timeouts and rate limits into a
    // render, which is precisely what this module exists not to do.
    const controller = new AbortController();
    for (const error of [
      new Error("429 Too Many Requests"),
      new TypeError("fetch failed"),
      Object.assign(new Error("timeout"), { name: "TimeoutError" }),
      "AbortError",
      null,
    ]) {
      expect(isCancellation(error, controller.signal)).toBe(false);
    }
  });
});

describe("validateJudgeResponse — falsy choices must not resolve to candidate 0", () => {
  // Regression. `Number(null)` and `Number("")` are both 0, and
  // `Number.isInteger(0)` is true, so a judge answer of null or "" used to
  // resolve to candidate index 0 — the judge silently picking the first clip
  // without having chosen it. That is the exact outcome `none` exists to
  // prevent, so it is pinned here rather than left to the zod schema, which
  // only guards the model path and not the defensive one.
  const scene = { id: "scene-1", index: 0, text: "a line", start: 0, end: 5, duration: 5 };
  const shortlist = new Map([["scene-1", [{ file: "/cache/a.mp4" }, { file: "/cache/b.mp4" }]]]);

  const choiceFor = (choice: unknown) =>
    validateJudgeResponse([scene] as never, shortlist as never, [{ scene_id: "scene-1", choice }])[0]!.choice;

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["a boolean", false],
    ["an empty array", []],
  ])("%s degrades to none, not candidate 0", (_label, choice) => {
    expect(choiceFor(choice)).toBeNull();
  });

  test("a real number and a numeric string still resolve", () => {
    expect(choiceFor(1)).toBe(1);
    expect(choiceFor("1")).toBe(1);
  });

  test("the refusal sentinel still means none", () => {
    expect(choiceFor(-1)).toBeNull();
  });
});

describe("buildScenes — picture must cover narration", () => {
  // The regression this tiling exists for. A verified book render produced 6
  // scenes for 39s of narration; at a 5s cap that is 30s of picture, and
  // `combineVideos` looped from the start to fill the gap, so the closing
  // narration played over the opening scene's footage. Overshooting is the
  // mirror failure: the combiner drops clips it no longer needs, stranding the
  // tail scenes. Coverage must land in [narration, narration + slot).
  const BOOK_SEGMENT: [number, number][] = [
    [0.11, 7.49], [7.86, 15.18], [15.46, 21.63], [22.15, 28.09], [28.44, 35.08], [35.48, 39.0],
  ];

  test.each([3, 4, 5, 6, 8])("covers the narration without overshooting a slot (slot=%is)", (slot) => {
    const cues = BOOK_SEGMENT.map(([start, end], i) => ({ start, end, text: `line ${i + 1}` }));
    const scenes = buildScenes(cues, slot);
    const narration = BOOK_SEGMENT.at(-1)![1] - BOOK_SEGMENT[0]![0];
    const picture = scenes.length * slot;

    expect(picture).toBeGreaterThanOrEqual(narration);
    expect(picture - narration).toBeLessThan(slot);
  });

  test("a cue straddling a tile boundary belongs to both tiles", () => {
    const scenes = buildScenes([{ start: 0, end: 4, text: "first" }, { start: 4, end: 9, text: "straddles" }], 5);
    expect(scenes).toHaveLength(2);
    expect(scenes[0]!.text).toContain("straddles");
    expect(scenes[1]!.text).toContain("straddles");
  });
});
