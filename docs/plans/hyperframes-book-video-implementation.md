# HyperFrames book video — implementation plan

Executes [`hyperframes-book-video.md`](hyperframes-book-video.md). Read that first; this
document assumes its decisions and does not re-argue them.

**Settled inputs:** bed at 15 fps / crf 26 / veryfast · template selection stored on the
book · one Docker image, ~500 MB growth accepted · `hyperframes@0.8.4` pinned exactly.

---

## Verified baseline

Recorded 2026-08-20 on `main` with the working tree as-is, so the gates below compare
against a known-good state rather than an assumed one:

```
bun run typecheck        → exit 0
bun run --cwd server test → 876 pass, 0 fail, 2100 expect() calls, 19 files, 15.75s
```

Any gate failure after this point is caused by the change, not inherited.

## Plan verification

| Check | Result |
| --- | --- |
| Every `file:line` in this plan resolves and is in range | 53 citations, 48 verified, 3 are files this plan creates. |
| The cited lines actually contain what is claimed | 36 load-bearing citations checked by content, not just existence. **2 were wrong** — `patchBookShort` and the `__default__` sentinel — both inherited from an earlier survey and corrected here after re-reading the source. |
| Independent Codex review | **Not done — still rate-limited** (`try again at 3:40 PM`). Same gap as the design spec. |

## How to run this

Tasks are grouped into waves. **Within a wave, tasks are parallel and have disjoint file
ownership — no two tasks in the same wave write the same file.** Between waves there is a
merge gate that must go green before the next wave starts.

- Parallel tasks run with `isolation: "worktree"`. They mutate files concurrently and their
  own verification runs `typecheck`, which would otherwise trip over a sibling's half-written
  state.
- **Verify each task's result yourself — do not trust its report.** Every task below carries
  an acceptance check that is a command with an observable result, not "the agent said done".
- A task that cannot meet its acceptance criteria stops and reports. It does not widen its
  own scope to compensate.

Verification commands used throughout:

```bash
bun run typecheck
```

```bash
bun run --cwd server test
```

---

## Wave 0 — the spike that decides whether to continue

One task. **Blocking: nothing else starts until this is reviewed by a human.**

### T0 — Author the first real template and prove it end to end

**Owns:** `resource/hyperframes/classic/**` (new), scratch renders outside the repo.

Build the `classic` template's three parts as real HyperFrames compositions and prove the
whole chain works on one actual book segment.

1. `resource/hyperframes/classic/template.json` — id, label, parts provided, default accent,
   bed encode profile (`fps: 15`, `crf: 26`, `preset: "veryfast"`), bed duration.
2. `card/index.html` — 5-10s title card, alpha fade-out on its tail, declaring
   `bookTitle`, `bookAuthor`, `chapterTitle`, `coverImage`, `accent` via
   `data-composition-variables`, bound with `data-var-text` / `data-var-src`.
3. `bed/index.html` — a **seamless** 20s loop declaring `coverImage`, `accent`.
4. `short/index.html` — kinetic typography declaring `bookTitle`, `chapterTitle`, `hookText`,
   `scriptText`, `coverImage`, `accent`, authored to accept a runtime duration.

Then render them and assemble one segment by hand, using
`storage/tasks/Me Before You/002 Chapter 1/` as the source (an 816s narration at 24 kHz mono).

**Acceptance — every item is a file you can look at, not a claim:**

- `npx hyperframes check` passes in each of the three project dirs.
- The bed's first and last frames match: `npx hyperframes snapshot --at 0,20` produces two
  visually identical frames. **A visible jump here kills deliverable B** — report it rather
  than papering over it.
- A hand-assembled segment MP4 exists whose duration equals the narration's (815.951s),
  whose audio measures within 1 dB of the source mp3 under `volumedetect`, and which shows
  the card over its opening and the looping bed after.
- Its size is within 10% of the 53 MB/segment the design spec predicts. A large miss means
  the encode profile is wrong and the storage decision needs revisiting **before** any
  plumbing is written.

**Stop here and show a human the rendered segment.** Every later task is plumbing; this is
the only one that answers "does it actually look good". If the loop reads as cheap or the
card fights the narration, the cheapest moment to cut deliverable B is now.

### T0 — RESULTS (executed 2026-08-20)

Built `resource/hyperframes/classic/` (card, bed, short + `template.json`) and rendered one
real segment: `Me Before You` / `Chapter 1`, 815.951 s of narration at 24 kHz mono.

**Acceptance:**

| Criterion | Result |
| --- | --- |
| `check` passes in all three project dirs | **Pass** — 0 errors, 0 warnings each |
| Bed seam is invisible | **Pass, measured.** PSNR last→first frame **46.25 dB**, against 46.79 / 46.57 dB for ordinary adjacent frames and 29.21 dB for frames 10 s apart. The join is statistically just another frame step |
| Duration equals narration | **Pass** — 815.951 s exactly |
| Narration intact | **Pass** — −17.7/−18.8/−20.1 dB at t=2/200/700 against −17.6/−18.9/−20.0 dB in the source mp3 |
| Size within 10% of 53 MB | **Marginal miss** — 60.1 MB, 13% over |
| Caption legibility over the bed | **UNVERIFIED — cannot be tested on this host.** See below |

