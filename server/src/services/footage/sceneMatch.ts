/**
 * Scene-matched footage selection (design `scene-matched-footage.md` v4, §3).
 *
 * Turns the narration cues a render already holds in memory into an **ordered
 * list of clip paths**, one per scene, chosen from the semantic library by an
 * LLM that reads each scene's narration against a shortlist of descriptions.
 *
 * What this module is *not* is as important as what it is. It does not place
 * footage at a timestamp, does not choose a `source_start`, and does not touch
 * the combiner: the output is a list, consumed by the existing sequential path
 * at the combiner's own cumulative offsets. That restraint is what makes it
 * shippable — see §2 of the design for the three files that would otherwise
 * have to change.
 *
 * Four properties are load-bearing, and each one is a review finding that was
 * paid for once already:
 *
 *  1. **It never throws into a render.** `matchScenes` catches everything and
 *     degrades to "no scene matching happened", which is exactly today's
 *     behaviour. The single exception is cancellation, which is rethrown —
 *     swallowing it would let an aborted task keep spending on judge calls.
 *  2. **Duration is a band, not a floor.** The judge reads a description of the
 *     *whole* clip while sequential rendering shows only `slot * speed` seconds
 *     from source zero. An unbounded upper end lets a clip described by
 *     something at second 20 render five seconds of something else. See
 *     `durationBand`.
 *  3. **Qdrant availability is checked explicitly.** `queryPoints` swallows
 *     every failure into `[]`, so without a preflight an outage is
 *     indistinguishable from "the gallery has nothing" — and would push every
 *     scene into provider fallback instead of falling back to today's path.
 *  4. **Assignment dedupes by resolved file, never by candidate index.**
 *     Indices are per-scene; two scenes both answering `0` normally mean two
 *     different clips.
 *
 * Everything expensive is injectable with a real default (`MatchDeps`,
 * `ShortlistDeps`, `JudgeDeps`), in the same shape `describe.ts` injects its
 * model and proxy builder: this repo's tests use no mocking library, so a seam
 * a plain function can be passed through is the only way the orchestration is
 * testable at all. The arithmetic and the response validation are additionally
 * broken out as exported pure helpers that need neither a key nor a network.
 */

import { z } from "zod";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject, type LanguageModel } from "ai";

import { sceneFootageSettingsSchema, type SceneFootageSettings } from "../../config/schema.ts";
import { getSettings } from "../../config/settings.ts";
import { aspectOrientation, VideoAspect, type VideoAspectValue } from "../../models/schema.ts";
import { errorMessage, errorName, logger } from "../../utils/logger.ts";
import { normalizeClipSpeed } from "../../utils/misc.ts";
import { cacheVideosDir } from "../../utils/paths.ts";
import { resolvePathWithinDirectory } from "../../utils/fileSecurity.ts";
import { probe, type MediaInfo } from "../video/probe.ts";
import { searchFootage } from "./index.ts";
import { isAvailable, type FootageFilter, type FootageMatch, type FootagePayload } from "./qdrant.ts";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * The `scene_footage` settings group.
 *
 * Aliased from `config/schema.ts` rather than restated, so a field added or
 * renamed there is a compile error here instead of a value this module quietly
 * stops honouring. The zod schema already bounds every field (`min(1)` on the
 * counts, `min(1)` on the ratio) and `initSettings()` parses a stored document
 * through it, so nothing read out of the group needs re-validating.
 */
export type SceneFootageOptions = SceneFootageSettings;

/**
 * The group's defaults, materialised from the schema itself.
 *
 * Built with `.parse({})` rather than typed out again: a default that drifts
 * from the schema's is the kind of disagreement nobody notices until two code
 * paths behave differently for the same deployment.
 */
export const SCENE_FOOTAGE_DEFAULTS: Readonly<SceneFootageOptions> = Object.freeze(
  sceneFootageSettingsSchema.parse({}),
);

/**
 * Slot length used when the caller supplies a nonsensical one.
 *
 * `video_clip_duration` is validated upstream, but `buildScenes` is a pure
 * helper anyone may call, and a zero or `NaN` slot would otherwise merge an
 * entire book into one scene or emit one scene per word.
 */
export const DEFAULT_SLOT_SECONDS = 5;

/**
 * The group, or the schema defaults when settings have not been loaded.
 *
 * `getSettings()` throws before `initSettings()` — a real case for a CLI that
 * probes early, and the same guard `preferredLanguage()` carries. The defaults
 * are a complete, usable configuration on their own, so falling back to them is
 * strictly better than making an unrelated caller crash on a settings lookup.
 */
