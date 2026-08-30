/**
 * Provider fallback for scene-matched footage (design `scene-matched-footage.md` v4, §3.5).
 *
 * `matchScenes` returns an ordered list plus the scene ids the gallery could
 * not serve. This module is what happens to those ids: they are grouped into
 * provider searches, the results are **judged before they are accepted**,
 * accepted results are downloaded into the shared cache, and provenance is
 * written so a later `footage index` pass can make them searchable.
 *
 * Six properties are load-bearing, and each one is either a review finding or a
 * line of §3.5 that would be easy to lose:
 *
 *  1. **Provider results are judged.** Provider search filters on duration,
 *     orientation and rendition and nothing else (`search.ts:220`, `:249`) —
 *     no part of it looks at content. Accepting these unjudged would abandon
 *     the relevance promise on exactly the noisiest path. They have no gallery
 *     description, so they are judged on the provider's own metadata: the
 *     human-readable title carried in the source-page slug, the search that
 *     reached them, dimensions and duration. See `providerCandidate`.
 *  2. **A scene whose candidates are all rejected contributes no clip.** That
 *     is the design working, not a failure. `-1` is the judge's first-class
 *     answer and it is honoured here exactly as it is in the gallery path.
 *  3. **Dedupe is by the resolved destination file, never by URL.**
 *     `saveVideo` names its output `vid-<md5(url without query)>.mp4`, so two
 *     signed URLs for one clip are one file, and a provider result can resolve
 *     to a gallery clip this render already placed. The URL set inside
 *     `downloadVideos` (`download.ts:267`) is local to one call and protects
 *     none of that. The key here is `destinationFileFor(url)` — known *before*
 *     the download, so a duplicate costs nothing rather than costing bytes.
 *  4. **Nothing thrown reaches the render.** Every failure means one scene
 *     contributes no clip; whatever was already downloaded is still returned.
 *     Cancellation is the single exception and is rethrown, because an aborted
 *     task must not carry on spending on searches and downloads.
 *  5. **The downloader is `saveVideo`.** It is already provider-agnostic, it
 *     probes what it wrote, and it stages its temp beside the destination
 *     because `material_directory` may be on another filesystem
 *     (`download.ts:148`). An earlier draft of this design claimed `pull.ts`'s
 *     private downloader was the reusable seam. It was wrong.
 *  6. **Provenance is provider-general.** `pull.ts:809` hardcodes
 *     `provider: "pexels"` because it is a Pexels-only pull; this path serves
 *     whatever `video_source` names, so the provider comes off the material.
 *
 * What this module deliberately does **not** do is describe the clip inline.
 * A describe is a proxy encode plus a vision call — seconds each — and a dozen
 * of them mid-render buys a relevance improvement that only the *next* render
 * collects. The row lands `stale` at version 0 with a null description, which
 * is exactly the state the download hook leaves one in (`hook.ts:216`), and a
 * later `footage index` pass picks it up.
 *
 * The judge, its response validation, the `-1` convention and the collision
 * pass are all `sceneMatch.ts`'s, reused rather than restated: a second copy of
 * "degrade every malformed answer to none" is a second copy that can rot.
 */

import { basename, join } from "node:path";

import type { LanguageModel } from "ai";

import { getSettings } from "../../config/settings.ts";
import { isConnected } from "../../db/client.ts";
import type { FootageCreator } from "../../db/types.ts";
import type { MaterialInfo, VideoAspectValue } from "../../models/schema.ts";
import { errorMessage, errorName, logger } from "../../utils/logger.ts";
import { cacheVideosDir } from "../../utils/paths.ts";
import { searchWithCache } from "../material/cache.ts";
import { saveVideo } from "../material/download.ts";
import { describeProviderError, safePublicUrl } from "../material/http.ts";
import { getProviderSearch, type SearchParams } from "../material/search.ts";
import { isCacheVideoPath } from "./hook.ts";
import { recordClipProvenance, type ClipProvenance } from "./provenance.ts";
import { destinationFileFor } from "./pull.ts";
import type { FootagePayload } from "./qdrant.ts";
import {
  assign,
  chunk,
  durationBand,
  isCancellation,
  judgeBatch,
  resolveJudgeModel,
  sceneFootageOptions,
  type Candidate,
  type JudgeProposal,
  type Scene,
  type SceneFootageOptions,
} from "./sceneMatch.ts";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Distinct provider searches one fallback run may issue.
 *
 * Unmatched scenes are a per-scene quantity and the provider's request
 * allowance is not: a 360-scene book segment whose gallery coverage is poor
 * would otherwise issue hundreds of searches inside one render, exhaust the
 * hourly allowance, and be answered with 429s that `fetchProviderJson` can only
 * back off from twice (`search.ts:118`). Thirty-two covers a whole short's
 * worth of scenes and bounds a book segment to something a provider will
 * actually serve.
 *
 * The cap drops scenes rather than clips: every scene beyond it simply
 * contributes nothing, which is the same outcome as a judge rejecting its
 * candidates, and it is logged once so the reason is never a mystery.
 */
