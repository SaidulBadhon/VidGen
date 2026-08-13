/**
 * Optional TwelveLabs semantic reranking of stock-search terms.
 * Ported from python-version/app/services/twelvelabs.py.
 *
 * Strictly opt-in and strictly best-effort: any failure returns the original
 * ordering, so enabling it can never make material selection worse.
 */

import { appConfig } from "../config/settings.ts";
import { logger, errorMessage } from "../utils/logger.ts";
import { rotateApiKey } from "../utils/misc.ts";
import { providerFetch } from "./material/http.ts";

const API_BASE = "https://api.twelvelabs.io/v1.3";
export const DEFAULT_MARENGO_MODEL = "marengo3.0";
export const DEFAULT_PEGASUS_MODEL = "pegasus1.5";

/** Pegasus requires max_tokens in [512, 98304]; 512 is plenty for one line. */
const PEGASUS_MIN_MAX_TOKENS = 512;

export function isEnabled(): boolean {
  return (appConfig().twelvelabs_api_keys ?? []).length > 0;
}

/** Successful embeddings are memoised; repeated terms are common. */
const embeddingCache = new Map<string, number[]>();

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Marengo text embedding, or null when disabled or on any failure. */
export async function embedText(text: string, model?: string): Promise<number[] | null> {
  if (!isEnabled() || !text?.trim()) return null;

  const modelName = model || appConfig().twelvelabs_marengo_model || DEFAULT_MARENGO_MODEL;
  const cacheKey = `${modelName}::${text.trim()}`;
  const cached = embeddingCache.get(cacheKey);
  if (cached) return cached;

  try {
    const apiKey = rotateApiKey("twelvelabs_api_keys", appConfig().twelvelabs_api_keys);
    const form = new FormData();
    form.append("model_name", modelName);
    form.append("text", text.trim());

    const response = await providerFetch(`${API_BASE}/embed`, {
      method: "POST",
      headers: { "x-api-key": apiKey },
      body: form,
      timeoutMs: 60_000,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      text_embedding?: { segments?: { float?: number[] }[] };
    };
    const vector = data.text_embedding?.segments?.[0]?.float;
    if (!Array.isArray(vector) || vector.length === 0) return null;

    // Only successful lookups are cached, so a transient API error never
    // poisons the cache for the rest of the process.
    embeddingCache.set(cacheKey, vector);
    return vector;
  } catch (error) {
    logger.warning(`TwelveLabs embed_text failed, skipping rerank: ${errorMessage(error)}`);
    return null;
  }
}

/**
 * Reorders terms so those most semantically related to the subject come first.
 * Returns the input unchanged whenever reranking is off or anything fails.
 */
export async function rerankTermsBySubject(
  videoSubject: string,
  searchTerms: string[],
  model?: string,
): Promise<string[]> {
  if (!isEnabled() || !appConfig().twelvelabs_rerank_terms) return searchTerms;
  if (!videoSubject || searchTerms.length < 2) return searchTerms;

  const subjectVector = await embedText(videoSubject, model);
  if (!subjectVector) return searchTerms;

  const scored: { term: string; score: number; index: number }[] = [];
  for (const [index, term] of searchTerms.entries()) {
    const vector = await embedText(term, model);
    if (!vector) return searchTerms;
    scored.push({ term, score: cosine(subjectVector, vector), index });
  }

  // A stable sort on the original index keeps ties in their authored order.
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const reranked = scored.map((entry) => entry.term);

  logger.info(`TwelveLabs reranked search terms: ${JSON.stringify(reranked)}`);
  return reranked;
}

/** One-line Pegasus answer about a clip. Used by the material inspector. */
export async function analyzeClip(videoUrl: string, prompt: string, model?: string): Promise<string> {
  if (!isEnabled()) return "";

  try {
    const apiKey = rotateApiKey("twelvelabs_api_keys", appConfig().twelvelabs_api_keys);
    const response = await providerFetch(`${API_BASE}/analyze`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        video_url: videoUrl,
        prompt,
        model_name: model || appConfig().twelvelabs_pegasus_model || DEFAULT_PEGASUS_MODEL,
        max_tokens: PEGASUS_MIN_MAX_TOKENS,
      }),
      timeoutMs: 120_000,
    });
    if (!response.ok) return "";

    const data = (await response.json()) as { data?: string; text?: string };
    return String(data.data ?? data.text ?? "").trim();
  } catch (error) {
    logger.warning(`TwelveLabs analyze failed: ${errorMessage(error)}`);
    return "";
  }
}
