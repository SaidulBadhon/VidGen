# Semantic material selection

Status: draft v2 — v1 reviewed by Codex, which found 14 defects including 5 critical.
v2 is materially different: the feature is **not** a search call bolted onto the existing
loop, it is a restructuring of selection orchestration.
Date: 2026-08-30
Depends on: `footage-library-qdrant.md` (shipped — 1,512 clips indexed)

## 1. Problem

The footage library knows what every clip contains. Selection does not use it.
`downloadVideos` takes LLM keyword terms, asks a provider, downloads what comes back. Every
clip already on disk — described, embedded, searchable — is invisible to it.

## 2. What v1 got wrong

Recorded because each error changes the design, not just the prose.

1. **`downloadVideos` never sees the script.** It receives `searchTerms` only
   (`download.ts:223`) — eight ordered 1-3 word terms from the LLM
   (`llm/prompts.ts:126,153`). v1's "use the script sentence as the query" is impossible at
   this seam.
2. **`match_materials_to_script` is not unrelated.** It changes term count, disables
   reranking, selects a different download algorithm and forces sequential concat
   (`pipeline.ts:251,266,375,513`). And `downloadVideosByScriptOrder` (`:340`, not `:225`)
   round-robins several clips per term — it is not "one clip per sentence".
3. **The injection seam is private.** `searchVideos` is bound inside `downloadVideos`
   (`:250,254`); it is not part of `DownloadVideosOptions`, and no test invokes the helper.
4. **Prepending cannot produce local-first.** Bulk mode shuffles the whole candidate list in
   the default random mode (`:267,288`), erasing order — and provider searches happen while
   *building* candidates (`:271`), before the duration stop, so quota is spent even when
   local footage would have covered the render.
5. **`MaterialInfo.url` is the dedupe identity** (`:275`, `:364`). Local clips with the
   schema default `url: ""` would collapse to a single entry.
6. **The auto-index feedback loop does not exist.** `noteDownloadedMaterial` writes
   provenance only, at `describe_version: 0` with no Qdrant upsert (`hook.ts:211`). Clips
   become searchable on a later `footage index` pass, not "with every render".
7. **The query-asymmetry argument was backwards.** Documents embed with
   `RETRIEVAL_DOCUMENT`, queries bare with `RETRIEVAL_QUERY`, and `types.ts:174` states
   that this is *exactly* what absorbs the labelled-document/bare-query difference; a test
   freezes it (`footage-embed.test.ts:172`). Wrapping a term in "footage for a video about"
   dilutes the subject and invalidates any threshold measured on bare queries.

## 3. Design

### 3.1 Two phases, not a prepend

Because provider searches happen during candidate construction, local-first requires
splitting `downloadVideos` into two explicit phases:

**Phase A — local selection.** For every term, query the library. Collect accepted matches
across all terms, applying the diversity rules in §3.3. Compute `coveredDuration` using the
**same accounting the download loop uses** — `min(clipDuration, maxClipDuration)`
(`:314`, `:411`) — not the informational `foundDuration` sum at `:269`.

**Phase B — provider top-up, for the global deficit only.** If
`coveredDuration >= audioDuration`, **no provider call is made at all**. Otherwise the
existing path runs unchanged for the shortfall.

This is the change that actually saves quota, and it is why this is render-path surgery
rather than a hook.

### 3.2 Local results are a separate list, not fake `MaterialInfo`s

Local clips never enter `searchWithCache` (its serialiser keeps only provider/url/duration/
source_info — `cache.ts:33,42` — so `local_path`, score and selection metadata cannot
survive a round trip), and never rely on `url` for identity.

`MaterialInfo` gains a discriminated origin:

```ts
origin?: "provider" | "library";   // absent = provider, so every existing caller is unchanged
local_file?: string;               // basename only, never an absolute path
score?: number;
```

**Dedupe key** becomes `origin === "library" ? local_file : url`, at both loops
(`:275`, `:364`). Asset-level dedupe uses **`(provider, asset_id)`** — bare `asset_id`
conflates unrelated assets across Pexels/Pixabay/Coverr.

### 3.3 Query, filter, diversity

- **Query the term bare**, via `embedSearchQuery`. No wrapping (§2.7).
- **Aspect**: filter on `aspectOrientation(videoAspect)` — the payload stores
  `landscape`/`portrait`/`square` (`index.ts:319`) while requests carry `16:9`/`9:16`/`1:1`
  (`models/schema.ts:40`). Passing the request value matches **nothing**. For square,
  mirror the provider path, which deliberately accepts every orientation (`search.ts:80`),
  rather than filtering to `square` and excluding most of the library.