**Design decisions forced by what was found, all now baked into the templates:**

1. **The bed must not use the cover image.** The first draft blurred the cover as a wash. A
   VidGen "cover" is usually not artwork — `renderDefaultCover()` generates a typographic
   card, and blurring type produced a smear of white blobs. Verified against a real book: the
   smear was the title. The bed is now generated purely from the accent colour.
   **Consequence, and it is an improvement:** the bed's cache key collapses to
   `(accent, aspect)` — **one bed per accent, not one per book**, and no cover-bytes hash.
   T7's caching gets simpler than specced.
2. **`data-no-timeline` is mandatory on every CSS-only composition.** Without it the producer
   polls for a `window.__timelines` registration for **45 seconds** before rendering anyway —
   roughly an hour of pure waiting across one book's cards.
3. **No GSAP, no `<script>`, no CDN.** The scaffold's `hyperframes init` pulls GSAP from
   jsdelivr at render time. That is a network fetch inside a render and would let a CDN change
   what a re-render produces. All three compositions use the CSS runtime adapter instead.
4. **Fonts are fetched from Google Fonts at compile time** and cached to
   `~/.cache/hyperframes/fonts/`. **New requirement for T5:** the Docker build must warm that
   cache the way it warms the Chrome download, or renders in a sealed container stall or
   silently substitute a different face.
5. **A short's duration cannot be a variable.** Root `data-duration` is read at compile time,
   so `--variables` cannot change render length. **T6 must write `data-duration` into a
   working copy** of `short/index.html` before rendering.

**Cost — measured, and worse than the design spec projected.** The spec's "≈5 s per 120 s"
was taken on a nearly-static gradient; a bed that actually moves costs far more to encode:

| | Today (still, 5 fps) | With bed + card (15 fps) |
| --- | --- | --- |
| Body encode, per 816 s segment | **96.5 s** | **264 s** |
| ffmpeg per 74-segment book | **~2.0 h** | **~5.4 h** |
| Segment size | 26.5 MB (shipped) | 60.1 MB |
| Book storage | ~1.9 GB | **~4.3 GB** |
| HyperFrames render | — | ~48 s per accent + ~25 s × 74 cards ≈ 0.5 h |

So the real figure is **~3× total render time per book** (≈2 h → ≈6 h) and **2.3× storage**.
The storage ratio matches the spec's "~2×"; the **encode time does not** — the spec never
measured today's baseline, so it could not state the delta. Filters are not the cause:
removing the fit filter saves 7% and removing the card overlay saves nothing. The cost is
decoding a looped bed and encoding real motion.

**This host cannot burn subtitles.** Its ffmpeg 8.1.2 is built without libass, so
`hasFilter("subtitles")` is false and `supportsAssBurn()` returns false — every book rendered
on this machine silently takes the soft-subtitle path. That is live confirmation that the
burn/soft divergence at `bookPipeline.ts:465-468` is real and environment-dependent, not
theoretical. **Caption legibility over a moving bed is therefore untested**, and T10 must
verify it inside the Docker image, where Debian's ffmpeg does ship libass.

**Open question for review:** the ~3× render-time increase was not on the table when
deliverable B was chosen. It is still opt-in per book, and the picture is genuinely improved
— but the honest trade is now "a moving body costs triple the render time and double the
storage", not the cheap win the spec implied.

---

## Wave 1 — foundations (6 tasks, parallel, worktree-isolated)

No task in this wave imports another's output. All are independently testable.

### T1 — Template registry

**Owns:** `server/src/services/video/templates.ts` (new),
`server/test/templates.test.ts` (new).

Discovery and validation for `resource/hyperframes/`, mirroring `listFonts()`
(`server/src/routes/v1/settings.ts:71-77`) in spirit — scan a resource directory, return a
sorted list.

```ts
export interface TemplateEncodeProfile { fps: number; crf: number; preset: string }
export interface TemplateManifest {
  id: string;
  label: string;
  description: string;
  parts: ("card" | "bed" | "short")[];
  defaultAccent: string;
  cardDuration: number;
  cardFadeOutSeconds: number;
  bedDuration: number;
  bedEncode: TemplateEncodeProfile;
}
export function listTemplates(): TemplateManifest[];         // cached, invalidated by mtime
export function getTemplate(id: string): TemplateManifest | null;
export function templatePartDir(id: string, part: string): string;
```

**As built** (T1 complete). `listTemplates()` deliberately never throws — it drops a bad
template and logs a warning, because it feeds both the settings endpoint and a render path
that must degrade to the still rather than fail a chapter. One malformed directory must not
take the rest down. `loadTemplateManifest()` is exported for the throwing form.

`templatePartDir` guards with an anchored charset before containment resolution, which is
stricter than "no separators" on purpose: a leading `-` would be read as a flag once the
directory reaches the HyperFrames CLI's argv. Verified by direct probe — `../etc`,
`/etc/passwd`, `a/b`, `-rf`, `..`, `classic/../../..` and the `part` equivalents all raise
`UnsafePathError`.

