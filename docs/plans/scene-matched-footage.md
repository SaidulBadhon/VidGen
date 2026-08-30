# Scene-matched footage selection

Status: draft v4 — narrowed in v3, then three review findings fixed. v1 and v2 were reviewed by Codex (16 and 18
defects). Both failed on the same thing: this renderer cannot place footage at a timestamp,
and every attempt to make it do so grew into surgery on `combineVideos`, `still.ts` and
`concat.ts` at once.

v3 drops timed placement and keeps what the request actually wanted: **only relevant
footage, chosen per scene, in the order the narration goes.**
Date: 2026-08-30

## 1. Goal

Per scene, an LLM picks the best clip from the gallery, judged on that scene's narration.
Scenes with nothing suitable fall back to a provider search, and the clip is saved to the
gallery with provenance for later reuse.

The output is an **ordered clip list in narrative order**, consumed by the existing
sequential path. Ships behind `scene_footage.enabled`, **default off**; with the flag off,
nothing about today's behaviour changes.

## 2. What v3 gives up, and why

Being explicit, because it is the difference between the request and what ships.

**No exact timing.** Clips land in narrative order, but at the combiner's own cumulative
offsets (`combine.ts:245`), not at cue timestamps. Scene 3's clip appears third, not
necessarily at 11.9s.

**No `source_start`.** v2 had the judge choose which moment of a clip to use. It cannot:
the describer encodes only the opening of a clip (proxy capped at `proxy_max_seconds`,
`describe.ts:236`, and the prompt tells the model the view may be truncated, `:387`), and
descriptions carry no timestamps. An LLM asked for a timecode returns a hallucinated
number. Sequential rendering takes each clip from source 0 (`combine.ts:186`), which is
exactly the window the description is derived from — so judging is sound *because* we
render from the start.

**Nothing touches `combineVideos`, `still.ts` or `concat.ts`.** That is what makes this
shippable: `still.ts:308/421` unconditionally loops the footage bed, `concat.ts:44` can
only append and trim, and a short picture makes `-shortest` truncate the narration
(`generate.ts:586`). All three would have to change for timed placement. None of them are
touched here.

## 3. Design

### 3.1 Scenes come from cues in memory, not the written subtitle

- **Short video**: `ttsCues`, retained after synthesis (`pipeline.ts:286`, `:322`).
  **Not the SRT.** `generateSubtitle` returns `""` when captions are disabled
  (`subtitle/index.ts:39`), which would silently disable matching for a reason unrelated to
  it; and its correction pass rewrites transcript text back to the script
  (`subtitle/index.ts:67`, `correct.ts:60`, `:74`), so the file does not reflect what was
  spoken even with custom audio.
- **Book**: `narration.cues`, in memory before selection (`bookPipeline.ts:882` writes them,
  `:956` selects footage). Note these are approximate when TTS alignment fails
  (`longform.ts:298`, `:311`, `:327`) — good enough for ordering, which is all v3 needs.
- No cues at all → scene matching is skipped and today's path runs.

Adjacent cues merge until a span reaches `video_clip_duration`, so one scene wants one clip.
Scene ids are stable and carried through judging.

### 3.2 Retrieve

Per scene: `embedSearchQuery(sceneText)` → top `SHORTLIST_N` (default 15), filtered on a
duration **band**: `slotSeconds * speed <= duration <= slotSeconds * DURATION_RATIO`
(default 4).

The upper bound is not tidiness, it is correctness. The judge reads a description of the
**whole clip** — the proxy covers up to `proxy_max_seconds` (`describe.ts:236`) and the
description narrates how the shot changes over its duration (`types.ts:82`) — while
sequential rendering shows only `slot * speed` seconds from source zero
(`combine.ts:167`, `:186`). A 60-second clip whose description is dominated by something at
second 20 can render five seconds containing none of it. Bounding duration keeps the
judged footage and the rendered footage approximately the same footage.

Measured against the current library (1,516 clips, median 13.2s): a 5-second slot with
ratio 4 gives a 5-20s band retaining **1,060 clips, 70%** — ample shortlist depth. Ratio is
tunable; it trades candidate pool against judge/render agreement.

**This is a mitigation, not a cure** (see §7). A 20-second clip is still four times the
rendered window.

