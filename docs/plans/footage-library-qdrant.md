# Semantic footage library (Qdrant)

Status: draft v3 — v1 reviewed by Codex (10 defects), v2 by three independent reviewers
(13 + 29 + 9 defects). v3 is a **simplification**: most defects are dissolved structurally
rather than patched.
Date: 2026-08-20

## 1. Problem

`storage/cache_videos` is a byproduct, not a library: 167 files / 3.4 GB named
`vid-<md5(url)>.mp4`, with nothing recording what is in them. There is no way to ask "do
we already have an empty hospital corridor?", the download URL is unrecoverable from the
filename (133 of 167 have task provenance, 25 more have live cache URLs, **9 have no
recoverable source**), and selection has no memory of footage already on disk.

## 2. What changed in v3, and why

v2 built an in-server background indexer with per-row leases, an `owner_id`, a
`generation` counter, tombstones, cross-database compare-and-write, and a hardened shared
`saveVideo`. Review demolished it. The three findings that forced a rewrite rather than a
patch:

**The deployment premise was false.** v2 assumed the CLI and the server share one Mongo.
They do not. The app runs as a **host `bun` process on :7778** (verified: PID 85146); the
`vidgen` app container does not exist, `vidgen-mongo` is **empty**, and the live data is
in `moneyprinterturbo` on a different container. `docker-compose.yml:26` also maps
`127.0.0.1:8080`, already held by `nano-vector`, so the compose `app` service cannot bind
today. v2's "the CLI writes rows, the server picks them up" would have silently done
nothing.

**The lease mechanism it copied cannot work here.** `isOwnerAlive()`
(`tasks/owner.ts:40-56`) returns `false` for the *current* process's own pid (`:45`) —
correct for its actual use, where it only ever runs at startup with nothing in flight, but
fatal for a long-lived worker: the sweep would reset rows its own live workers hold. And
it returns `true` unconditionally for a foreign hostname (`:44`), so any row leased by a
Ctrl-C'd host CLI is immortal to the container. There is also **no poller anywhere in the
repo** (`grep -rn setInterval server/src` → zero); `recoverInterruptedTasks()` has exactly
one caller, inside `bootstrap()` (`index.ts:97-98`). A queue with no consumer is inert.

**The AI SDK already does video.** v2 hand-rolled the Gemini Files API. Verified live
using the repo's own `@ai-sdk/google` + `ai` v5: `generateObject` with an inline
`{type:"file", mediaType:"video/mp4"}` part and a zod schema returned a valid object in
**2.9 s / 805 tokens**. The entire upload → poll → describe → delete → sweep → 20 GB-cap
apparatus is deleted.

The unifying simplification: **the filesystem is the work-list.** `footage index` means
"every file in `cache_videos` has a current point in Qdrant." That is idempotent and
crash-proof by construction, which removes leases, owners, generations, tombstones, the
in-server queue, and drain-on-shutdown in one move.

## 3. Approach

**(a) Qdrant** as a compose service, `qdrant/qdrant:v1.15.4` (already on this machine),
named volume, healthcheck, **publishing `127.0.0.1:6333`** — non-negotiable, because the
app and the CLI both run on the host.