export function sceneFootageOptions(): SceneFootageOptions {
  try {
    return getSettings().scene_footage;
  } catch {
    return SCENE_FOOTAGE_DEFAULTS;
  }
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/**
 * One timed narration fragment, in the shape both producers already have.
 *
 * `TtsCue` (short video) spells the text `content`; `SubtitleCue` (book
 * narration) spells it `text`. Both are structurally assignable to this, so
 * neither caller has to convert a list before handing it over — which is the
 * point, since converting is exactly where a caller would reach for the SRT
 * file the design forbids (§3.1).
 */
export interface SceneCue {
  /** Seconds from the start of the narration. */
  start: number;
  end: number;
  text?: string;
  content?: string;
}

/** One scene: a span of narration that wants one clip. */
export interface Scene {
  /** Stable, deterministic, and carried through judging: `scene-1`, `scene-2`. */
  id: string;
  /** Zero-based position, which is also the position in the ordered output. */
  index: number;
  /** The merged narration text the retrieval and the judge both read. */
  text: string;
  start: number;
  end: number;
}

/**
 * Merges adjacent cues until a span reaches the slot, one scene per clip.
 *
 * Pure and deterministic: same cues in, same scenes out, no settings read and
 * nothing async. A group closes as soon as its wall-clock span reaches
 * `slotSeconds`, so a scene is *at least* one slot long and, for word-level
 * cues, very close to exactly one.
 *
 * Two deliberate choices:
 *
 *  - **Silent cues still count toward the span.** A pause is part of the time
 *    the clip has to cover; dropping it would systematically produce fewer,
 *    longer scenes and therefore fewer clips than the narration needs.
 *  - **A group that ends up with no text is still emitted.** It keeps the
 *    scene count honest against the narration's length; `shortlistFor`
 *    short-circuits blank text to an empty shortlist without a network call, so
 *    it simply becomes an unmatched scene rather than a wasted embedding.
 *
 * A non-finite or non-positive `slotSeconds` falls back to
 * `DEFAULT_SLOT_SECONDS` rather than degenerating, because both alternatives —
 * one scene for the whole narration, or one scene per cue — are silently wrong
 * in a way nobody would notice until the render.
 */
export function buildScenes(cues: readonly SceneCue[], slotSeconds: number): Scene[] {
  const slot = Number.isFinite(slotSeconds) && slotSeconds > 0 ? slotSeconds : DEFAULT_SLOT_SECONDS;
  if (!Array.isArray(cues) || cues.length === 0) return [];

  const scenes: Scene[] = [];
  let words: string[] = [];
  let start = 0;
  let end = 0;
  let open = false;

  const flush = () => {
    if (!open) return;
    scenes.push({
      id: `scene-${scenes.length + 1}`,
      index: scenes.length,
      text: words.join(" ").replace(/\s+/g, " ").trim(),
      start,
      end,
    });
    words = [];
    open = false;
  };

  for (const cue of cues) {
    if (!cue) continue;

    // Cue timings arrive from TTS adapters and from approximate long-form
    // alignment (`longform.ts:298`), so they are coerced rather than trusted.
    // A cue that carries no usable start continues from where the last one
    // stopped, which keeps the span monotonic instead of resetting it to zero.
    const rawStart = Number(cue.start);
    const rawEnd = Number(cue.end);
    const cueStart = Number.isFinite(rawStart) ? rawStart : open ? end : 0;
    const cueEnd = Number.isFinite(rawEnd) ? Math.max(rawEnd, cueStart) : cueStart;

    if (!open) {
      start = cueStart;
      end = cueEnd;
      open = true;
    } else {
      end = Math.max(end, cueEnd);
    }

    const text = String(cue.text ?? cue.content ?? "").trim();
    if (text) words.push(text);

    if (end - start >= slot) flush();
  }

  flush();
  return scenes;
}

// ---------------------------------------------------------------------------
// The duration band
// ---------------------------------------------------------------------------

/** The duration window a candidate must fall inside, and the speed it assumed. */
export interface DurationBand {
  /** `slot * speed`: the source the renderer will actually consume. */
  min: number;
  /** `slot * ratio`: how far the description may outrun what is rendered. */
  max: number;
  /** The normalized speed, exposed so a caller can log what was applied. */
  speed: number;
}

/**
 * The band, and **the only place clip-duration arithmetic happens**.
 *
 * `normalizeClipSpeed` is called here and nowhere else in this module, which is
 * what makes "normalize exactly once, before any duration arithmetic" a
 * property of the code rather than a convention. It matters: the request schema
 * accepts unbounded speed (`models/schema.ts:126`) while the renderer clamps to
 * 0.5–2.0 (`combine.ts:158`), so a raw `10` would demand five times too much
 * source and a raw `-1` would ask for a negative-length clip.
 *
 * The lower bound mirrors `combine.ts:167` exactly: `sourceClipDuration =
 * maxClipDuration * normalizedClipSpeed`. A clip shorter than that cannot fill
 * its window.
 *
 * The upper bound is the correctness half. The judge reads a description of the
 * whole clip — the proxy covers up to `proxy_max_seconds` (`describe.ts:236`)
 * and the description narrates how the shot changes across its duration — while
 * the renderer shows only the first `min` seconds from source zero
 * (`combine.ts:186`). Bounding the total duration keeps the judged footage and
 * the rendered footage approximately the same footage. Measured on the live
 * library (1,516 clips): a 5s slot at ratio 4 retains 1,060 of them.
 *
 * A ratio below the speed would invert the band. Rather than return an empty
 * window, the ratio is raised to the speed, which reads as "you must tolerate
 * at least as much source as you consume".
 */
export function durationBand(
  slotSeconds: number,
  rawSpeed: unknown,
  ratio: number = SCENE_FOOTAGE_DEFAULTS.duration_ratio,
): DurationBand {
  const speed = normalizeClipSpeed(rawSpeed);
  const slot = Number.isFinite(slotSeconds) && slotSeconds > 0 ? slotSeconds : DEFAULT_SLOT_SECONDS;
  const safeRatio = Number.isFinite(ratio) && ratio >= 1 ? ratio : SCENE_FOOTAGE_DEFAULTS.duration_ratio;

  const min = slot * speed;
  return { min, max: slot * Math.max(safeRatio, speed), speed };
}

/** A single Qdrant filter clause, derived from the client's own filter type. */
type FilterCondition = Extract<NonNullable<FootageFilter["must"]>, readonly unknown[]>[number];

/**
 * The Qdrant filter for one scene's retrieval.
 *
 * The aspect clause carries `aspectOrientation(videoAspect)`, never the request
 * value: verified against the live collection, `aspect = "9:16"` matches zero
 * points while `aspect = "portrait"` matches 756 of 1,512. Square is left
 * unfiltered, mirroring both the provider path (`search.ts:80`) and
 * `compare.ts:197`; the consequence — a square render can receive portrait
 * footage, which `buildFitFilter` pads (`clip.ts:58`) — is today's behaviour
 * for square and is accepted in §7.5.
 */
export function sceneFilter(videoAspect: VideoAspectValue, band: DurationBand): FootageFilter | undefined {
  const must: FilterCondition[] = [];

  if (videoAspect !== VideoAspect.square) {
    must.push({ key: "aspect", match: { value: aspectOrientation(videoAspect) } });
  }

  if (band.min > 0 && Number.isFinite(band.min) && Number.isFinite(band.max)) {
    must.push({ key: "duration", range: { gte: band.min, lte: band.max } });
  }

  return must.length > 0 ? { must } : undefined;
}

// ---------------------------------------------------------------------------
// Shortlisting
// ---------------------------------------------------------------------------

/** One shortlist entry: a library hit that has been resolved and probed. */
export interface Candidate {
  /** Absolute path, proven to sit inside `cacheVideosDir()`. **The dedupe key.** */
  file: string;
  /** Basename as stored in the payload, kept for logs and provenance. */
  local_file: string;
  score: number;
  /** Probed duration, which is what the renderer will see. */
  duration: number;
  payload: FootagePayload;
}

export interface ShortlistOptions {
  slotSeconds: number;
  /** Raw request value; normalized inside `durationBand`, once. */
  speed: unknown;
  videoAspect: VideoAspectValue;
  /** Defaults to `scene_footage.shortlist_size`. */
  limit?: number;
  /** Defaults to `scene_footage.duration_ratio`. */
  durationRatio?: number;
  signal?: AbortSignal;
}

export interface ShortlistDeps {
  /**
   * Library search. The default is `searchFootage`, which is exactly
   * `embedSearchQuery` → `queryPoints`: the embedding half throws on a
   * configuration fault, the Qdrant half degrades to `[]`. Both behaviours are
   * relied on here — see `matchScenes`.
   */
  search?: (query: string, limit: number, filter?: FootageFilter) => Promise<FootageMatch[]>;
  /** Media probe. Injected so a test can answer without ffprobe. */
  probeFile?: (path: string) => Promise<MediaInfo>;
  /**
   * Resolves a payload's `local_file` to an absolute path, proving containment.
   * Defaults to `resolvePathWithinDirectory(cacheVideosDir(false), …)`.
   */
  resolveFile?: (localFile: string) => string;
  /**
   * Probe memo shared across a whole run. A 30-scene short shortlists 450
   * candidates and the same popular clip appears in many of them; without this,
   * each appearance costs another ffprobe process.
   */
  probeCache?: Map<string, MediaInfo | null>;
}

/**
 * Retrieves and validates one scene's shortlist, best first.
 *
 * Every candidate is resolved inside `cacheVideosDir()` with the realpath
 * containment check and probed before it can be chosen, so nothing that reaches
 * the judge is a path the render would refuse or a file that is not there.
 *
 * The probed duration is re-checked against the band's **floor only**. The two
 * bounds mean different things: the floor is a render-correctness bound (too
 * little source cannot fill the window) and must hold for the file as it is on
 * disk right now, while the ceiling is a judge-agreement bound tied to the
 * description, which was written from the file as it was indexed. Re-imposing
 * the ceiling on a probe would drop clips for a disagreement that says nothing
 * about whether the judge was misled.
 *
 * Note a probe proves metadata, not that any interval decodes (`probe.ts:60`).
 * Because rendering always starts at source zero, the residual exposure is a
 * clip that is shorter on screen than expected, not a black window.
 *
 * Throws only what `search` throws — an embedding/configuration fault, which
 * the run level turns into "no scene matching happened". Per-candidate
 * failures are dropped, never propagated.
 */
export async function shortlistFor(
  scene: Scene,
  options: ShortlistOptions,
  deps: ShortlistDeps = {},
): Promise<Candidate[]> {
  const text = scene.text.trim();
  // A silent scene has nothing to embed. `searchFootage` would reject it with
  // "a footage search needs a query", which at run level aborts the whole
  // match — for a scene that is simply a pause. Short-circuit instead.
  if (!text) return [];

  const band = durationBand(options.slotSeconds, options.speed, options.durationRatio);
  const limit = Math.max(1, Math.trunc(options.limit ?? SCENE_FOOTAGE_DEFAULTS.shortlist_size));

  const search = deps.search ?? searchFootage;
  const probeFile = deps.probeFile ?? ((path: string) => probe(path));
  const resolveFile =
    deps.resolveFile ?? ((localFile: string) => resolvePathWithinDirectory(cacheVideosDir(false), localFile));
  const probeCache = deps.probeCache;

  const matches = await search(text, limit, sceneFilter(options.videoAspect, band));

  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    if (options.signal?.aborted) break;

    const payload = match.payload;
    const localFile = String(payload?.local_file ?? "").trim();
    if (!payload || !localFile) continue;

    let file: string;
    try {
      file = resolveFile(localFile);
    } catch (error) {
      logger.debug(`scene match: ${scene.id} dropped ${localFile}: ${errorMessage(error)}`);
      continue;
    }

    // The same file twice in one shortlist would let the judge "choose" between
    // identical options and would waste a slot in a list of 15.
    if (seen.has(file)) continue;
    seen.add(file);

    let info: MediaInfo | null | undefined = probeCache?.get(file);
    if (info === undefined) {
      try {
        info = await probeFile(file);
      } catch (error) {
        info = null;
        logger.debug(`scene match: ${scene.id} could not probe ${localFile}: ${errorMessage(error)}`);
      }
      probeCache?.set(file, info);
    }

    if (!info || !info.hasVideo || !(info.duration > 0)) continue;
    if (info.duration + PROBE_TOLERANCE_SECONDS < band.min) continue;

    candidates.push({ file, local_file: localFile, score: match.score, duration: info.duration, payload });
  }

  return candidates;
}