Known limit, documented in the source: the cache stamp is built from directory mtimes, so
adding, removing or renaming a template or part is picked up live, but **editing a
`template.json` in place needs a restart**.

**Acceptance:** `bun run --cwd server test templates` green. Tests cover: a well-formed
manifest parses; a manifest missing a declared part's `index.html` is rejected with a named
error; an unknown id returns `null` rather than throwing; `templatePartDir` refuses `..`
traversal in `id` or `part` (this value reaches a shell argument — see `fileSecurity.ts` for
the containment pattern already used for task paths).

### T2 — HyperFrames renderer service

**Owns:** `server/src/services/video/hyperframes.ts` (new),
`server/test/hyperframes.test.ts` (new).

Implements the interface in the design spec's *API surface* section. Takes `templateDir` as a
plain path string, so it does not depend on T1.

Requirements that are easy to miss and are not optional:

- **`buildRenderArgs` is pure** and separately exported, matching `buildStillArgs`. All arg
  assertions test this, with no process spawned.
- **Kill the process group, not the pid.** `runFfmpeg` uses `proc.kill()` on the direct child
  (`server/src/services/video/ffmpeg.ts:64`), which is right for ffmpeg and wrong here — a
  Node CLI spawns a Chrome tree that survives it. Spawn detached and signal the group, on
  both `signal.aborted` and `timeoutMs`.
- **`hyperframesAvailable()` must not be a process-lifetime memo.** `supportsAssBurn()`
  (`server/src/services/video/capabilities.ts`) caches forever, which is correct for a static
  ffmpeg binary and wrong for a Chrome that can die. Use a TTL, and invalidate on render
  failure.
- **Atomic output.** Render to a temp path and rename. A truncated file at a valid cache key
  is reused forever by every later segment.
- **Throttle progress.** `updateTask` is an unthrottled Mongo upsert (`server/src/tasks/state.ts:72-86`);
  coalesce `--json` events to an interval or a percentage delta before calling `onProgress`.
- Invoke `node_modules/.bin/hyperframes`. **Never `npx`, never `@latest`** — a network fetch
  mid-render could change renderer behaviour between two segments of one book.

**Acceptance:** `bun run --cwd server test hyperframes` green, covering `buildRenderArgs`
output for card/bed/short shapes, variable JSON encoding (including quotes and non-ASCII in a
book title), timeout producing a typed error, and `signal.aborted` before spawn returning
without spawning. Plus one integration test, skipped when `hyperframesAvailable()` is false,
that renders a 1s composition and asserts the output probes as non-empty with a plausible
duration.

### T3 — Render params: schemas and documents

**Owns:** `server/src/models/bookSchema.ts`, `server/src/db/types.ts`.

Both files in one task because the zod schema and the document type must move together.

1. `bookRenderRequestSchema` (`bookSchema.ts:202`) gains `template_id` (string, default `""`),
   `template_parts` (array of `"card" | "bed"`, default `[]`), `template_accent` (string,
   default `""`).
2. `BookRenderParamsDocument` (`db/types.ts:221`) gains the same three, **optional**, so
   books stored before this ships still parse.
3. `renderParamsToDocument` (`bookSchema.ts:243`) passes them through.
4. `bookShortsRenderRequestSchema` (`bookSchema.ts:354`) and
   `BookShortsRenderParamsDocument` (`db/types.ts:374`) gain `template_id` only.
5. `videoParamsForBookShort` (`bookSchema.ts:388`) threads `hook` and `chapter_title`, which
   exist on `BookShortDocument` (`db/types.ts:426`, `:438`) and are currently dropped.

**Acceptance:** `bun run typecheck` clean. New tests in `server/test/book-api.test.ts`
asserting: a request omitting all three parses to the no-op defaults; a stored document
predating the change round-trips unchanged; `template_parts: ["bed"]` survives
`renderParamsToDocument`. **Existing `book-api.test.ts` tests must not be modified** — if one
fails, the defaults are wrong.

### T4 — Still renderer: bed and card

**Owns:** `server/src/services/video/still.ts`, `server/test/longform-video.test.ts`.

The three additive fields from the design spec (`bedPath`, `cardPath`, `cardDuration`) plus
`fps` and a bed encode profile, and the four mandatory corrections.

- `bedPath` set → `-stream_loop -1 -i <bed>`; **remove** `-loop 1 -framerate N`
  (`still.ts:145-150`). This is a different argument shape, not a path swap.
- `bedPath` set → **suppress `-tune stillimage`** (`still.ts:183`) and use the bed profile
  instead of `codecQualityArgs()` (`codec.ts:130`).
- `bedPath` set and `duration <= 0` → **refuse the bed, fall back to the still.** `-t` is
  omitted when the probe finds no duration (`still.ts:203`), and `-shortest` against an
  infinitely looping video is the classic non-terminating case; a wedged encode holds a
  `BookConcurrencyGate` slot.
