# HyperFrames as a book-video render backend

Status: **design spec, not yet approved.** Scope confirmed 2026-08-20.

## Review status

| Check | Result |
| --- | --- |
| Independent Codex review (`codex exec --sandbox read-only`) | **Not done — blocked.** Codex hit its account usage limit and returned `You've hit your usage limit… try again at 3:40 PM`, while still exiting 0. This spec has *not* had the independent outside-context critique the process calls for. |
| Adversarial in-repo review | Done, as a substitute. Weaker: shares this session's model and repo access rather than reviewing cold. It read the **first** draft, so its findings on the prepend design independently corroborate what the ffmpeg testing found. All of its findings are folded in; five were re-verified against the source before being accepted. |
| Empirical verification | Done, on this machine. Every cost figure and every ffmpeg claim below was measured, not estimated. Three defects in the first draft were found this way and are corrected in place. |

**Decisions taken** (2026-08-20): bed kept at 15 fps / crf 26 / veryfast; template selection
stored on the book; one Docker image, accepting the ~500 MB growth.

---

## Problem

A book segment is currently one PNG held for the length of its narration.
`renderStillSegment()` (`server/src/services/video/still.ts:210`) is a single ffmpeg
invocation — `-loop 1 -framerate 5` over a cover image, narration muxed in, captions
burned or soft-muxed. Nothing on screen ever moves.

Measured on the checked-in library (`storage/tasks/Me Before You`): 74 segments,
13.96 hours of finished video, avg 11.3 min/segment, all 1920×1080 at 5 fps.

Book Shorts are the one exception — `bookShortsPipeline.ts` delegates to the ordinary
short-video pipeline, so a short gets generic Pexels/Pixabay stock footage that has
nothing to do with the book it came from.

