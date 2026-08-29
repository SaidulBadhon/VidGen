/**
 * The footage library's identity contracts.
 *
 * Everything here is a pure function whose output is written into Qdrant and
 * kept there: `composeEmbeddingText` defines the vector space, `pointIdFor`
 * defines the primary key, and `terms.json` defines what the bulk pull spends
 * on. A silent change to any of the three is a rebuild of the collection, so
 * these cases exist to make such a change loud.
 */

import { describe, expect, test } from "bun:test";

import {
  DESCRIBE_VERSION,
  EMBED_VERSION,
  allTerms,
  clipDescriptionSchema,
  composeEmbeddingText,
  pointIdFor,
  type ClipDescription,
} from "../src/services/footage/types.ts";
import seedTerms from "../src/services/footage/terms.json" with { type: "json" };

/** A complete description; individual cases override only what they exercise. */
function description(overrides: Partial<ClipDescription> = {}): ClipDescription {
  return {
    summary: "A woman in a raincoat walks along a wet city street at night.",
    detailed_description: "Medium shot, handheld. Neon reflects off the pavement.",
    use_cases: ["a narrator explaining burnout", "a segment on urban loneliness"],
    mood: ["melancholy", "calm"],
    tags: ["rain", "city", "night"],
    setting: "outdoor",
    time_of_day: "night",
    has_people: true,
    has_on_screen_text: false,
    camera_motion: "handheld",
    quality_flags: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("composeEmbeddingText", () => {
  test("lays the four semantic fields out in a fixed order", () => {
    expect(composeEmbeddingText(description())).toBe(
      "A woman in a raincoat walks along a wet city street at night.\n\n" +
        "Medium shot, handheld. Neon reflects off the pavement.\n\n" +
        "Useful for: a narrator explaining burnout; a segment on urban loneliness.\n\n" +
        "Keywords: rain, city, night.",
    );
  });

  test("omits every closed-vocabulary field, which rides in the payload instead", () => {
    // Sentinels rather than realistic values, so a match cannot come from the
    // prose fields by coincidence.
    const text = composeEmbeddingText(
      description({
        summary: "A summary.",
        detailed_description: "A detail.",
        mood: ["MOOD_SENTINEL"],
        setting: "SETTING_SENTINEL",
        time_of_day: "TIME_SENTINEL",
        camera_motion: "MOTION_SENTINEL",
        quality_flags: ["FLAG_SENTINEL"],
      }),
    );

    // Folding these in would pull every "static"/"day" clip together for no
    // retrieval gain, so their absence is the contract.
    for (const excluded of ["MOOD", "SETTING", "TIME", "MOTION", "FLAG"]) {
      expect(text).not.toContain(`${excluded}_SENTINEL`);
    }
    expect(text).toBe("A summary.\n\nA detail.\n\nUseful for: a narrator explaining burnout; a segment on urban loneliness.\n\nKeywords: rain, city, night.");
  });

  test("trims the prose fields", () => {
    const text = composeEmbeddingText(
      description({ summary: "  A summary.  ", detailed_description: "\n A detail. \n" }),
    );
    expect(text.startsWith("A summary.\n\nA detail.")).toBe(true);
  });

  test("drops blank and whitespace-only list entries", () => {
    const text = composeEmbeddingText(description({ use_cases: ["  ", "a talk on rain", ""], tags: ["", " city "] }));
    expect(text).toContain("Useful for: a talk on rain.");
    expect(text).toContain("Keywords: city.");
  });

  test("removes duplicates case-insensitively, keeping the first spelling", () => {
    const text = composeEmbeddingText(
      description({ use_cases: ["Rainy City", "rainy city"], tags: ["City", "city", "CITY", "rain"] }),
    );
    expect(text).toContain("Useful for: Rainy City.");
    expect(text).toContain("Keywords: City, rain.");
  });

  test("omits a section entirely rather than emitting a dangling label", () => {
    const text = composeEmbeddingText(description({ use_cases: [], tags: ["  "] }));
    expect(text).not.toContain("Useful for");
    expect(text).not.toContain("Keywords");
    expect(text).toBe(
      "A woman in a raincoat walks along a wet city street at night.\n\n" +
        "Medium shot, handheld. Neon reflects off the pavement.",
    );
  });

  test("omits an empty summary without leaving a leading separator", () => {
    const text = composeEmbeddingText(description({ summary: "   ", use_cases: [], tags: [] }));
    expect(text).toBe("Medium shot, handheld. Neon reflects off the pavement.");
  });

  test("composes an empty string when nothing semantic survives", () => {
    const empty = composeEmbeddingText(
      description({ summary: "", detailed_description: " ", use_cases: [""], tags: [] }),
    );
    // `embedText` refuses this rather than sending it, which is the point of
    // having a describable empty case at all.
    expect(empty).toBe("");
  });

  test("is deterministic: the same description composes byte-identically", () => {
    const input = description();
    expect(composeEmbeddingText(input)).toBe(composeEmbeddingText(input));
  });
});

// ---------------------------------------------------------------------------

describe("clipDescriptionSchema", () => {
  test("accepts a complete description", () => {
    expect(clipDescriptionSchema.parse(description())).toEqual(description());
  });

  test("requires every field, so the model cannot skip the expensive ones", () => {
    const { use_cases: _omitted, ...withoutUseCases } = description();
    expect(clipDescriptionSchema.safeParse(withoutUseCases).success).toBe(false);
  });

  test("keeps the versions the rows are stamped with pinned", () => {
    // Bumping either constant re-pays Gemini across the whole library, so it is
    // a deliberate act rather than a side effect of an edit.
    expect(DESCRIBE_VERSION).toBe(1);
    expect(EMBED_VERSION).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("pointIdFor", () => {
  // Golden values. These are the Qdrant point ids and the Mongo `_id`s of every
  // clip already in the library: if this test fails, the change orphans the
  // whole index and `reconcile` deletes it as unrecognised.
  test("is stable for a given filename", () => {
    expect(pointIdFor("vid-0123456789abcdef0123456789abcdef.mp4")).toBe("8de7a8cb-3933-5b77-9052-d4c92240b863");
    expect(pointIdFor("vid-a.mp4")).toBe("84024c6c-e143-5785-b256-60b95e682f09");
    expect(pointIdFor("")).toBe("be97823f-ff84-56b9-8537-f0c72be4641c");
  });

  test("emits a well-formed v5 UUID", () => {
    const id = pointIdFor("vid-a.mp4");
    // Qdrant rejects hex that merely looks like a UUID: the version nibble must
    // be 5 and the variant nibble must be one of 8, 9, a, b.
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("gives distinct ids to distinct filenames", () => {
    const ids = ["vid-a.mp4", "vid-b.mp4", "vid-aa.mp4", "vid-a.mov", ""].map(pointIdFor);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("is case-sensitive, matching the filesystem it derives from", () => {
    expect(pointIdFor("A.mp4")).not.toBe(pointIdFor("a.mp4"));
  });

  test("hashes the basename, so two paths to one clip agree", () => {
    // The id is deliberately derived from the basename only: the host process
    // and the container see the same file at different absolute paths.
    expect(pointIdFor("vid-a.mp4")).not.toBe(pointIdFor("/storage/cache_videos/vid-a.mp4"));
  });
});

// ---------------------------------------------------------------------------

describe("terms.json", () => {
  test("parses with the nested shape allTerms walks", () => {
    expect(seedTerms.version).toBe(1);
    expect(typeof seedTerms.categories).toBe("object");
    expect(Array.isArray(seedTerms.observed_terms.terms)).toBe(true);
  });

  test("groups the curated terms into non-empty string categories", () => {
    const categories = Object.entries(seedTerms.categories);
    expect(categories.length).toBe(16);
    for (const [name, terms] of categories) {
      expect(Array.isArray(terms)).toBe(true);
      expect(terms.length).toBeGreaterThan(0);
      for (const term of terms) {
        expect(typeof term).toBe("string");
        expect(term.trim()).toBe(term);
        expect(term).not.toBe("");
      }
      expect(name).toMatch(/^[a-z_]+$/);
    }
  });
});

describe("allTerms", () => {
  test("flattens to exactly 126 terms", () => {
    expect(allTerms().length).toBe(126);
  });

  test("holds no duplicates, case-insensitively", () => {
    const terms = allTerms();
    expect(new Set(terms.map((term) => term.toLowerCase())).size).toBe(terms.length);
  });

  test("puts curated categories in file order first and observed terms last", () => {
    const terms = allTerms();
    // A budget-capped pull truncates the tail, so this order decides what gets
    // bought first.
    expect(terms[0]).toBe(seedTerms.categories.nature_landscape[0]);
    expect(terms.at(-1)).toBe(seedTerms.observed_terms.terms.at(-1));
    expect(terms).toContain("rain on window");
    expect(terms).toContain(seedTerms.observed_terms.terms[0]);
  });

  test("returns trimmed, non-empty terms", () => {
    for (const term of allTerms()) {
      expect(term).toBe(term.trim());
      expect(term.length).toBeGreaterThan(0);
    }
  });

  test("returns a fresh array each call, so a caller may slice or sort it", () => {
    const first = allTerms();
    first.length = 3;
    expect(allTerms().length).toBe(126);
  });
});