/**
 * Slack allowed when comparing a probed duration to the band's floor.
 *
 * `probe()` prefers the container duration over the stream's (`probe.ts:68`),
 * and the two disagree by a frame or two on plenty of stock encodes. Dropping a
 * 4.98s clip from a 5.00s floor would cost a real candidate for a rounding
 * difference the renderer absorbs by simply producing a slightly shorter clip.
 */
const PROBE_TOLERANCE_SECONDS = 0.05;

// ---------------------------------------------------------------------------
// The judge
// ---------------------------------------------------------------------------

/**
 * `-1` is the documented way to say "nothing here fits".
 *
 * It needs no special case in validation: every index outside
 * `[0, shortlist.length)` degrades to `none`, and `-1` is simply the value the
 * prompt asks for so the model has an unambiguous, in-type way to decline. A
 * union of `number | "none"` was considered and rejected — `anyOf` in a
 * structured-output schema is the kind of thing a provider silently mangles,
 * and the failure would look like a wrong pick rather than a refusal.
 */
export const JUDGE_NONE = -1;

const judgeResponseSchema = z.object({
  picks: z
    .array(
      z.object({
        scene_id: z
          .string()
          .describe("The scene id, copied exactly as given. One entry per scene, no scene omitted."),
        choice: z
          .number()
          .int()
          .describe(
            "The number of the chosen clip for this scene, exactly as printed in its candidate list. " +
              "Use -1 when no candidate genuinely fits the narration — a wrong clip is worse than none.",
          ),
        reason: z
          .string()
          .describe("One short sentence saying why, naming what in the clip matches or fails the narration."),
      }),
    )
    .describe("Exactly one entry per scene given, in the same order."),
});

