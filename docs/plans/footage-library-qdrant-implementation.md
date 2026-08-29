# Implementation plan — semantic footage library

Companion to `footage-library-qdrant.md` (v3). Task-by-task, with strict file ownership:
**no two tasks in the same wave write the same file.**

Settled parameters: `--per-term 4` (~1,008 clips, ~15-21 GB) · describe with
`gemini-3.7-flash` · embed with `gemini-embedding-001` at 3072-d · clear the whole existing
cache · `saveVideo` hardening folded in (§4.7).

Environment facts every task must respect:
- The app runs as a **host bun process on :7778**, not in Docker. Mongo is
  `mongodb://127.0.0.1:27017`, db **`moneyprinterturbo`** (per `.env`). `vidgen-mongo` is a
  different, empty container. Qdrant must publish `127.0.0.1:6333`.
- Tests use **no mocks** — `bun:test`, pure functions, `__setXForTest` seams, dependency
  injection. No test may touch network or Mongo.
- Bun + TypeScript, `.ts` extensions in imports, snake_case for DB/API fields.

---

## Wave 1 — foundations (all parallel)

### T1 · Config plumbing
**Owns:** `server/src/config/schema.ts`, `server/src/config/settings.ts`, `.env.example`
**Depends on:** nothing

Add two settings groups following `whisper` (`schema.ts:145-165`) exactly:
- `qdrant`: `url` (default `http://127.0.0.1:6333`), `api_key` (default `""`),
  `collection` (default `footage`).
- `footage_index`: `enabled` (true), `auto_index` (true), `describe_model`
  (`gemini-3.7-flash`), `embed_model` (`gemini-embedding-001`), `concurrency` (4),
  `proxy_height` (360), `proxy_fps` (2), `proxy_max_seconds` (60).

Every field must have a default. Register both in `settingsSchema` with `.default({})`
(`:228-238`); export inferred types (`:241`); add `["qdrant","api_key"]` to `SECRET_FIELDS`
(`:264-281`). Add `ENV_BINDINGS` (`settings.ts:47-68`) for `QDRANT_URL`, `QDRANT_API_KEY` —
**the first non-`app` bindings in the codebase**. Verified: `applyEnvOverrides` and
`envManagedSettingPaths` are already section-generic (`settings.ts:91-108`, indexing
`effective[binding.section]`) and `SettingsSection = keyof Settings` (`schema.ts:251`)
widens automatically. **Registering the section is sufficient — do NOT refactor shared
config code.**

**Acceptance:** `bun run --cwd server typecheck` clean. An existing settings document with
neither group parses and backfills defaults. `QDRANT_URL=http://x:1/` overrides and
`envManagedSettingPaths()` returns `qdrant.url`.

### T2 · Data model
**Owns:** `server/src/db/types.ts`, `server/src/db/client.ts`
**Depends on:** nothing

Add `FootageIndexDocument` and `FootageRunDocument` as in spec §5, **plus
`state: "indexed" | "failed" | "stale"`** — `stale` is how §4.5 search-term freshness is
detected (a new term on an indexed row flips it to `stale` for a cheap payload-only
re-upsert, no re-describe, no re-embed). Add
`footageIndexCollection()` / `footageRunsCollection()` accessors, and indexes in
`createIndexes()`: `footage_index` on `local_file` (unique), on `{describe_version:1, embed_version:1}`,
and on `state`; `footage_runs` on `{started_at:-1}`.

**Acceptance:** typecheck clean; accessors follow the existing `requireDb()` pattern.

### T3 · Infrastructure and dependencies
**Owns:** `docker-compose.yml`, `server/package.json`
**Depends on:** nothing

