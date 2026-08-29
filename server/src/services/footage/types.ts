/**
 * Contracts for the semantic footage library.
 *
 * This module is deliberately dependency-free apart from `zod` and `node:crypto`:
 * every export is a constant, a schema, or a pure function, so the describe,
 * embed, index, pull and CLI layers can all import it without dragging in Mongo,
 * Qdrant, Gemini or the filesystem — and so the whole file is unit-testable with
 * no network and no database (see the testing rules in the implementation plan).
 *
 * Three things live here because they are shared *identity* concerns rather than
 * implementation details of any one stage:
 *   - what a clip description is (`clipDescriptionSchema`), which doubles as the
 *     prompt sent to the description model;
 *   - what text gets embedded (`composeEmbeddingText`), which must be identical
 *     for every clip or the vector space is inconsistent;
 *   - what a clip's point id is (`pointIdFor`), which is the primary key in
 *     Qdrant and the `_id` in Mongo's `footage_index`.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

import seedTerms from "./terms.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/**
 * Version of the description contract — the schema below *and* the field
 * descriptions that steer the model, since changing the wording changes the
 * output just as much as changing the fields.
 *
 * `footage_index` rows carry the version they were written at. Bumping this
 * invalidates every cached description and forces a re-describe (real Gemini
 * spend across the whole library), so bump it only when the change is
 * semantic — never for a typo fix.
 */
export const DESCRIBE_VERSION = 1;

/**
 * Version of the embedding contract — the model, its dimensionality, and the
 * `composeEmbeddingText` layout below.
 *
 * Vectors produced under different versions are not comparable, so this is also
 * baked into the Qdrant collection name (`footage_v<EMBED_VERSION>`, created by
 * the client wrapper) with the `footage` alias pointing at the live one. A bump
 * therefore means: build the new collection alongside the old, backfill, then
 * move the alias — not an in-place migration.
 */
export const EMBED_VERSION = 1;

// ---------------------------------------------------------------------------
// Clip description
// ---------------------------------------------------------------------------

/**
 * What the vision model must return for one clip.
 *
 * This schema is handed straight to `generateObject`, which serialises it to a
 * JSON schema — **the `.describe()` strings below are the prompt**. They are
 * written as instructions to the model, not as documentation for a reader, which
 * is why they carry counts, vocabularies and worked examples.
 *
 * Two deliberate choices:
 *   - `setting`, `time_of_day` and `camera_motion` are plain strings with a
 *     suggested vocabulary rather than `z.enum(...)`. A hard enum turns an
 *     unanticipated clip (a split-screen, a rendered animation) into a schema
 *     violation and a wasted retry; a steered string degrades to a sensible
 *     out-of-vocabulary word instead. Search filters normalise on read.
 *   - Nothing is `.optional()`. Optional fields let a model skip the expensive
 *     thinking; requiring every field is what makes `use_cases` reliable.
 */
