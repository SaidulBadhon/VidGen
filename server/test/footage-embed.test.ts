/**
 * The vector gate.
 *
 * `embedText` is the only place a vector is checked before it reaches Qdrant,
 * and both failures it catches surface much later and much less legibly: a
 * short vector is refused on upsert, and a non-finite component is accepted and
 * then poisons every distance it takes part in.
 *
 * The model is injected through `deps`, so these cases make no network call —
 * `fakeModel` is a hand-written `EmbeddingModel<string>` that returns whatever
 * the case needs and records what it was asked for.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { EmbeddingModel } from "ai";

import { defaultSettings } from "../src/config/schema.ts";
import { __setSettingsForTest } from "../src/config/settings.ts";
import {
  EMBED_DIMENSIONS,
  EmbeddingDimensionError,
  FootageEmbeddingError,
  __resetEmbeddingModelForTest,
  embedClipDescription,
  embedSearchQuery,
  embedText,
} from "../src/services/footage/embed.ts";
import { composeEmbeddingText, type ClipDescription } from "../src/services/footage/types.ts";

beforeAll(() => {
  __setSettingsForTest(defaultSettings());
});

afterEach(() => {
  __resetEmbeddingModelForTest();
});

interface Call {
  values: string[];
  providerOptions?: Record<string, unknown>;
}

/** A stand-in embedding model. Records its calls; never touches the network. */
function fakeModel(embedding: number[] | (() => number[]), calls: Call[] = []): EmbeddingModel<string> {
  return {
    specificationVersion: "v2",
    provider: "test",
    modelId: "fake-embedder",
    maxEmbeddingsPerCall: 1,
    supportsParallelCalls: false,
    async doEmbed(options) {
      calls.push({ values: options.values, providerOptions: options.providerOptions as Record<string, unknown> });
      return { embeddings: [typeof embedding === "function" ? embedding() : embedding] };
    },
  };
}

/** A vector of the width the collection was created with. */
function fullVector(fill = 0.1): number[] {
  return new Array<number>(EMBED_DIMENSIONS).fill(fill);
}