Add a `qdrant` service: image `qdrant/qdrant:v1.15.4` (already local — do not bump),
named volume `qdrant-data:/qdrant/storage`, **`ports: ["127.0.0.1:6333:6333"]`** (the host
app needs this), healthcheck, `restart: unless-stopped`. Add
`depends_on: qdrant: {condition: service_healthy}` to `app`, and forward
`QDRANT_URL: http://qdrant:6333` and `QDRANT_API_KEY: ${QDRANT_API_KEY:-}` in
`app.environment:` — the image ships no `.env` (`docker-compose.yml:38-39`), so
`.env.example` alone would never reach the container. Hardcode the URL exactly as
`MONGODB_URI` is.

Add **`@qdrant/js-client-rest@~1.15.0`** to dependencies — pin to the 1.15 line to match
the pinned server image. The current 1.19.0 `console.warn`s on every client construction
when the server minor differs by more than 1. Add a `"footage": "bun src/footageCli.ts"`
script. Run `bun install`.

**No uuid dependency.** `node:crypto` exposes only `randomUUID` (v4); v5 is implemented as
a pure helper in T4.

**Acceptance:** `docker compose config` parses. `docker compose up -d qdrant` starts and
`curl -s localhost:6333/healthz` succeeds. **Do not start the `app` service** — port 8080
is held by `nano-vector` and the app runs on the host.

### T4 · Contracts and seed data
**Owns:** `server/src/services/footage/types.ts`, `server/src/services/footage/terms.json`
**Depends on:** nothing

`types.ts`: the `clipDescriptionSchema` zod object (summary, detailed_description,
use_cases[], mood[], tags[], setting, time_of_day, has_people, has_on_screen_text,
camera_motion, quality_flags[]), its inferred `ClipDescription`, `DESCRIBE_VERSION = 1`,
`EMBED_VERSION = 1`, and `composeEmbeddingText(d: ClipDescription): string` — a pure
function joining summary + description + use cases + tags, which the tests will cover.

Also `pointIdFor(localFile: string): string` — an RFC-4122 **v5** UUID, since Qdrant
accepts only uint64 or UUID point ids and there is no `uuid` dependency. Derive with
`createHash("sha1")` over (namespace bytes ‖ name), then force the version nibble to 5 and
the variant bits to `0b10`. Pure and deterministic, so it is directly unit-testable.

`terms.json`: **copy `server/src/services/footage-terms.seed.json`**, already committed to
the repo for this purpose. Its shape is nested, not a flat array:
`{version, note, categories: {<16 keys>: string[]}, observed_terms: {note, terms: string[]}}`
— 109 curated + 17 observed = **126**. Export a `allTerms(): string[]` helper that flattens
both halves, so no caller re-implements the traversal.

**Acceptance:** typecheck clean; `allTerms()` returns exactly 126 unique strings;
`pointIdFor("vid-x.mp4")` is stable across calls and is a syntactically valid v5 UUID.

---

## Wave 2 — services (parallel; needs Wave 1)

### T5 · Qdrant client
**Owns:** `server/src/services/footage/qdrant.ts`
**Depends on:** T1, T2, T3

`ensureCollection()` (create `footage_v<EMBED_VERSION>` at 3072-d cosine if absent, create
payload indexes on `aspect`/`provider`/`duration`/`has_people`, point the `footage` alias
at it), `upsertPoint()`, `deletePoints(ids[])` **batched** (`delete` takes a
`PointsSelector`, so chunk into `{points: ids}` calls), `scrollAll()`, and `health()`.

**API corrections — verified against the package's own `.d.ts`, do not guess:**
- **`QdrantClient` has no `search()`.** Use **`query(collection, {query: vector, limit,
  filter, with_payload})`**. Only `query`, `queryBatch`, `queryGroups`, `searchMatrixPairs`,
  `searchMatrixOffsets` exist.
- Real methods: `createCollection`, `collectionExists`, `createPayloadIndex`,
  `updateCollectionAliases`, `getAliases`, `scroll`, `upsert`, `delete`.
- **No `health()` method** — use `client.api("service").healthz()` or `versionInfo()`.
- Import `pointIdFor` from T4; do not re-implement it.

