/**
 * Text embedding for the semantic footage library.
 *
 * This is the narrow waist between a clip's description and its point in
 * Qdrant: every vector in the collection — and every query vector compared
 * against them — is produced here, so that the same model, the same output
 * width and the same text layout apply to both sides of the comparison. A
 * caller that reached for `embed()` directly could quietly diverge on any of
 * the three and get a vector space that still *works*, just worse.
 *
 * Two things are therefore deliberately not parameters:
 *   - the text of a clip, which comes from `composeEmbeddingText` in
 *     `types.ts` and is never assembled ad hoc here;
 *   - the vector width, which is asserted rather than accepted.
 *
 * The model is injectable (see `EmbedTextDeps`) so the pure logic around the
 * call — task-type selection, dimension assertion, error shaping — is testable
 * with a hand-written `EmbeddingModelV2` and no network, in a repo that uses no
 * mocking library.
 */

import { embed, type EmbeddingModel } from "ai";
import { createGoogleGenerativeAI, type GoogleGenerativeAIEmbeddingProviderOptions } from "@ai-sdk/google";

import { appConfig, getSettings } from "../../config/settings.ts";
import { composeEmbeddingText, type ClipDescription } from "./types.ts";

/**
 * Width of every vector in the collection.
 *
 * `gemini-embedding-001`'s native size, and the size the Qdrant collection is
 * created at (`footage_v<EMBED_VERSION>`). It is also the only output
 * dimensionality Google returns already L2-normalised — the truncated Matryoshka
 * sizes (1536, 768, …) have to be normalised by the caller — which is why this
 * module can hand its result straight to a cosine collection.
 *
 * Changing it is an `EMBED_VERSION` bump and a rebuild of the collection, not an
 * edit here.
 */
export const EMBED_DIMENSIONS = 3072;

/** Used when `footage_index.embed_model` is somehow blank. */
const DEFAULT_EMBED_MODEL = "gemini-embedding-001";

/**
 * Which side of the comparison a vector is being produced for.
 *
 * Gemini embeds asymmetrically: a document and a query about that document are
 * projected differently on purpose, so a stored clip description and the phrase
 * a user searches for land near each other despite being nothing alike as text.
 * Getting this backwards — or leaving it unset on one side — does not fail, it
 * just measurably degrades recall, which is the worst kind of bug to own.
 * Hence: no default at the call sites that matter, and one wrapper per side.
 */
export type EmbeddingTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

/** Anything this module rejects before or after the provider call. */
export class FootageEmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FootageEmbeddingError";
  }
}

/**
 * The provider returned a vector of the wrong width.
 *
 * Worth its own type because the alternative is discovering it several layers
 * later: Qdrant rejects a mis-sized vector with a message about the collection's
 * configuration that says nothing about which clip, which model, or which call
 * produced it. Failing here names all three.
 */
export class EmbeddingDimensionError extends FootageEmbeddingError {
  readonly expected: number;
  readonly actual: number;

  constructor(message: string, expected: number, actual: number) {
    super(message);
    this.name = "EmbeddingDimensionError";
    this.expected = expected;
    this.actual = actual;
  }
}

export interface EmbedTextOptions {
  /** Defaults to `RETRIEVAL_DOCUMENT`; queries must pass `RETRIEVAL_QUERY`. */
  taskType?: EmbeddingTaskType;
  /** Cancels an in-flight call, e.g. when a render or an index run is aborted. */
  abortSignal?: AbortSignal;
  /** Provider-level retries. The AI SDK's default is 2. */
  maxRetries?: number;
}

export interface EmbedTextDeps {
  /**
   * The embedding model. Defaults to the configured Gemini model, resolved
   * lazily so importing this module never requires settings or a key.
   */
  model?: EmbeddingModel<string>;
}

/**
 * Cached provider+model, keyed by the settings that produced it.
 *
 * An index run embeds a thousand clips one after another; rebuilding the
 * provider each time allocates a fresh client for no reason. Keying the cache on
 * the api key and model id means a settings change through the UI invalidates it
 * on the next call rather than pinning a stale key for the life of the process.
 */
let cachedModel: { apiKey: string; modelId: string; model: EmbeddingModel<string> } | undefined;

/**
 * Builds the configured embedding model.
 *
 * Exported because the CLI and the indexer resolve it once and pass it down
 * through `deps` for a whole run, which is both cheaper and how a caller pins
 * one model across a batch that must stay internally consistent.
 */
