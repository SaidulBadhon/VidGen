# Implementation plan — scene-matched footage

Companion to `scene-matched-footage.md` (v4). Strict file ownership; no two tasks in a wave
write the same file.

Settled: ordered relevance, no timed placement, no `source_start`. Behind
`scene_footage.enabled`, default off. Duration band `slot*speed .. slot*4`. Judge in
batches of 8 over shortlists of 15. Provider fallback is judged too.

Environment: app runs as a host bun process on :7778 against Mongo db `moneyprinterturbo`.
Qdrant live at 127.0.0.1:6333 with 1,516 indexed clips. Tests use **no mocks** — pure
functions and DI seams only, no network, no Mongo. Baseline: **1309 pass / 0 fail**, both
typechecks exit 0.

---

## S1 · Config
**Owns:** `server/src/config/schema.ts`, `server/src/config/settings.ts`, `.env.example`,
`web/src/api/client.ts`
**Depends on:** nothing

`scene_footage` group, every field defaulted, registered with `.default({})`, type exported,
web `Settings` extended: `enabled` (false), `shortlist_size` (15), `judge_batch` (8),
`judge_model` (`gemini-3.7-flash`), `duration_ratio` (4), `concurrency` (4),
`fallback_enabled` (true).

Follow the `qdrant` / `footage_index` groups added earlier as the template.

**Acceptance:** `bun run --cwd server typecheck` and `--cwd web typecheck` exit 0; a stored
settings document without the group parses and backfills.

## S2 · Scene matching engine
**Owns:** `server/src/services/footage/sceneMatch.ts` (new)
**Depends on:** S1

Pure-ish module, everything injectable. Exports:

- `buildScenes(cues, slotSeconds)` — merge adjacent cues until a span reaches the slot;
  stable ids; pure and unit-testable.
- `shortlistFor(scene, opts, deps)` — `embedSearchQuery` → `queryPoints` with the duration
  **band** (`slot*speed .. slot*ratio`) and aspect (square unfiltered). Resolve each
  `local_file` inside `cacheVideosDir` with the containment check
  (`utils/fileSecurity.ts`), probe it, drop what fails.
- `judgeBatch(scenes, shortlists, deps)` — one `generateObject` call per batch; per scene
  returns `scene_id`, `choice` (index or `none`), `reason`. Prompt includes
  `summary + detailed_description + use_cases + tags + mood + quality_flags`. Validate
  omissions, duplicate ids, out-of-range, extras → degrade to `none`.
- `assign(proposals)` — single sequential pass; **dedupe by resolved `local_file`, never by
  candidate index**; a taken clip falls to the next shortlist entry, then `none`.
- `matchScenes(...)` — orchestration returning `{ ordered: string[], unmatched: SceneId[] }`.

Rules that are defects if missed:
- **`normalizeClipSpeed` (`utils/misc.ts`) once**, before any duration arithmetic.
- **Explicit `isAvailable()` preflight** before the run: `queryPoints` swallows failures
  into `[]`, so without it a Qdrant outage reads as "gallery has nothing" and triggers mass
  provider fallback instead of today's path.
- Embedding failures throw from `searchFootage`; catch at run level, fall through to today's
  path, and **rethrow cancellation**.
- Never throw into the render path.

**Acceptance:** typecheck exit 0. Pure helpers unit-tested with no network. A live run
against real Qdrant on a handful of scenes returns sensible ordered picks.

## S3 · Pipeline wiring
**Owns:** `server/src/tasks/pipeline.ts`, `server/src/tasks/bookPipeline.ts`,
`server/src/services/book/footage.ts`
**Depends on:** S2

- **Short video**: scenes from `ttsCues` held in memory (`pipeline.ts:286`, `:322`) — **not**
  the SRT, which is `""` when captions are off and is corrected back to the script.
  When matching produces a list, pass it as the material list and make `generateFinalVideos`
  use sequential ordering for that run (`pipeline.ts:513` currently derives it only from
  `match_materials_to_script` — **do not mutate that flag**).
- **Book**: scenes from `narration.cues` (written at `bookPipeline.ts:882`, footage selected
  at `:956`). `buildSegmentFootage` hardcodes `"random"` (`book/footage.ts:265`) — honour
  ordering for a scene-matched run.
- **Skip matching entirely** when `video_source`/`footage_source` is `"local"`
  (`bookSchema.ts:267` permits it) — those files are not in the gallery, and `"local"`
  falls through to Pexels in `getProviderSearch`.
- Flag off → byte-identical behaviour to today.

**Acceptance:** `bun test --cwd server` stays at **1309 pass / 0 fail**; typecheck exit 0;
a real short-video render with the flag off is unchanged.

## S4 · Tests
**Owns:** `server/test/footage-scenematch.test.ts`
**Depends on:** S2, S3

No mocks, no network. Cover `buildScenes` (merging, stable ids, degenerate cues),
the duration band arithmetic including speed normalization, `assign` collision handling and
`local_file` dedupe, judge-response validation (omitted/duplicate/out-of-range/extra), and
the `"local"` skip.

**Acceptance:** suite ≥1309 pass, 0 fail.

---

## Risks
- **S3 is the blast radius** — it touches both render orchestrators. Flag-off equivalence is
  the hard gate.
- Judge latency at book scale (~45 calls/segment) is unmeasured.
- Known limitations in spec §7 are accepted, not solved.