- `cardPath` set → one extra input plus
  `[card]format=yuva420p,fade=t=out:alpha=1[c];[bed][c]overlay=0:0:enable='between(t,0,D)'`
  ahead of the existing fit/caption chain.
- `imagePath` becomes optional when `bedPath` is set, and stays the documented fallback.

**The audio half of the graph must not change.** Narration map, BGM `-stream_loop` mix, `-t`,
`-shortest` and the probed sample rate (`still.ts:231`) are the invariant that keeps the
narration safe.

**Acceptance:** `bun run --cwd server test longform-video` green with **all 17 existing
`buildStillArgs` call sites unmodified** — they cover the still path and must keep passing
verbatim, including `toContain("stillimage")` (`:634`) and `-crf 23` (`:641`). Add a parallel
`describe("buildStillArgs — bed")` asserting: `-stream_loop -1` present and `-loop` absent;
`stillimage` absent; bed profile flags present; `duration: 0` falls back to the still path;
and — the safety invariant — that with `cardPath` set, the audio maps, `-t` and `-shortest`
are byte-identical to the same input without a card.

### T5 — Packaging

**Owns:** `Dockerfile`, `docker-compose.yml`, `server/package.json`.

- `server/package.json`: `"hyperframes": "0.8.4"` — exact, no caret.
- `Dockerfile`: Node 22+ via nodesource; Chrome runtime libs (`libnss3`,
  `libatk-bridge2.0-0`, `libdrm2`, `libxkbcommon0`, `libxcomposite1`, `libxdamage1`,
  `libxfixes3`, `libxrandr2`, `libgbm1`, `libasound2`); `COPY resource ./resource` already
  exists and now carries the templates; **`RUN node_modules/.bin/hyperframes browser ensure`
  at build time** so no render ever downloads Chrome; Noto fonts with Latin coverage for
  non-Latin book text (pull `full/ttf/`, not `hinted/` — the `hinted` builds ship no Latin).
- **Warm the font cache at build time.** The compiler fetches faces from Google Fonts and
  caches them under `~/.cache/hyperframes/fonts/` (confirmed in T0: it pulled EB Garamond and
  Inter). Run a throwaway `check` or `render` against `resource/hyperframes/classic/card` in
  the build so the cache is baked into the image; otherwise a sealed container either stalls
  on the fetch or silently substitutes a different face.
- `docker-compose.yml`: `shm_size: 1gb` on the `app` service. Chrome's default 64 MB in
  Docker crashes tabs at 1080p.

**Acceptance:** `docker compose build` succeeds, and inside the built image all four of these
report success:

```bash
docker compose run --rm app node --version
```

```bash
docker compose run --rm app node_modules/.bin/hyperframes doctor --json
```

Gate on the payload, not the exit code — `doctor --json` always exits 0. Assert `.ok` is
true and that the Chrome and FFmpeg checks are `ok`. Also confirm `/dev/shm` reports at least
1 GB and that the image's size delta from `main` is recorded in the task report.

### T6 — Book Shorts re-plumb

**Owns:** `server/src/tasks/bookShortsPipeline.ts`.

Placement C. **Not a branch — a re-plumb**, because HyperFrames does no TTS.

Replace `runPipeline({ stopAt: "video" })` (`bookShortsPipeline.ts:463`) with, when
`template_id` is set:

1. `runPipeline({ taskId, params, stopAt: "subtitle", signal })` — the stage exists
   (`server/src/tasks/pipeline.ts:347`). Keeps TTS, cues and BGM resolution untouched.
2. Probe the narration for its real duration and render the `short` composition to that
   length. **Per T0 this cannot be passed as a variable** — root `data-duration` is read at
   compile time, so the service must write the value into a working copy of
   `short/index.html` before invoking the renderer.
3. Assemble with **`renderStillSegment({ bedPath: <composition>, audioPath, assPath, … })`** —
   a short's composition is exactly narration-length, so looping is a no-op and no new
   compositor is needed. This depends on T4's `bedPath` support.
4. Keep writing `audio_path` and `subtitle_path` on `patchBookShort` (`:475-481`). The naive
   swap leaves both null on every templated short; that is the bug this task exists to avoid.

`template_id` unset → the existing stock-footage path, byte-for-byte.

**Acceptance:** `bun run --cwd server test book-shorts` green, including a new test asserting
that a templated short still records non-null `audio_path` and `subtitle_path`, and that an
untemplated short takes `stopAt: "video"` exactly as before.

> **Note:** T6 reads T4's interface. Sequence T4 → T6, or have T6 write against the
> interface as specced and integrate at the wave gate. Do not let both edit `still.ts`.

---

## Gate 1

**Required gate action, added during execution.** T2's integration render test is written but
has **never executed** — it skips when `node_modules/.bin/hyperframes` is absent, which was
true for its whole run because T5 owns the dependency. Once T5 has landed:

```bash
bun install && bun run --cwd server test hyperframes
```

Confirm the integration test **ran rather than skipped** (the suite prints
`skipping: hyperframes is not installed…` when it did not). Until that line is gone, the
render path against the real CLI is unverified, and no amount of green elsewhere covers it.

Then, on the merged tree:

```bash
bun run typecheck && bun run --cwd server test
```

Every pre-existing test must pass. **A pre-existing test that needed editing to pass is a
defect in the change, not in the test** — the whole design rests on absent params reproducing
today's ffmpeg arguments exactly. Investigate rather than update the assertion.

---

## Wave 2 — wiring (3 tasks, parallel, worktree-isolated)

### T7 — Book pipeline wiring (A + B)

**Owns:** `server/src/tasks/bookPipeline.ts`.

In `runSegmentRender`, between the cover resolve (`:456`) and the render call (`:502`):

1. Resolve the bed (cached per book) and the card (per segment) through T1 + T2.
2. **Thread `fps` into the `still` object at `:489-499`** — it is absent today, so the bed
   would silently render at `STILL_FRAMERATE = 5` with no error.
3. Pass `bedPath` / `cardPath` / `cardDuration` to the existing `renderStillSegment` call.
   **One ffmpeg invocation still produces the segment** — that property is what
   `still.ts:1-9` exists to protect. Add nothing after the render; the soft-sub mux at `:514`
   is untouched.
4. Cache under `storage/books/<bookId>/hyperframes/`, write-to-temp-then-rename.
   **Simpler than originally specced, per T0:** the bed does not use the cover, so its key is
   `(template_id, accent, width, height, fps)` — no cover-bytes hash, and one bed per accent
   rather than per book. The **card** key still includes the chapter title. Nothing in this
   feature needs to hash cover bytes; that requirement belonged to the separate pre-existing
   cover-overlay bug.
5. `hyperframesAvailable()` is checked **here**, not only in the settings endpoint —
   `template_id` is persisted on `book.render_params` (`:641`) and can outlive the host that
   could render it, including via `tasks/recovery.ts`. On a miss: log, fall back to the still,
   complete the segment. **Never fail a chapter over a missing template.**
6. Same degradation on composition render failure or timeout, mirroring how BGM already
   degrades at `:511`.

**Invariant to hold and to state in a comment: the body's t=0 is the narration's t=0.**
`SubtitleCue.start` means "seconds from the start of the video"
(`server/src/services/subtitle/srt.ts:11`) and the SRT is written at `:446`, before any of
this runs. Nothing here may shift the narration.

**Acceptance:** `bun run --cwd server test` green. New tests: a segment with
`template_parts: []` produces the identical `still` object as before; a bed cache hit does not
re-render; `hyperframesAvailable() === false` completes the segment via the still path with a
log line. Then the real check — render one segment of a real book end to end and confirm the
output duration equals the narration's and its subtitles are in sync at t=0, t=mid and t=end.

### T8 — Settings metadata

**Owns:** `server/src/routes/v1/settings.ts`.

Add `book_templates` to `GET /settings/metadata` (`:46`), alongside `fonts` and
`video_aspects` — id, label, parts, default accent. Sourced from T1. Returns `[]` when
`hyperframesAvailable()` is false, which is what empties the UI dropdown.

**Acceptance:** `curl -s localhost:8080/api/v1/settings/metadata | jq '.data.book_templates'`
returns an array containing `classic` on a capable host, and `[]` with Chrome removed from
`PATH`. Existing metadata keys unchanged.

### T9 — Web UI

**Owns:** `web/src/book/api.ts`, `web/src/book/RenderPanel.tsx`,
`web/src/i18n/locales/en.json`.

1. `api.ts:144` — add the three fields to `BookRenderRequest` and the template shape to the
   metadata type.

   **The two sides use different key names, on purpose — do not conflate them.** T8 shipped
   each `book_templates` entry keyed `id` (a straight snake_case mapping of `TemplateManifest`,
   matching the `llm_providers` pattern in the same handler). The render *request* field is
   `template_id`. So the UI reads `id` off the dropdown entry and sends it as `template_id`.
   The metadata entry carries `{ id, label, description, parts, default_accent }` and
   deliberately omits `cardDuration` / `bedDuration` / `bedEncode` — those are renderer tuning,
   not a client contract.
2. `RenderPanel.tsx` — a template Select plus part checkboxes and an accent picker, in the
   Cover card. Follow the existing `DEFAULT_FORM` (`:42-60`) convention, and the
   `"__default__"` sentinel pattern used for the font Select (`DEFAULT_FONT` at `:40`, wired
   at `:619-622`) for "let the server decide". Hide the whole control when `book_templates`
   is empty.

   **Do not copy `buildBody`'s delete.** It strips an empty `font_name` (`:378-384`) because
   `""` would reach the ASS writer as a literal font name and fail. The new fields are the
   opposite: `""` *is* the documented no-op for `template_id` and `template_accent`, and the
   zod schema defaults them to `""`. Send them as-is.
3. `en.json` only. English backfills every other locale (`web/src/i18n/index.tsx:121`), and
   the non-English files are already incomplete — 277 keys against en's 701 — so adding keys
   to one file matches how this repo actually works.
4. **Fix the now-wrong copy:** `Book Cover Hint` currently reads "It becomes the still image
   behind the narration", which stops being true once a bed is selected.