export const clipDescriptionSchema = z.object({
  summary: z
    .string()
    .describe(
      "One sentence, at most 20 words, naming only what is literally visible: subject, action, place. " +
        'No preamble, no "this video shows", no interpretation. ' +
        'Example: "A woman in a raincoat walks along a wet city street at night."',
    ),
  detailed_description: z
    .string()
    .describe(
      "Two to four sentences describing the clip as a shot: the subject and what it does, the framing " +
        "(wide/medium/close-up), the lighting and colour, the setting, and how the shot changes over its " +
        "duration. Describe what is in frame, never what it might symbolise.",
    ),
  use_cases: z
    .array(z.string())
    .describe(
      "Four to eight concrete narration topics or video contexts this clip works as B-roll for — the " +
        "search this clip should win. Each entry is a short phrase naming the SUBJECT BEING NARRATED, " +
        "not the visual content again. " +
        'Good: "a narrator explaining burnout at work", "a segment on urban loneliness", ' +
        '"an intro to a story set in a rainy city", "a passage about walking home after bad news". ' +
        'Bad: "rain video", "city b-roll", "stock footage" — those describe the clip, not the story it serves. ' +
        "Range from the literal topic to the emotional or metaphorical ones the shot could carry.",
    ),
  mood: z
    .array(z.string())
    .describe(
      "Two to five single-word or two-word emotional tones the shot conveys, lowercase. " +
        'Examples: "calm", "tense", "hopeful", "melancholy", "energetic", "clinical", "nostalgic".',
    ),
  tags: z
    .array(z.string())
    .describe(
      "Eight to fifteen lowercase keywords for the concrete things in frame: objects, people, clothing, " +
        "animals, materials, locations, actions, weather, dominant colours. Single words or short noun " +
        "phrases, no duplicates, no adjectives of quality, no hashtags.",
    ),
  setting: z
    .string()
    .describe(
      'Where the shot takes place, one lowercase word or short phrase. Prefer one of: "indoor", "outdoor", ' +
        '"studio", "vehicle", "underwater", "aerial", "abstract". Use "mixed" only if the shot genuinely changes.',
    ),
  time_of_day: z
    .string()
    .describe(
      'Apparent time of day from the light, one lowercase word or short phrase. Prefer one of: "day", ' +
        '"night", "dawn", "dusk", "golden hour", "artificial light", "unknown". Use "unknown" rather than guessing.',
    ),
  has_people: z
    .boolean()
    .describe(
      "True if any human being is visible at all, including a crowd, a silhouette, a hand, or a body part. " +
        "False only if no person appears in any frame.",
    ),
  has_on_screen_text: z
    .boolean()
    .describe(
      "True if any legible text is burned into the picture: signage, captions, watermarks, logos with " +
        "wordmarks, screen or interface text, credits. False for illegible or purely decorative marks.",
    ),
  camera_motion: z
    .string()
    .describe(
      'How the camera itself moves, one lowercase word or short phrase. Prefer one of: "static", "handheld", ' +
        '"pan", "tilt", "zoom", "dolly", "tracking", "crane", "aerial", "orbit", "timelapse". ' +
        'Use "static" when only the subject moves.',
    ),
  quality_flags: z
    .array(z.string())
    .describe(
      "Defects that would limit how this clip can be used. Empty array when there are none — do not invent " +
        'flags. Prefer terms from: "low light", "noisy", "out of focus", "shaky", "heavy compression", ' +
        '"watermark", "visible logo", "letterboxed", "low resolution", "overexposed", "dated look", "cuts mid-shot".',
    ),
});

/** The description shape as stored in Mongo and in the Qdrant payload. */
export type ClipDescription = z.infer<typeof clipDescriptionSchema>;

// ---------------------------------------------------------------------------
// Embedding text
// ---------------------------------------------------------------------------

/**
 * Builds the single string that gets embedded for a clip.
 *
 * Only the four *semantic* fields go in. `mood`, `setting`, `time_of_day`,
 * `camera_motion`, `has_people` and `quality_flags` are deliberately excluded:
 * they are short closed-vocabulary values that ride in the Qdrant payload as
 * filters, and folding them into the text would let a dozen clips sharing
 * `"static"` / `"day"` drift toward each other in vector space for no retrieval
 * gain.
 *
 * `use_cases` carries most of the weight. A query like "empty hospital
 * corridor" matches the description, but "a segment about waiting for bad news"
 * only matches because the model was asked to write that phrasing down.
 *
 * The two labels ("Useful for", "Keywords") are the minimum structure that keeps
 * a keyword list from reading as a broken sentence. Queries are embedded bare
 * with `taskType: RETRIEVAL_QUERY` against documents embedded with
 * `RETRIEVAL_DOCUMENT`, so the asymmetry between a labelled document and an
 * unlabelled query is exactly what those task types exist to absorb.
 *
 * Pure and deterministic: same description in, same string out. Empty or
 * whitespace-only entries are dropped, and an empty section is omitted entirely
 * rather than emitting a dangling label.
 */