**Speed is normalized once**, with the same helper the renderer uses
(`normalizeClipSpeed`, `utils/misc.ts:34`), before any duration arithmetic. The request
schema accepts unbounded values (`models/schema.ts:126`) while the renderer clamps to
0.5–2.0 (`combine.ts:158`); using the raw value would demand five times too much source at
`10` and permit invalid ranges at `-1`.

**Aspect** filters on `aspectOrientation(videoAspect)`, except square, which is left
unfiltered to match the provider path (`search.ts:80`) and `compare.ts:197`. Note this
means square renders can receive portrait or landscape footage, which `buildFitFilter`
pads with black bars rather than cropping (`clip.ts:58`) — that is today's behaviour for
square, unchanged, not something v3 introduces.

Every candidate is resolved inside `cacheVideosDir` with the realpath containment check
(`utils/fileSecurity.ts:24`) and probed before it can be chosen. Note a probe proves
metadata, not that a given interval decodes: `probe()` prefers container duration over the
video stream's (`probe.ts:68`, `:71`). Because v3 always renders from source 0, the
exposure is a clip that is shorter on screen than expected, not a black or failed window.

### 3.3 Judge

Scenes are judged in batches of `JUDGE_BATCH` (default 8), one structured call per batch,
bounded concurrency. Each scene shows its narration and a numbered shortlist rendered as
`summary + detailed_description + use_cases + tags + mood`.

Per scene the model returns `scene_id`, `choice` (candidate index **or `none`**), and a
one-line reason for the task log. `none` is first-class: a wrong clip is worse than a
provider fetch.

Responses are validated for omitted scenes, duplicate scene ids, out-of-range indices and
extras. Anything invalid degrades to `none`.

### 3.4 One global assignment pass

Batches propose; a single sequential pass disposes, so concurrent batches can never
double-book. **Deduplication is by resolved `local_file`, never by candidate index** —
indices are per-scene, so two scenes both answering `0` usually mean different clips, and
the same clip can be index 0 for one scene and 3 for another.

A scene whose pick is taken falls to its next shortlist candidate, then to `none`. v3 can
do this safely precisely because it dropped `source_start`: a substitute needs no judged
start, only the clip.

### 3.5 Fallback, and saving to the gallery

Scenes at `none` are grouped into one provider search per distinct query.

**Provider results are judged before they are accepted.** Provider search filters only on
duration, orientation and rendition (`search.ts:220`, `:249`) — nothing looks at content —
so accepting them unjudged would abandon the relevance promise on exactly the path most
likely to be noisy. Candidates go through the same judge, using the provider's own metadata
(title/tags/source page) since they have no gallery description yet. A scene whose provider
candidates are all rejected simply contributes no clip.

Accepted results are appended at those scenes' positions in the ordered list.

Downloads use **`saveVideo`** (`download.ts:152`), which is already provider-agnostic and
stages its temp beside the destination because `material_directory` may be on another
filesystem (`:148`). No extraction from `pull.ts` is needed — v2 was wrong about that.
Provenance is written with `recordClipProvenance` (`provenance.ts:184`) with
provider-general arguments, not the Pexels-hardcoded call `pull.ts:809` makes. The
fallback keeps one dedupe set across all its searches, since the existing URL set is local
to a single `downloadVideos` call (`download.ts:267`).

**Being exact about the reuse loop:** the clip is used immediately and saved with
provenance, but becomes *searchable* only after a `footage index` pass, which nothing
schedules (`footageCli.ts:523` is operator-invoked). Shipping this feature includes
scheduling that pass; without it, "reusable next time" is aspirational. And if the
provenance write fails, `backfill-provenance` can only recover Pexels attribution
(`provenance.ts:17`, `:50`).

### 3.6 Handing the list to the renderer

The ordered list is passed as the material list with `videoConcatMode: sequential`, which
takes one window per material and preserves order (`combine.ts:204`;
`prioritizeUniqueSourceClips` is a no-op outside random mode, `:76`).

**This requires a real orchestration change, which v3 wrongly claimed it did not.**
`generateFinalVideos` derives sequential mode solely from `match_materials_to_script`
(`pipeline.ts:513`) and the book path hardcodes `"random"` (`footage.ts:265`), so an
ordered list is re-randomised by both. Both need to honour a scene-matched run — without
mutating `match_materials_to_script`, which is a different feature. This is a narrow,
flag-guarded change to two call sites, not the `combineVideos` surgery v2 required.