**Acceptance:** `bun run typecheck` clean; `bun run build` succeeds. In the browser: the
control appears, a chosen template survives a page reload (it is persisted on the book), and
`POST /books/:id/render` carries the three fields. With `book_templates: []` the control is
absent and the form behaves exactly as it does today.

---

## Gate 2

```bash
bun run typecheck && bun run --cwd server test && bun run build
```

---

## Wave 3 — integration verification

### T10 — Prove it on a real book

**Owns:** nothing. Read and run only.

Not a test suite — the actual product. Render **three consecutive segments** of a real book
with `template_id: "classic"` and `template_parts: ["card", "bed"]`, then verify:

| Check | How |
| --- | --- |
| Duration is unchanged | Each segment's probed duration equals its narration's, within 100 ms |
| Narration is intact | `volumedetect` within 1 dB of the source mp3, sampled under the card and mid-chapter |
| Subtitles are in sync | Spot-check burned **and** soft paths at t=0, mid, end. Run once with libass present and once absent — `canBurn` degrades silently at `bookPipeline.ts:465-468`, and that is the environment-dependent failure the design spec calls its biggest historical risk |
| Storage matches prediction | Total bytes within 15% of 53 MB/segment |
| The bed cache works | Segments 2 and 3 render **no** new bed; confirm by file mtime, not by log line |
| No leaked Chrome | `pgrep -f chrome` returns nothing after the run, and again after cancelling a render mid-flight |
| Docker parity | Repeat one segment inside the built image and confirm it matches the host render |

**Acceptance:** every row demonstrated with its command output pasted into the task report.
Any row that cannot be shown is reported as unverified — not as passed.

### T10 — RESULTS (executed 2026-08-20)

Run against a **new** book in a **throwaway database** (`vidgen_t10`), not against the real
library: `storage/` is gitignored with zero tracked files, and "Me Before You" holds 74
rendered MP4s / 2.3 GB of TTS work with no version history. "A Tale Of Two Cities" also had an
abandoned segment-0 render on disk. Neither was touched.

Three segments (37.2 s / 30.5 s / 34.4 s), `template_id: "classic"`, parts `["card","bed"]`,
accent `#e0af68`. Whole render: **91 seconds**.

| Check | Result |
| --- | --- |
| Duration unchanged | **PASS** — delta **0.0 ms** on all three |
| Narration intact | **PASS** — **0.00 dB** delta vs source mp3 on all three |
| Subtitles in sync | **PASS, both paths.** Soft: first cue `00:00:00,100`, identical in sidecar and embedded track. Burned/ASS: verified inside the Docker image, which does ship libass — see below |
| Storage | **PASS** — 67.3 KB/s → **53.6 MB** for an 816 s chapter, against the 53 MB predicted |
| Bed cache | **PASS** — **1 bed, 3 cards** for 3 segments, confirming the bed keys on accent and not on the book |
| fps threaded | **PASS** — output is `15/1`; a silent failure of T7's fps threading would have produced `5/1` |
| Degrade path | **PASS** — with `HYPERFRAMES_PATH` broken, a segment whose stored params carry `template_id: "classic"` **completed** via the still path at `5/1` with `WARNING … this host cannot render HyperFrames compositions; rendering the plain still`. `book_templates` served `[]`, so the UI hides the control |
| No leaked Chrome | **PASS** — 7-process tree (1 CLI + 6 Chrome), 0 survivors at +3/+6/+12 s, attributed per-pid. An earlier FAIL here was a measurement error; see the retraction below |
| Docker parity | **PASS** — see the Docker section below |

### RETRACTED: the "Chrome leak" was a measurement error

An earlier revision of this document reported a confirmed Chrome leak — 18 orphaned
processes holding 3.67 GB after an aborted render. **That finding was wrong and is
withdrawn.** No leak exists.

What actually happened, in order, because the failure mode is instructive:

1. `pgrep -fc -i chrome` returned counts that looked clean. The pattern was matching Claude
   Code's own processes, whose command lines contain `mcp__claude-in-chrome`. Useless signal.
2. Switching to `chrome-headless-shell` showed 12 processes at "baseline", 19 at peak, 19
   after abort — read as a leak of the 7 new ones.
3. It was not. Inspecting the tree showed
   `npm exec hyperframes render --output renders/part-06.mp4 -w 8 --gpu --quiet` — **another
   Claude Code session on the same machine, running its own renders.** This project's renders
   write to a scratchpad and never pass those flags. A `PPID 1` root, treated as proof of
   orphaning, turns out to be normal for an npm-exec'd render.
4. Re-measured with per-pid attribution — find this render's own CLI by a unique output tag,
   enumerate only its descendants, abort, then check whether *those specific pids* die. Result:
   a 7-process tree (1 CLI + 6 Chrome), **0 survivors at +3 s, +6 s and +12 s.**
5. Counterfactual, to prove the measurement rather than the patch: the descendant-sweep fix was
   temporarily disabled and the same test re-run on the pre-fix code. **Also 0 survivors.**
   T2's group kill was correct all along; the patch was reverted.