- **Duration**: filter `duration >= minimumDuration` in the Qdrant payload filter.
- **Diversity**: per-render reuse ban on `local_file`; per-term cap; `(provider, asset_id)`
  dedupe.
- **Availability**: call the cached 3-second `isAvailable()` probe **once before** the term
  loop (`qdrant.ts:575`). Without it, a hung Qdrant costs a 30-second timeout and a warning
  *per term* (`qdrant.ts:57,466`).
- **Cancellation**: `searchFootage` takes no `AbortSignal` (`index.ts:1067`). Either thread
  one through or check the signal between terms — a blanket catch must not swallow an
  aborted task and continue into provider work.

### 3.4 The local path must be validated, not trusted

`saveVideo` stats, probes, re-downloads invalid files and publishes atomically
(`:157`, `:181`). Short-circuiting it discards all of that. A library clip is used only
after: resolving `local_file` **inside `cacheVideosDir`** with the repo's realpath/
containment check (`utils/fileSecurity.ts:24`), confirming it is a regular file, and
**probing it** — the indexed duration reflects an earlier probe and the file may have been
replaced or damaged since. A clip failing any check is dropped and the deficit grows, which
Phase B then covers.

Not doing this is how the design silently degrades into a render that loops a tiny subset:
`combine.ts:173,247,254` probes again, skips unreadable sources, catches per-clip failures
and loops whatever survived — succeeding while showing the same three clips.

### 3.5 Provenance needs real schema changes

`materialSourceRecord` is an allow-list with no `selection` or `score` (`download.ts:31`),
so passthrough via `source_info` does not survive. Both the allow-list and `MaterialInfo`
gain explicit fields. `source_info.search_term` records **the semantic query that selected
the clip**, not a historical provider term — the library's `search_terms` array is
history, and conflating them would also mark the row `stale` for no reason
(`hook.ts:183`). Original provider/`asset_id`/`source_page`/`creator` are carried through
from the payload: these are Pexels clips under Pexels terms however they were chosen.

### 3.6 Rollout, and the book-pool trap

Ships **disabled** behind a new `semantic_selection` settings section — which does not
exist today and must be added across server schema, `SECRET_FIELDS` (n/a here), the web
`Settings` type (`client.ts:51`) and defaults, in one change.

**The book footage pool bypasses all of it.** `book/footage.ts:218` calls bulk
`downloadVideos`, but its persistent manifest key contains only sorted terms, source and
aspect (`:174`), and a match returns *before* `downloadVideos` is reached (`:203`). Without
a **semantic-selection config digest in that key**, enabling the feature — or changing
`min_score`, `max_per_term`, or the algorithm — keeps serving the old provider-only pool
forever, and the flag will look like it does nothing.

`footage compare "<subject>"` prints the two selections side by side (keyword-only vs
local-first) with scores and summaries. No render; the selection diff is the question.

## 4. Failure modes

| Failure | Handling |
|---|---|
| Qdrant down/hung | One cached `isAvailable()` probe before the loop; fall through to today's path. **A render never fails because a vector DB is down.** |
| Embedding fails | Same. |
| Library thin for a term | `min_score` drops it; Phase B covers the deficit. Expected. |
| Library clip missing/damaged | Containment check + probe; drop and grow the deficit. |
| Near-duplicates | `(provider, asset_id)` dedupe + per-term cap + per-render reuse ban. |
| Task cancelled mid-selection | Signal checked between terms; abort is not swallowed. |
| Stale book pool | Config digest in the manifest key. |

## 5. Explicitly not doing

- **Not changing `match_materials_to_script`** — but explicitly composing with *both* of its
  values, and tested both ways.
- **Not re-ranking provider results** with embeddings.
- **Not claiming a per-render feedback loop.** New clips become searchable when
  `footage index` next runs; that stays a separate step.
- **Not fixing** `video_clip_speed` never reaching the downloader (`pipeline.ts:527`,
  `clip.ts:125`), so requested duration and rendered duration already disagree. Pre-existing;
  noted because it compounds any duration arithmetic here.

## 6. Open decisions

1. **`min_score`.** Measured on bare queries: strong 0.72-0.83, plausible 0.60-0.65,
   unrelated ~0.51. Must be set from a sweep over the real term list, not picked. Suggest
   starting at 0.62 and tuning with `footage compare`.
2. **Full-local renders.** If the library covers the whole duration, skip the provider
   entirely (cheapest, but the library stops growing), or always source a fraction remotely?
3. **Scope check.** §3.1 restructures `downloadVideos` — the function every render and every
   book pool depends on. Is that acceptable now, or should this ship first as
   `footage compare` only (read-only, zero render-path change) to measure selection quality
   before touching the pipeline?