export function resolveEmbeddingModel(modelId?: string): EmbeddingModel<string> {
  const apiKey = String(appConfig().gemini_api_key ?? "").trim();
  if (!apiKey) {
    throw new FootageEmbeddingError("gemini_api_key is not set, configure it in Settings to index footage.");
  }

  const id = (modelId ?? getSettings().footage_index.embed_model ?? "").trim() || DEFAULT_EMBED_MODEL;

  if (cachedModel && cachedModel.apiKey === apiKey && cachedModel.modelId === id) return cachedModel.model;

  const model = createGoogleGenerativeAI({ apiKey }).textEmbeddingModel(id);
  cachedModel = { apiKey, modelId: id, model };
  return model;
}

/**
 * Embeds one string and returns a validated `EMBED_DIMENSIONS`-wide vector.
 *
 * `taskType` is **not** a top-level `embed()` argument — it is provider-specific
 * and travels in `providerOptions.google`, alongside `outputDimensionality`,
 * which is pinned rather than left to the model default so that a future model
 * whose native width differs fails loudly here instead of silently filling the
 * collection with vectors from a different space.
 */
export async function embedText(
  text: string,
  options: EmbedTextOptions = {},
  deps: EmbedTextDeps = {},
): Promise<number[]> {
  const { taskType = "RETRIEVAL_DOCUMENT", abortSignal, maxRetries } = options;

  const value = text.trim();
  if (!value) {
    // The provider rejects this with an opaque 400. A clip that composed to an
    // empty string is a description bug, and this says so.
    throw new FootageEmbeddingError("cannot embed empty text");
  }

  const model = deps.model ?? resolveEmbeddingModel();

  const google = {
    taskType,
    outputDimensionality: EMBED_DIMENSIONS,
  } satisfies GoogleGenerativeAIEmbeddingProviderOptions;

  const { embedding } = await embed({
    model,
    value,
    providerOptions: { google },
    ...(abortSignal ? { abortSignal } : {}),
    ...(maxRetries === undefined ? {} : { maxRetries }),
  });

  return assertVector(embedding, modelIdOf(model), taskType);
}

/**
 * Embeds a clip description for storage.
 *
 * The text layout is `composeEmbeddingText`'s alone — imported, never
 * re-implemented — because a clip embedded under a different layout is not
 * comparable to the rest of the collection even though nothing about it looks
 * wrong.
 */
export function embedClipDescription(
  description: ClipDescription,
  options: Omit<EmbedTextOptions, "taskType"> = {},
  deps: EmbedTextDeps = {},
): Promise<number[]> {
  return embedText(composeEmbeddingText(description), { ...options, taskType: "RETRIEVAL_DOCUMENT" }, deps);
}

/**
 * Embeds a search query.
 *
 * Queries are embedded bare — no labels, no padding — because the asymmetry
 * between a short query and a labelled document is exactly what the two task
 * types exist to absorb.
 */
export function embedSearchQuery(
  query: string,
  options: Omit<EmbedTextOptions, "taskType"> = {},
  deps: EmbedTextDeps = {},
): Promise<number[]> {
  return embedText(query, { ...options, taskType: "RETRIEVAL_QUERY" }, deps);
}

/** Model id for error messages; a string model is its own id. */
function modelIdOf(model: EmbeddingModel<string>): string {
  return typeof model === "string" ? model : model.modelId;
}

/**
 * The gate every vector passes through.
 *
 * Two checks, both cheap next to the network call that produced the vector, and
 * both catching failures whose natural symptom appears much later: a short
 * vector is refused by Qdrant on upsert, and a non-finite component is accepted
 * by some paths and poisons every distance it takes part in.
 */
function assertVector(embedding: number[], modelId: string, taskType: EmbeddingTaskType): number[] {
  if (embedding.length !== EMBED_DIMENSIONS) {
    throw new EmbeddingDimensionError(
      `embedding model '${modelId}' returned ${embedding.length} dimensions, expected ${EMBED_DIMENSIONS} ` +
        `(task_type=${taskType}); the footage collection cannot store this vector`,
      EMBED_DIMENSIONS,
      embedding.length,
    );
  }

  for (let i = 0; i < embedding.length; i++) {
    const component = embedding[i];
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw new FootageEmbeddingError(
        `embedding model '${modelId}' returned a non-finite value at index ${i} (task_type=${taskType})`,
      );
    }
  }

  return embedding;
}

/** Test seam: drops the memoised provider so a settings change is picked up. */
export function __resetEmbeddingModelForTest(): void {
  cachedModel = undefined;
}