**The rule this yields: on a shared machine, never measure by process-name pattern.** Attribute
to your own pid tree, and always run the counterfactual before believing a fix worked — a green
result after a change proves nothing if the same result appears without it.

Collateral damage worth recording: acting on the false finding, a broad `pkill -9 -f
chrome-headless-shell` was run, which killed ~18 processes belonging to another session's
in-flight renders. Broad pattern kills have no place on a shared host.

`terminateGroup` therefore keeps its original shape, now with a comment recording that the
`setsid` + negative-pid pair is load-bearing and verified by the counterfactual above.

---

## Rollback

Everything is gated on `template_id`, which defaults to `""`.

- **Per book:** clear `template_id` in `render_params` and re-render. No migration.
- **Per deployment:** remove Chrome from the image. `hyperframesAvailable()` returns false,
  the dropdown empties, and every book renders through the still path.
- **Full revert:** the change is additive across 12 files with no schema migration and no
  data rewrite. Existing rendered videos are untouched.

## Whole-feature acceptance

1. A book rendered with no template produces the identical ffmpeg argument list it does today
   (asserted by the unmodified `buildStillArgs` tests, not by inspection).
2. A book rendered with `classic` produces segments of unchanged duration, in-sync subtitles
   on both caption paths, intact narration, and ~2× today's storage.
3. A templated short records non-null `audio_path` and `subtitle_path`.
4. A host without Node or Chrome renders every book exactly as it does today, with a log line
   and no failures.
5. `docker compose build` produces a working image and its size delta is recorded.

### Docker parity and burned captions (executed 2026-08-20)

Both checks needed the image, because this development host's ffmpeg has no libass and
therefore can never exercise the burn path.

**Environment inside the image:** Node v22.23.2 · ffmpeg 7.1.5 · **libass present** ·
`/dev/shm` 1.0 G under compose (a bare `docker run` shows 64 M — compose's `shm_size` is what
supplies it) · 18 woff2 faces baked into the font cache · Chrome resolved to
`/usr/bin/chromium`, the arm64 fallback T5 documented · templates copied in.

**Parity — structurally identical, visually indistinguishable, not bit-identical.** The same
bed composition rendered host-side and container-side gives the same 1920×1080, 15 fps, 300
frames, 20.000 s, and **PSNR 45.3–46.4 dB** between them at t=0/5/10/15. For scale, two
*adjacent frames of the same render* score 46.2–46.8 dB — so the host/container difference is
no larger than one frame of the animation's own motion. File sizes differ (13.3 MB vs
12.1 MB). This is exactly the consequence T5 flagged: arm64 substitutes Debian chromium for
the pinned chrome-headless-shell, so **releases should still be rendered on amd64** if
byte-reproducibility ever matters. Container render was ~2× slower (1 m 40 s vs 48 s).

**Burned captions work and are legible.** The exact argument list from `buildStillArgs`
(bed + card + real narration + an ASS written by the pipeline's own `writeAssFile` with its
real styling — Microsoft YaHei 60, white on black outline) was executed inside the container.
Verified by looking at the frames, not by exit code:

- Over the moving bed: captions sit in the darkened lower third the bed's `caption-scrim` was
  designed to provide, and read cleanly against the accent glow.
- **Over the card:** captions render *on top of it*. This confirms T4's decision to append
  `subtitles=` after the overlay in the chain — placed before it, the opaque card would have
  hidden the first seconds of every chapter's captions, on every book.

**The image must be rebuilt after the `parseDoctorOk` fix, and this nearly shipped broken.**
The first parity run reported `hyperframesAvailable(): false` inside the container. That was
not a bug in the fix — the image had been built at 14:04, before the fix existed at 16:49, and
carried the old `.ok` gate. Rebuilt, the same image reports `parseDoctorOk() true`,
`hyperframesAvailable() true`, `supportsAssBurn() true`. Worth noting how close this came to
being missed: every host-side test was green, and only running in the container exposed that
the shipped artifact disagreed with the source.

## Found during execution

**The exact `hyperframes@0.8.4` pin was only half-effective, because `bun.lock` was
gitignored.** T5 could not fix this — it was scoped to three files and the lockfile was not
one of them — and the ticket it filed prescribed "commit the updated bun.lock", which was
impossible: `.gitignore:15-16` listed `bun.lock` and `bun.lockb` alongside `node_modules`,
`dist`, `.vite` and `*.tsbuildinfo`, and no lockfile had ever been tracked in this repo's
history.

Why it mattered: an exact version in `package.json` fixes the CLI itself and nothing beneath
it. `hyperframes@0.8.4` declares its own dependencies with carets — `puppeteer-core ^25.2.1`,
`sharp ^0.35.0`, `esbuild ^0.25.12` — so without a committed lockfile a clean clone or CI
resolves them fresh at build time. `puppeteer-core` is what drives Chrome, which is the one
dependency a deterministic renderer cannot afford to float.

The Dockerfile had already papered over the absence: the runtime stage falls back from
`bun install --frozen-lockfile --production` to a plain install plus a production-only
reinstall, which kept builds green while quietly giving up reproducibility. Note that bun
1.3.14's `--production` implies a frozen lockfile with no CLI or env opt-out, so the lockfile
has to be correct rather than bypassed.