const DESCRIPTION: ClipDescription = {
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

// ---------------------------------------------------------------------------

describe("embedText", () => {
  test("returns a vector of the collection's width", async () => {
    const vector = await embedText("a rainy street", {}, { model: fakeModel(fullVector()) });
    expect(vector.length).toBe(EMBED_DIMENSIONS);
    expect(EMBED_DIMENSIONS).toBe(3072);
  });

  test("rejects a short vector rather than letting Qdrant refuse it later", async () => {
    const caught = (await embedText("a rainy street", {}, { model: fakeModel([0.1, 0.2, 0.3]) }).catch(
      (error: unknown) => error,
    )) as EmbeddingDimensionError;

    expect(caught).toBeInstanceOf(EmbeddingDimensionError);
    expect(caught).toBeInstanceOf(FootageEmbeddingError);
    expect(caught.expected).toBe(EMBED_DIMENSIONS);
    expect(caught.actual).toBe(3);
    expect(caught.message).toContain("fake-embedder");
    expect(caught.message).toContain("returned 3 dimensions, expected 3072");
    expect(caught.message).toContain("task_type=RETRIEVAL_DOCUMENT");
  });

  test("rejects a long vector too", async () => {
    const promise = embedText("q", {}, { model: fakeModel(new Array<number>(4096).fill(0.1)) });
    await expect(promise).rejects.toBeInstanceOf(EmbeddingDimensionError);
  });

  test("rejects an empty vector, which is what a silently-degraded model returns", async () => {
    const caught = (await embedText("q", {}, { model: fakeModel([]) }).catch(
      (error: unknown) => error,
    )) as EmbeddingDimensionError;
    expect(caught.actual).toBe(0);
  });

  test("rejects a non-finite component and names its index", async () => {
    const poisoned = fullVector();
    poisoned[42] = Number.NaN;
    const caught = (await embedText("q", {}, { model: fakeModel(poisoned) }).catch(
      (error: unknown) => error,
    )) as FootageEmbeddingError;

    expect(caught).toBeInstanceOf(FootageEmbeddingError);
    expect(caught).not.toBeInstanceOf(EmbeddingDimensionError);
    expect(caught.message).toContain("non-finite value at index 42");
  });

  test("rejects an infinite component", async () => {
    const poisoned = fullVector();
    poisoned[0] = Number.POSITIVE_INFINITY;
    await expect(embedText("q", {}, { model: fakeModel(poisoned) })).rejects.toBeInstanceOf(FootageEmbeddingError);
  });

  test("refuses empty text without calling the model", async () => {
    const calls: Call[] = [];
    for (const blank of ["", "   ", "\n\t "]) {
      const caught = (await embedText(blank, {}, { model: fakeModel(fullVector(), calls) }).catch(
        (error: unknown) => error,
      )) as FootageEmbeddingError;
      expect(caught).toBeInstanceOf(FootageEmbeddingError);
      expect(caught.message).toBe("cannot embed empty text");
    }
    // The provider answers this with an opaque 400; not spending the call is
    // the point.
    expect(calls).toEqual([]);
  });

  test("sends the trimmed text", async () => {
    const calls: Call[] = [];
    await embedText("  a rainy street  ", {}, { model: fakeModel(fullVector(), calls) });
    expect(calls[0]!.values).toEqual(["a rainy street"]);
  });

  test("pins the output width instead of trusting the model's default", async () => {
    const calls: Call[] = [];
    await embedText("a rainy street", {}, { model: fakeModel(fullVector(), calls) });
    const google = calls[0]!.providerOptions?.google as Record<string, unknown>;
    expect(google.outputDimensionality).toBe(EMBED_DIMENSIONS);
    expect(google.taskType).toBe("RETRIEVAL_DOCUMENT");
  });
});

// ---------------------------------------------------------------------------

describe("embedClipDescription and embedSearchQuery", () => {
  test("documents are embedded from composeEmbeddingText, never a re-implementation", async () => {
    const calls: Call[] = [];
    await embedClipDescription(DESCRIPTION, {}, { model: fakeModel(fullVector(), calls) });

    // A clip embedded under a different layout is not comparable to the rest of
    // the collection, and nothing about it would look wrong.
    expect(calls[0]!.values).toEqual([composeEmbeddingText(DESCRIPTION)]);
    expect((calls[0]!.providerOptions?.google as Record<string, unknown>).taskType).toBe("RETRIEVAL_DOCUMENT");
  });

  test("queries are embedded bare, under the query task type", async () => {
    const calls: Call[] = [];
    await embedSearchQuery("empty hospital corridor", {}, { model: fakeModel(fullVector(), calls) });

    expect(calls[0]!.values).toEqual(["empty hospital corridor"]);
    expect((calls[0]!.providerOptions?.google as Record<string, unknown>).taskType).toBe("RETRIEVAL_QUERY");
  });

  test("the dimension gate applies to queries as well as documents", async () => {
    const caught = (await embedSearchQuery("q", {}, { model: fakeModel([0.1]) }).catch(
      (error: unknown) => error,
    )) as EmbeddingDimensionError;

    expect(caught).toBeInstanceOf(EmbeddingDimensionError);
    expect(caught.message).toContain("task_type=RETRIEVAL_QUERY");
  });

  test("says where to configure the key rather than making a keyless call", async () => {
    // The default settings hold no Gemini key, so resolving the real model must
    // fail here — not at the provider, and not by embedding nothing.
    __setSettingsForTest(defaultSettings());
    await expect(embedText("a rainy street")).rejects.toThrow(/gemini_api_key is not set/);
  });

  test("a description that composes to nothing is refused before the call", async () => {
    const calls: Call[] = [];
    const empty: ClipDescription = { ...DESCRIPTION, summary: " ", detailed_description: "", use_cases: [], tags: [] };
    await expect(embedClipDescription(empty, {}, { model: fakeModel(fullVector(), calls) })).rejects.toThrow(
      "cannot embed empty text",
    );
    expect(calls).toEqual([]);
  });
});