const JUDGE_SYSTEM_PROMPT = [
  "You are a video editor choosing B-roll for a narrated video.",
  "",
  "For each scene you are given the narration that will be spoken over it and a numbered list of",
  "candidate clips from a footage library, each described by someone who watched it.",
  "",
  "Choose the one clip that best supports what the narration is SAYING. A clip that is literally",
  "about the subject is good; a clip that carries the right feeling for the passage is also good.",
  "A clip that merely shares a keyword is not.",
  "",
  "Rules:",
  "- Answer for every scene you are given, exactly once each, using the scene id verbatim.",
  "- Only the first few seconds of a clip are shown on screen, from its beginning. Prefer clips whose",
  "  description holds from the very start over ones that only become relevant later.",
  "- Respect quality flags. A watermark, heavy blur or broken framing disqualifies a clip unless",
  "  nothing else fits at all.",
  "- Answer -1 rather than settling. An unrelated clip is worse for the video than no clip.",
].join("\n");

/** What the judge proposed for one scene, before assignment resolves collisions. */
export interface JudgeProposal {
  scene_id: string;
  /** Index into that scene's shortlist, or `null` for "none". */
  choice: number | null;
  reason: string;
}

export interface JudgeDeps {
  /** Pre-built model. Supplying it skips the settings and key lookup entirely. */
  model?: LanguageModel;
  /** Replaces the whole model call — the seam a no-network test passes through. */
  generate?: (request: {
    model: LanguageModel;
    system: string;
    prompt: string;
    signal?: AbortSignal;
  }) => Promise<z.infer<typeof judgeResponseSchema>>;
  signal?: AbortSignal;
}