We want designed motion in all three places, rendered by
[HyperFrames](https://github.com/heygen-com/hyperframes) (`hyperframes`, Apache-2.0),
which renders video from HTML compositions via headless Chrome.

## The constraint that shapes everything

Benchmarked on this machine (M-series, 6 workers, `hyperframes@0.8.4`):

```
10.0s of 1920×1080 @ 30fps  →  22.8s wall clock  (300 frames, ~76ms/frame)
```

**≈2.3× slower than realtime.** Rendering 13.96 hours of book body through Chrome is
~32 hours of compute per book. That number is not negotiable by tuning; it is the cost
of rasterising every frame in a browser.

So the design rule is: **HyperFrames renders short assets; ffmpeg still assembles the
long timeline.** Every placement below is chosen to keep the browser away from the
full narration length.

## Approach

Three deliverables, one shared renderer service, one new "template" concept.

### A — Chapter card, **overlaid on the opening, not prepended**

A 5–10s designed title card per segment: book title, chapter title, author, cover art,
template accent. Rendered by HyperFrames with a transparent tail, then composited over the
**first seconds of the body** in the same ffmpeg pass — not joined ahead of it.

This is a correction to the obvious design, and it is forced by three things found while
testing the prepend approach:

1. **Prepending silently destroys the narration.** A HyperFrames card has no audio track.
   Fed to the concat demuxer with `-c copy` — which `concatVideoClips()` tries first
   (`concat.ts:37`) — ffmpeg drops the body's audio stream entirely, logs one
   `New audio stream with index 1` line, and **exits 0**. Verified: the joined file came
   out 125s, video-only, no narration. This would have shipped silent audiobooks.
2. **Matching the card's audio doesn't fully fix it.** Giving the card an `anullsrc` track
   still produced non-monotonic-DTS warnings at the seam, and the card's audio must match
   the narration's *probed* rate and layout — which is 24 kHz mono for this TTS, not
   44.1 kHz stereo. `still.ts:232` already reuses the probed rate for exactly this reason.
3. **Prepending desyncs every subtitle.** Cues are narration-relative and start at
   `00:00:00,000` (verified in a real segment SRT). A 10s card ahead of the body puts every
   cue 10s early, in both the burned ASS and the soft-muxed SRT.

Overlaying dodges all three: total duration is unchanged, so cues stay correct; the
narration is never re-muxed, so it cannot be dropped; and there is no seam to desync.

It is also **better creatively**. The narration already *speaks* the book and chapter title
in its first ~3.5s — `announcementLines` (`bookPipeline.ts:395-399`); a real segment's cues
read "Me Before You" at 0.0-1.8s, "Chapter 1" at 1.8-3.5s. A card timed to sit under that
announcement matches what the listener is hearing. A card *before* it says everything twice.

Mechanically it is one extra input and an `overlay=…:enable='between(t,0,N)'` on the
existing filter graph — the same construct `generate.ts:225` already uses for caption
overlays. Verified end to end in a single pass: 120s output, both streams intact, narration
measured at −19.8 dB under the card and −19.6 dB mid-chapter against −20.0 dB in the source.

Cost: ~20s render per card (5-10s at 1080p). 74 segments ≈ 25 min/book, backgroundable.
`concatVideoClips()` is **not** used, and `concat.ts` is not touched.

### B — Motion bed for the chapter body

**This is where the 32-hour problem gets solved.** HyperFrames renders a short
**seamless loop** — a 20s "motion bed" of drifting gradient, grain, cover-art parallax,
whatever the template specifies — and ffmpeg loops it under the narration with
`-stream_loop -1`, exactly the way `buildStillArgs()` already loops a BGM track
(`still.ts:162`).

The bed depends only on (template, aspect, accent, cover art) — **not** on chapter title,
which lives on the card. So it is rendered **once per book** and reused across all
segments, cached by content hash the way `coverOverlayCacheName()`
(`services/book/coverOverlay.ts:218`) already caches cover overlays.

Cost: ~46s **per book**, not per segment. Against ~32 hours for a naive full-length
render, this is the entire viability argument for including the body at all.

Mechanically: replace the `-loop 1 -framerate N -i cover.png` input pair (`still.ts:145-150`)
with `-stream_loop -1 -i bed.mp4`. This is a **second argument shape, not a path swap** —
`-loop`/`-framerate` must be removed, not retargeted. The existing `-stream_loop -1` at
`still.ts:162` is not the same case: it applies to an audio-only input bounded by
`amix=…duration=first`, whereas a looped *video* input is bounded by `-t`/`-shortest`.

**Four corrections are mandatory, and none is optional polish:**

- **`fps` is never plumbed, and fails silently.** The `still` object at
  `bookPipeline.ts:489-499` does not set `fps`, so `renderStillSegment` defaults it to
  `STILL_FRAMERATE = 5` (`still.ts:232`). Drop a 30 fps bed in without threading `fps`
  through and it is decimated to 5 fps with **no error** — a juddering bed and a green
  build. `buildFitFilter` (`clip.ts:58-64`) carries no `fps=` either, so nothing else
  catches it.
- **`-shortest` with an infinite video loop can wedge.** `-shortest` is pushed
  unconditionally (`still.ts:204`) and `-t` is *omitted* when the narration probe returns
  no duration (`still.ts:203`, warned at `:220`). Today that pairs `-shortest` with a cheap
  PNG loop and is harmless. Paired with `-stream_loop -1` on a video it is the classic
  non-terminating case — and a wedged encode holds a `BookConcurrencyGate` slot. **`-t` must
  become mandatory whenever `bedPath` is set**; refuse the bed and fall back to the still
  if the duration is unknown.

- **`-tune stillimage` must be dropped when the input is a bed.** `buildStillArgs()` applies
  it unconditionally for libx264 (`still.ts:183`). It is correct for a held PNG and actively
  wrong for moving content.
- **`codecQualityArgs()` defaults are wrong for a bed.** It returns
  `-preset medium -crf 23` for libx264 (`codec.ts:130`), tuned for stills. The body needs
  its own quality profile.

Measured, encoding 120s of body from a looping bed and extrapolating to a 816s segment and
a 74-segment book (sizes are deterministic; **timings are noisy — another job was running
concurrently — and should be treated as indicative only**):

| Body config                          | MB / segment | GB / book | Encode / 120s |
| ------------------------------------ | ------------ | --------- | ------------- |
| **static still, 5 fps — today**      | **26.5**     | **1.9**   | —             |
| 30 fps, `stillimage` tune, crf 23    | 124–150      | 9–11      | 12–48s        |
| 30 fps, crf 28, veryfast             | 52           | 3.7       | 21s           |
| **15 fps, crf 26, veryfast** ←       | **53**       | **3.8**   | **5s**        |
| 12 fps, crf 28, veryfast             | 42           | 3.0       | 10s           |

The naive reading — keep the existing encoder settings, raise fps to 30 — costs **5–6×
today's storage**, roughly 10 GB per book. Choosing `15 fps / crf 26 / veryfast` instead
brings it to **~2× today's storage** for a body that genuinely moves. Note the lever that
matters is the *preset and crf*, not the frame rate: 30 fps at crf 28 is no larger than
15 fps at crf 26.

Storage is therefore the honest cost of placement B: **~1.9 GB → ~3.8 GB per book.** That
belongs in the decision, not in a footnote.

### C — Book Shorts rendered entirely in HyperFrames

Replace the stock-footage *picture* in `runShortRender()` (`bookShortsPipeline.ts:436`) with
a HyperFrames composition driven by the short's own `hook` / `script` / `chapter_title` —
kinetic typography over the book's cover art instead of an unrelated Pexels clip.

**This is a re-plumb, not a branch.** The obvious framing — "branch on `template_id`:
HyperFrames, or the existing `runPipeline`" — is wrong, because **HyperFrames does not do
TTS**. `runShortRender` calls `runPipeline({ stopAt: "video" })` (`bookShortsPipeline.ts:463`)
and then reads `result.videos`, `result.audio_file` and `result.subtitle_path` to write
`patchBookShort` (`:479-487`) and feed `scheduleAutoYoutubeUpload`. Swapping the whole
pipeline out discards narration, subtitles and BGM along with the stock footage, and leaves
`audio_path` / `subtitle_path` null on every templated short.

The real shape is:

1. `runPipeline({ stopAt: "subtitle" })` — the stage exists (`pipeline.ts:347`). Keeps TTS,
   cues and BGM resolution exactly as they are.
2. Render the composition, **told how long to be** by the probed narration duration.
3. Composite picture + narration + captions, reusing the existing muxing.

Two consequences the first draft missed:

- **`CompositionRenderOptions` needs a duration input.** A card is a fixed 5-10s; a short is
  exactly as long as its TTS, which varies with script, voice and `voice_rate`. A composition
  with no way to be told its length cannot carry a short. This also means `scriptText` cannot
  be laid out as fixed-timing text.
- **`hook` and `chapter_title` do not currently reach the renderer.**
  `videoParamsForBookShort` (`bookSchema.ts:388-413`) threads `title` and `script` only; both
  other fields exist on `BookShortDocument` (`db/types.ts:426`, `:438`) and are dropped.

Cost: ~2.3 min per 60s short (1080×1920 is the same pixel count as 1080p, so the measured
76 ms/frame applies directly). Still the placement HyperFrames is actually built for.

The existing stock path stays reachable; the template choice selects between them.

---

## Data model

### Templates are files, not LLM output

A template is a HyperFrames project directory checked into the repo:

```
resource/hyperframes/
  <template-id>/
    card/index.html      # A — chapter card
    bed/index.html       # B — looping motion bed
    short/index.html     # C — book short
    template.json        # id, label, which parts it provides, variable contract
```

Each `index.html` declares its inputs on the root element with
`data-composition-variables`, and binds them with `data-var-text` / `data-var-src`. No
model writes composition HTML at render time — renders stay deterministic, reviewable and
unit-testable, and a template ships or it doesn't.

Variable contract (the union across parts; each part declares the subset it uses):

| id             | type   | Source                                        |
| -------------- | ------ | --------------------------------------------- |
| `bookTitle`    | string | `BookDocument.title`                          |
| `bookAuthor`   | string | `BookDocument.author`                         |
| `chapterTitle` | string | `BookSegmentDocument.title`                   |
| `coverImage`   | string | resolved cover path (file URL)                |
| `accent`       | color  | `render_params.template_accent`               |
| `language`     | string | `BookStructure.language`                      |
| `hookText`     | string | C only — `BookShortDocument.hook`             |
| `scriptText`   | string | C only — `BookShortDocument.script`           |

### New render params

Three fields, added in the four places the codebase already requires for any book render
setting:

| Field              | Type                              | Default | Meaning                             |
| ------------------ | --------------------------------- | ------- | ----------------------------------- |
| `template_id`      | string                            | `""`    | `""` = today's static still exactly |
| `template_parts`   | `("card" \| "bed")[]`             | `[]`    | Which parts to apply to the body    |
| `template_accent`  | string (hex)                      | `""`    | `""` = template's own default       |

The bed's encoder profile is **not** a render param — it is a property of the template
(`template.json`), because it is a quality/size trade the template author makes, not one a
user should be asked about in a render form. Defaults from the measurements above:
`fps: 15`, `crf: 26`, `preset: "veryfast"`. When `template_parts` omits `"bed"`, none of it
applies and the body encodes exactly as it does today.

Touch points (this is the established pattern for `bgm_*` and `burn_*_title`):

1. `bookRenderRequestSchema` — `server/src/models/bookSchema.ts:202`
2. `BookRenderParamsDocument` — `server/src/db/types.ts:221`
3. `renderParamsToDocument` — `server/src/models/bookSchema.ts:243`
4. `RenderPanel.tsx` form + `BookRenderRequest` in `web/src/book/api.ts:144`

All three default to the empty/no-op value, so **a book rendered before this ships and
re-rendered after it ships is handed identical ffmpeg arguments.** That rule is why
`burn_book_title` defaults to `false`; it applies here for the same reason.

Note the claim is *identical arguments*, not identical bytes — byte-comparability is not
achievable in this codebase and never was. `bgm_type: "random"` redraws a track at render
time by design (`bookPipeline.ts:481-483`), `disableRuntimeVideoCodec` (`codec.ts:95`) can
change the encoder between runs on the same host, and x264 is not bit-identical across
`-threads` counts.

Shorts get the same `template_id` on `BookShortsRenderParamsDocument`
(`db/types.ts:374`) + `bookShortsRenderRequestSchema` (`bookSchema.ts:354`).

`BookSegmentDocument` gains **nothing**. Per-segment visual override is explicitly out of
scope (see below).

### Cache

Rendered compositions land in `storage/books/<bookId>/hyperframes/` keyed by a content hash
of `(template_id, part, variables, width, height, fps)`. The bed is the one that matters:
hit rate should be ~1 render per book, and a cold cache is the difference between 46 seconds
and 57 minutes.

Modelled on `coverOverlayCacheName()` (`coverOverlay.ts:218`) in *shape* but with one
deliberate departure: **the cover's bytes are hashed, not its `sourceKind`.** That is not
what the existing helper does — it hashes `sourceKind: "upload" | "blank"` and never reads
the file. Which means there is a **live bug in the current code**: replace a book's cover
and every segment reuses the stale burned overlay PNG. Worth fixing separately; do not copy
it here.

Two mechanics the model also lacks:

- **Atomic writes.** `bookPipeline.ts:319` writes straight to the final path
  (`Bun.write(overlayPath, png)`). Do that with a bed and a crash or timeout mid-write leaves
  a truncated `bed.mp4` at a *valid* cache key, silently reused by every later segment
  forever. Write to a temp name and rename.
- **Eviction.** Nothing prunes the directory; every accent, template and aspect experiment
  leaves a bed behind. Evict on `template_id` / accent change and on book delete.

---

## API surface

### New service — `server/src/services/video/hyperframes.ts`

```ts
export interface CompositionRenderOptions {
  templateDir: string;               // resource/hyperframes/<id>/<part>
  variables: Record<string, string>; // the declared contract, values only
  outputFile: string;
  width: number;
  height: number;
  fps?: number;                      // default 30
  quality?: "draft" | "high";        // default "high"
  workers?: number;                  // default 2, see concurrency below
  timeoutMs?: number;                // default 10 min, hard kill
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface CompositionRenderResult {
  outputFile: string;
  duration: number;                  // probed, not declared
  cached: boolean;
}

export function buildRenderArgs(options: CompositionRenderOptions): string[]; // pure, testable
export async function renderComposition(options: CompositionRenderOptions): Promise<CompositionRenderResult>;
export async function hyperframesAvailable(): Promise<boolean>;               // gates the UI
```

Mirrors the shape of `still.ts` deliberately: a pure argument builder for unit tests and an
async runner that probes its own output.

**`hyperframesAvailable()` must *not* copy `supportsAssBurn()`.** That helper
(`services/video/capabilities.ts`) is a process-lifetime memoised promise
(`filterProbe ??= probeFilters()`) that caches failure as an empty set — fine when the probe
is one `ffmpeg -filters` spawn against a static binary. Here the probe means launching Node
and Chrome, and the thing being probed can *die*: a Chrome that OOMs is never re-detected,
and every later segment then fails against a cached `true`. Use a TTL'd probe that
re-evaluates, and treat a render failure as invalidating it.

### Changed — `StillSegmentOptions` (`still.ts:30`)

Three additive optional fields. Every one absent = today's behaviour, byte for byte.

```ts
  /** Looping motion bed. Replaces the held still; `imagePath` stays the fallback. */
  bedPath?: string;
  /** Card composited over the opening, normally under the spoken announcement. */
  cardPath?: string;
  /** Seconds the card is visible, incl. its own alpha fade-out. */
  cardDuration?: number;
```

`buildStillArgs()` gains two branches, and both are covered by its existing pure-function
test seam:

- `bedPath` set → `-stream_loop -1 -i <bed>` instead of `-loop 1 -framerate N -i <png>`,
  **and `-tune stillimage` suppressed** (`still.ts:183`), and the bed quality profile used
  instead of `codecQualityArgs()`.
- `cardPath` set → one more input plus
  `[card]format=yuva420p,fade=t=out:alpha=1[c];[bed][c]overlay=0:0:enable='between(t,0,D)'`,
  spliced ahead of the existing caption/fit chain.

The audio side of the graph — narration map, BGM `-stream_loop` mix, `-t`, `-shortest`,
probed sample rate — is **not** touched by either branch. That is the invariant that keeps
the narration safe.

`hyperframes` becomes a pinned dependency in `server/package.json` and is invoked from
`node_modules/.bin/hyperframes` — **never `npx …@latest`**, which would hit the network
mid-render and could change renderer behaviour between two segments of the same book.

### HTTP

No new endpoints. `GET /api/v1/settings/metadata` (`routes/v1/settings.ts:46`) gains a
`book_templates` array — id, label, available parts, default accent — alongside the
`fonts` / `video_aspects` enumerations it already serves. That is the existing mechanism
for "what may the UI put in this dropdown".

### Pipeline wiring

- **A + B**: inside `runSegmentRender()`, between the cover resolve (`bookPipeline.ts:456`)
  and the render call (`:502`). Both compositions are resolved *before* the render and
  handed to `renderStillSegment()` as new options — the bed replaces `imagePath`, the card
  becomes an overlay input. **One ffmpeg invocation still produces the segment**, which is
  the property the whole file was written to preserve (`still.ts:1-9`). Nothing is added
  after the render; the soft-sub mux at `:526` is untouched.
- **C**: `runShortRender()` (`bookShortsPipeline.ts:463`) branches on `template_id` —
  HyperFrames composition, or the existing `runPipeline({ stopAt: "video" })`.

### Progress

`hyperframes render --json` emits capture progress events. Wire them into
`updateTask(taskId, { progress })`, which the SSE projection at `routes/v1/book.ts:1638`
already streams to the UI.

**Correcting the first draft, which had this backwards.** The dead zone between 71.5% and
100% (`SYNTHESIS_PROGRESS_SHARE`, `bookPipeline.ts:74`) *is the ffmpeg encode* — the
multi-minute part. The card render is ~20s and the bed is cached to roughly once per book,
so HyperFrames progress fills **seconds of a minutes-long silence**, and the bed makes that
silence *longer*, not shorter. If the dead zone is worth fixing, the thing to instrument is
the ffmpeg encode (parse `-progress` output), not the composition render. Composition
progress is worth wiring for the *first* segment of a book, where the cold-cache bed render
is genuinely the long pole.

**Throttle it.** `updateTask` is an unthrottled Mongo `updateOne` upsert per call
(`state.ts:72-86`). Piping per-frame `--json` events straight in is 300+ writes per card ×
74 cards per book. Coalesce to a fixed interval or a percentage delta.

---

## Runtime and packaging

The runtime image is `oven/bun:1.3-debian` with ffmpeg and fontconfig. HyperFrames needs
**Node.js ≥ 22** and a **Chrome** binary. Both go into the image (decided: local render,
not HeyGen cloud).

```dockerfile
# Node 22 via nodesource — hyperframes' CLI is Node, not Bun
# Chrome runtime libs: libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0
#                      libxcomposite1 libxdamage1 libxfixes3 libxrandr2
#                      libgbm1 libasound2
# Pinned Chrome pulled at BUILD time so no render ever downloads:
RUN node_modules/.bin/hyperframes browser ensure
```

Image grows roughly 500 MB. Two container-specific gotchas:

- **`/dev/shm`** — Chrome's default 64 MB in Docker causes tab crashes at 1080p.
  `docker-compose.yml` needs `shm_size: 1gb`.
- **Fonts** — Chrome font-falls-back where `@napi-rs/canvas` does not, but only to fonts
  that exist in the image. Non-Latin book text needs Noto in the container; the existing
  `resource/fonts` scan is for ASS, not for Chrome. See the note in
  `vidgen-subtitle-font-script-coverage` — pull `full/ttf/`, not `hinted/`.

`hyperframesAvailable()` gates the whole feature: on a host without Node or Chrome the
template dropdown is empty and every book renders exactly as it does today.

---

## Failure modes

| Failure | Handling |
| --- | --- |
| **Chrome process storm.** `BOOK_SEGMENT_CONCURRENCY = 2` × 6 render workers = 12 Chrome processes, on top of `max_concurrent_tasks` ffmpeg jobs. | Default `workers: 2`, and put composition renders behind their own semaphore — the same shape as `BookConcurrencyGate` (`bookPipeline.ts:91`). Sized in config, not hardcoded. |
| **Hung browser.** A composition that never signals render-ready blocks the segment forever. | `timeoutMs` hard kill, wired to the existing per-task `AbortSignal`. On timeout fall back to the static still and log it, the way BGM failure already degrades at `bookPipeline.ts:511`. |
| **Body storage cost.** Measured: a moving body is 42–150 MB/segment against today's 26.5 MB, i.e. 3–11 GB per book against 1.9 GB. | Settled by measurement, not deferred: bed at **15 fps, crf 26, preset veryfast**, `-tune stillimage` dropped. Lands at ~2× today. Exposed as template fields so a template can trade quality for size. The bed stays opt-in per book via `template_parts`. |
| **Silent-failure concat.** A card prepended with `-c copy` drops the narration and exits 0. | Designed out — the card is an overlay, `concatVideoClips()` is never used. Retained here because it is the trap anyone re-reading this plan will fall into. |
| **Subtitle desync.** Any change that shifts narration away from t=0 invalidates every cue in both the ASS and the SRT. | Designed out by overlaying rather than prepending. **Invariant to hold: the body's t=0 is the narration's t=0.** Any future outro/interstitial must either sit inside the narration length or shift `narration.cues` before `writeSrtFile` (`bookPipeline.ts:446`) *and* `writeAssFile` (`:474`). |
| **Bed loop seam.** A bed whose last frame doesn't match its first will visibly jump every 20s for 11 minutes. | Seamlessness is a template authoring requirement, verified by a `hyperframes snapshot` assertion at t=0 and t=duration in the template's own test. Not something the runtime can check. |
| **`hyperframes@0.8.4` is pre-1.0.** | Pin the exact version. No `@latest` anywhere in the server. Upgrades are a deliberate PR with a re-render diff. |
| **Cache poisoning across revisions.** A book whose cover changes must not reuse the old bed. | Cover file hash is an input to the cache key, not the cover *path*. |
| **Stale render after revision bump.** A bed render plus a card render widens the window `shouldCommitSegmentResult()` guards. | Correct already — the revision gate at `bookPipeline.ts:530` covers it, and composition renders check `signal.aborted` between parts. Not a correctness risk; a *cost* one, since more discarded Chrome work is thrown away at `:531`. |
| **Orphaned Chrome on cancel.** `runFfmpeg` aborts with `proc.kill()` on the direct child (`ffmpeg.ts:64`) — that signals the pid, not the process group. Correct for ffmpeg; for a Node CLI that spawns Chrome it leaves zygote, GPU and renderer processes alive. Cancel a 74-segment book and you leak Chrome trees. `timeoutMs`'s "hard kill" has the identical hole. | Spawn detached and kill the process group, and reap on both abort and timeout. This is a genuinely new requirement, not a reuse of the ffmpeg path. |
| **Disk headroom.** A segment already writes `segment-silent-subs.mp4` then `videoFile` (`bookPipeline.ts:479`, `:514-524`). At bed bitrates, × `BOOK_SEGMENT_CONCURRENCY = 2`, into a bind-mounted `./storage`. | Check free space before starting a bed render and degrade to the still if short. Nothing accounts for disk anywhere in the codebase today. |
| **`template_id` outlives the host that could render it.** It is persisted on `book.render_params` (`bookPipeline.ts:641`). A book saved on a capable host and later re-rendered — or recovered by `tasks/recovery.ts` — on a host with no Node/Chrome hits a server path the UI gate never sees. | `hyperframesAvailable()` is checked in `runSegmentRender`, not just in the settings endpoint. On a miss: log it, fall back to the static still, and complete the segment. Never fail a chapter over a missing template. |

---

## Test impact

`buildStillArgs` is called from **17 places** in `server/test/longform-video.test.ts`, and
two of them assert exactly what the bed changes:

```ts
:634  expect(buildStillArgs(input, "libx264")).toContain("stillimage");
:641  expect(buildStillArgs(input, "libx264").join(" ")).toContain("-crf 23");
```

Both stay correct for the still path and must gain bed-path counterparts asserting the
opposite — `stillimage` absent, the bed quality profile present. Because the bed is a new
argument shape rather than a path swap, the existing block needs a parallel `describe` for
the bed rather than edits in place. New assertions required, at minimum:

- `bedPath` set → `-stream_loop -1` present, `-loop 1` and `-framerate` absent
- `bedPath` set + `duration === 0` → bed refused, still path taken (the `-shortest` wedge)
- `cardPath` set → overlay chain present, audio maps and `-t`/`-shortest` byte-identical to
  the no-card case (the narration-safety invariant)
- `fps` threaded from the template, not defaulted to `STILL_FRAMERATE`

## Explicitly not doing

- **No full-length HyperFrames body render.** Named because it is the obvious reading of
  "animate the chapter" and it costs ~32 hours per book. The looping bed is the substitute.
- **No LLM-authored compositions.** Templates are checked-in files. A model choosing HTML
  per book would make renders non-reproducible and untestable.
- **No cloud rendering.** `hyperframes cloud render` / Lambda / Cloud Run are out; local
  Chromium was chosen. No HeyGen credential enters this codebase.
- **No per-segment visual overrides.** One template per book, as with every other book
  render param. `BookSegmentDocument` gains no visual fields.
- **No Studio / preview surface in VidGen's UI.** The book feature has no video player at
  all today (`SegmentsPanel.tsx:394` opens the mp4 in a new tab); adding one is separate work.
- **No change to the short-video product.** `/` and its pipeline are untouched.
- **No template authoring UI.** New templates arrive as PRs.

---

## Open questions for review

1. **Is the looping bed an acceptable reading of "animate the chapter body"?** It is one
   20s loop repeated ~34 times across an 11-minute chapter, identical across every chapter
   of the book. The alternative — per-chapter unique full-length motion — is the 32-hour
   number and is not on the table. If the loop reads as cheap, the honest answer is to drop
   placement B and keep A + C.
2. **Is ~2× storage per book acceptable?** ~1.9 GB → ~3.8 GB, measured. This is the real
   price of B, and it is paid on every book, forever, not once at render time.
3. Does the ~500 MB image growth need a separate `vidgen:slim` build for deployments that
   only use the short-video product?
4. Should template selection live on the book (one look per book, as specced) or on the
   render request (re-render a book in a different look without touching stored params)?