**(b) Describe via a proxy.** Every clip is reduced by ffmpeg to a 360p / 2 fps / ≤60 s
proxy, then passed inline to `generateObject`. Measured: **201 MB → 2.0 MB in 2.9 s**, and
the description off that proxy correctly read "wheat swaying in strong breeze, pine trees,
partly cloudy sky". This gives one uniform path with a bounded request size, no Files API,
no size branching (44 of 167 clips exceed Gemini's ~20 MB inline limit), and fewer tokens.

**(c) Embed + upsert** — `embed()` with `google.textEmbeddingModel("gemini-embedding-001")`,
3072-d (verified L2-normalised), upserted with the full description as payload.

**(d) Two entry points** — a bulk-pull CLI, and an auto-index hook that is an
*optimisation*, not a durability mechanism.

### Measured cost model

792 video tokens for 12.012 s → **~66 tokens/sec** of footage; median clip 16.7 s, mean
20.4 s. At ~1,000 clips, well under 2 M tokens on a flash model. **API spend is not the
constraint.** Proxying cuts this further.

| Real constraint | Measured |
|---|---|
| Disk (host volume) | 116 GB free; clips mean 20.5 MB, median 11.9 MB, max 211 MB |
| Pexels quota | 25,000/mo, 24,894 left, resets 2026-09-10 — not a constraint |
| Docker VM | 8.3 GB RAM, 12 CPUs, already running 19 containers |
| Wall clock | ~6 s/clip (proxy + describe + embed); ~20 min for 1,200 at concurrency 8 |

## 4. Design

### 4.1 The filesystem is the work-list

`footage index` walks `cacheVideosDir()`, and for each `vid-*.mp4` checks Mongo for a row
at the current `describe_version` / `embed_version`. Missing or stale → proxy, describe,
embed, upsert, mark done.

- **Idempotent**: re-running is a no-op.
- **Crash-proof**: the file on disk is the durable record. A crash loses at most one
  clip's in-flight work.
- **No leases, no `owner_id`, no generation counter, no tombstones, no in-server queue,
  no shutdown drain.**

Mongo `footage_index` is a **cache of descriptions plus a failure record**, not a
work-list. Losing it costs Gemini spend, never correctness.

Concurrent runs are prevented by one lock document (`_id: "footage_index_lock"`, TTL +
heartbeat). `POST /api/v1/cache/clear` returns **409** while it is held — which is also
what removes v2's entire clear-versus-indexer resurrection race.

### 4.2 Identity

Point id = **uuidv5 of the `local_file` basename**. The file is the thing being indexed.
`provider` / `asset_id` / `rendition_id` ride in the payload for later dedup analysis.

v2 keyed on `provider:asset_id:rendition_id` to dedupe the same asset across renditions.
That bought little (two renditions are two files on disk) and cost tombstone-revival
semantics that reviewers showed would silently strand re-downloaded clips forever.

**`local_path` is never stored** — only `local_file`, resolved through `cacheVideosDir()`.
Storing an absolute path means a host-written index reads `/Users/…/storage/…` while a
container reads `/app/storage/…`, and a reconcile run from the wrong side would delete the
entire index. `download.ts:26-27` already established this rule: "only the local filename —
never a host path or Docker mount".

### 4.3 The pull touches no render-path code

This is what makes "not changing material selection" **true**, where v2 claimed it and
violated it twice.

- **Its own paginating Pexels search.** It constructs `page=N` itself — Pexels returns
  `next_page` with a doubled path (`/v1/v1/videos/search?…`) that **404s with an empty
  body**, which under `search.ts:124`'s unchecked `response.json()` would surface as the
  same silent `[]`. It **bypasses `searchWithCache`**, so the 24 h render cache is never
  written; `cacheKey` (`cache.ts:22-31`) has no `page` field, so paginating through it
  would overwrite page 1 with page 7 for the render path.
- **Its own downloader**: stream the body to a unique temp in `storage/temp/downloads/`,
  ffprobe it, then atomic-rename into `cache_videos`. Same filesystem, so no `EXDEV`.
  Temps live **outside** `cache_videos`, so the two unfiltered `readdirSync` walkers in
  `media.ts:196-231` cannot count or delete them.
- **No in-flight dedup map.** Unique temps mean two concurrent downloads of one URL both
  succeed and one rename wins with identical content — wasted bandwidth, never corruption.
  v2's shared promise would have shared one `AbortSignal` across tasks, so cancelling one
  render would abort a *different* render's downloads (`http.ts:52-61`, `queue.ts:110`).
- **`saveVideo()` and `searchVideosPexels()` are not modified.** Blast radius: zero.

Yield is better than v2 assumed — measured 15-20 accepted per 20-result page, not "far
below 20" — so one page usually suffices; the page cap is 3.

Budget: count **actual bytes written**, plus a free-disk floor checked before each
download. Overshoot is bounded by concurrency × max clip size. v2's "reserve from the
Pexels `size` field" was hollow: `size` is discarded by `search.ts:130`, absent from
`MaterialInfo` (`schema.ts:75-95`) and from `CachedMaterial` (`db/types.ts:142-156`), so
any warm-cache rerun would have reserved zero.

### 4.4 The hook is an optimisation, not a guarantee

At the two `MaterialInfo` call sites (`download.ts:191`, `:287`), guarded on
**`dirname(savedPath) === cacheVideosDir(false)`**. It must not test
`resolveMaterialDirectory()`, which returns `""` for the default case (`download.ts:100`)
— the live settings document has `material_directory: ""`, so a literal
`=== cacheVideosDir()` check would be false for **every normal download** and the hook
would never fire.

Fire-and-forget with a short timeout; never blocks, never throws into the caller, one flag
disables it. It records provenance the filename cannot carry (`search_term`, `asset_id`,
`source_page`, `creator`) via `$addToSet`. **If it fails or is skipped, nothing is lost** —
`footage index` still finds the file. v2 made this write synchronous *and* claimed it never
blocks; those cannot both hold, and with `serverSelectionTimeoutMS: 10_000`
(`db/client.ts:86`) a degraded Mongo would have added up to an hour to a 360-clip book pool.

### 4.7 Hardening `saveVideo()` (decided: folded into this change)

Two real pre-existing bugs, fixed here at the operator's direction. I advised doing this
as a separate change because it touches shared render-path code; that was overruled, so it
is designed defensively instead.

**Bug 1 — unvalidated cache hits.** `download.ts:70-73` returns any non-empty file without
probing it, so one truncated write poisons that URL forever and fails later, mid-render.

**Bug 2 — non-atomic write.** An unlocked `existsSync` check, then `Bun.write()` straight to
the *final* filename (`:84`). Two concurrent callers for one URL can have one writing while
another probes or unlinks.

Fixes, each chosen to keep blast radius minimal:

1. **Unique temp → validate → atomic rename.** Temp is created **in the destination
   directory** (`material_directory` may be any absolute path, `schema.ts:118`, so a temp
   elsewhere risks `EXDEV`), named `.vid-<hash>.<pid>.<rand>.part`. Unique names mean **no
   in-flight dedup map is needed**: two concurrent downloads of one URL both complete and
   one rename wins with identical bytes. This deliberately avoids a shared promise, which
   would share one `AbortSignal` (`http.ts:52-61`) and let a cancelled task
   (`queue.ts:110`) abort a *different* render's download.
2. **`media.ts` walkers get an extension filter.** `:196-206` (stats) and `:225-231`
   (clear) treat every regular file as a cache video. Without a filter they would count and
   `rm` in-progress temps out from under an active download.
3. **Validate on cache hit, memoised per process.** One ffprobe per unique clip per process
   lifetime. Bounded: a book pool is ~360 distinct clips (`book/footage.ts:39,:42`), so
   ~360 probes once, not per hit. Note the clear-everything decision (§9) means every file
   in the cache after this ships was written by the atomic path, so this guards only
   against *external* truncation (a `docker compose down` mid-write, a full disk).
4. **`probe()` gets a `timeoutMs`.** `probe.ts:49-55` passes none, and `ffmpeg.ts:57-62`
   only arms the kill timer when one is given — so a hung ffprobe on a corrupt file holds
   its slot forever, uninterruptible.
5. **Stream the body to the temp file** instead of `Bun.write(path, await
   response.arrayBuffer())` (`:84`), which buffers whole files. At concurrency 8 with the
   measured 211 MB max that is a multi-GB resident spike alongside an ffmpeg render.

**No invalid file is auto-deleted while a render may hold it.** A failed probe marks the
row `failed` and leaves the bytes in place; only an explicit cache-clear removes files.

### 4.5 Search terms stay fresh

`$addToSet` accumulates terms. The indexer re-reads them immediately before upsert, and a
term added to an already-indexed row marks it stale for a cheap payload-only re-upsert (no
re-describe, no re-embed).

### 4.6 Collection migration

The collection is addressed through the **alias `footage`** pointing at
`footage_v<embed_version>`, because vector width is fixed at creation. Changing model or
dimensionality is: create, backfill, swap alias, drop old.

## 5. Data model

```jsonc
// Qdrant payload. Indexes on aspect, provider, duration, has_people.
{
  "local_file": "vid-d6e9….mp4",
  "provider": "pexels", "asset_id": "6138311", "rendition_id": "9949168",
  "source_page": "…", "creator": { "id": "…", "name": "…", "profile_page": "…" },
  "search_terms": ["candlelight", "candle"],
  "duration": 12.012, "width": 1920, "height": 1080, "aspect": "landscape", "bytes": 698522,
  "summary": "…", "detailed_description": "…",
  "use_cases": ["…"], "mood": ["…"], "tags": ["…"],
  "setting": "indoor", "time_of_day": "night",
  "has_people": false, "has_on_screen_text": false,
  "camera_motion": "static", "quality_flags": ["low light"],
  "describe_model": "gemini-3.7-flash", "describe_version": 1,
  "embed_model": "gemini-embedding-001", "embed_version": 1,
  "indexed_at": "2026-08-20T…Z"
}
```

```ts
// Mongo footage_index — description cache + failure record, NOT a work-list.
interface FootageIndexDocument {
  _id: string;                 // uuidv5(local_file)
  local_file: string;          // indexed
  state: "indexed" | "failed";
  description?: ClipDescription | null;   // cached so a re-run never re-pays Gemini
  provider: string; search_terms: string[];
  asset_id?: string; rendition_id?: string;
  duration?: number; width?: number; height?: number; bytes?: number;
  describe_version: number; embed_version: number;
  attempts: number; last_attempt_at?: Date;
  errors?: { at: Date; message: string }[];   // history, not a scalar
  created_at: Date; updated_at: Date;
}

// footage_runs — without this, a clip never downloaded leaves no trace, and
// "term X is thin" is indistinguishable from "term X 429'd" or "budget hit".
interface FootageRunDocument {
  _id: string; started_at: Date; finished_at?: Date;
  stop_reason?: "complete" | "budget" | "disk" | "aborted" | "error";
  per_term: { term: string; aspect: string; attempted: number; accepted: number;
              rejected_resolution: number; last_status?: number }[];
  bytes_written: number; clips_added: number; clips_failed: number;
}
```

## 6. Surface

### Config — 8 steps

Following `whisper` (`schema.ts:145-165`): (1) sub-schema, every field defaulted;
(2) register with `.default({})` (`schema.ts:228-238`); (3) export the type (`:241`);
(4) `["qdrant","api_key"]` into `SECRET_FIELDS` (`:264-281`); (5) `ENV_BINDINGS`
(`settings.ts:47-68`) — the **first non-`app` bindings in the codebase**, so they ship
with a test; (6) `.env.example` + `MANAGED_VARS` (`test/config.test.ts:19-29`);
(7) `interface Settings` (`web/src/api/client.ts:51-60`); **(8) forward the vars in
`docker-compose.yml` `app.environment:`** — the image ships no `.env`
(`docker-compose.yml:38-39`), so a var documented only in `.env.example` never reaches the
container. Hardcode `QDRANT_URL: http://qdrant:6333` there exactly as `MONGODB_URI` is,
plus `depends_on: qdrant: {condition: service_healthy}`.

`GET/POST /api/v1/settings` needs no change (no per-section allow-list,
`settings.ts:28-38`).

### Dependencies and wiring

- Add a Qdrant client to `server/package.json` — none exists today.
- Register `footageRouter` in `index.ts` alongside `:63-69`, or `/api/v1/footage/*` falls
  through to the 404 at `:76-78`.

### CLI — its own entry point

`cli.ts` sets `allowPositionals: false` (`:144`) and requires a subject/script
(`:162-166`), so footage gets `server/src/footageCli.ts` + a `"footage"` script rather
than a risky rewrite of the working video CLI. (Verified that
`bun run --cwd server footage pull --per-term 4` delivers the subcommand through.)

```
bun run --cwd server footage pull       # download + index
bun run --cwd server footage index      # index whatever is on disk (also reconciles)
bun run --cwd server footage search     # semantic query — proves the index works
bun run --cwd server footage status     # per-run stats, failures, drift
```

### HTTP

`GET /api/v1/footage/stats`, `POST /api/v1/footage/search`, and `POST /api/v1/cache/clear`
extended to batch Mongo `bulkWrite` + batched Qdrant deletes (today it is a bare `rm` loop,
`media.ts:224-233`; 2,000 unbatched round trips in one unauthenticated request would take
~100 s).

## 7. Seed taxonomy

**126 terms**: 109 curated across 16 general B-roll categories, plus 17 real terms observed
in the DB and task artifacts. Junk from the keyword-fallback path ("already", "barely",
"footage-book") is excluded — that is a term-generation bug, **out of scope**. Checked in
as JSON so the list is reviewable. Both orientations are pulled.

| `--per-term` | clips (×2 orientations) | ≈ at 15 MB | ≈ at 20.5 MB |
|---|---|---|---|
| 3 | 756 | 11.3 GB | 15.5 GB |
| 4 | 1,008 | 15.1 GB | 20.7 GB |
| 6 | 1,512 | 22.7 GB | 31.0 GB |
| 8 | 2,016 | 30.2 GB | 41.3 GB |

## 8. Failure modes

| Failure | Handling |
|---|---|
| Crash mid-run | Filesystem is the work-list; re-run resumes. At most one clip's work lost. |
| Crash after describe | Description cached in Mongo; re-run skips straight to embed. |
| Two indexers | Single lock document; `/cache/clear` 409s while held. |
| Gemini 429 | Backoff, capped retries, then `failed` with error history. One clip never stalls a run. |
| Off-schema output | zod schema via `generateObject`; one retry, then `failed`. |
| Clip too large / corrupt | Proxy step bounds size and fails loudly; unreadable clips are `failed`, **left on disk, never auto-deleted** (deleting under a live render is how v2's sweep broke renders). |
| Qdrant down at render | Hook logs and drops. **A render never fails because a vector DB is down.** |
| Qdrant down at index | Run stops with a clear message; re-run resumes. |
| Partial download | Unique temp outside `cache_videos` + ffprobe + atomic rename. |
| Disk fills | Actual-bytes counter + free-disk floor before each download. |
| Point with no file | `footage index` reconciles both directions by construction. |
| Secrets in logs | `redactSecrets` (`utils/misc.ts:118`). |

## 9. Explicitly not doing

- **Not modifying `searchVideosPexels()`** — so its unchecked `response.ok`
  (`search.ts:124`) still turns a 429 into a silent `[]` on the render path. Filed
  separately; the pull uses its own paginating search, so nothing here depends on it.
- **Not changing material *selection*.** §4.7 changes how bytes reach disk, never which
  clips are chosen: no change to search, ordering, filtering, or the returned path on the
  success path.
- **Not preserving the 9 orphan clips.** Decided: clear everything. Accepted loss.
- **Not indexing** `local_videos`, task-directory copies, BGM, songs, book assets.
- **Not fixing** junk term generation, missing `kokoro` in the web `Settings` type, dead
  `analyzeClip`, or the fact that compose's `app` cannot bind 8080.
- **No new web UI** beyond cache-panel counts.

## 10. Decisions (settled)

1. **Library size: `--per-term 4`** — 126 terms × 2 orientations ≈ 1,008 clips, ~15-21 GB.
2. **Describe model: `gemini-3.7-flash`** — probed at 2.9 s inline, 4.5 s via proxy.
3. **Vector width: full 3072-d** — memory is negligible (~25 MB for 2,000 vectors), so
   truncation would only cost retrieval quality.
4. **The two `saveVideo` bugs: folded into this change** (§4.7) — operator's call, against
   my recommendation to split them out.
5. **Review: proceeding** on the three-reviewer pass; the Codex loop is incomplete
   (quota exhausted until 2026-08-27) and v3 has not been through Codex.
6. **Cache clear runs only when the task queue is idle**, since the server is live.