`video_source: "local"` **skips scene matching entirely** — those files are the user's own
and are not in the gallery, which indexes only `cache_videos` (`index.ts:292`); passing
`"local"` into provider resolution would silently select Pexels (`search.ts:447`).

`video_count > 1` is **allowed**. Outputs share footage but still differ: transitions and
slide direction are chosen per output (`transitions.ts:66`), and music is per-output
(`pipeline.ts:549`, `bgm.ts:274`). v2's blanket rejection was wrong on both counts.

## 4. Failure modes

| Failure | Handling |
|---|---|
| No cues | Skip matching; today's path runs. |
| Qdrant unreachable | **Explicit `isAvailable()` preflight before the run.** `queryPoints` swallows failures into `[]` (`qdrant.ts:461`, `:487`), so without a preflight an outage reads as "gallery has nothing" and triggers mass provider fallback instead of today's path. |
| Embedding fails | `searchFootage` throws before querying (`index.ts:1060`); caught at run level, falls through to today's path. Cancellation is rethrown, never swallowed. |
| Judge batch fails | Those scenes become `none` → fallback. A render never fails because a judge was down. |
| Invalid judge response | Validated per §3.3; degrades to `none`. |
| Candidate file missing/damaged | Dropped at shortlist time (§3.2). |
| Clip already taken | Global pass (§3.4), dedupe by `local_file`. |
| Fallback download fails | That scene contributes no clip; the list is shorter and the combiner covers the tail exactly as it does today. |
| Provenance write fails | Clip still renders; attribution recoverable only for Pexels. |

## 5. Cost

Per scene: one embedding + one Qdrant query. Per 8 scenes: one judge call. A 30-scene short
≈ 30 embeddings, 30 queries, 4 judge calls. A 360-scene book segment ≈ 360 embeddings, 360
queries, 45 judge calls — `embedSearchQuery` is one request per text (`embed.ts:164`), so
batching reduces judge calls only. `SHORTLIST_N` and `JUDGE_BATCH` are tunable.

## 6. Explicitly not doing

- **No timed placement, no `source_start`** (§2).
- **No changes to `combineVideos`, `still.ts`, `concat.ts`, or `match_materials_to_script`.**
- **No book pool restructuring.** Books get ordered relevance through the same path; the
  shared pool's inability to carry an assignment (`footage.ts:165`, `:175`, `:266`) does not
  block ordering.
- **No waveform analysis.** Matching is on narration text.
- **No behaviour change with the flag off.**

## 7. Known limitations, accepted

Documented rather than fixed, because each needs its own change:

1. **Judged content is only approximately rendered content.** The duration band (§3.2)
   narrows the gap; it does not close it. Closing it means describing clips per render
   window rather than per clip — a different indexing model and a re-describe of the
   library.
2. **No exact timing** (§2). Clips are ordered, not placed.
3. **Cue granularity can force false `none`s.** A TTS adapter without word boundaries emits
   one cue per sentence (`syntheticCues.ts:19`), so a 20-second sentence becomes a
   20-second scene that cannot be split, demanding source the renderer will not use. Books
   use a fixed `FOOTAGE_CLIP_SECONDS` (`book/footage.ts:41`) rather than a request field.
4. **`probe()` proves metadata, not decodability** (`probe.ts:60`). A corrupt candidate can
   pass the shortlist and fail in `renderClip`; if every clip fails, `combineVideos` throws
   rather than degrading (`combine.ts:277`).
5. **Square renders can receive non-square footage**, which `buildFitFilter` pads with black
   bars (`clip.ts:58`). Leaving square unfiltered matches `compare.ts:197` but **not** the
   Pexels path, which requests `orientation=square` and accepts only exact square renditions
   (`search.ts:191`, `:225`). This is a behaviour change for square renders.
6. **`quality_flags` is not yet in the judge prompt** (`types.ts:144`), though it carries
   watermarks, blur and broken framing.
7. **The reuse loop needs a scheduled `footage index`.** `indexAll` does not take its own
   lock (`index.ts:904`); only the CLI wraps it (`footageCli.ts:523`). A coalesced, locked
   background job is required, or concurrent renders schedule competing full-cache passes.

## 8. Open decisions

1. `SHORTLIST_N` (15) and `JUDGE_BATCH` (8) — set from a measured run.
2. Judge model — `gemini-3.7-flash`, or a lite model for cheap text reasoning.
3. Shorts and books together, or shorts first?