Resolved by tracking it (commit `b062c3f`): the two lines removed from `.gitignore`, the
lockfile committed. Verified — both `bun install --frozen-lockfile` and
`--frozen-lockfile --production` exit 0, `hyperframes` still resolves to 0.8.4 afterwards, and
the frozen fast path succeeds inside the built image.



**Gating on `doctor --json`'s `.ok` would have shipped the feature dead. This was a spec
error, not an agent error** — the design spec said "Gate on its payload: `jq -e '.ok'`",
copied from generic CI guidance.

`.ok` is the aggregate of every check the CLI can run, including three optional local media
fallbacks — `whisper-cpp`, `TTS (Kokoro)`, `BGM (MusicGen)` — that VidGen deliberately
replaces with its own, plus `Docker` / `Docker running`, which matter only for
`render --docker`. Measured on this development machine and independently inside T5's image:
**`.ok` is false while Node.js, Chrome, FFmpeg and FFprobe are all ok.**

`hyperframesAvailable()` would therefore have answered false on essentially every realistic
host, every book would have quietly rendered as today's still, and nothing would have looked
broken. T2 and T5 both hit it from opposite directions and neither could fix it — T2 was
correctly implementing the spec, T5 does not own the module. Fixed at the integration gate:
`parseDoctorOk` now requires `Node.js`, `Chrome`, `FFmpeg` and `FFprobe` specifically, falling
back to `.ok` only when a payload carries none of them. All six pre-existing assertions still
pass.

**T5's acceptance criterion is amended accordingly.** "`doctor --json` reports `.ok: true`" is
the wrong gate for this image and is replaced by: the Chrome and FFmpeg checks report ok, and
the optional media/Docker checks are expected to fail.

**The integration render test had never executed, and its fixture was invalid.** It skipped on
every host until the binary landed. Once it ran, it failed: the stub composition omitted
`data-composition-id` and `data-start`, so the compiler could not identify the root, fell back
to a default frame size, and rejected the render with a "composition is portrait (1080×1920)"
error from a file declaring 1920×1080. A test that cannot run cannot validate its own fixture.
Fixed and now genuinely passing — a real composition renders, probes as real video, and the
cache-reuse path is exercised.

**The short template carries `data-duration` on two elements, and retiming must patch both.**
`resource/hyperframes/classic/short/index.html` declares `data-duration="24"` on the root
*and* on its full-span `#short-scene` clip (a clip's own duration is required, so this is
correct authoring, not a mistake). The T0 instruction said only "patch `data-duration` on the
root element" — which would have left every short longer than 24 s **blank after 24 seconds**.
T6 found it by reading the template rather than following the instruction, and
`retimeComposition()` now rewrites every `data-duration` equal to the root's. Verified: a
retime to 47.5 s leaves no `"24"` behind.

**`stopAt: "subtitle"` does not return `audio_file`.** `pipeline.ts:347-357` sets only
`subtitle_path`, so the templated short path locates narration by convention at
`join(taskDir(taskId), "audio.mp3")`, guarded by `existsSync` with a degrade. This is the
sharpest edge in the shorts design and is commented as such at the call site.

**Templated shorts need caption handling of their own.** The stock path gets captions inside
`generateFinalVideos`, which the templated path replaces. Without an explicit ASS-burn /
soft-mux step, every templated short on a no-libass host — i.e. this development machine —
would have shipped with no captions at all.

**AI-generated music does not reach a templated short.** `sonilo` and `elevenlabs` tracks are
produced inside `generateFinalVideos`; `getBgmFile("sonilo", "")` returns `""`. Library and
`random` tracks work exactly as before. The short logs the reason rather than shipping
unexplained silence. Closing this means lifting music generation out of that stage — out of
scope here, worth a follow-up.

**`template_accent` is not validated at the API boundary.** `bookRenderRequestSchema` types it
as a plain string with default `""`, so any value survives zod, is persisted on
`book.render_params`, and would reach a composition's CSS. T7 added
`resolveTemplateAccent()` in `bookPipeline.ts`, which refuses anything that is not `#rrggbb`
and falls back to the template's own `defaultAccent` with a warning — verified by probe
against `red`, `#fff`, `url(x)`, `javascript:alert(1)` and `#12345g`.

That guard is at the right layer and closes the hole for the render path. Tightening the zod
schema to a hex pattern as well would be defence in depth and is a cheap follow-up; it was not
done because T3 had already completed and the downstream guard is sufficient.

## Known gaps carried into execution

- **The design spec never had its independent Codex review** — rate-limited at the time of
  writing. This plan inherits that gap. Worth spending it on the spec before Wave 1 rather
  than on this document.
- **Bed seam quality is unproven** until T0. It is the one risk no amount of plumbing
  addresses, which is why T0 blocks everything and ends at a human.
- **The pre-existing cover-cache bug** (`coverOverlay.ts:218` hashes `sourceKind`, not the
  cover's bytes) is tracked separately. T7 must not copy that pattern.
