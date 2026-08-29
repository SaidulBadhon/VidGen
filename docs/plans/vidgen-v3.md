# VidGen v3 — the pipeline becomes a value

Status: **design spec, revision 5. Scope and sequencing approved 2026-08-20; awaiting round-5 technical review.** Scope confirmed 2026-08-20.

Scope answers on record, from the requester:

- **Depth** — re-architect the core *and* extract a reusable engine package.
- **Pipeline state** — filesystem artifacts, with Mongo as an index rather than the pipeline's memory.
- **The uncommitted footage work** — folded in as a first-class body source, not a `bedPath` overload.

Decisions taken 2026-08-20, after review:

- **Package: sequenced.** `server/src/engine/` with an enforced import boundary from wave 1; extraction to a workspace package at wave 9, once the interfaces have stabilised against three recipes. Destination unchanged.
- **Sequencing: the footage-pool bug is fixed early** (wave 5a moves ahead of 4), so the architecture work carries a visible correctness win rather than fifteen invisible merges.
- **`python-version/` deletion is intentional** and lands as its own commit, unrelated to v3, before wave 0a. The baseline is re-taken after it lands.
- **Round-5 review is deferred, not skipped.** The implementation plan is written now; the spec's round-5 review and the implementation-plan review run together when Codex is available (2026-08-27).

## Review status