export function composeEmbeddingText(d: ClipDescription): string {
  const parts: string[] = [];

  const summary = d.summary.trim();
  if (summary) parts.push(summary);

  const detailed = d.detailed_description.trim();
  if (detailed) parts.push(detailed);

  const useCases = cleanList(d.use_cases);
  if (useCases.length > 0) parts.push(`Useful for: ${useCases.join("; ")}.`);

  const tags = cleanList(d.tags);
  if (tags.length > 0) parts.push(`Keywords: ${tags.join(", ")}.`);

  return parts.join("\n\n");
}

/** Trims, drops blanks, and removes duplicates while preserving order. */
function cleanList(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = String(value).trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Point identity
// ---------------------------------------------------------------------------

/**
 * Namespace for footage point ids.
 *
 * **This constant must never change.** `pointIdFor` is the point id in Qdrant
 * and the `_id` in Mongo's `footage_index`; changing the namespace changes every
 * id, which would orphan every existing point, break every upsert's idempotency,
 * and make `reconcile()` delete the entire index as unrecognised. There is no
 * migration short of rebuilding the collection from scratch.
 *
 * It is an app-specific random (v4) UUID rather than the RFC-4122 URL or DNS
 * namespace because the name being hashed is a cache filename, not a URL or a
 * hostname — reusing a standard namespace would invite collisions with anything
 * else that hashes the same string.
 */
const FOOTAGE_NAMESPACE_UUID = "2c373882-2ac5-436e-8d0f-a8709aa7f5fb";

/** The namespace as its 16 big-endian bytes, parsed once at module load. */
const FOOTAGE_NAMESPACE_BYTES = uuidToBytes(FOOTAGE_NAMESPACE_UUID);

/**
 * RFC-4122 v5 (SHA-1, name-based) UUID for a cache filename.
 *
 * Qdrant accepts only a uint64 or a UUID as a point id, and the identity of a
 * clip is its file (design §4.2), so the id is derived from the basename —
 * never from an absolute path, which differs between the host process and a
 * container and would split one library into two.
 *
 * Hand-rolled because there is no `uuid` dependency and `node:crypto` exposes
 * only `randomUUID` (v4). This matches how `utils/misc.ts` hand-rolls `md5` and
 * `sha256`: a small pure hashing helper is cheaper than a dependency.
 *
 * The algorithm is RFC-4122 §4.3 verbatim: SHA-1 over the namespace's 16 bytes
 * followed by the UTF-8 name, keep the first 16 bytes of the digest, then
 * overwrite the version nibble with 5 and the two top variant bits with `0b10`.
 * Those two writes are what makes the output a *valid* UUID rather than just
 * hex that looks like one — Qdrant rejects the latter.
 */
export function pointIdFor(localFile: string): string {
  const digest = createHash("sha1").update(FOOTAGE_NAMESPACE_BYTES).update(localFile, "utf8").digest();

  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC-4122 variant

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Parses a hyphenated UUID string into its 16 bytes. Throws on a malformed literal. */
function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`invalid UUID: ${uuid}`);
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// ---------------------------------------------------------------------------
// Seed search terms
// ---------------------------------------------------------------------------

/**
 * Every seed search term, flattened from `terms.json`.
 *
 * The file is nested on purpose — curated terms grouped into 16 categories, plus
 * the terms this app has actually issued against Pexels — because that shape is
 * what makes it reviewable and editable by a human. Callers want a flat list, so
 * the traversal lives here once instead of being re-implemented by the pull
 * command, the CLI and the tests.
 *
 * Order is stable and meaningful: categories in file order first, observed terms
 * last, so a budget-capped pull spends on the curated coverage before the tail.
 * Duplicates are removed case-insensitively — the two halves were assembled
 * independently and nothing stops a future edit from overlapping them.
 */
export function allTerms(): string[] {
  const terms: string[] = [];
  for (const category of Object.values(seedTerms.categories)) terms.push(...category);
  terms.push(...seedTerms.observed_terms.terms);
  return cleanList(terms);
}