Smoke-tested against the real v1.15.4 image: 3072-d collection, alias, UUID-keyed upsert
through the alias, payload index, and filtered search all work.

Never throw into a render path: export a `isAvailable()` probe callers can use to degrade.

**Acceptance:** typecheck clean. Against the live container: create → upsert → search →
delete round-trips, and re-running `ensureCollection()` is a no-op.

### T6 · Describe
**Owns:** `server/src/services/footage/describe.ts`
**Depends on:** T4

`buildProxy(src, opts)` — ffmpeg to `storage/temp/footage_proxies/`, scale to
`proxy_height`, `fps`, `-t proxy_max_seconds`, `-an`, `libx264 -crf 32 -preset veryfast`;
delete in `finally`. Use `getFfmpegBinary()` from `utils/paths.ts` and the existing
`ffmpeg.ts` runner **with a timeout**.

`describeClip(path, deps)` — build proxy, read bytes, call `generateObject` from `ai` with
`createGoogleGenerativeAI(...)(model)` and `clipDescriptionSchema`, passing
`{type:"file", mediaType:"video/mp4", data: bytes}`. Verified working: 2.9 s inline,
2.0 MB proxy from a 201 MB source. Take the model + fs as injected deps so tests need no
network. Retry once on schema violation, then throw a typed error.

**Acceptance:** typecheck clean; proxy of the 211 MB clip is <5 MB and builds in <5 s; pure
helpers unit-tested without network.

### T7 · Embed
**Owns:** `server/src/services/footage/embed.ts`
**Depends on:** T1, T4

`embedText(text, deps)` via `embed()` + `google.textEmbeddingModel(...)`. `taskType` is
**not** a top-level `embed()` argument — it goes in
`providerOptions: { google: { taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" } }`
(verified in `@ai-sdk/google@2.0.87` `dist/index.d.ts:203-214`). Use `RETRIEVAL_DOCUMENT`
for indexing and `RETRIEVAL_QUERY` for search. Assert 3072 dimensions and reject otherwise.
Inject the model for testability.

**Acceptance:** typecheck clean; live call returns 3072 dims, L2 norm ≈ 1.0.

### T8 · `saveVideo` hardening (spec §4.7)
**Owns:** `server/src/services/material/download.ts`,
`server/src/services/video/probe.ts`, `server/src/routes/v1/media.ts`
**Depends on:** nothing

**This is the one task touching the live render path. Be conservative.**

1. `saveVideo`: unique temp `.vid-<hash>.<pid>.<rand>.part` **in the destination
   directory** (never `tmpdir()` — `material_directory` may be any absolute path, so a
   cross-device rename throws `EXDEV`), **stream** the response body into it instead of
   `await response.arrayBuffer()`, ffprobe, then `rename()` to the final name. Do **not**
   add an in-flight dedup map — unique temps make it unnecessary, and a shared promise
   would share one `AbortSignal` and let one cancelled task abort another's download.
2. Validate on cache hit, memoised in a module-level `Map<path, boolean>` so repeat hits in
   one process are free.
3. `probe.ts:49-55`: pass a `timeoutMs` so a hung ffprobe cannot hold a slot forever.
4. `media.ts`: filter both `readdirSync` walkers (`:201`, `:225`) to `vid-*.mp4` so
   in-progress temps are neither counted nor `rm`ed. **Filter only — the `/cache/clear`
   body is extended later by T11, which is a different wave, so the two never write
   concurrently.**

**5. The auto-index hook (design §4.4) — this task owns it.** It was missing from the first
draft of this plan; it is one of the design's two entry points.

At both `MaterialInfo` call sites (`download.ts:191` and `:287`), after a successful
`saveVideo`, call a footage hook with the saved path and the item's provenance. Rules,
all load-bearing:
- **Guard on `dirname(savedPath) === cacheVideosDir(false)`.** Do **not** test
  `resolveMaterialDirectory()`, which returns `""` for the default case
  (`download.ts:100`) — the live settings document has `material_directory: ""`, so a
  literal `=== cacheVideosDir()` comparison is false for *every* normal download and the
  hook would silently never fire.
