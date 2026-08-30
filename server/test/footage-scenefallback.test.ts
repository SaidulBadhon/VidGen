/**
 * The provider fallback for the scenes the gallery could not serve.
 *
 * Nothing here reaches a provider, a downloader, Mongo or a model: the query
 * reduction, the grouping, the source-page title and the candidate projection
 * are pure, and the run itself takes its search, download, provenance write and
 * judge as injected functions.
 *
 * **No case asserts that a particular clip is chosen for a particular scene.**
 * The judge is a model; what is pinned is the structure around it — one search
 * per distinct query, the search cap, narrative order restored before anything
 * is decided, and the dedupe rule that a clip this render already placed is
 * never fetched twice.
 *
 * Two things are deliberately not covered, because they cannot be reached
 * without a database: `recordFallbackProvenance` short-circuits on
 * `isConnected()`, which is false in this suite, so the provenance write and its
 * `record` seam are unreachable here by construction.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { basename, join } from "node:path";

import { defaultSettings } from "../src/config/schema.ts";
import { __setSettingsForTest } from "../src/config/settings.ts";
import { VideoAspect, type MaterialInfo } from "../src/models/schema.ts";
import { cacheVideosDir } from "../src/utils/paths.ts";
import { destinationFileFor } from "../src/services/footage/pull.ts";
import type { Candidate, Scene } from "../src/services/footage/sceneMatch.ts";
import {
  DEFAULT_MAX_FALLBACK_SEARCHES,
  groupScenesByQuery,
  providerCandidate,
  providerQueryFor,
  resolveSceneFallback,
  titleFromSourcePage,
  type SceneFallbackDeps,
  type SceneFallbackInput,
} from "../src/services/footage/sceneFallback.ts";
import type { SearchParams } from "../src/services/material/search.ts";

beforeAll(() => {
  __setSettingsForTest(defaultSettings());
});

const CACHE_DIR = cacheVideosDir(false);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Two narrations that reduce to one query, and one that does not. */
const FOX_A = "a red fox in the snow";
const FOX_B = "the red fox and a snow";
const WAVES = "ocean waves at dawn";

function sceneAt(index: number, text: string): Scene {
  return { id: `scene-${index + 1}`, index, text, start: index * 5, end: (index + 1) * 5 };
}

function material(url: string, overrides: Partial<MaterialInfo> = {}): MaterialInfo {
  return {
    provider: "pexels",
    url,
    duration: 12,
    source_info: {
      provider: "pexels",
      asset_id: "778",
      source_page: "https://www.pexels.com/video/a-red-fox-in-snow-778/",
      rendition: { id: "r1", width: 1080, height: 1920 },
    },
    ...overrides,
  };
}

/** Where the projection says a URL will land — the module's own dedupe key. */
function destinationOf(url: string): string {
  return join(CACHE_DIR, destinationFileFor(url));
}

function input(overrides: Partial<SceneFallbackInput> = {}): SceneFallbackInput {
  const scenes = overrides.scenes ?? [sceneAt(0, FOX_A)];
  return {
    scenes,
    unmatched: scenes.map((scene) => scene.id),
    source: "pexels",
    videoAspect: VideoAspect.portrait,
    slotSeconds: 5,
    clipSpeed: 1,
    ...overrides,
  };
}

/**
 * Every seam answered locally. The judge takes the first surviving candidate,
 * which is a stand-in for "the model answered", never a claim about which clip
 * a real judge would pick.
 */