export const DEFAULT_MAX_FALLBACK_SEARCHES = 32;

/**
 * Words kept from a scene's narration when it becomes a provider query.
 *
 * Measured against the live Pexels API: a full narration sentence and its
 * eight-word keyword reduction return comparable result counts (17 vs 18 for a
 * Notre-Dame line, 20 vs 20 for a pit-stop line, 15 vs 14 for a luthier line),
 * so the reduction costs nothing in recall. What it buys is two things the raw
 * sentence cannot give: distinct scenes can collapse onto one search, and the
 * string that ends up stored as this clip's `search_term` looks like every
 * other term in the library ("forest path", "ocean waves") rather than like a
 * sentence from one script that will never be issued again.
 */
const QUERY_WORD_CAP = 8;

/**
 * Function words dropped from a narration before it becomes a query.
 *
 * Deliberately only function words. Nothing here carries an image, so nothing
 * here can cost a search its subject — the failure mode of a longer list is a
 * dropped noun, which is unrecoverable and invisible.
 */
const QUERY_STOP_WORDS: ReadonlySet<string> = new Set(
  (
    "a an the and or but if then than that this these those there here " +
    "is are was were be been being am it its it's " +
    "of in on at to from by for with without into onto over under above below between about across through during " +
    "not no nor so as too very just only also even still yet " +
    "i you he she we they me him her us them my your his their our " +
    "will would shall should can could may might must do does did done have has had " +
    "what which who whom whose when where why how " +
    "all any both each few more most other some such own same"
  ).split(" "),
);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SceneFallbackInput {
  /** Every scene, in narrative order — `MatchScenesResult.scenes`. */
  scenes: readonly Scene[];
  /** The ids the gallery could not serve — `MatchScenesResult.unmatched`. */
  unmatched: readonly string[];
  /** `video_source`. Never `"local"`: §3.6 skips scene matching for those. */
  source: string;
  videoAspect: VideoAspectValue;
  /** `video_clip_duration`: how long one clip is on screen. */
  slotSeconds: number;
  /** Raw `video_clip_speed`; normalized exactly once, inside `durationBand`. */
  clipSpeed: unknown;
  /** Only used to attribute log lines to a render. */
  taskId?: string;
  signal?: AbortSignal;

  /**
   * Absolute paths this render has already placed, so a download that resolves
   * onto one of them is dropped instead of shown twice.
   *
   * Optional, and additive to the agreed signature. Without it the run is still
   * internally consistent — no two fallback scenes can be handed the same file
   * — but the collision the review actually found, a provider result resolving
   * to a gallery clip assigned earlier in the same render, can only be seen by
   * a caller holding `MatchScenesResult.ordered`. Pass it.
   */
  assigned?: Iterable<string>;

  /** Overrides for the `scene_footage` group, for a CLI run or a test. */
  options?: Partial<SceneFootageOptions>;

  /** Distinct searches this run may issue. Defaults to the module bound. */
  maxSearches?: number;
}