/**
 * Judges one batch of scenes in a single structured call.
 *
 * Never throws for a model or transport failure: a batch that fails becomes
 * `none` for every scene in it, which routes those scenes to fallback. A render
 * must not fail because a judge was down. Cancellation is the one thing that
 * propagates.
 */
export async function judgeBatch(
  scenes: readonly Scene[],
  shortlists: ReadonlyMap<string, readonly Candidate[]>,
  deps: JudgeDeps = {},
): Promise<JudgeProposal[]> {
  // A scene with no surviving candidates cannot be judged, and including it
  // would invite the model to invent an index for an empty list.
  const judgeable = scenes.filter((scene) => (shortlists.get(scene.id)?.length ?? 0) > 0);
  const declined = (reason: string): JudgeProposal[] =>
    scenes.map((scene) => ({ scene_id: scene.id, choice: null, reason }));

  if (judgeable.length === 0) return declined("no candidates survived shortlisting");

  let model: LanguageModel;
  try {
    model = deps.model ?? resolveJudgeModel();
  } catch (error) {
    logger.warning(`scene match: judge unavailable, scenes fall back: ${errorMessage(error)}`);
    return declined(`judge unavailable: ${errorMessage(error)}`);
  }

  const generate = deps.generate ?? defaultJudgeGenerate;
  const prompt = buildJudgePrompt(judgeable, shortlists);

  let response: z.infer<typeof judgeResponseSchema>;
  try {
    response = await generate({ model, system: JUDGE_SYSTEM_PROMPT, prompt, signal: deps.signal });
  } catch (error) {
    if (isCancellation(error, deps.signal)) throw error;
    logger.warning(
      `scene match: judge batch failed (${errorName(error)}: ${errorMessage(error)}), ` +
        `${judgeable.length} scene(s) fall back`,
    );
    return declined(`judge call failed: ${errorMessage(error)}`);
  }

  return validateJudgeResponse(scenes, shortlists, response.picks);
}

/**
 * Reduces a raw model answer to exactly one proposal per input scene.
 *
 * Pure, exported, and the whole of review finding 5: **every** way a response
 * can be wrong degrades to `none`, never to a different scene's clip.
 *
 *  - a scene the model omitted → `none`;
 *  - a scene id answered **twice** → `none`, not the first answer. Two answers
 *    for one scene means the model lost track of the list, and picking one of
 *    them at random is exactly the "confidently wrong clip" this exists to
 *    prevent;
 *  - an id that was never in the batch → discarded, and it does not disturb the
 *    scenes that were;
 *  - an index outside that scene's own shortlist (`-1` included) → `none`.
 *
 * Indices are validated against **that scene's** shortlist length, never a
 * shared one: shortlists differ in length after probing drops candidates.
 */
export function validateJudgeResponse(
  scenes: readonly Scene[],
  shortlists: ReadonlyMap<string, readonly Candidate[]>,
  picks: ReadonlyArray<{ scene_id?: unknown; choice?: unknown; reason?: unknown }>,
): JudgeProposal[] {
  const wanted = new Set(scenes.map((scene) => scene.id));
  const byScene = new Map<string, { choice: unknown; reason: unknown }>();
  const duplicated = new Set<string>();
  let extras = 0;

  for (const pick of picks ?? []) {
    const id = String(pick?.scene_id ?? "").trim();
    if (!wanted.has(id)) {
      extras++;
      continue;
    }
    if (byScene.has(id)) {
      duplicated.add(id);
      continue;
    }
    byScene.set(id, { choice: pick?.choice, reason: pick?.reason });
  }

  if (extras > 0) logger.warning(`scene match: judge returned ${extras} answer(s) for unknown scenes, ignored`);
  if (duplicated.size > 0) {
    logger.warning(`scene match: judge answered twice for ${[...duplicated].join(", ")}, degraded to none`);
  }

  return scenes.map((scene) => {
    const answer = byScene.get(scene.id);
    const reason = typeof answer?.reason === "string" ? answer.reason.trim() : "";
    const size = shortlists.get(scene.id)?.length ?? 0;

    // A scene with an empty shortlist was never put to the judge (`judgeBatch`
    // withholds it rather than invite an index into an empty list), so it must
    // not be logged as an omission the judge is answerable for.
    if (size === 0) return { scene_id: scene.id, choice: null, reason: "no candidates survived shortlisting" };

    if (!answer) return { scene_id: scene.id, choice: null, reason: "judge omitted this scene" };
    if (duplicated.has(scene.id)) {
      return { scene_id: scene.id, choice: null, reason: "judge answered this scene more than once" };
    }

    const raw = typeof answer.choice === "number" ? answer.choice : Number(answer.choice);
    const choice = Number.isInteger(raw) ? raw : NaN;

    // A deliberate refusal and a malformed answer both become `none`, but they
    // are different events and the log should not conflate them: the first is
    // the judge working as asked, the second is a response nobody should trust.
    if (choice === JUDGE_NONE) {
      return { scene_id: scene.id, choice: null, reason: reason || "judge found nothing suitable" };
    }

    if (!Number.isInteger(choice) || choice < 0 || choice >= size) {
      const detail = `judge returned an invalid choice (${String(answer.choice)}, shortlist has ${size})`;
      return { scene_id: scene.id, choice: null, reason: reason ? `${detail}; it said: ${reason}` : detail };
    }

    return { scene_id: scene.id, choice, reason };
  });
}