| Review | Status |
| --- | --- |
| Independent review (Codex, read-only, repo root) | **Round 1 done.** Found 4 factual errors, 2 broken load-bearing assumptions, 7 approval blockers. All 4 factual claims independently re-verified against source before accepting. This revision responds to every finding; see [What round 1 changed](#what-round-1-changed) |
| Independent review, round 2 | **Done. Verdict: do not approve.** Found the run-identity model unsound, `plan.json`'s justification false, waves 0/3/5/7 not credible, and the baseline stale. Every finding re-verified against source before accepting. Revision 3 responds; see [What round 2 changed](#what-round-2-changed) |
| Independent review, round 3 | **Done. Verdict: do not approve.** Accepted `plan.json`'s scoping and wave 0a's feasibility; named 5 mechanisms the spec owed and 1 factual error. Revision 4 responds; see [What round 3 changed](#what-round-3-changed) |
| Independent review, round 4 | **Done. Verdict: do not approve.** Categorised the remainder as 4 design gaps + 1 execution detail, and stated the architectural thesis needs no more prose. Found 5 factual errors, 2 of them mine and material. Revision 5 responds; see [What round 4 changed](#what-round-4-changed) |
| Independent review, round 5 | **Not done — blocked.** Codex usage limit reached; retry available 2026-08-27. Revision 5's four mechanism fixes are therefore **unreviewed**. Rounds 1–4 each found real defects in the preceding revision, so the prior on revision 5 containing at least one more is high. **Do not execute without it** |
| Adversarial in-repo review | Not done |
| **Net across rounds 1–4** | 11 factual errors found and corrected (5 of them material), 3 load-bearing assumptions withdrawn (`plan.json` as universal clock; run identity = `taskId`; "relocates nothing"), 2 false claims retracted (YouTube reconciliation; queue-rejection parity). The **architectural thesis survived all four rounds unchanged**; round 4 stated it needs no more prose |
| Empirical verification of the baseline | **Done** |

## Verified baseline

**Re-taken at revision 3.** Round 2 correctly caught that revision 2's baseline was stale — the tree moved while the spec was being written.

Run at HEAD `58c28b8`:

```
bun run typecheck             → exit 0
bun run --cwd server test     → 1004 pass, 0 fail, 2509 expect() calls, 23 files
```

Working tree: **119 deletions, all under `python-version/`** — the archived Python original is being removed — plus this spec, untracked. The stock-footage-under-narration work described in [§E](#e--body-sources-become-first-class) is **no longer uncommitted; it landed in `58c28b8`.** Every reference to it as "in-flight" is corrected below.

Any gate failure after this point is caused by this change, not inherited.

## What round 1 changed

Recorded rather than quietly folded in, because three of these were errors in my reading of the repo:

| Finding | Response |
| --- | --- |
| **`plan.json` cannot be an extraction.** Stock composition decides its timeline *during* rendering: `combine.ts:144` defaults `random = Math.random`, `:209` orders clips randomly, `:213-251` accumulates duration from *actually rendered* clips and skips failures, `:254` loops if short | **Accepted, and it reshapes the spec.** The universal-clock claim is withdrawn. See [§C](#c--a-narration-timing-artifact-not-a-composition-clock) |
| **"Same ffmpeg arguments" is too weak a gate** — misses randomness, probe results, Mongo writes, progress, warnings, cancellation, cleanup, cross-post. And `book-template-render.test.ts:264` compares `StillSegmentOptions`, not argv | **Accepted.** Acceptance is now a side-effect trace, and characterization tests move to wave 0b (behind a seam-extraction wave 0a). See [§ Test impact](#test-impact) |
| **Run granularity unresolved** — book renders target selected segments (`book.ts:1219`), a segment retries alone (`book.ts:1260`), every segment owns a task ID (`db/types.ts:351`) | **Accepted.** A run is now defined as one task-owning renderable unit. See [§ Identity](#identity-two-identities-and-no-relocation) |
| **`storage/runs` breaks the URL space** — media is served only from `storage/tasks` (`staticFiles.ts:116`), URLs minted only under it (`video.ts:38`), deletion removes `storage/tasks/<taskId>` (`video.ts:182`), renames rewrite absolute paths (`paths.ts:58`) | **Accepted.** The workspace now lives *inside* `storage/tasks/<taskId>/`. No new URL space, no new deletion path |
| **Waves 1, 4 and 5 are big-bang cutovers** wearing a strangler's clothes | **Accepted.** Rewaved with characterization first, dual-write, and a feature flag. See [§ Migration](#migration) |
| **The repo already writes atomic artifacts** — `taskArtifacts.ts` writes `script.json` atomically into the task dir; long-form TTS has a chunk manifest | **Correct, and my "intermediates are invisible" was overstated.** Rewritten as *the instinct exists and is applied unevenly* |
| **"Existing recovery tests" is false** | **Correct.** Verified: no file in `server/test/` references `recoverInterruptedTasks`, `recoverInterruptedBookSegments` or `resumeInterruptedBookRenders`. That is now a gap this plan must fill, not a safety net it can lean on |
| **The cover-cache bug is already fixed** — `coverFileFingerprint()` hashes stat/mtime (`coverOverlay.ts:232`) | **Correct.** Verified. The stale `:218` claim is deleted |
| **Health returns `version` too** (`ping.ts:16`) | **Correct.** Verified. Table corrected |
| **Docker copies only `server`/`web` manifests** (`Dockerfile:9,100,169`); root typecheck covers only those two (`package.json:16`) | **Accepted.** Now explicit packaging work |
| **Revision fencing is not replaceable by input hashes** (`bookPipeline.ts:807`, `:1020`) | **Accepted.** Fencing stays a distinct mechanism |
| **Recovery has three deliberate behaviours** — tasks fail, chapters resume, hook shorts fail because they are cheap (`recovery.ts:197`) | **Accepted.** "Replace the book-specific sweep" withdrawn |
| **`BookConcurrencyGate` holds book work *before* the global queue** so one book cannot take every slot (`bookPipeline.ts:104`) | **Accepted.** Admission fairness is now a named invariant |
| **Package boundary not yet earned** | **Accepted as sequencing**, surfaced to the requester rather than decided unilaterally |

## What round 2 changed

Round 2's verdict was **do not approve**, and it was right on every load-bearing point. Each was re-verified against source before being accepted.

| Finding | Response |
| --- | --- |
| **The run-identity model is unsound.** `taskId` is an *attempt* id — a fresh `getUuid()` per render and per retry (`bookPipeline.ts:1091`), and startup recovery creates more (`recovery.ts:315`). Segment work lives in a **stable** `bookSegmentDir(book.title, bookId, index, segment.title)` (`bookPipeline.ts:855`, `paths.ts:119`), and long-form TTS reuses prior chunks from that stable directory (`longform.ts:773`). Moving the workspace under `<taskId>` destroys chunk reuse on exactly the retry and crash paths where it matters | **Accepted; the model is replaced.** Two identities now, and **v3 relocates nothing.** See [§ Identity](#identity-two-identities-and-no-relocation) |
| **A run is not one video.** `video_count` permits several outputs per task (`schema.ts:128`), rendered in one loop (`pipeline.ts:523`) | **Accepted.** A run is an orchestration unit, not an output |
| **`plan.json`'s long-form justification is false.** There are already *two* narration clocks — summed per-chunk probes and a separate probe of the joined mp3, with drift explicitly tolerated and logged (`longform.ts:846`) — and `renderStillSegment` probes a *third* time for the encode (`still.ts:441`). With footage on, long-form visuals run the same dynamic `combineVideos` (`footage.ts:265`) | **Accepted.** `plan.json` is demoted from composition clock to **narration-timing artifact**. See [§C](#c--a-narration-timing-artifact-not-a-composition-clock) |
| **Wave 0 is hand-waving.** Both orchestrators import their effects directly (`pipeline.ts:25`, `bookPipeline.ts:18`); only `renderShortVideo` has a dependency seam. A *total* order is also wrong: listing runs concurrently with narration (`bookPipeline.ts:837`) and progress writes are fire-and-forget (`bookPipeline.ts:940`) | **Accepted.** A seam-extraction wave precedes characterization, and assertions are **partial-order** |
| **"Mongo is never written before the manifest" is already false** — live progress writes happen throughout a stage | **Accepted.** Split into advisory writes (progress, logs — unordered) and commit writes (state, outputs — after the manifest) |
| **"Every stage must be idempotent" is not enough** — uploads, publishes and paid provider calls are not | **Accepted.** Stages are now classified `idempotent` or `at-most-once`, the latter carrying a commit record |
| **The book-level footage pool has no owner** — "resolve before fan-out" means a multi-gigabyte download with no task, no queue slot, no cancellation and no progress (`bookPipeline.ts:1100`, `:1138`) | **Accepted.** The pool becomes its own task, inheriting admission, cancellation, progress and recovery |
| **Waves 3, 5, 7 are still big-bangs; a flag is rollback, not decomposition** | **Accepted.** Decomposed per-stage and per-recipe |
| **Wave 8 is riskiest** — manifest recovery cannot find the previous attempt's manifest under per-attempt identity | **Resolved by the identity fix**: the manifest lives in the stable workspace, which recovery already knows how to find |
| **Baseline stale** — HEAD is `58c28b8`, footage is committed, 119 deletions under `python-version/` | **Accepted.** Re-taken above |
| Citation drift: fencing at `bookPipeline.ts:807`/`:1020` not `:171`; `combine.ts:144` not `:141`; SRT at `bookPipeline.ts:882` not `:862`; aspect decline at `bookShortsPipeline.ts:781` not `:785`; the shipped short **is** 1080×1920 | **Corrected throughout** |

## What round 3 changed

Round 3 accepted the narration-timing correction and wave 0a's feasibility. What remained was five mechanisms the spec asserted but never designed, plus one factual error. All five are now designed; none required changing the thesis.

| Finding | Response |
| --- | --- |
| **The "stable" workspace is not stable.** `bookSegmentDir` derives from book *and segment titles* (`paths.ts:120`), so a block edit that changes a segment title (`book.ts:1018`) strands the old directory and loses chunk reuse. Hook shorts have no stable workspace at all — each retry writes into `taskDir(taskId)` (`bookShortsPipeline.ts:438`) | **Accepted. "v3 relocates nothing" is withdrawn** — it was true of outputs, false of workspaces. Working state moves to an index-keyed path; outputs stay put. See [§ Identity](#identity-two-identities-and-no-relocation) |
| **Deletion and ownership unsolved.** Generic task deletion removes `storage/tasks/<attemptId>` (`video.ts:196`), not a segment's stable directory or the pool under `storage/books`. And admission is check-then-write (`book.ts:1241`), so two requests can both launch detached fan-outs for the same segment | **Accepted.** "Artifacts are reclaimed with the task" was false and is corrected. One writer per workspace is now an **atomic lease**, not a stated rule |
| **The pool task is not an executable design.** `TaskQueue.add()` returns no completion handle (`queue.ts:40`); a pool task that awaits fan-out deadlocks at global concurrency 1. Book deletion cancels segment/short/OCR/planning tasks but no pool task (`book.ts:1759-1767`); the downloader has no progress callback | **Accepted.** Fan-out becomes a detached continuation after the slot is released, with queue-rejection, failure, decline and cancellation states defined |
| **Waves 7b and 8 are still big-bangs** — no earlier wave creates the book-specific stages, so 7b converts ~250 lines of `runSegmentRender` in one merge | **Accepted.** 7b decomposed into per-stage extractions consumed by the *existing* orchestrator before any recipe flip; 8 decomposed per recipe |
| **Wave 0a needs more seams than stated** — `bookPipeline.ts` needs threading through nested helpers plus injectable queue, gate, uuid, fs, db, and an **awaitable scheduler**; without the last, 0b cannot characterize fan-out | **Accepted.** The seam list is now explicit |
| **The at-most-once protocol is incomplete** — a record written before the call cannot distinguish "crashed before" from "succeeded, crashed before recording" | **Accepted.** Three durable states with an explicit unknown, never a silent skip |
| **Factual error:** past 64 cues, burned captions do *not* silently become soft. With burn requested and libass available the code uses ASS; without libass it warns first (`generate.ts:79`) | **Corrected.** The open question is withdrawn |
| Citation drift: cue accumulation `longform.ts:336-350`; drift warning `:850` | **Corrected** |

## What round 4 changed

Round 4 confirmed the at-most-once protocol's core and wave 8's decomposition, and said plainly that the architectural thesis needs no more prose. What remained were four mechanisms and one inventory. Two of my claims were **false**, not merely thin.

| Finding | Response |
| --- | --- |
| **The canonical workspace contradicts itself.** §Identity introduces `storage/books/<bookId>/work/...`, but §B and wave 2 still say "the directory each unit already uses", and **no wave creates or migrates to it** | **Accepted — this was an outright contradiction.** The index-keyed workspace is now the single answer, its contents are enumerated, and waves 2a–2c perform the migration |
| **The lease is unsafe.** `isOwnerAlive(PROCESS_OWNER_ID)` deliberately returns **false** for the current process (`owner.ts:40`), and every task in a process shares that id — so a second request could break a *live* lease. Foreign owners are always "alive", so heartbeat expiry needs a rule. Deletion cancels then removes files without awaiting termination (`book.ts:1751`) | **Accepted.** The lease now holds the **attempt id**, not the process id — using `PROCESS_OWNER_ID` was simply wrong. Liveness, expiry and destructive-operation participation are defined |
| **The pool has no post-release hook and no destination control.** Slots release in `TaskQueue.start().finally()` *after* the callback returns (`queue.ts:65`), so a callback cannot schedule work after its own release. And `downloadVideos` picks its destination from global config (`download.ts:96`), so it cannot target a book work directory | **Accepted.** Two small API changes are now stated as such — a queue completion contract and a download destination parameter. "Progress is the one new API" was wrong |
| **Wave 7b's six stages are not the whole path** — they omit structure/text resolution, cover generation, caption strategy/ASS, BGM and the still encode | **Accepted.** Stage inventory corrected and extended |
| **`needs-resolution` has no contract**, and task state is only `-1/1/4` (`const.ts:30`) | **Accepted.** Recorded as a task-document field, not a new state — the UI hard-codes those three integers |
| **False claim (mine):** "the existing multi-channel client can answer whether a YouTube upload landed". It exports upload and playlist operations only — **no listing or search** (`youtube/index.ts:48`) | **Withdrawn.** Automatic reconciliation is not available; the honest answer is human resolution through the existing failure surface |
| **False claim (mine):** queue rejection behaves "exactly as a rejected segment does today". Detached admission catches rejection and marks the *segment* failed (`bookPipeline.ts:1101`); it cannot return 429 to an HTTP request that already completed, and there is no queue-rejection `BookState` | **Withdrawn and redesigned** |
| Pool identity lists aspect/provider but its path omits them | **Corrected** |
| "No Mongo schema migration; fields stay" conflicts with adding `pool_task_id` and an effects field | **Corrected** — no *backfill*, but the document shape does change |
| Retention row still claims artifacts are reclaimed with the task | **Corrected** |
| Wave 0a/7b seam and stage inventories | **Deferred to the implementation plan**, per round 4's own categorisation |

---

## Problem

VidGen v2 works. The book feature renders, shorts render, HyperFrames is wired in, packaged and degrading gracefully, and 1004 tests pass. Nothing here is a rescue.

The problem is that **the pipeline is a control-flow shape rather than a data structure.**

### 1. Stages are not values

`tasks/pipeline.ts:183` — `executePipeline()` is a ~310-line straight-line function whose stage boundaries are inline early returns (`:240`, `:275`, `:326`, `:347`, `:389`).

- **`--stop-at` is complete only on the CLI.** Validated against `STOP_AT_STAGES` at `cli.ts:168`; HTTP exposes two hardwired values, `"subtitle"` (`routes/v1/video.ts:105`) and `"audio"` (`:112`). No HTTP route reaches `script`, `terms` or `materials`.
- **There is no `--resume-from`.**
- **The highest-churn orchestration file has no test.** Nothing asserts stage ordering, the early returns, or `generateFinalVideos`.

### 2. One pipeline shape, implemented three times

`pipeline.ts`, `bookPipeline.ts:799` (`runSegmentRender`) and `bookShortsPipeline.ts:1019` (`renderShortVideo`) independently reimplement BGM-resolve-and-retry-silent (`pipeline.ts:549-570` / `bookPipeline.ts:990-1000` / `bookShortsPipeline.ts:932-943`), burn-vs-soft captions (`generate.ts:79` / `bookPipeline.ts:~882` / `bookShortsPipeline.ts:~895`), and the soft-mux-then-rename dance.

**Correction from review:** these three are *not* simply duplicated — some differences are deliberate policy (a 15-minute chapter and a 40-second short genuinely want different caption strategies). The defect is that policy and mechanism are tangled, so you cannot tell which differences are intentional. v3 shares the mechanism and makes the policy an explicit per-recipe value.

### 3. Multi-part output is book-shaped

`book_segments`, `BookSegmentDocument` (`db/types.ts:351`), `BookConcurrencyGate` (`bookPipeline.ts:104`) and `resumeInterruptedBookRenders` (`recovery.ts:280`) are welded to `BookStructure`, `block_ids`, `FilterDecision`, chapter titles and cover overlays. "Split this script into five parts" is a fourth pipeline.

### 4. The compositor is a parameter slot, not an interface

`renderStillSegment` (`still.ts:428`) composites everything except stock shorts, and its interface is "a still, or a bed that loops". A montage is passed as `bedPath: footagePath` (`bookPipeline.ts:972`). `buildStillArgs` hardcodes narration as input 1, bgm 2, card 3 (`still.ts:325-334`); `buildStillAudioChains` reads `[1:a]`/`[2:a]` literally (`:272-285`). The file's own comment at `:416-420`:

> An earlier design that touched this path shipped chapter videos with no narration at all, exit code 0.

### 5. The artifact instinct exists but is applied unevenly

`taskArtifacts.ts` already writes `script.json` atomically into the task directory, with a comment explaining that the temp file must sit in the same directory for `rename` to be atomic on Docker mounts. Long-form TTS keeps a chunk manifest. Book text lives on disk with pointers in Mongo (`db/types.ts:172-181`).

The pattern is right and already proven here three times. It is simply not the rule, so most intermediates are Mongo fields or unnamed temp files, and no stage can be re-run alone.

---

## The constraints that shape everything

**1. Chrome is ~2.3× slower than realtime.** v2 measured `10.0s @ 1080p30 → 22.8s`. Its answer — HyperFrames renders short assets, ffmpeg assembles the long timeline — is correct and unchanged here.

> Corroborated independently: a 4-hour, 17-part narration built end-to-end on HyperFrames as whole-timeline compositor ran at 2.14× realtime, and reached 0.61–0.92× only after GPU encode (`--gpu`, VideoToolbox) cut encoding from 23.4s to 2.3s per 20s. The v2 boundary holds; GPU encode is worth carrying as an `EncodeProfile` option behind a capability probe, in the shape of `supportsAssBurn()` (`video/capabilities.ts:68`).

**2. Rendering is not deterministic today, and v3 does not make it so.** `combineVideos` defaults `random = Math.random` (`combine.ts:144`). Provider search results vary. This kills any acceptance gate based on output equality, and it constrains what a "plan" can mean — see below.

**3. The engine must be drivable with no Mongo and no Hono.** Every side effect arrives as an injected provider. This is what makes `executePipeline`'s successor testable, and that test's absence is defect #1.

---

## Identity: two identities, and no relocation

Round 2 killed revision 2's answer, and correctly. `taskId` is an **attempt** id: a fresh `getUuid()` is minted inside the fan-out loop for every render and every retry (`bookPipeline.ts:1091`), and startup recovery mints more by calling `renderBookSegments` again (`recovery.ts:315`). Meanwhile the work already lives in a **stable** directory — `bookSegmentDir(book.title, bookId, index, segment.title)` (`bookPipeline.ts:855`, `paths.ts:119`) — and `synthesizeLongform` reuses prior TTS chunks by reading a manifest from it (`longform.ts:773`). Putting the workspace under `<taskId>` would have destroyed that reuse on precisely the retry and crash-recovery paths it exists for.

So v3 uses two identities. Round 3 then showed the "stable" directory is not stable either: `bookSegmentDir` derives from the book *and segment titles* (`paths.ts:120`), and a block edit can rename a segment (`book.ts:1018`), stranding the old directory and losing chunk reuse. Hook shorts have no stable workspace at all — every retry writes into `taskDir(taskId)` (`bookShortsPipeline.ts:438`).

**So "v3 relocates nothing" is withdrawn.** It was true of *outputs* and false of *workspaces*. The corrected rule:

> **Outputs stay exactly where they are. Working state moves to an identity-keyed path.**

| | Working state (manifest, chunks, temp) | Outputs (served, linked, deleted) |
| --- | --- | --- |
| Book segment | `storage/books/<bookId>/work/segments/<index>/` — **new**, index-keyed, title-independent | unchanged: `bookSegmentDir(title, …)` |
| Hook short | `storage/books/<bookId>/work/shorts/<index>/` — **new** | unchanged: `taskDir(taskId)` |
| Standalone short | `storage/tasks/<taskId>/` — unchanged (the request *is* the identity) | unchanged |
| Footage pool | `storage/books/<bookId>/work/pool/` | n/a |

Outputs keep their URL space, their filenames, their deletion path and their rename behaviour. Working state becomes title-independent, so a rename no longer strands a workspace and chunk reuse survives an edit. Migration is one-way and lazy: an absent work directory is a cache miss, which is exactly today's behaviour on a rename.

The two identities:

| | **Workspace identity** (stable) | **Attempt identity** |
| --- | --- | --- |
| What it is | where artifacts live and resume reads from | queueing, cancellation, logs, progress |
| Book segment | `(bookId, index)` | `taskId`, fresh per attempt |
| Standalone short | `taskId` of the originating request | the same `taskId` |
| Hook short | `(bookId, index)` | `taskId`, fresh per attempt |
| Book footage pool | `(bookId, aspect, provider)` | its own `taskId` (see below) |

`revision` is **not** part of the workspace key. Round 3 noted that a cover replacement bumps revision while the work is unaffected; keying on it would throw away every chunk for an unrelated change. Revision stays what it already is — a commit-time fence (`bookPipeline.ts:807`, `:1020`) — and staleness is handled by input hashing.

**Ownership is an atomic lease on the attempt, not the process.** Round 3 found admission is check-then-write (`book.ts:1241`) and that `BookConcurrencyGate` permits two attempts at one segment. Revision 4 proposed keying the lease on `PROCESS_OWNER_ID`; **round 4 showed that is broken** — `isOwnerAlive` deliberately returns *false* for the current process (`owner.ts:40`), and every task in a process shares the id, so a second request could break a live lease.

Corrected: `lease.json` is created `O_EXCL` and holds the **attempt id** (`taskId`) plus the owner id plus a heartbeat.

| Question | Rule |
| --- | --- |
| Is the holder live? | its `taskId` is in the queue's active set (same process), **or** its owner id belongs to another live host and the heartbeat is fresh |
| Foreign host, stale heartbeat | breakable after an expiry that must exceed the longest stage — a 15-minute chapter encode cannot look dead at minute 10 |
| Same process, task gone | breakable immediately; the queue is authoritative |
| Deletion and re-plan | **lease participants.** Today deletion cancels and removes files without awaiting termination (`book.ts:1751`), which races a live render. Both must cancel, wait for the lease to clear, then break it if the owner is gone |

**Reclamation is explicit, because the old claim was false.** Generic task deletion removes `storage/tasks/<attemptId>` (`video.ts:196`) and will never reach a book workspace or the pool. So: book deletion reclaims `storage/books/<bookId>/work/` wholesale (it already `rm -rf`s the book directory); replan reclaims per-segment work directories for segments that no longer exist; and the currently-unreclaimed `footage.mp4` is reclaimed with its segment. "Artifacts are reclaimed with the task" applied only to standalone shorts and is corrected.

**A run is an orchestration unit, not an output.** `video_count` lets one task emit several videos (`schema.ts:128`, rendered in one loop at `pipeline.ts:523`). A run may therefore produce N outputs; the manifest records them as a list.

**The footage pool becomes its own task — and fan-out must not await it from inside a queue slot.** Round 3 found the deadlock: `TaskQueue.add()` returns no completion handle (`queue.ts:40`), so a pool task that awaits `fanOutSegments` wedges at global concurrency 1 — the pool holds the only slot while segment tasks wait for a slot that cannot free. The design is therefore a **detached continuation**:

1. `POST /books/:id/render` with footage enabled creates one pool task, `request_id: book:<id>:pool`, and stores `pool_task_id` on the book document.
2. The pool task downloads, writes `footage-pool.json`, commits, **releases its slot, and only then schedules fan-out.** Round 4 showed this needs a real API change and revision 4 hand-waved it: slots release inside `TaskQueue.start().finally()` *after* the callback returns (`queue.ts:65`), so a callback cannot schedule anything after its own release. **`TaskQueue.add()` gains a completion contract** — a settled promise or an `onSettled` hook that fires post-release. Small, and it belongs in wave 1, not smuggled into 5a.
3. **The download needs a destination parameter.** `downloadVideos` selects its destination from global configuration (`download.ts:96`) and cannot target a book work directory. Revision 4's claim that progress was "the one new API" was wrong: there are two, and this is the load-bearing one.
4. **Queue rejection.** Revision 4 claimed this behaves "exactly as a rejected segment does today" — false. Detached admission catches `TaskQueueFullError` and marks the *segment* failed (`bookPipeline.ts:1101`); the HTTP request has already returned, so no 429 reaches the caller, and there is no queue-rejection `BookState`. A rejected pool therefore **declines rather than fails**: segments fan out and fall through to bed, then still. The book is never blocked by a full queue.
5. **Pool failure** is likewise not fatal — a chapter must render, which is already the module's own stated rule.
6. **Cancellation.** Book deletion cancels segment, short, OCR and planning task ids today (`book.ts:1759-1767`) and must now cancel `pool_task_id` too. Without that, deleting a book mid-download orphans gigabytes.
7. **Progress.** `downloadVideos` has no progress callback either; without one the bar parks for the whole download.
8. **Recovery.** Ordinary recovery fails dead processing tasks (`recovery.ts:70`), which is correct here — the pool is a cache, so failing it makes the next render rebuild it.

Book-level terms are derived once, from the book's metadata plus a sample across chapters — not from one segment's narration, which is the bug in [§E](#e--body-sources-become-first-class).

## Approach

### A — Stages are values

`server/src/engine/` (a package later — [open question 1](#1-package-now-or-package-later--settled-later)), with an enforced import boundary: no `mongodb`, no `hono`, no `appConfig()`.

```ts
export interface Stage<I, O> {
  readonly id: StageId;
  readonly needs: readonly StageId[];
  readonly produces: readonly ArtifactKind[];
  readonly version: number;            // bumped when output semantics change
  run(ctx: StageContext, input: I): Promise<O>;
}
```

Because `needs` is declared, four things stop being hand-written: DAG truncation (`--stop-at`), resume from the first stale node, topological order assertable in a test, and the DAG itself testable without spawning ffmpeg.

`version` exists because round 1 was right that hashing inputs alone reuses stale results when a stage's code changes.

### B — The workspace is identity-keyed; outputs never move

Round 4 caught §B and §Identity contradicting each other. One answer, stated once:

| | Path | Contents |
| --- | --- | --- |
| Standalone short | `storage/tasks/<taskId>/` (unchanged — the request *is* the identity) | manifest, script.json, audio, srt, outputs |
| Book segment **work** | `storage/books/<bookId>/work/segments/<index>/` | `manifest.json`, `lease.json`, `chunks/`, temp encodes |
| Hook short **work** | `storage/books/<bookId>/work/shorts/<index>/` | same |
| Footage pool | `storage/books/<bookId>/work/pool/<aspect>-<provider>/` | `footage-pool.json`, clips, `lease.json` |
| Book segment **outputs** | `bookSegmentDir(title, …)` — **unchanged** | mp3, srt, mp4 |

Outputs keep their paths, URLs, filenames, deletion and rename behaviour. Only working state is identity-keyed, which is what makes resume survive a title edit (`book.ts:1018`) — the defect round 3 found in title-derived `bookSegmentDir` (`paths.ts:120`). The pool path now carries the aspect and provider its identity claims.

Commit rules:

1. A stage writes exactly the artifacts it declares, atomically, reusing `taskArtifacts.ts`'s same-directory temp+rename.
2. **`manifest.json` commits last.** A crash between artifact and manifest re-runs the stage.
3. **Multi-artifact stages commit once.**
4. **Mongo writes split in two.** *Advisory* — progress, logs — are unordered and already precede the manifest continuously; revision 2's blanket ordering rule was false on arrival. *Commit* — terminal state, output paths — happen after the manifest. Reconciliation reads the manifest and repairs Mongo, never the reverse.
5. **Stages are classified, not assumed idempotent**, with three durable states rather than one record — round 3 was right that a single pre-call record cannot distinguish "crashed before calling" from "succeeded, crashed before recording":

   | State | Written | On resume |
   | --- | --- | --- |
   | `intent` | before the call | the effect definitely did not happen — retry |
   | `in-flight` | immediately before dispatch, fsynced | **unknown** — never skip, never blindly retry |
   | `committed` | once the provider's result id is held | done; skip |

   **Reconciliation is mostly unavailable, and revision 4 claimed otherwise.** The YouTube client exports upload and playlist operations and no listing or search (`youtube/index.ts:48`), so it cannot answer "did this land?". An `in-flight` effect therefore resolves **by a human**. Contract: task state stays `-1` (the UI hard-codes `-1/1/4`, `const.ts:30`, `TaskManager.tsx:22-24`), the task document gains `effects: [{kind, state, provider_ref?}]`, and the existing `error` surface carries a distinct code. No new task state, no UI change.

### C — A narration-timing artifact, not a composition clock

Revision 1 claimed a universal clock; round 1 killed that. Revision 2 retreated to "long-form already has one fixed clock"; **round 2 killed that too, and was right.**

Long-form does not have one clock. It has three:

1. Cue offsets accumulate **summed per-chunk probes** (`longform.ts:336-350`).
2. The **joined mp3 is probed separately**, and the difference from (1) is explicitly tolerated and logged as drift (`longform.ts:850`).
3. `renderStillSegment` probes the joined audio **a third time** and uses *that* for the encode (`still.ts:441`).

Choosing which wins, and defining drift correction, is a **behaviour decision, not an extraction**. And with footage enabled the long-form visual track runs the same dynamic `combineVideos` as the short path (`footage.ts:265`), so a pre-composition plan cannot truthfully carry authoritative visual offsets either.

So `plan.json` is demoted to what is actually defensible:

- **It records narration timing** — chunk boundaries, unit offsets, the probed durations, and the drift between clocks (1) and (2). It makes an existing, currently-invisible disagreement visible.
- **It is not authoritative for composition.** Encoders keep probing. Nothing changes about which duration wins.
- **Choosing a single authoritative clock is a separate proposal**, named here so it cannot be smuggled into a refactor. It is the natural follow-on once the drift is measurable, which is precisely what this artifact provides.
- **The stock short path gets a post-hoc `composition.json`** recording what the montage chose — inspectable, reproducible with a recorded seed, never an input.

**Seeding.** Every random draw takes an explicit seed recorded in the manifest. Today's book footage seed derives from the absolute output path, so it changes if a workspace moves; it becomes `(bookId, segmentIndex)`.

### D — Compositors are an interface

```ts
export interface Compositor {
  readonly id: "ffmpeg-still" | "ffmpeg-montage" | "hyperframes";
  supports(req: CompositionRequest): Support;   // ok | decline(reason)
  render(req: CompositionRequest, ctx: StageContext): Promise<CompositionResult>;
}
```

`still.ts`'s positional inputs become named tracks, so the warning at `still.ts:416-420` becomes a compile error. `supports()` gives the existing ad-hoc declines a home — `planTemplatedShort` refusing a 16:9 short because the shipped composition is authored 1080×1920 (`bookShortsPipeline.ts:781`) is exactly a decline, and as a value the reason can reach the UI.

### E — Body sources become first-class

The footage work — **committed in `58c28b8`, not in-flight** — establishes footage > bed > still with the card on top, expressed as one key overwrite (`bookPipeline.ts:972-974`). The precedence is right; the expression changes:

```ts
type BodySource =
  | { kind: "footage"; clips: string[]; encode: EncodeProfile }
  | { kind: "bed";     loop: string;    encode: EncodeProfile }
  | { kind: "still";   image: string };
```

An ordered candidate list, each able to decline with a recorded reason. Three wins: the **wasted bed render disappears** (today the bed renders in Chrome before footage resolves, then footage overwrites `bedPath` — content-cached, so once per book, but still discarded); **encode profiles travel with their source** instead of `FOOTAGE_ENCODE` (`bookPipeline.ts:381`) and `DEFAULT_BED_ENCODE` (`still.ts:68`) being reconciled by a spread; and **declines become visible**. Exhaustion is an error, never a blank frame — `still.ts:437` already throws when both are missing.

**Two defects to fix rather than inherit**, both re-verified against the committed code:

1. **The pool is not per-book.** The header states the design — `~230 GB per book (dead on arrival)` vs `~4.7 GB` pooled — but terms are derived per segment (`bookPipeline.ts:709-715`) and the key includes them (`footage.ts:175`), so the manifest misses on essentially every segment and each re-downloads ~1800s. It degrades to *N × pool*, not 230 GB, but the claim does not hold. Under [§ Identity](#identity-two-identities-and-no-relocation) the pool becomes **its own task** with a book-level key and book-level term derivation, so it inherits admission, cancellation, progress and recovery, and segment fan-out waits on it. That also closes the concurrent-download race at `BOOK_SEGMENT_CONCURRENCY = 2`, and the analogous race on the cached bed, where two segments can both miss the existence check (`hyperframes.ts:675`) and render separate temp files before both rename onto the same target (`:743`).
2. **`footage_source: "local"` silently downloads from Pexels.** `getProviderSearch` (`search.ts:362`) has no `local` branch. The short path branches *before* `downloadVideos` (`pipeline.ts:361` → `preprocessVideos`); books have no `video_materials` equivalent, yet the UI offers "Local materials". `supports()` makes this a visible decline.

Smaller carried corrections: the header's two figures for the pooled case (4.7 GB, 1.7 GB) need reconciling; `footageWorkDir` is exported with no callers; `author` is accepted and never read; `targetSeconds` is never passed; `footage.mp4` is never reclaimed while `renderTarget` is (`bookPipeline.ts:1014`); `footageSearchTerms` takes no `AbortSignal`.

### F — Recipes carry policy explicitly

A recipe is a stage list **plus a policy record** — the round-1 correction that caption and BGM differences are partly deliberate:

```ts
interface Recipe {
  id: RecipeId;
  stages: Stage<any, any>[];
  policy: { captions: CaptionPolicy; bgm: BgmPolicy; onProviderFailure: FallbackPolicy };
}
```

Shared mechanism, per-recipe policy. `bookShortsPipeline` already proves the pattern by calling `runPipeline({ stopAt: "subtitle" })` and substituting its picture.

### G — Fencing and admission stay as they are

Two mechanisms round 1 correctly defended:

- **Revision fencing is not an input hash.** `bookPipeline.ts:807` and `:1020` check `revision` before work and again before committing, so a re-plan mid-render discards results instead of attaching hour-old audio to different text. Input hashing answers "is this artifact stale?"; fencing answers "may I still commit?". Both stay.
- **Admission fairness.** `BookConcurrencyGate` (`bookPipeline.ts:104`) deliberately holds book work *before* the global queue so one book cannot consume every slot. Generalising the gate must preserve that ordering.
- **Recovery keeps three behaviours.** Ordinary tasks fail, book chapters resume, hook shorts fail because they are cheap (`recovery.ts:197`). Recovery also owns cross-post and YouTube reconciliation (`recovery.ts:43-145`). "Replace the book-specific sweep" is withdrawn.

### Per-run params replace process-global settings

`appConfig()` is a global mutable cache read synchronously everywhere (`config/settings.ts:24-26`), so two concurrent tasks cannot use different subtitle providers or codecs. The engine takes an immutable resolved `RunParams`; the server resolves `appConfig()` into it at task creation. **Credentials never enter `RunParams` or the manifest** — providers hold them; the manifest records provider identity and version only.

---

## Design work this plan owes

Round 1 listed what a re-architecture of this system needs and revision 1 was silent on. Each is now in scope:

| Concern | Resolution |
| --- | --- |
| Identity model | [§ Identity](#identity-two-identities-and-no-relocation) — stable workspace identity, separate attempt identity |
| Dependency hashing | inputs + resolved params + `Stage.version` + tool versions (ffmpeg, Chrome, model ids) |
| Concurrent manifest writers | one writer per workspace; book-level caches (pool, bed) are single-flight behind a lease, closing the races at `hyperframes.ts:675` and the pool manifest |
| Crash consistency | artifacts → manifest → Mongo *commit* fields; advisory progress/log writes are unordered. Manifest reconciles Mongo on restart, never the reverse |
| Legacy runs | absent `manifest.json` ⇒ legacy; read from Mongo as today. No backfill |
| Non-idempotent effects | stages classified `idempotent` / `at-most-once`; the latter write a commit record before the effect (uploads, cross-post, paid provider calls) |
| Portability | **not claimed.** A workspace references a shared material pool and provenance recorded inside `script.json` (`taskArtifacts.ts:38`); the book pool lives in `footage-pool.json` (`footage.ts:170`). Copying a workspace alone does not carry its media, and v3 does not pretend otherwise |
| Artifact integrity | existence + size + content hash; media additionally probed |
| Retention | **task-owned artifacts only** are reclaimed with the task (`video.ts:196`) — that covers standalone shorts. Book work directories and the pool are *not* task-owned and are reclaimed by book deletion and re-plan; the currently-unreclaimed `footage.mp4` goes with its segment |
| Cancellation cleanup | temp artifacts removed on abort; `combineVideos` currently leaves `temp-clip-N.mp4` behind on abort (`combine.ts:295` deletes only on success) |
| Reproducibility | seeds, provider/model ids and tool versions recorded in the manifest |
| Redaction | manifests carry no secrets, mirroring `settings.ts:266-278`'s `__stored__` convention |

---

## API surface

**No route, request or response changes.** The UI couples to the backend in ten places:

| Coupling | Where | Obligation |
| --- | --- | --- |
| Task states are `-1 / 1 / 4` | `TaskManager.tsx:22-24`; `VideoScreen.tsx:178` fabricates `state: 4` client-side | emit only those three |
| Artifact URLs string-manipulated | `book/api.ts:868-873` searches for literal `/tasks/`; `TaskManager.tsx:259` hardcodes `/tasks/<id>/subtitle.srt` | keep the URL space and filenames — [§ Identity](#identity-two-identities-and-no-relocation) does |
| `POST /videos` is an untyped 30-key `Record` | `VideoScreen.tsx:44-79` | no param renames |
| Old tasks' params replayed as new requests | `TaskManager.tsx:211` → `VideoScreen.tsx:111` | renames break history, not just new renders |
| `book.revision` gates SSE-vs-fetch | `BookScreen.tsx:457-460` | stays monotonic |
| Two SSE vocabularies, neither reconnects | `client.ts:339`, `book/api.ts:821` | do not restart workers mid-render |
| `metadata.book_templates` read structurally | `book/api.ts:245-248` | keep the key; `[]` hides the control |
| Health is `{version, database, ffmpeg}` | `ping.ts:16`; asserted `app-header.tsx:18`, shown `:46` | keep all three keys |
| `X-Audio-Duration` header | `client.ts:248` | keep the side channel |
| Zod issues parsed as `error.detail` | `book/api.ts:906-921` | keep validation library and status mapping |

---

## Migration

Round 1 called waves 1/4/5 big-bangs. Round 2 said the rewave fixed rollback but not decomposition — "a flag is rollback machinery, not incremental migration" — and named waves 0, 3, 5 and 7 as still-uncredible. Both were right. Rewaved a second time, with the unit of change reduced from *an orchestrator* to *a stage*.

| Wave | Lands | Why it is not a cutover |
| --- | --- | --- |
| **0a** | **Dependency seams.** Both orchestrators import their effects directly (`pipeline.ts:25`, `bookPipeline.ts:18`); only `renderShortVideo` has an injectable `deps` (`bookShortsPipeline.ts:494`). Extend that pattern, threading through the nested template and footage helpers, and inject: **queue, book gate, uuid, filesystem, database, and an awaitable scheduler seam**. The scheduler is the one round 3 insisted on — fan-out is detached (`bookPipeline.ts:1138`), so without an awaitable seam wave 0b cannot characterize it at all. No behaviour change | pure parameterisation; existing tests must pass untouched |
| **0b** | **Characterization tests** using those seams. **Partial-order** assertions, not total — listing runs concurrently with narration (`bookPipeline.ts:837`) and progress writes are fire-and-forget (`:940`), so legitimate order varies. Seeds pinned | tests only |
| 1 | `server/src/engine/` types, DAG, manifest writer. **No caller.** Import-boundary lint. Docker (`Dockerfile:9,100,169`) and root typecheck (`package.json:16`) updated | dead code until wave 3 |
| 2a | **Dual-write** `manifest.json` into existing workspaces. Nothing reads it | additive; delete the file to revert |
| 2b | **Create the identity-keyed work directories** and write new working state to them, still reading the old title-derived location on miss | dual-location read; old path still authoritative |
| 2c | **Switch chunk reuse to the new location**, old path read-only as a fallback for one release, then dropped. This is the wave round 4 correctly said was missing entirely | falls back to a cache miss, which is today's behaviour after a rename |
| 3 | **One stage at a time.** `script` moves to the engine behind `ENGINE_STAGES=script`; then `terms`, `audio`, `subtitle`, `materials`. Each is a separate merge with wave-0b traces green | five small cutovers, not one large one. The env var takes a stage list, so any prefix can ship |
| **3.5a** | **Footage pool becomes its own task** with book-level terms, a destination parameter and a lease. **The one user-visible correctness win, sequenced early by decision.** Depends only on 0a/0b/1/2a | isolated to pool acquisition; the segment path still consumes a clip list |
| 4 | `Compositor` interface; `still.ts` → `ffmpeg-still`, HyperFrames → `hyperframes`. Signature refactor only | traces unchanged by construction |
| 5b | `BodySource` candidate list replaces the `bedPath` overwrite; the wasted bed render disappears | body selection only |
| 5c | `local` source declines instead of silently using Pexels (`search.ts:362`) | one decline path |
| 6 | Narration-timing artifact ([§C](#c--a-narration-timing-artifact-not-a-composition-clock)) written and surfaced. **Records drift; changes no encode** | read-only artifact |
| 7a | `Recipe` type + policy record; the **short** path expressed as a recipe | one recipe |
| 7b-i…x | **Book path, one stage per merge, each consumed by the *existing* orchestrator before any recipe exists.** Round 4 correctly found revision 4's six-stage list incomplete; the actual inventory is: structure/text resolution → long-form TTS → caption strategy (burn/ASS/soft) → BGM resolution → cover generation → template assets → footage body → still encode → mux → listing → fencing/commit | ten small extractions; the orchestrator keeps its shape until 7b-xi |
| 7b-xi | The now-thin `runSegmentRender` expressed as a recipe | mechanical, because the stages already exist |
| 7c | Hook shorts as a recipe | one recipe |
| 8a | Resume-from-manifest for the **short** recipe only, alongside the three existing recovery behaviours (`recovery.ts:70`, `:197`, `:280`) | one recipe; existing sweeps untouched |
| 8b | …for **book segments** | one recipe |
| 8c | …for **hook shorts** | one recipe |
| 9 | Extract the package — see [open question 1](#1-package-now-or-package-later--settled-later) | a move, once interfaces are stable |

Every wave ends green on `typecheck`, `test`, `build`. Waves 3, 6, 7 ship dark behind flags; 0a, 1, 2, 4 are invisible by construction; 5a–5c are the user-visible ones.

**The riskiest wave is 8**, and round 2 named why: recovery must find a previous attempt's manifest. Under [§ Identity](#identity-two-identities-and-no-relocation) it can, because the manifest lives in the stable workspace rather than under a dead attempt id. If that identity model is wrong, wave 8 fails first.

## Failure modes

| Failure | Cause | Mitigation | Detection |
| --- | --- | --- | --- |
| A wave changes rendered output | stage extraction alters behaviour | wave 0b traces compared per wave | test, pre-merge |
| Trace comparison is flaky | rendering is non-deterministic (`combine.ts:144`); some interleavings are legitimate | partial-order assertions on structure, not values; seeds pinned | test |
| Resume replays a stale artifact | hash misses a relevant input | hash inputs + params + `Stage.version` + tool versions | resume test with mutated stage version |
| Manifest and Mongo disagree after a crash | two stores | commit order artifacts → manifest → Mongo; manifest reconciles | recovery test — **new, none exist today** |
| Two writers race a book-level cache | `BOOK_SEGMENT_CONCURRENCY = 2` | single-flight + lease; pool resolved before fan-out | concurrent-render test |
| A decline becomes silence | candidate list exhausts | exhaustion is an error; `still.ts:437` already throws | unit test |
| Book fairness regresses | gate generalised past the global queue | ordering is a named invariant with a test | test |
| Engine acquires a server dependency | convenience import | import-boundary lint in CI | build |
| Docker build breaks | new workspace not copied | `Dockerfile:9,100,169` updated in wave 1 | CI build |

---

## Test impact

**Waves 0a and 0b are the plan's foundation, not its preamble.** 0a extends the injectable-`deps` pattern that today exists only on `renderShortVideo` (`bookShortsPipeline.ts:494`) to the other two orchestrators, because both currently import their effects directly (`pipeline.ts:25`, `bookPipeline.ts:18`) and cannot be observed without that seam. 0b then captures the current side effects through it.

**Assertions are partial-order.** Round 2 was right that a total trace is the wrong model: book listing runs concurrently with narration (`bookPipeline.ts:837`) and composition progress writes are fire-and-forget (`:940`), so some interleavings are legitimate. Traces assert *which* effects occur, their arguments' structure, and the orderings that are causally required — not a single global sequence.

Round 1 was right that argv equality is far too weak, and that the cited `book-template-render.test.ts:264` compares `StillSegmentOptions` rather than argv.

**New:** DAG ordering and truncation; resume decisions; `plan.json` timing invariants (long-form); `BodySource` resolution incl. every decline; `Compositor.supports()`; recipe policy; **manifest/Mongo crash reconciliation** — a genuinely new area, since **no test today references any recovery function**.

**Preserved and load-bearing:** `video.test.ts`, `longform-video.test.ts`, `hyperframes.test.ts` (stub binaries), `templates.test.ts`, `book-template-render.test.ts`.

**Inherited verbatim from v2's implementation plan:**

> A pre-existing test that needed editing to pass is a defect in the change, not in the test.

---

## Explicitly not doing

- **No web rewrite.** Ten couplings honoured; zero UI files changed by engine work.
- **No API break.**
- **No stack change.**
- **No full-length HyperFrames body render.**
- **No convergence of the two caption rasterisers** (Skia PNG-per-cue for shorts, ASS for long-form). The `Compositor` interface is where it would land; deciding it here would smuggle a behaviour change into a refactor.
- **No unified timeline planner.** [§C](#c--a-narration-timing-artifact-not-a-composition-clock) — long-form only; the stock path keeps its dynamic composition.
- **No determinism guarantee.** Seeds are recorded so a run is *reproducible on the same machine with the same providers*. Provider results and tool versions still vary.
- **No Mongo backfill.** Authority moves and no existing field changes meaning — but the document *shape* does grow: `pool_task_id` on the book, `effects[]` on the task. Round 4 was right that "fields stay" overstated it.
- **No new product surface.** Wave 5 is the only user-visible change, and it is finishing work already in the tree.
- **No LLM-authored compositions, no cloud rendering.** Unchanged from v2.

---

## Open questions for review

### 1. ~~Package now, or package later?~~ — **settled: later**

`server/src/engine/` with an enforced import boundary from wave 1; extraction at wave 9. The destination is unchanged. Revisit only if an external consumer appears, which would move wave 9 forward.

### 2. ~~Is a near-invisible release acceptable?~~ — **settled: no, so the footage fix moves early**

Wave 3.5a lands the pool fix as soon as the engine can host it.

### 3. How much of the manifest should Mongo mirror?

Proposed: status, current stage, artifact URLs — not artifact contents. Mirroring nothing means the task list cannot show a stage without reading disk.

### 4. Should the stock short path ever get a real plan?

It would make montages reproducible across machines and let the UI show a shot list before rendering. It is also a rendering-algorithm rewrite with visible output changes. Out of scope here; worth an explicit yes/no.

### 5. ~~`MAX_OVERLAY_INPUTS = 64`~~ — withdrawn

Revision 3 claimed burned captions silently become a soft track past 64 cues. **That is false.** With burn requested and libass available the code uses ASS; without libass it warns before falling back (`generate.ts:79`). Nothing is silent, and there is no question to answer.

### 6. ~~Is `python-version/` being deleted deliberately?~~ — **settled: yes**

Intentional. It lands as its own commit before wave 0a, and the baseline is re-taken afterwards. The README's reference to `python-version/` wants updating in that same commit.