export interface SceneFallbackDeps {
  /**
   * Provider search. The default is the normal render path exactly:
   * `getProviderSearch(source)` fed through `searchWithCache`, so a term this
   * render issues is a term the next render gets free for 24 hours.
   */
  searchProvider?: (params: SearchParams) => Promise<MaterialInfo[]>;
  /** Downloader. Defaults to `saveVideo` into the shared cache directory. */
  download?: (url: string, signal?: AbortSignal) => Promise<string>;
  /** Provenance write. Defaults to `recordClipProvenance`. */
  record?: (provenance: ClipProvenance) => Promise<unknown>;
  /** Judge seam, for a test that never reaches a model. Defaults to `judgeBatch`. */
  judge?: typeof judgeBatch;
  /** Pre-built judge model, passed straight through to `judgeBatch`. */
  model?: LanguageModel;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * The provider query one scene's narration becomes.
 *
 * Pure, and exported because it decides what the provider is asked for, which
 * is the single largest influence on what this module can possibly return.
 *
 * Punctuation goes, case is folded, function words are dropped, repeats are
 * dropped, and what is left is capped at `QUERY_WORD_CAP` content words in the
 * order the narration said them. Bare numbers go too: "nine hundred years" and
 * "twelve percent" spend query slots on tokens no footage library indexes.
 *
 * Returns `""` for a scene with nothing sayable in it — a pause, or a line
 * made entirely of function words. That scene is dropped rather than turned
 * into a search for nothing.
 */
export function providerQueryFor(text: string, cap: number = QUERY_WORD_CAP): string {
  const limit = Number.isFinite(cap) && cap > 0 ? Math.trunc(cap) : QUERY_WORD_CAP;

  const words = String(text ?? "")
    .toLowerCase()
    // Keep letters, digits, apostrophes and hyphens: "o'clock" and "close-up"
    // are one word each, and splitting them produces two useless fragments.
    .replace(/[^\p{L}\p{N}\s'’-]/gu, " ")
    .split(/\s+/);

  const kept: string[] = [];
  const seen = new Set<string>();

  for (const raw of words) {
    const word = raw.replace(/^['’-]+|['’-]+$/g, "");
    if (!word) continue;
    if (/^\p{N}+$/u.test(word)) continue;
    if (QUERY_STOP_WORDS.has(word)) continue;
    if (seen.has(word)) continue;

    seen.add(word);
    kept.push(word);
    if (kept.length >= limit) break;
  }

  return kept.join(" ");
}

/** Scenes that want the same provider search, and the search they want. */
export interface QueryGroup {
  query: string;
  scenes: Scene[];
}

/**
 * Groups scenes by the query their narration reduces to — **one search per
 * distinct query, never one per scene** (§3.5).
 *
 * Pure. Order is the order the queries first appear, which is narrative order,
 * so a search cap truncates the tail of the video rather than an arbitrary
 * middle. Scenes reducing to an empty query are dropped here, before anything
 * network-shaped happens.
 */
export function groupScenesByQuery(scenes: readonly Scene[]): QueryGroup[] {
  const groups = new Map<string, QueryGroup>();

  for (const scene of scenes) {
    const query = providerQueryFor(scene.text);
    if (!query) continue;

    const group = groups.get(query);
    if (group) group.scenes.push(scene);
    else groups.set(query, { query, scenes: [scene] });
  }

  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/**
 * The human-readable title hiding in a provider's source-page URL.
 *
 * This is the only content signal a provider search returns. Pexels spells a
 * clip's title into its page slug —
 * `/video/vibrant-scarlet-macaw-grooming-in-nature-35499010/` — and Pixabay and
 * Coverr do the same, so one generic rule serves all three: take the last path
 * segment, drop a trailing numeric id, and turn separators into spaces.
 *
 * Returns `""` when the URL carries no slug worth reading, which is a real
 * case; the caller falls back to naming the search that found the clip.
 */
export function titleFromSourcePage(sourcePage: string | null | undefined): string {
  const url = String(sourcePage ?? "").trim();
  if (!url) return "";

  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return "";
  }

  const segment = path.split("/").filter(Boolean).pop() ?? "";
  if (!segment) return "";

  const words = segment
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .split(/[-_]+/)
    .filter(Boolean)
    // A trailing all-digit token is the asset id, which is already printed as
    // its own field and would only read as noise inside a title.
    .filter((word, index, all) => !(index === all.length - 1 && /^\d+$/.test(word)))
    .filter((word) => !/^\d+$/.test(word));

  return words.join(" ").trim();
}

/**
 * A provider result dressed as a judge candidate.
 *
 * `Candidate` and `FootagePayload` are shapes here, not claims. The judge
 * prompt prints six payload fields (`sceneMatch.ts:buildJudgePrompt`) and this
 * fills exactly those with what the provider actually told us; the remaining
 * required fields are inert filler that no prompt reads, set to neutral values
 * rather than to guesses. In particular `describe_version`/`embed_version` stay
 * 0 and `indexed_at` stays empty: nothing here has been described or embedded,
 * and this object is never written to Qdrant.
 *
 * `detailed_description` says out loud that nobody watched this clip. The
 * judge's system prompt tells it the descriptions come from someone who did,
 * which is true of the gallery path and false here; leaving that uncorrected
 * would invite the model to trust a title as if it were a viewing.
 *
 * `file` is the path the download *will* produce — `destinationFileFor` is the
 * same md5-of-url-without-query rule `saveVideo` names its output by — which is
 * what makes `assign`'s collision pass dedupe by resolved file for free, before
 * a single byte is fetched.
 */
export function providerCandidate(item: MaterialInfo, query: string): Candidate | null {
  const url = String(item?.url ?? "").trim();
  if (!url) return null;

  const source = item.source_info ?? {};
  const provider = String(item.provider || source.provider || "").trim() || "provider";
  const localFile = destinationFileFor(url);
  const sourcePage = safePublicUrl(source.source_page) ?? "";
  const title = titleFromSourcePage(sourcePage);
  const width = Number(source.rendition?.width) || 0;
  const height = Number(source.rendition?.height) || 0;
  const duration = Number(item.duration) || 0;

  const shape = width > 0 && height > 0 ? `${width}x${height}` : "unknown size";
  const assetId = source.asset_id === null || source.asset_id === undefined ? "" : String(source.asset_id);

  const payload: FootagePayload = {
    local_file: localFile,
    provider,
    ...(assetId ? { asset_id: assetId } : {}),
    ...(sourcePage ? { source_page: sourcePage } : {}),
    search_terms: [query],
    duration,
    ...(width > 0 ? { width } : {}),
    ...(height > 0 ? { height } : {}),

    summary: title || `stock clip returned for the search "${query}"`,
    detailed_description:
      `No description: nobody has viewed this clip. This is ${provider} search metadata only — ` +
      `it was returned for the search "${query}"` +
      (title ? `, and the provider titles it "${title}"` : ", and the provider gives it no title") +
      `. ${shape}, ${duration.toFixed(0)}s` +
      (assetId ? `, asset ${assetId}` : "") +
      ".",
    use_cases: [],
    mood: [],
    tags: [...new Set([...title.split(" ").filter(Boolean), ...query.split(" ")])],

    // Inert: required by the payload type, read by nothing in the judge prompt,
    // and unknowable from a search response. Neutral, never guessed.
    setting: "",
    time_of_day: "",
    has_people: false,
    has_on_screen_text: false,
    camera_motion: "",
    quality_flags: [],
    describe_model: "",
    describe_version: 0,
    embed_model: "",
    embed_version: 0,
    indexed_at: "",
  };

  return {
    file: join(cacheVideosDir(false), localFile),
    local_file: localFile,
    // Provider results carry no similarity score, and inventing one would make
    // a ranked list look like a judged one.
    score: 0,
    duration,
    payload,
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Serves the scenes the gallery could not, and returns what it managed.
 *
 * The map is scene id → absolute local path, holding only the scenes that
 * ended with a clip. A scene is absent when its query was empty, its search
 * returned nothing, the judge rejected everything, the download failed, or its
 * clip turned out to be one this render already had. Every one of those is a
 * normal outcome; none of them is an error, and none of them throws.
 *
 * `scene_footage.fallback_enabled` is deliberately **not** read here, for the
 * same reason `matchScenes` does not read `enabled`: the flag decides whether a
 * render calls this at all, and re-checking it inside would make the module
 * unusable from a CLI and untestable without flipping a global.
 *
 * Downloads run one at a time. The count is small by construction — a scene the
 * gallery could not serve is the exception — and serialising them keeps this
 * off the provider's bandwidth limits mid-render and keeps the duplicate check
 * against what has actually landed a single, obvious decision point.
 */
export async function resolveSceneFallback(
  input: SceneFallbackInput,
  deps: SceneFallbackDeps = {},
): Promise<Map<string, string>> {
  const startedAt = Date.now();
  const resolved = new Map<string, string>();
  const signal = input.signal;
  const label = input.taskId ? `scene fallback (${input.taskId})` : "scene fallback";

  // Claimed destination files, seeded with what the render already placed.
  // Basenames, not full paths: `saveVideo` may be pointed at a different
  // directory than the projection assumed, and the identity of a clip is its
  // `vid-<md5>.mp4` name, not where it happens to sit.
  const claimed = new Set<string>();
  for (const path of input.assigned ?? []) {
    const name = basename(String(path ?? "")).trim();
    if (name) claimed.add(name);
  }

  try {
    const wanted = new Set(input.unmatched ?? []);
    const scenes = (input.scenes ?? []).filter((scene) => wanted.has(scene.id));
    if (scenes.length === 0) return resolved;

    const options = { ...sceneFootageOptions(), ...(input.options ?? {}) };
    const band = durationBand(input.slotSeconds, input.clipSpeed, options.duration_ratio);
    const maxSearches = Math.max(1, Math.trunc(input.maxSearches ?? DEFAULT_MAX_FALLBACK_SEARCHES));

    const allGroups = groupScenesByQuery(scenes);
    const groups = allGroups.slice(0, maxSearches);
    if (allGroups.length > groups.length) {
      const dropped = allGroups.slice(groups.length).reduce((sum, group) => sum + group.scenes.length, 0);
      logger.warning(
        `${label}: ${allGroups.length} distinct queries exceeds the ${maxSearches}-search bound; ` +
          `${dropped} scene(s) past the bound contribute no clip`,
      );
    }

    logger.info(
      `${label}: ${scenes.length} unmatched scene(s) in ${groups.length} search(es), ` +
        `minimum duration ${band.min.toFixed(2)}s at ${band.speed.toFixed(2)}x`,
    );
    if (groups.length === 0) return resolved;

    const searchProvider = deps.searchProvider ?? defaultProviderSearch(input.source);

    // One search per distinct query, issued serially: the provider's request
    // allowance is the scarce resource here, not the wall clock — the same
    // reason `pull.ts` searches terms one at a time.
    const shortlists = new Map<string, Candidate[]>();
    const items = new Map<string, MaterialInfo>();
    const queryFor = new Map<string, string>();

    for (const group of groups) {
      signal?.throwIfAborted();

      let results: MaterialInfo[];
      try {
        results = await searchProvider({
          searchTerm: group.query,
          minimumDuration: band.min,
          videoAspect: input.videoAspect,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (isCancellation(error, signal)) throw error;
        logger.warning(
          `${label}: search for ${JSON.stringify(group.query)} failed, ` +
            // No secret to name: the provider functions redact their own key
            // before they log, and a query is not one. `describeProviderError`
            // still strips any configured proxy out of the detail.
            `${group.scenes.length} scene(s) contribute nothing: ${describeProviderError(error)}`,
        );
        continue;
      }

      const candidates: Candidate[] = [];
      const offered = new Set<string>();
      for (const item of results) {
        const candidate = providerCandidate(item, group.query);
        if (!candidate) continue;
        // A clip this render already has is not an option at all, and finding
        // that out here rather than after the download is the whole value of
        // projecting the destination name before fetching anything.
        if (claimed.has(candidate.local_file)) continue;
        // The same clip twice in one list would let the judge "choose" between
        // identical options — `shortlistFor` refuses the same thing for the
        // same reason. Across *different* queries it is allowed to appear
        // twice: two scenes may both be offered it, and `assign` is what
        // decides which one gets it.
        if (offered.has(candidate.local_file)) continue;
        offered.add(candidate.local_file);

        items.set(candidate.local_file, item);
        // First query wins, which is the narratively earlier one — the same
        // scene most likely to be the one that ends up with the clip.
        if (!queryFor.has(candidate.local_file)) queryFor.set(candidate.local_file, group.query);
        candidates.push(candidate);
        if (candidates.length >= options.shortlist_size) break;
      }

      logger.info(
        `${label}: ${JSON.stringify(group.query)} → ${results.length} result(s), ` +
          `${candidates.length} candidate(s) for ${group.scenes.length} scene(s)`,
      );

      // Every scene in the group is judged against the same list. They are
      // different narrations, so the judge can and does answer differently;
      // `assign` is what stops two of them walking off with one clip.
      for (const scene of group.scenes) shortlists.set(scene.id, candidates);
    }

    signal?.throwIfAborted();

    // Back into narrative order before anything is decided. Grouping by query
    // reshuffles scenes, and `assign` resolves collisions in the order it is
    // given — so leaving them grouped would hand an earlier scene's clip to a
    // later one purely because they reduced to different searches.
    const judgeable = groups
      .flatMap((group) => group.scenes)
      .filter((scene) => shortlists.has(scene.id))
      .sort((left, right) => left.index - right.index);
    if (judgeable.length === 0) return resolved;

    // ---------------------------------------------------------------------
    // Judge. `judgeBatch` owns the schema, the `-1` convention, the response
    // validation and the "a failed batch is `none`, never a throw" rule.
    // ---------------------------------------------------------------------
    const judge = deps.judge ?? judgeBatch;
    const model = deps.model ?? judgeModelOverride(input.options?.judge_model);
    const proposals = new Map<string, JudgeProposal>();

    for (const batch of chunk(judgeable, options.judge_batch)) {
      signal?.throwIfAborted();
      let answers: JudgeProposal[];
      try {
        answers = await judge(batch, shortlists, {
          ...(model ? { model } : {}),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (isCancellation(error, signal)) throw error;
        logger.warning(`${label}: judge batch raised, ${batch.length} scene(s) contribute nothing: ${errorMessage(error)}`);
        answers = batch.map((scene) => ({ scene_id: scene.id, choice: null, reason: errorMessage(error) }));
      }
      for (const answer of answers) proposals.set(answer.scene_id, answer);
    }

    const assignments = assign(
      judgeable.map((scene) => {
        const proposal = proposals.get(scene.id);
        return {
          scene,
          candidates: shortlists.get(scene.id) ?? [],
          choice: proposal?.choice ?? null,
          reason: proposal?.reason ?? "scene was never judged",
        };
      }),
    );

    for (const assignment of assignments) {
      logger.info(
        `${label}: ${assignment.scene_id} → ${assignment.local_file ?? "none"}` +
          (assignment.substituted ? " (substituted)" : "") +
          `: ${assignment.reason}`,
      );
    }

    // ---------------------------------------------------------------------
    // Download and record. One clip at a time; a failure costs that scene and
    // nothing else.
    // ---------------------------------------------------------------------
    const download = deps.download ?? ((url: string, abort?: AbortSignal) => saveVideo(url, "", abort));

    for (const assignment of assignments) {
      signal?.throwIfAborted();
      if (!assignment.local_file) continue;

      const item = items.get(assignment.local_file);
      if (!item) continue;
      if (claimed.has(assignment.local_file)) {
        logger.info(`${label}: ${assignment.scene_id} skipped, ${assignment.local_file} is already in this render`);
        continue;
      }

      let savedPath: string;
      try {
        savedPath = await download(item.url, signal);
      } catch (error) {
        if (isCancellation(error, signal)) throw error;
        logger.warning(
          `${label}: ${assignment.scene_id} download failed, it contributes no clip: ` +
            `${describeProviderError(error, item.url)}`,
        );
        continue;
      }

      // `saveVideo` returns "" for a file that downloaded but would not decode.
      if (!savedPath) {
        logger.warning(`${label}: ${assignment.scene_id} download did not produce a playable file`);
        continue;
      }

      // The name is re-read off what actually landed rather than trusted from
      // the projection: the two agree today, and a silent disagreement is
      // exactly how a duplicate would get past the check above.
      const saved = basename(savedPath);
      if (claimed.has(saved)) {
        logger.info(`${label}: ${assignment.scene_id} skipped, ${saved} is already in this render`);
        continue;
      }

      claimed.add(saved);
      resolved.set(assignment.scene_id, savedPath);
      logger.success(`${label}: ${assignment.scene_id} ← ${savedPath}`);

      await recordFallbackProvenance(item, savedPath, queryFor.get(assignment.local_file) ?? "", label, deps.record);
    }

    logger.info(
      `${label}: ${resolved.size}/${scenes.length} unmatched scene(s) served from ${input.source} ` +
        `in ${Date.now() - startedAt}ms`,
    );
    return resolved;
  } catch (error) {
    // Cancellation is the one thing that must not become a degraded result: an
    // aborted task would otherwise carry on into the rest of the render.
    if (isCancellation(error, signal)) throw error;
    logger.warning(`${label}: stopped after ${errorName(error)}: ${errorMessage(error)}`);
    // Whatever was already downloaded and recorded is still good, and dropping
    // it would waste bytes that are already on disk.
    return resolved;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The normal render path's search: the provider, through the 24-hour cache. */
function defaultProviderSearch(source: string): (params: SearchParams) => Promise<MaterialInfo[]> {
  const { provider, search } = getProviderSearch(source);
  return (params: SearchParams) => searchWithCache({ provider, search, ...params });
}

/**
 * A judge model built from an override, or `undefined` to let `judgeBatch`
 * resolve the configured one itself.
 *
 * Never throws: a missing key is `judgeBatch`'s own well-handled case, where it
 * degrades every scene in the batch to `none`, and duplicating that failure
 * here would only move it earlier.
 */
function judgeModelOverride(judgeModel: string | undefined): LanguageModel | undefined {
  const id = String(judgeModel ?? "").trim();
  if (!id) return undefined;
  try {
    return resolveJudgeModel(id);
  } catch (error) {
    logger.debug(`scene fallback: judge model override ${JSON.stringify(id)} unavailable: ${errorMessage(error)}`);
    return undefined;
  }
}

/**
 * Records where a fallback clip came from, and never costs the clip.
 *
 * Awaited rather than fire-and-forget: the count is small, the bytes are
 * already spent, and one durable row is what makes "the clip is reusable next
 * time" true rather than aspirational. Every outcome is swallowed after a log
 * line — `pull.ts`'s rule, for `pull.ts`'s reason: the file on disk is the
 * durable work-list, so a lost row costs one later re-read, not one clip.
 *
 * The provider comes off the material, never a constant. `pull.ts:809` can
 * hardcode `"pexels"` because it is a Pexels-only pull; this path serves
 * whatever `video_source` names.
 *
 * The two guards are the download hook's, for the same reasons: a clip written
 * outside `cacheVideosDir` is one `footage index` will never walk, so a row
 * pointing at it would describe a file the library cannot find; and
 * `auto_index` off is an operator saying renders should not touch the index.
 */
async function recordFallbackProvenance(
  item: MaterialInfo,
  savedPath: string,
  searchTerm: string,
  label: string,
  record: SceneFallbackDeps["record"],
): Promise<void> {
  const localFile = basename(savedPath);

  try {
    if (!isCacheVideoPath(savedPath)) {
      logger.debug(`${label}: ${localFile} is outside the footage cache, no provenance written`);
      return;
    }
    if (!getSettings().footage_index.auto_index) return;
    if (!isConnected()) return;

    const source = item.source_info ?? {};
    const assetId = source.asset_id === null || source.asset_id === undefined ? "" : String(source.asset_id).trim();
    const renditionId =
      source.rendition?.id === null || source.rendition?.id === undefined ? "" : String(source.rendition.id).trim();

    let creator: FootageCreator | null = null;
    if (source.creator) {
      const kept: FootageCreator = {};
      if (source.creator.id) kept.id = String(source.creator.id);
      if (source.creator.name) kept.name = String(source.creator.name);
      const profile = safePublicUrl(source.creator.profile_page);
      if (profile) kept.profile_page = profile;
      if (Object.keys(kept).length > 0) creator = kept;
    }

    const write = record ?? recordClipProvenance;
    await write({
      localFile,
      provider: String(item.provider || source.provider || "").trim(),
      assetId,
      renditionId,
      // Rebuilt through the allow-list rather than copied: a signed or
      // private-network URL must never be persisted (`hook.ts:83`).
      sourcePage: safePublicUrl(source.source_page) ?? "",
      creator,
      searchTerm,
    });
  } catch (error) {
    logger.warning(
      `${label}: could not record provenance for ${localFile}: ${errorName(error)}, detail=${errorMessage(error)}`,
    );
  }
}