/**
 * Renders the batch as one prompt.
 *
 * Exported because the layout is the prompt, and a change to it is a change to
 * the feature's behaviour that a test should be able to read.
 *
 * `quality_flags` is printed alongside the semantic fields even though it is
 * excluded from the embedding text (`types.ts:184`) — deliberately, and it is
 * the fix for §7.6. Retrieval should not push watermarked clips apart in vector
 * space, but a judge choosing between fifteen plausible options absolutely
 * needs to know which of them carries a watermark.
 */
export function buildJudgePrompt(
  scenes: readonly Scene[],
  shortlists: ReadonlyMap<string, readonly Candidate[]>,
): string {
  const blocks = scenes.map((scene) => {
    const candidates = shortlists.get(scene.id) ?? [];
    const lines = candidates.map((candidate, index) => {
      const p = candidate.payload;
      const fields = [
        `  [${index}] ${oneLine(p.summary)}`,
        `      detail: ${oneLine(p.detailed_description)}`,
        `      use cases: ${list(p.use_cases)}`,
        `      tags: ${list(p.tags)}`,
        `      mood: ${list(p.mood)}`,
        `      quality flags: ${p.quality_flags?.length ? list(p.quality_flags) : "none"}`,
      ];
      return fields.join("\n");
    });

    return [`SCENE ${scene.id}`, `narration: ${oneLine(scene.text)}`, "candidates:", ...lines].join("\n");
  });

  return [
    `Choose one clip for each of the ${scenes.length} scene(s) below.`,
    "",
    blocks.join("\n\n"),
    "",
    "Return one entry per scene, using the scene id exactly as written above and the candidate number in",
    "square brackets, or -1 for none.",
  ].join("\n");
}