function deps(overrides: Partial<SceneFallbackDeps> = {}, results: MaterialInfo[] = []): SceneFallbackDeps {
  return {
    searchProvider: async () => results,
    download: async (url: string) => destinationOf(url),
    judge: async (scenes, shortlists) =>
      scenes.map((scene) => ({
        scene_id: scene.id,
        choice: (shortlists.get(scene.id)?.length ?? 0) > 0 ? 0 : null,
        reason: "stub judge",
      })),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("providerQueryFor", () => {
  test("keeps the content words in the order the narration said them", () => {
    expect(providerQueryFor("The bells of Notre-Dame rang out across the city at nine o'clock.")).toBe(
      "bells notre-dame rang out city nine o'clock",
    );
  });

  test("keeps hyphens and apostrophes inside a word", () => {
    // Splitting them produces two useless fragments.
    expect(providerQueryFor("close-up of a luthier's hands")).toBe("close-up luthier's hands");
  });

  test("strips punctuation and leading or trailing separators", () => {
    expect(providerQueryFor("'quoted' -dash- word!")).toBe("quoted dash word");
  });

  test("folds case and keeps non-Latin letters", () => {
    expect(providerQueryFor("Café niño 東京 street")).toBe("café niño 東京 street");
  });

  test("drops bare numbers, which no footage library indexes", () => {
    expect(providerQueryFor("In 1920, some 12 workers built 900 metres of tunnel under the river.")).toBe(
      "workers built metres tunnel river",
    );
  });

  test("drops repeats, so one word cannot spend two slots", () => {
    expect(providerQueryFor("snow on snow on snow")).toBe("snow");
  });

  test("caps the query at eight content words", () => {
    // Measured against the live API: an eight-word reduction returns comparable
    // result counts to the full sentence, and distinct scenes can collapse onto
    // one search.
    expect(providerQueryFor("one two three four five six seven eight nine ten eleven")).toBe(
      "one two three four five six seven eight",
    );
  });

  test("honours an explicit cap and falls back for a nonsensical one", () => {
    expect(providerQueryFor("the quick brown fox jumps over lazy dogs", 3)).toBe("quick brown fox");
    for (const cap of [0, -2, NaN]) {
      expect(providerQueryFor("the quick brown fox jumps over lazy dogs everywhere daily now", cap).split(" ")).toHaveLength(
        8,
      );
    }
  });

  test("returns empty for a scene with nothing sayable in it", () => {
    // A pause, or a line made entirely of function words: dropped rather than
    // turned into a search for nothing.
    for (const text of ["", "   ", "and the of a an it is", "123 456", null as unknown as string]) {
      expect(providerQueryFor(text)).toBe("");
    }
  });

  test("is pure and deterministic", () => {
    expect(providerQueryFor(FOX_A)).toBe(providerQueryFor(FOX_A));
    expect(providerQueryFor(FOX_A)).toBe("red fox snow");
  });
});

// ---------------------------------------------------------------------------

describe("groupScenesByQuery", () => {
  test("issues one group per distinct query, never one per scene", () => {
    const groups = groupScenesByQuery([sceneAt(0, FOX_A), sceneAt(1, WAVES), sceneAt(2, FOX_B)]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.query)).toEqual(["red fox snow", "ocean waves dawn"]);
    expect(groups[0]!.scenes.map((scene) => scene.id)).toEqual(["scene-1", "scene-3"]);
  });

  test("orders groups by first appearance, which is narrative order", () => {
    // A search cap then truncates the tail of the video rather than a middle.
    const groups = groupScenesByQuery([sceneAt(0, WAVES), sceneAt(1, FOX_A)]);
    expect(groups.map((group) => group.query)).toEqual(["ocean waves dawn", "red fox snow"]);
  });

  test("drops a scene whose narration reduces to nothing, before any search", () => {
    const groups = groupScenesByQuery([sceneAt(0, "the and of it"), sceneAt(1, "   "), sceneAt(2, FOX_A)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.scenes.map((scene) => scene.id)).toEqual(["scene-3"]);
  });

  test("returns nothing for no scenes", () => {
    expect(groupScenesByQuery([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("titleFromSourcePage", () => {
  test("reads the title out of a Pexels slug and drops the trailing asset id", () => {
    expect(titleFromSourcePage("https://www.pexels.com/video/vibrant-scarlet-macaw-grooming-in-nature-35499010/")).toBe(
      "vibrant scarlet macaw grooming in nature",
    );
  });

  test("serves Pixabay and Coverr with the same rule", () => {
    expect(titleFromSourcePage("https://pixabay.com/videos/ocean-waves-sea-12345/")).toBe("ocean waves sea");
    expect(titleFromSourcePage("https://coverr.co/videos/misty_forest_path")).toBe("misty forest path");
  });

  test("strips a file extension from the last segment", () => {
    expect(titleFromSourcePage("https://example.com/clip.mp4")).toBe("clip");
  });

  test("drops every all-digit token, not only the trailing one", () => {
    expect(titleFromSourcePage("https://example.com/2024-summer-2-beach-99/")).toBe("summer beach");
  });

  test("returns empty when the URL carries no slug worth reading", () => {
    // A real case; the caller falls back to naming the search that found it.
    for (const url of ["https://example.com/", "https://example.com/12345", "not a url", "", null, undefined]) {
      expect(titleFromSourcePage(url)).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------

describe("providerCandidate", () => {
  const query = "red fox snow";

  test("projects the destination file the download will produce", () => {
    // Known before the download, which is what makes a duplicate cost nothing
    // rather than cost bytes.
    const candidate = providerCandidate(material("https://cdn.example.com/fox.mp4"), query)!;
    expect(candidate.local_file).toBe(destinationFileFor("https://cdn.example.com/fox.mp4"));
    expect(candidate.file).toBe(join(CACHE_DIR, candidate.local_file));
  });

  test("two signed URLs for one clip project to one file", () => {
    // `saveVideo` hashes the URL without its query string, so the signature
    // does not make a second file — and must not make a second candidate.
    const one = providerCandidate(material("https://cdn.example.com/fox.mp4?sig=1"), query)!;
    const two = providerCandidate(material("https://cdn.example.com/fox.mp4?sig=2"), query)!;
    expect(one.local_file).toBe(two.local_file);
    expect(one.file).toBe(two.file);
  });

  test("refuses a result with no URL at all", () => {
    expect(providerCandidate(material(""), query)).toBeNull();
    expect(providerCandidate({ provider: "pexels", url: "  ", duration: 4 }, query)).toBeNull();
  });

  test("carries no similarity score, because a provider result has none", () => {
    // Inventing one would make a ranked list look like a judged one.
    expect(providerCandidate(material("https://cdn.example.com/fox.mp4"), query)!.score).toBe(0);
  });

  test("uses the provider's own title as the summary", () => {
    const candidate = providerCandidate(material("https://cdn.example.com/fox.mp4"), query)!;
    expect(candidate.payload.summary).toBe("a red fox in snow");
    expect(candidate.payload.search_terms).toEqual([query]);
  });

  test("names the search when the provider gives no title", () => {
    const candidate = providerCandidate(
      material("https://cdn.example.com/fox.mp4", { source_info: { provider: "coverr" } }),
      query,
    )!;
    expect(candidate.payload.summary).toBe(`stock clip returned for the search "${query}"`);
  });

  test("says out loud that nobody watched this clip", () => {
    // The judge's system prompt says the descriptions come from someone who
    // did, which is true of the gallery path and false here; leaving that
    // uncorrected would invite the model to trust a title as if it were a
    // viewing.
    const candidate = providerCandidate(material("https://cdn.example.com/fox.mp4"), query)!;
    expect(candidate.payload.detailed_description).toContain("nobody has viewed this clip");
    expect(candidate.payload.detailed_description).toContain("search metadata only");
    expect(candidate.payload.detailed_description).toContain("1080x1920");
  });

  test("drops a source page that is not a plain public URL", () => {
    const candidate = providerCandidate(
      material("https://cdn.example.com/fox.mp4", {
        source_info: { source_page: "https://user:secret@example.com/video/a-fox-1/" },
      }),
      query,
    )!;
    expect(candidate.payload.source_page).toBeUndefined();
    expect(JSON.stringify(candidate)).not.toContain("secret");
  });

  test("falls back to a neutral provider name rather than guessing", () => {
    const candidate = providerCandidate(
      material("https://cdn.example.com/fox.mp4", { provider: "", source_info: null }),
      query,
    )!;
    expect(candidate.payload.provider).toBe("provider");
  });

  test("leaves the describe and embed stamps inert, because nothing was described", () => {
    // This object is a shape for the judge prompt, not a claim, and is never
    // written to Qdrant.
    const payload = providerCandidate(material("https://cdn.example.com/fox.mp4"), query)!.payload;
    expect(payload.describe_version).toBe(0);
    expect(payload.embed_version).toBe(0);
    expect(payload.describe_model).toBe("");
    expect(payload.indexed_at).toBe("");
    expect(payload.quality_flags).toEqual([]);
    expect(payload.use_cases).toEqual([]);
    expect(payload.mood).toEqual([]);
  });

  test("tags come from the title and the query, deduped", () => {
    const payload = providerCandidate(material("https://cdn.example.com/fox.mp4"), query)!.payload;
    expect(payload.tags).toEqual([...new Set(payload.tags)]);
    expect(payload.tags).toContain("fox");
    expect(payload.tags).toContain("snow");
  });
});

// ---------------------------------------------------------------------------

describe("resolveSceneFallback", () => {
  test("serves only the scenes the gallery could not", async () => {
    const searched: string[] = [];
    const resolved = await resolveSceneFallback(
      input({ scenes: [sceneAt(0, FOX_A), sceneAt(1, WAVES)], unmatched: ["scene-2"] }),
      deps(
        {
          searchProvider: async (params: SearchParams) => {
            searched.push(params.searchTerm);
            return [material("https://cdn.example.com/waves.mp4")];
          },
        },
        [],
      ),
    );

    expect(searched).toEqual(["ocean waves dawn"]);
    expect([...resolved.keys()]).toEqual(["scene-2"]);
  });

  test("does nothing at all when no scene is unmatched", async () => {
    let searches = 0;
    const resolved = await resolveSceneFallback(
      input({ scenes: [sceneAt(0, FOX_A)], unmatched: [] }),
      deps({
        searchProvider: async () => {
          searches++;
          return [];
        },
      }),
    );

    expect(resolved.size).toBe(0);
    expect(searches).toBe(0);
  });

  test("issues one search per distinct query, never one per scene", async () => {
    const searched: string[] = [];
    await resolveSceneFallback(
      input({ scenes: [sceneAt(0, FOX_A), sceneAt(1, WAVES), sceneAt(2, FOX_B)] }),
      deps({
        searchProvider: async (params: SearchParams) => {
          searched.push(params.searchTerm);
          return [];
        },
      }),
    );

    expect(searched).toEqual(["red fox snow", "ocean waves dawn"]);
  });

  test("asks the provider for the band's floor and the render's aspect", async () => {
    const seen: SearchParams[] = [];
    await resolveSceneFallback(
      input({ slotSeconds: 5, clipSpeed: 2, videoAspect: VideoAspect.landscape }),
      deps({
        searchProvider: async (params: SearchParams) => {
          seen.push(params);
          return [];
        },
      }),
    );

    expect(seen[0]!.minimumDuration).toBe(10);
    expect(seen[0]!.videoAspect).toBe(VideoAspect.landscape);
  });

  test("normalizes the clip speed exactly once, so a raw 10 asks for 10s not 50s", async () => {
    const seen: SearchParams[] = [];
    await resolveSceneFallback(
      input({ slotSeconds: 5, clipSpeed: 10 }),
      deps({
        searchProvider: async (params: SearchParams) => {
          seen.push(params);
          return [];
        },
      }),
    );

    expect(seen[0]!.minimumDuration).toBe(10);
  });

  test("drops a scene whose narration reduces to nothing, without a search", async () => {
    const searched: string[] = [];
    const resolved = await resolveSceneFallback(
      input({ scenes: [sceneAt(0, "the and of it"), sceneAt(1, FOX_A)] }),
      deps(
        {
          searchProvider: async (params: SearchParams) => {
            searched.push(params.searchTerm);
            return [material("https://cdn.example.com/fox.mp4")];
          },
        },
        [],
      ),
    );

    expect(searched).toEqual(["red fox snow"]);
    expect([...resolved.keys()]).toEqual(["scene-2"]);
  });

  // -- the search cap -------------------------------------------------------

  test("bounds the run at maxSearches and drops the scenes past it", async () => {
    // The cap drops scenes rather than clips: a scene beyond it contributes
    // nothing, which is the same outcome as a judge rejecting its candidates.
    const searched: string[] = [];
    const resolved = await resolveSceneFallback(
      input({ scenes: [sceneAt(0, FOX_A), sceneAt(1, WAVES)], maxSearches: 1 }),
      deps({
        searchProvider: async (params: SearchParams) => {
          searched.push(params.searchTerm);
          return [material(`https://cdn.example.com/${params.searchTerm.split(" ")[0]}.mp4`)];
        },
      }),
    );

    expect(searched).toEqual(["red fox snow"]);
    expect([...resolved.keys()]).toEqual(["scene-1"]);
  });

  test("floors the cap at one rather than issuing no searches", async () => {
    const searched: string[] = [];
    await resolveSceneFallback(
      input({ scenes: [sceneAt(0, FOX_A), sceneAt(1, WAVES)], maxSearches: 0 }),
      deps({
        searchProvider: async (params: SearchParams) => {
          searched.push(params.searchTerm);
          return [];
        },
      }),
    );
    expect(searched).toHaveLength(1);
  });

  test("thirty-two searches is the default bound", () => {
    // A 360-scene book segment would otherwise issue hundreds of searches
    // inside one render and be answered with 429s.
    expect(DEFAULT_MAX_FALLBACK_SEARCHES).toBe(32);
  });

  // -- what reaches the judge ----------------------------------------------

  test("caps a shortlist at the configured size", async () => {
    const sizes: number[] = [];
    await resolveSceneFallback(
      input({ options: { shortlist_size: 2 } }),
      deps(
        {
          searchProvider: async () => [
            material("https://cdn.example.com/a.mp4"),
            material("https://cdn.example.com/b.mp4"),
            material("https://cdn.example.com/c.mp4"),
            material("https://cdn.example.com/d.mp4"),
          ],
          judge: async (scenes, shortlists) => {
            for (const scene of scenes) sizes.push(shortlists.get(scene.id)?.length ?? 0);
            return scenes.map((scene) => ({ scene_id: scene.id, choice: null, reason: "" }));
          },
        },
        [],
      ),
    );

    expect(sizes).toEqual([2]);
  });

  test("offers the same clip only once inside one search", async () => {
    const offered: Candidate[][] = [];
    await resolveSceneFallback(
      input(),
      deps({
        searchProvider: async () => [
          material("https://cdn.example.com/fox.mp4?sig=1"),
          material("https://cdn.example.com/fox.mp4?sig=2"),
          material("https://cdn.example.com/other.mp4"),
        ],
        judge: async (scenes, shortlists) => {
          offered.push([...(shortlists.get(scenes[0]!.id) ?? [])]);
          return scenes.map((scene) => ({ scene_id: scene.id, choice: null, reason: "" }));
        },
      }),
    );

    expect(offered[0]!.map((candidate) => candidate.local_file)).toEqual([
      destinationFileFor("https://cdn.example.com/fox.mp4"),
      destinationFileFor("https://cdn.example.com/other.mp4"),
    ]);
  });

  test("never offers a clip this render has already placed", async () => {
    // The collision the review found: a provider result resolving onto a
    // gallery clip assigned earlier in the same render. Seen here before a
    // single byte is fetched.
    const taken = "https://cdn.example.com/fox.mp4";
    const offered: string[][] = [];
    let downloads = 0;

    const resolved = await resolveSceneFallback(
      input({ assigned: [destinationOf(taken)] }),
      deps({
        searchProvider: async () => [material(taken)],
        judge: async (scenes, shortlists) => {
          offered.push((shortlists.get(scenes[0]!.id) ?? []).map((candidate) => candidate.local_file));
          return scenes.map((scene) => ({ scene_id: scene.id, choice: 0, reason: "" }));
        },
        download: async (url: string) => {
          downloads++;
          return destinationOf(url);
        },
      }),
    );

    // The scene is still put to the judge — with nothing in its list, which is
    // what `judgeBatch` turns into "no candidates survived shortlisting".
    expect(offered.flat()).toEqual([]);
    expect(downloads).toBe(0);
    expect(resolved.size).toBe(0);
  });

  test("matches an already-placed clip by name, wherever the render put it", async () => {
    // The identity of a clip is its `vid-<md5>.mp4` name, not the directory it
    // happens to sit in.
    const taken = "https://cdn.example.com/fox.mp4";
    let downloads = 0;
    const resolved = await resolveSceneFallback(
      input({ assigned: [join("/somewhere/else", destinationFileFor(taken))] }),
      deps({
        searchProvider: async () => [material(taken)],
        download: async (url: string) => {
          downloads++;
          return destinationOf(url);
        },
      }),
    );

    expect(downloads).toBe(0);
    expect(resolved.size).toBe(0);
  });

  test("judges in narrative order, however the grouping reshuffled the scenes", async () => {
    // `assign` resolves collisions in the order it is given, so leaving them
    // grouped would hand an earlier scene's clip to a later one purely because
    // they reduced to different searches.
    const batches: string[][] = [];
    await resolveSceneFallback(
      input({ scenes: [sceneAt(0, FOX_A), sceneAt(1, WAVES), sceneAt(2, FOX_B)] }),
      deps({
        searchProvider: async (params: SearchParams) => [
          material(`https://cdn.example.com/${params.searchTerm.split(" ")[0]}.mp4`),
        ],
        judge: async (scenes, shortlists) => {
          batches.push(scenes.map((scene) => scene.id));
          return scenes.map((scene) => ({
            scene_id: scene.id,
            choice: (shortlists.get(scene.id)?.length ?? 0) > 0 ? 0 : null,
            reason: "",
          }));
        },
      }),
    );

    expect(batches.flat()).toEqual(["scene-1", "scene-2", "scene-3"]);
  });

  test("respects a refusal: a scene whose candidates are all rejected gets nothing", async () => {
    // That is the design working, not a failure. `-1` is honoured here exactly
    // as it is in the gallery path.
    let downloads = 0;
    const resolved = await resolveSceneFallback(
      input(),
      deps({
        searchProvider: async () => [material("https://cdn.example.com/fox.mp4")],
        judge: async (scenes) => scenes.map((scene) => ({ scene_id: scene.id, choice: null, reason: "no fit" })),
        download: async (url: string) => {
          downloads++;
          return destinationOf(url);
        },
      }),
    );

    expect(downloads).toBe(0);
    expect(resolved.size).toBe(0);
  });

  // -- dedupe by resolved destination file ---------------------------------

  test("two scenes offered one clip fetch it once and only one is served", async () => {
    const downloaded: string[] = [];
    const resolved = await resolveSceneFallback(
      input({ scenes: [sceneAt(0, FOX_A), sceneAt(1, WAVES)] }),
      deps({
        // Both searches happen to return the same asset.
        searchProvider: async () => [material("https://cdn.example.com/fox.mp4")],
        download: async (url: string) => {
          downloaded.push(url);
          return destinationOf(url);
        },
      }),
    );

    expect(downloaded).toHaveLength(1);
    expect([...resolved.keys()]).toEqual(["scene-1"]);
  });

  test("re-reads the saved name, so a download that lands on a claimed file is dropped", async () => {
    // The projection and what actually landed agree today, and a silent
    // disagreement is exactly how a duplicate would get past the earlier check.
    const landed = join(CACHE_DIR, "vid-collision.mp4");
    const resolved = await resolveSceneFallback(
      input({ scenes: [sceneAt(0, FOX_A), sceneAt(1, WAVES)] }),
      deps({
        searchProvider: async (params: SearchParams) => [
          material(`https://cdn.example.com/${params.searchTerm.split(" ")[0]}.mp4`),
        ],
        download: async () => landed,
      }),
    );

    expect([...resolved.values()]).toEqual([landed]);
    expect(resolved.size).toBe(1);
  });

  test("every path in a run maps to a distinct file", async () => {
    const resolved = await resolveSceneFallback(
      input({ scenes: [sceneAt(0, FOX_A), sceneAt(1, WAVES)] }),
      deps({
        searchProvider: async (params: SearchParams) => [
          material(`https://cdn.example.com/${params.searchTerm.split(" ")[0]}.mp4`),
        ],
      }),
    );

    const paths = [...resolved.values()];
    expect(paths).toHaveLength(2);
    expect(new Set(paths.map((path) => basename(path))).size).toBe(2);
  });

  // -- nothing thrown reaches the render ------------------------------------

  test("a failed search costs its own scenes and nothing else", async () => {
    const resolved = await resolveSceneFallback(
      input({ scenes: [sceneAt(0, FOX_A), sceneAt(1, WAVES)] }),
      deps({
        searchProvider: async (params: SearchParams) => {
          if (params.searchTerm.startsWith("red")) throw new Error("429 Too Many Requests");
          return [material("https://cdn.example.com/waves.mp4")];
        },
      }),
    );

    expect([...resolved.keys()]).toEqual(["scene-2"]);
  });

  test("a failed download costs its own scene and keeps what already landed", async () => {
    const resolved = await resolveSceneFallback(
      input({ scenes: [sceneAt(0, FOX_A), sceneAt(1, WAVES)] }),
      deps({
        searchProvider: async (params: SearchParams) => [
          material(`https://cdn.example.com/${params.searchTerm.split(" ")[0]}.mp4`),
        ],
        download: async (url: string) => {
          // The second scene reduces to "ocean waves dawn", so its clip is the
          // one named for its first word.
          if (url.includes("ocean")) throw new Error("connection reset");
          return destinationOf(url);
        },
      }),
    );

    expect([...resolved.keys()]).toEqual(["scene-1"]);
  });

  test("a download that produced no playable file contributes nothing", async () => {
    // `saveVideo` returns "" for a file that downloaded but would not decode.
    const resolved = await resolveSceneFallback(
      input(),
      deps({
        searchProvider: async () => [material("https://cdn.example.com/fox.mp4")],
        download: async () => "",
      }),
    );

    expect(resolved.size).toBe(0);
  });

  test("a judge that raises costs its batch, not the run", async () => {
    const resolved = await resolveSceneFallback(
      input(),
      deps({
        searchProvider: async () => [material("https://cdn.example.com/fox.mp4")],
        judge: async () => {
          throw new Error("the judge exploded");
        },
      }),
    );

    expect(resolved.size).toBe(0);
  });

  test("a search that returns nothing is a normal outcome", async () => {
    const resolved = await resolveSceneFallback(input(), deps({ searchProvider: async () => [] }));
    expect(resolved.size).toBe(0);
  });

  test("a result with no URL is skipped rather than fetched", async () => {
    const resolved = await resolveSceneFallback(
      input(),
      deps({ searchProvider: async () => [material(""), material("  ")] }),
    );
    expect(resolved.size).toBe(0);
  });

  test("still serves a clip the downloader wrote outside the footage cache", async () => {
    // Provenance is skipped for it — a row pointing at a file `footage index`
    // will never walk would describe a clip the library cannot find — but the
    // render still gets its clip.
    const outside = "/tmp/other-materials/vid-elsewhere.mp4";
    const resolved = await resolveSceneFallback(
      input(),
      deps({
        searchProvider: async () => [material("https://cdn.example.com/fox.mp4")],
        download: async () => outside,
      }),
    );

    expect([...resolved.values()]).toEqual([outside]);
  });

  // -- cancellation ---------------------------------------------------------

  test("rethrows cancellation instead of returning a degraded result", async () => {
    // An aborted task must not carry on spending on searches and downloads.
    const controller = new AbortController();
    controller.abort();
    let searches = 0;

    const caught = await resolveSceneFallback(
      input({ signal: controller.signal }),
      deps({
        searchProvider: async () => {
          searches++;
          return [];
        },
      }),
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(Map);
    expect(searches).toBe(0);
  });

  test("rethrows a cancellation raised from inside a download", async () => {
    const controller = new AbortController();
    const caught = await resolveSceneFallback(
      input(),
      deps({
        searchProvider: async () => [material("https://cdn.example.com/fox.mp4")],
        download: async () => {
          controller.abort();
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          throw error;
        },
      }),
    ).catch((error: unknown) => error);

    expect((caught as Error).name).toBe("AbortError");
  });
});