- **Fires for cache hits too**, not only fresh downloads — `saveVideo` returns the path
  either way, and skipping hits would miss most clips.
- Fire-and-forget with a short timeout. **Never blocks the loop, never throws into the
  caller, never fails a render.** Note the call sites are a serial `for` loop and a book
  pool is ~360 clips, so a synchronous Mongo write here could add an hour under a degraded
  Mongo (`serverSelectionTimeoutMS: 10_000`, `db/client.ts:86`).
- Writes provenance with `$addToSet` on `search_terms` plus `provider`, `asset_id`,
  `rendition_id`, `source_page`, `creator`. **If the row already exists and is `indexed`
  and the term is new, set `state: "stale"`** (design §4.5).
- Gated by `footage_index.auto_index`.
- **It is not a durability mechanism** — the filesystem is. If it fails or is skipped,
  `footage index` still finds the file. So swallow every error.

Put the hook function itself in a T4-owned or T9-owned module and import it, so this task's
diff to `download.ts` stays small.

**Acceptance:** `bun run --cwd server test` fully green (this is the gate — existing render
tests must not regress). The success-path return value is unchanged. Manually verify a
partial file is never visible under the final name.

---

## Wave 3 — orchestration (needs Wave 2)

### T9 · Index orchestration
**Owns:** `server/src/services/footage/index.ts`, `server/src/services/footage/lock.ts`
**Depends on:** T5, T6, T7, T2

`lock.ts`: single Mongo lock document (`_id: "footage_index_lock"`) with TTL + heartbeat;
`withLock(fn)`; `isLocked()`.

`index.ts`: `indexOne(localFile)` — reuse a cached description when `describe_version`
matches, else describe; embed; upsert; write the row. **Handle `state: "stale"` as a
payload-only path** (design §4.5): re-read `search_terms` from Mongo, re-upsert the Qdrant
payload, and mark `indexed` again — **no re-describe and no re-embed**. Always re-read
`search_terms` immediately before any upsert so a term added mid-describe is not lost. `indexAll(opts)` — **walk
`cacheVideosDir()`**, diff against Mongo, process at `concurrency` with bounded parallelism,
per-clip failures recorded in `errors[]` and never fatal. `reconcile()` — delete points
whose file is gone; enqueue files with no row. `stats()`.

Failures leave the file on disk; nothing is auto-deleted.

**Acceptance:** typecheck clean; re-running `indexAll` on an indexed cache is a no-op;
killing it mid-run and re-running resumes with no duplicate Gemini spend.

### T10 · Pull
**Owns:** `server/src/services/footage/pull.ts`
**Depends on:** T4, T2