function oneLine(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function list(values: readonly string[] | undefined): string {
  const cleaned = (values ?? []).map((value) => oneLine(value)).filter(Boolean);
  return cleaned.length > 0 ? cleaned.join(", ") : "none";
}

/** Default generator: one `generateObject` call against the batch schema. */
async function defaultJudgeGenerate(request: {
  model: LanguageModel;
  system: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<z.infer<typeof judgeResponseSchema>> {
  const { object } = await generateObject({
    model: request.model,
    schema: judgeResponseSchema,
    system: request.system,
    prompt: request.prompt,
    ...(request.signal ? { abortSignal: request.signal } : {}),
  });
  return object;
}

/** Builds the configured judge model. Throws when the key or model is missing. */
export function resolveJudgeModel(modelId?: string): LanguageModel {
  let apiKey = "";
  try {
    apiKey = String(getSettings().app.gemini_api_key ?? "").trim();
  } catch {
    apiKey = "";
  }
  if (!apiKey) throw new Error("app.gemini_api_key is not set; configure it in Settings");

  const id = (modelId ?? sceneFootageOptions().judge_model).trim();
  if (!id) throw new Error("scene_footage.judge_model is not set");

  return createGoogleGenerativeAI({ apiKey })(id);
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/** One scene's proposal, paired with the shortlist the indices refer to. */
export interface SceneProposal {
  scene: Scene;
  candidates: readonly Candidate[];
  /** Index into `candidates`, or `null` for none. */
  choice: number | null;
  reason: string;
}

/** What one scene ended up with. */
export interface Assignment {
  scene_id: string;
  /** Absolute path, or `null` when the scene contributes no clip. */
  file: string | null;
  /** Basename, for logs. `null` when unmatched. */
  local_file: string | null;
  /** The judge's one-line reason, or why it was overridden. */
  reason: string;
  /** True when the judge's own pick was already taken and a substitute was used. */
  substituted: boolean;
}

/**
 * Resolves every proposal into a final list, one sequential pass.
 *
 * Batches propose concurrently; this disposes serially, which is what makes it
 * impossible for two concurrent batches to double-book a clip.
 *
 * **Deduplication is by resolved `local_file` — the absolute, realpath-resolved
 * `Candidate.file` — and never by candidate index.** Indices are per-scene:
 * two scenes both answering `0` normally mean two different clips, and the same
 * clip is index 0 for one scene and index 3 for another. Deduping on the index
 * would both reject clips that were never taken and admit the same clip twice.
 *
 * A scene whose pick is taken falls **forward** to its next shortlist entry,
 * then to `none`. Forward only: the entries before the judged one are the
 * higher-scoring candidates the judge looked at and passed over, so walking
 * back would override a decision it actually made. This substitution is safe
 * only because v3 dropped `source_start` — a substitute needs no judged start,
 * just the clip.
 */
export function assign(proposals: readonly SceneProposal[]): Assignment[] {
  const taken = new Set<string>();

  return proposals.map((proposal) => {
    const { scene, candidates, choice } = proposal;
    const none = (reason: string): Assignment => ({
      scene_id: scene.id,
      file: null,
      local_file: null,
      reason,
      substituted: false,
    });

    if (choice === null || !Number.isInteger(choice) || choice < 0 || choice >= candidates.length) {
      return none(proposal.reason || "no clip chosen");
    }

    for (let index = choice; index < candidates.length; index++) {
      const candidate = candidates[index];
      if (!candidate || taken.has(candidate.file)) continue;

      taken.add(candidate.file);
      return {
        scene_id: scene.id,
        file: candidate.file,
        local_file: candidate.local_file,
        reason: proposal.reason,
        substituted: index !== choice,
      };
    }

    return none(
      proposal.reason
        ? `${proposal.reason} (chosen clip and every later candidate already used)`
        : "chosen clip and every later candidate already used",
    );
  });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface MatchScenesInput {
  /** `ttsCues` for a short, `narration.cues` for a book. Never the SRT — §3.1. */
  cues: readonly SceneCue[];
  /** `video_clip_duration`, i.e. how long one clip is on screen. */
  slotSeconds: number;
  /** Raw `video_clip_speed` from the request; normalized once, downstream. */
  speed?: unknown;
  videoAspect: VideoAspectValue;
  /** Overrides for the settings group, for a CLI run or a test. */
  options?: Partial<SceneFootageOptions>;
  signal?: AbortSignal;
}

export interface MatchScenesResult {
  /** Absolute clip paths in narrative order. Empty means "nothing matched". */
  ordered: string[];
  /** Scene ids that got no clip; §3.5's fallback operates on these. */
  unmatched: string[];
  /** The scenes as built, so a caller can map an id back to its narration. */
  scenes: Scene[];
  /** Per-scene outcome including the judge's reason, for the task log. */
  assignments: Assignment[];
  /** Set when the run did not happen at all; the caller runs today's path. */
  skipped?: string;
}

export interface MatchDeps extends ShortlistDeps, JudgeDeps {
  /** Qdrant reachability preflight. Defaults to `isAvailable`. */
  available?: () => Promise<boolean>;
  /** Judge seam at batch granularity, for tests that skip the model entirely. */
  judge?: typeof judgeBatch;
}

/**
 * The whole run: scenes → shortlists → judge → assignment → ordered list.
 *
 * **Never throws**, except for cancellation. Every other failure returns a
 * result whose `skipped` says why and whose `ordered` is empty, which the
 * caller reads as "scene matching did not happen" and answers by running
 * exactly today's path.
 *
 * `scene_footage.enabled` is deliberately **not** checked here. The flag gates
 * whether a render calls this at all (S3), and re-checking it inside would make
 * the engine untestable and unusable from a CLI without flipping a global.
 *
 * Ordering of the two guards matters. Scenes are built first, because "there
 * are no cues" is a cheaper and more common answer than anything Qdrant knows.
 * The availability preflight comes next and before any search: `queryPoints`
 * turns every failure into `[]` (`qdrant.ts:461`), so an outage without this
 * check looks exactly like an empty gallery and would push every scene into a
 * provider fetch instead of into the untouched original path.
 */
export async function matchScenes(input: MatchScenesInput, deps: MatchDeps = {}): Promise<MatchScenesResult> {
  const startedAt = Date.now();
  const options = { ...sceneFootageOptions(), ...(input.options ?? {}) };
  const signal = input.signal ?? deps.signal;

  const scenes = buildScenes(input.cues ?? [], input.slotSeconds);
  const empty = (skipped: string): MatchScenesResult => ({
    ordered: [],
    unmatched: scenes.map((scene) => scene.id),
    scenes,
    assignments: [],
    skipped,
  });

  if (scenes.length === 0) return empty("no narration cues, scene matching skipped");

  try {
    const available = deps.available ?? isAvailable;
    if (!(await available())) return empty("qdrant is unavailable, scene matching skipped");

    // Every abort checkpoint below *throws* rather than returning a degraded
    // result. A cancelled task must not be handed an empty match and carry on
    // into a provider fetch — the outer catch recognises this and rethrows it.
    signal?.throwIfAborted();

    const band = durationBand(input.slotSeconds, input.speed, options.duration_ratio);
    logger.info(
      `scene match: ${scenes.length} scene(s), candidate duration ${band.min.toFixed(2)}-${band.max.toFixed(2)}s ` +
        `(slot ${input.slotSeconds}s at ${band.speed.toFixed(2)}x, ratio ${options.duration_ratio})`,
    );

    // A ratio below the playback speed asks for a band that ends before it
    // begins. `durationBand` refuses to invert it, which collapses the window
    // to a single duration and quietly matches almost nothing — so it is said
    // out loud here, once per run, rather than left to look like an empty
    // gallery. The schema's floor is 1, so this is reachable at speed > 1.
    if (options.duration_ratio < band.speed) {
      logger.warning(
        `scene match: scene_footage.duration_ratio (${options.duration_ratio}) is below the clip speed ` +
          `(${band.speed.toFixed(2)}x), so the duration band collapses to ${band.min.toFixed(2)}s and will match ` +
          `almost nothing; raise it to at least the speed`,
      );
    }

    // One probe memo for the whole run: popular clips recur across shortlists,
    // and each recurrence would otherwise spawn another ffprobe.
    const probeCache = deps.probeCache ?? new Map<string, MediaInfo | null>();
    const shortlists = new Map<string, Candidate[]>();

    // A shortlist failure is a configuration fault (`searchFootage` throws for a
    // missing key or a bad embedding model), not a property of one scene, so it
    // is allowed to escape the pool and abort the run rather than repeat itself
    // thirty times over.
    await pool(scenes, options.concurrency, async (scene) => {
      if (signal?.aborted) return;
      const candidates = await shortlistFor(
        scene,
        {
          slotSeconds: input.slotSeconds,
          speed: input.speed,
          videoAspect: input.videoAspect,
          limit: options.shortlist_size,
          durationRatio: options.duration_ratio,
          ...(signal ? { signal } : {}),
        },
        { ...deps, probeCache },
      );
      shortlists.set(scene.id, candidates);
    });

    signal?.throwIfAborted();

    const withCandidates = scenes.filter((scene) => (shortlists.get(scene.id)?.length ?? 0) > 0).length;
    logger.info(`scene match: ${withCandidates}/${scenes.length} scene(s) have candidates`);

    const judge = deps.judge ?? judgeBatch;
    const batches = chunk(scenes, options.judge_batch);
    const proposals = new Map<string, JudgeProposal>();

    await pool(batches, options.concurrency, async (batch) => {
      if (signal?.aborted) return;
      // `judgeBatch` already degrades a failed call to `none` for its scenes;
      // this catch covers anything it could not, so one bad batch can never
      // take down a render.
      let answers: JudgeProposal[];
      try {
        answers = await judge(batch, shortlists, { ...deps, ...(signal ? { signal } : {}) });
      } catch (error) {
        if (isCancellation(error, signal)) throw error;
        logger.warning(`scene match: judge batch raised, ${batch.length} scene(s) fall back: ${errorMessage(error)}`);
        answers = batch.map((scene) => ({ scene_id: scene.id, choice: null, reason: errorMessage(error) }));
      }
      for (const answer of answers) proposals.set(answer.scene_id, answer);
    });

    signal?.throwIfAborted();

    const assignments = assign(
      scenes.map((scene) => {
        const proposal = proposals.get(scene.id);
        return {
          scene,
          candidates: shortlists.get(scene.id) ?? [],
          choice: proposal?.choice ?? null,
          reason: proposal?.reason ?? "scene was never judged",
        };
      }),
    );

    const ordered = assignments
      .map((assignment) => assignment.file)
      .filter((file): file is string => typeof file === "string" && file.length > 0);
    const unmatched = assignments.filter((a) => a.file === null).map((a) => a.scene_id);

    logger.info(
      `scene match: ${ordered.length}/${scenes.length} scene(s) matched, ${unmatched.length} unmatched ` +
        `in ${Date.now() - startedAt}ms`,
    );

    return { ordered, unmatched, scenes, assignments };
  } catch (error) {
    // Cancellation is the one thing that must not be turned into a degraded
    // result: an aborted task would otherwise carry on into a provider fetch.
    if (isCancellation(error, signal)) throw error;
    logger.warning(`scene match: skipped after ${errorName(error)}: ${errorMessage(error)}`);
    return empty(`scene matching failed: ${errorMessage(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * Whether a thrown value means "the caller went away".
 *
 * Checked both ways because the two signals disagree in practice: an aborted
 * signal is authoritative even when a library has already reshaped the
 * rejection into something unrecognisable, while a bare `AbortError` can arrive
 * from a signal this module was never handed. In Bun an aborted signal throws a
 * `DOMException` named `AbortError`, which *is* an `Error` — verified, because
 * an `instanceof` that quietly returned false here would swallow every
 * cancellation.
 *
 * Deliberately narrow. A timeout, a rate limit and a transport error are **not**
 * cancellations: widening this would start rethrowing ordinary failures into a
 * render, which is precisely what this module exists not to do.
 */
export function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

/** Fixed-size worker pool over an array, mirroring `index.ts:760`. */
async function pool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const size = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length));
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  });
  await Promise.all(runners);
}

/** Splits into fixed-size groups, preserving order. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.trunc(size) || 1);
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += step) {
    groups.push(items.slice(index, index + step));
  }
  return groups;
}