Its own paginating Pexels search — construct `page=N` directly (`next_page` is malformed
`/v1/v1/…` and 404s), check `response.ok` and back off on 429, apply the repo's
exact-resolution rule, and **never call `searchWithCache`** (its key has no `page`, so
paginating through it would overwrite the render path's 24 h cache).

Its own downloader: stream → unique temp in `storage/temp/downloads/`
(`storageDir("temp/downloads", true)` already mkdirs recursively — no `paths.ts` change
needed) → ffprobe → atomic rename into `cacheVideosDir()`. **The destination filename must
be exactly `vid-<md5(url without query)>.mp4`, matching `download.ts:67-68`** — otherwise
the render path re-downloads every clip the pull already fetched, and T8's new `vid-*.mp4`
filter hides them from `/cache/stats` and `/cache/clear`. Track **actual bytes written** against `--max-bytes` and
check free disk before each download. Page cap 3 (measured yield is 15-20 per page, so one
page usually suffices). Write a `footage_runs` document with per-term
attempted/accepted/rejected/last_status and a stop reason.

**Acceptance:** `--dry-run` lists what it would fetch without writing. A real run of 2 terms
lands validated clips and a complete run document.

---

## Wave 4 — surface (needs Wave 3)

### T11 · CLI, routes, registration
**Owns:** `server/src/footageCli.ts`, `server/src/routes/v1/footage.ts`,
`server/src/index.ts`, **`server/src/routes/v1/media.ts`** (the `/cache/clear` body; T8
touched only the readdir filters, in an earlier wave — sequential, never concurrent)
**Depends on:** T9, T10

CLI subcommands `pull` / `index` / `search` / `status` / `reconcile`, each taking the lock.
Routes `GET /footage/stats`, `POST /footage/search`; **register `footageRouter` in
`index.ts`** alongside `:63-69` or it 404s. Extend `POST /cache/clear` to batch Mongo `bulkWrite` + batched Qdrant deletes, and to
**409 while the index lock is held**. Also **409 when the task queue is not idle** — design
§10.6, implemented as a real code gate rather than the manual Wave 5 step, because the
server is live and a clear during a render deletes clips out from under it.

**Acceptance:** `bun run --cwd server footage status` prints counts.
`curl :7778/api/v1/footage/stats` returns 200.

### T12 · Tests
**Owns:** `server/test/footage-*.test.ts`, `server/test/config.test.ts`
**Depends on:** T1-T11

No mocks, no network, no Mongo. Cover: `composeEmbeddingText`, `pointIdFor` stability,
`terms.json` shape, the exact-resolution filter, byte-budget arithmetic, temp-name
uniqueness, the `dirname(savedPath) === cacheVideosDir()` hook guard, and non-`app` env
overrides (add `QDRANT_URL` to `MANAGED_VARS`, `config.test.ts:19-29`).

**Acceptance:** `bun run --cwd server test` green.

### T13 · Web settings type
**Owns:** `web/src/api/client.ts`
**Depends on:** T1

Add `qdrant` and `footage_index` to `interface Settings` (`:51-60`). Do **not** fix the
missing `kokoro` — out of scope. **No change to `web/src/settings/cache.tsx`**: the design's
"cache-panel counts" allowance is dropped, so no task owns any web UI file but this one.

**Acceptance:** `bun run --cwd web typecheck` clean.

---

## Wave 5 — execution (manual, gated)

Not a code task. In order:
1. Confirm the task queue is idle (the server is live on :7778).
2. `docker compose up -d qdrant`; verify health.
3. **Clear the cache** — 167 files / 3.4 GB, of which 9 are unrecoverable. Deliberate.
4. `footage pull --per-term 4` (~1,008 clips, ~15-21 GB, ~20-40 min).
5. `footage status`, then `footage search "empty hospital corridor"` as the acceptance
   demo that the index actually answers the question §1 opened with.

## Verified baselines (measured, not assumed)

- `bun run --cwd server test` → **1004 pass, 0 fail**, 23 files, exit 0. T8's "suite stays
  green" gate is therefore meaningful exactly as written.
- `bun run --cwd server typecheck` and `bun run --cwd web typecheck` → **exit 0, zero
  errors**. "Typecheck clean" is meaningful.
- Caveat: `book-shorts.test.ts` and `book-template-render.test.ts` degrade
  `chrome died mid-frame` to a warning rather than failing, so the suite would not catch a
  real Chrome-render regression. Not introduced here; do not rely on those two for T8.

## Risks carried into implementation

- **T8 is the blast radius.** Full existing test suite green is a hard gate.
- **Gemini rate limits** at concurrency 4-8 across ~1,000 clips are unmeasured; backoff must
  be real, and the run must survive a sustained 429.
- **Non-`app` env bindings are untested ground** (T1) — the mechanism may need fixing, not
  just extending.
- **Nothing else in the repo uses Qdrant**, so T5's client wrapper has no precedent to
  follow; keep it thin and REST-shaped like `material/http.ts`.
