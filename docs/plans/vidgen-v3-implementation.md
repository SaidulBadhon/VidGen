# VidGen v3 — implementation plan, tranche 1

Executes [vidgen-v3.md](vidgen-v3.md). **Read that first**; this document assumes its decisions and does not re-argue them.

## Scope of this tranche

Waves **0a → 0b → 1 → 2a → 3.5a**, ending at the footage-pool fix — the one user-visible correctness win, sequenced early by decision.

Waves 3 (per-stage engine cutover), 4 (compositors), 5b/5c, 6, 7 and 8 get their own plan **after 0a lands**, because 0a is what reveals how much of each orchestrator is actually separable. Planning twenty waves in detail before the first one teaches us anything is waste.

## Prerequisite, outside this plan

The `python-version/` deletion (119 files) lands first, as its own commit, with the README reference updated. **Re-take the baseline after it lands.** No task below may include that deletion.

## Verified baseline

At HEAD `58c28b8`:

```
bun run typecheck             → exit 0
bun run --cwd server test     → 1004 pass, 0 fail, 2509 expect() calls, 23 files
```

Any gate failure after this point is caused by this change, not inherited.

## Plan verification

| Claim class | Count | Status |
| --- | --- | --- |
| `file:line` citations to existing code | 24 | **all 24 verified by reading the line at `58c28b8`.** 7 were wrong on first pass — off by 1–12 lines, pointing at a doc comment or enclosing block — and are corrected here |
| Files this plan creates | 11 | marked `(new)` |
| Files this plan modifies | 9 | each named in exactly one task per wave |

**Known gap carried into execution:** the spec's round-5 review is blocked until 2026-08-27 (Codex usage limit). Rounds 1–4 each found real defects in the preceding revision, so **expect this plan to need amendment** when that review lands. Task acceptance criteria are written to fail loudly rather than to be argued with.

---

## How to run this

- Tasks are grouped into **waves**. **Within a wave, tasks are parallel and have disjoint file ownership — no two tasks in the same wave write the same file.**
- Each task declares **`Owns:`** with explicit paths. `(new)` means the task creates it.
- Parallel tasks run with `isolation: "worktree"`.
- **Verify each task's result yourself — do not trust its report.** Every task carries an acceptance check that is a command with an observable result, not "the agent said done".
- A task that cannot meet its acceptance criteria **stops and reports. It does not widen its own scope to compensate.**
- Between waves, a **Gate** running `bun run typecheck && bun run --cwd server test && bun run build` must go green before the next wave starts.
- **A pre-existing test that needed editing to pass is a defect in the change, not in the test.** Waves 0a, 1 and 2a are behaviour-preserving by construction: all 1004 existing tests must pass **untouched**. Investigate rather than update the assertion.

---

## Wave 0a — dependency seams

No behaviour change. Pure parameterisation, following the pattern that already exists on `renderShortVideo` (`bookShortsPipeline.ts:494-512`): a `Deps` interface, a `live*Deps` bundle as the default argument, so nothing in production ever passes one.

### T1 — queue completion contract

**Owns:** `server/src/tasks/queue.ts`, `server/test/queue.test.ts`

`TaskQueue.add()` returns `void` (`queue.ts:40`) and the slot releases inside `start().finally()` *after* the callback returns (`queue.ts:65`). A callback therefore cannot schedule work after its own release — the deadlock round 4 identified for the pool task.

Add a completion contract: `add()` returns a handle exposing a promise that settles **after** the slot is released, or accepts an `onSettled` callback invoked post-release. Do not change admission, rejection, cancellation or `BoundedPool`.

**Acceptance:**
- `bun run --cwd server test -- queue` passes, including a **new** test asserting that work scheduled via the completion hook starts *after* `running` has decremented — assert on the observed slot count, not on timing.
- Existing `queue.test.ts` cancel and admission tests pass **unmodified**.

### T2 — short pipeline seams

**Owns:** `server/src/tasks/pipeline.ts`, `server/test/pipeline-deps.test.ts` `(new)`

`pipeline.ts:25` imports every effect directly. Introduce `PipelineDeps` + `livePipelineDeps` covering: LLM (`generateScript`, `generateTerms`), TTS (`tts`), subtitle generation, material download/preprocess, `combineVideos`, `generateVideo`, BGM resolution, and the task-state writers.

Do **not** change stage order, the `--stop-at` early returns, warning accumulation, cross-post scheduling, or the book-shorts suppression at `pipeline.ts:418`.

**Acceptance:**
- `bun run --cwd server test` → **1004 pass, 0 fail**, no existing test file modified (`git diff --stat server/test/` shows only the new file).
- New test constructs `executePipeline` with a fully stubbed `PipelineDeps` and asserts it runs to completion with **zero** real ffmpeg, Mongo or network calls.

### T3 — hook-short seam audit

**Owns:** `server/src/tasks/bookShortsPipeline.ts`, `server/test/book-shorts.test.ts`

`ShortRenderDeps` (`:494`) already exists but does not cover BGM resolution or the task-state writers. Extend it to parity with T2's list. Smallest task in the wave.

**Acceptance:** `bun run --cwd server test -- shorts` passes; `ShortRenderDeps` and `PipelineDeps` cover the same effect categories.

> **Gate 1** — `bun run typecheck && bun run --cwd server test && bun run build`. 1004 tests, 0 fail.

---

## Wave 0a.2 — book pipeline seams

Sequential after T1: it consumes the queue contract.

### T4 — book segment seams

**Owns:** `server/src/tasks/bookPipeline.ts`, `server/test/book-pipeline-deps.test.ts` `(new)`

`bookPipeline.ts:18` imports its effects directly, and round 4 found the seam must reach **nested** helpers. Introduce `SegmentRenderDeps` + `liveSegmentRenderDeps` covering: long-form TTS, subtitle write, `resolveSegmentTemplateAssets`, `resolveSegmentFootage`, `renderStillSegment`, cover overlay, listing generation, BGM, plus injectable **queue** (T1's contract), **book gate**, **uuid**, **filesystem** and **clock**.

Preserve exactly: revision fencing (`bookPipeline.ts:807`, `:1020`), gate acquired before the task is created (`:1074` before `:1092`), detached fan-out (`:1138`), and the concurrent listing/narration overlap (`:837`).

**Acceptance:**
- `bun run --cwd server test` → 1004 pass, 0 fail, no existing test modified.
- New test runs `runSegmentRender` fully stubbed, asserting: gate acquired **before** `createTask`; revision checked **twice**; a revision bump between the two checks discards the result without writing outputs.

> **Gate 2** — full gate green.

---

## Wave 0b — characterization traces

Partial-order assertions only. `bookPipeline.ts:837` runs listing concurrently with narration and `:940` writes progress fire-and-forget, so a single global sequence is not a valid model.

### T5 — trace harness

**Owns:** `server/test/helpers/trace.ts` `(new)`

A recorder that wraps a `Deps` bundle and captures `{effect, args-shape, causal-parent}`. Assertions available: `occurred(effect)`, `occurredBefore(a, b)` for causally-required pairs only, `argShape(effect, matcher)`, `neverOccurred(effect)`. **No total-order assertion API** — do not provide one; its absence is the design.

**Acceptance:** unit-tested against a synthetic deps bundle; concurrent effects assert as unordered.

### T6 / T7 / T8 — traces per orchestrator

Parallel, disjoint. **Depend on T5.**

- **T6 Owns:** `server/test/trace-short.test.ts` `(new)`
- **T7 Owns:** `server/test/trace-book-segment.test.ts` `(new)`
- **T8 Owns:** `server/test/trace-hook-short.test.ts` `(new)`

Each pins seeds, stubs every dep, and records the current trace as the reference. Cover at minimum: the happy path, one provider failure with its degradation, and one cancellation.

**Acceptance:** each trace test passes at `58c28b8` **and** fails if you deliberately reorder two causally-required effects. Demonstrate the induced failure in the task report — a trace test that cannot fail is worthless.

> **Gate 3** — full gate green. **This gate is the plan's safety net; do not proceed past it on a partial pass.**

---

## Wave 1 — engine skeleton (no caller)

Dead code until wave 3. Nothing imports it.

### T9 — core types and DAG

**Owns:** `server/src/engine/types.ts` `(new)`, `server/src/engine/dag.ts` `(new)`, `server/src/engine/registry.ts` `(new)`, `server/test/engine-dag.test.ts` `(new)`

`Stage<I,O>` with `id`, `needs`, `produces`, `version`, `run`. Topological sort, truncation (`--stop-at`), and resume selection (first stage whose input hash or stage version differs, or whose artifact is absent).

**Acceptance:** tests cover a diamond DAG, cycle rejection, truncation, and resume selection. Pure — no fs, no Mongo, no spawn.

### T10 — workspace, manifest, lease

**Owns:** `server/src/engine/workspace.ts` `(new)`, `server/src/engine/manifest.ts` `(new)`, `server/src/engine/lease.ts` `(new)`, `server/test/engine-workspace.test.ts` `(new)`

Manifest read/write with same-directory temp+rename (mirroring `taskArtifacts.ts:31`), commit-last ordering, multi-artifact single commit.

Lease per the spec: `O_EXCL`, holds the **attempt id** (`taskId`) — *not* `PROCESS_OWNER_ID`, which `isOwnerAlive` reports dead for the current process (`owner.ts:40`) — plus owner id and heartbeat. Liveness: attempt in the queue's active set, or foreign owner with a fresh heartbeat. Expiry must exceed the longest stage.

**Acceptance:** tests against a temp dir cover concurrent `O_EXCL` claim (one winner), stale-heartbeat break, same-process-task-gone break, and a crash between artifact and manifest re-running the stage. Asserting the lease **cannot** be broken while its attempt is live is mandatory.

### T11 — boundary, packaging, typecheck

**Owns:** `Dockerfile`, `package.json`, `server/package.json`, `.github/` lint config as applicable

Import-boundary lint: nothing under `server/src/engine/` may import `mongodb`, `hono`, or `config/settings`. Docker copies whatever wave 9 will need (`Dockerfile:9,100,169` currently copy only the two workspace manifests). Root `typecheck` (`package.json:16`) must cover the engine.

**Acceptance:** a deliberate `import { appConfig } from "../config/settings"` inside `server/src/engine/` **fails CI**. Demonstrate the failure, then revert it. `docker compose build` succeeds.

> **Gate 4** — full gate green, plus the boundary-violation demo.

---

## Wave 2a — dual-write manifests

### T12 — write manifests from the existing orchestrators

**Owns:** `server/src/tasks/pipeline.ts`, `server/src/tasks/bookPipeline.ts`, `server/src/tasks/bookShortsPipeline.ts`

Each orchestrator additionally writes `manifest.json` into its workspace. **Nothing reads it.** Mongo stays authoritative. Manifest commits after artifacts, before the Mongo commit write; advisory progress/log writes are unaffected.

**Acceptance:** wave-0b traces pass **unchanged except for the manifest write itself**, which must appear as a new recorded effect in the expected causal position. A trace diff showing any other change fails the task.

> **Gate 5** — full gate green; trace diff reviewed by hand.

---

## Wave 3.5a — the footage pool becomes a task

The user-visible wave. Fixes a real bug in shipped code: the pool is keyed on per-segment terms (`bookPipeline.ts:709-715` → `footage.ts:175`), so it misses on essentially every segment and each re-downloads ~1800s, against a module header that states the pooled design explicitly.

### T13 — download destination and progress

**Owns:** `server/src/services/material/download.ts`, `server/test/services.test.ts`

`downloadVideos` selects its destination from global config (`download.ts:96`) and cannot target a book work directory. Add an explicit optional destination parameter and an `onProgress` callback. **Default behaviour unchanged when neither is passed.**

**Acceptance:** existing material tests pass unmodified; new tests assert the default resolves to today's directory and an explicit destination is honoured.

### T14 — book-level term derivation

**Owns:** `server/src/services/book/footage.ts`, `server/test/book-footage.test.ts`

Add `bookFootageTerms({ bookTitle, author, chapterTitles, sampleText })` deriving terms **once per book** from metadata plus a sample across chapters — not from one segment's narration. Make `footagePoolKey` book-scoped. Fix the loose ends the module already carries: `footageWorkDir` has no callers; `author` is accepted and never read; `targetSeconds` is never passed; the header states both 4.7 GB and 1.7 GB for the pooled case.

**Acceptance:** `bun run --cwd server test -- footage` passes; a new test asserts **two different chapters of the same book produce the same pool key** — the assertion that fails against today's code. Demonstrate that it fails before the fix.

### T15 — pool task, continuation, cancellation

**Owns:** `server/src/tasks/bookPipeline.ts`, `server/src/routes/v1/book.ts`, `server/src/db/types.ts`, `server/test/book-api.test.ts`

- Pool runs as its own task, `request_id: book:<id>:pool`; `pool_task_id` stored on the book document.
- Fan-out is scheduled through **T1's completion contract**, after the pool's slot releases. Never awaited from inside the slot.
- Queue rejection ⇒ the pool **declines**; segments fan out and fall through to bed, then still. A full queue never blocks a book. (Round 4: detached admission marks the *segment* failed at `bookPipeline.ts:1101` and no 429 can reach the caller — do not claim parity.)
- Pool failure ⇒ same decline path.
- Book deletion cancels `pool_task_id` alongside segment/short/OCR/planning ids (`book.ts:1759-1767`).
- Pool writes to `storage/books/<bookId>/work/pool/<aspect>-<provider>/` under a lease (T10).

**Acceptance:**
- New tests: rejection declines rather than fails; deletion cancels the pool task; fan-out observably starts after slot release.
- **The end-to-end check that matters:** render a two-segment book with `footage_enabled: true` and assert **one** pool download, not two. Record the observed download count in the task report.

> **Gate 6** — full gate green; all wave-0b traces green; the two-segment single-download check demonstrated.

---

## Whole-tranche acceptance

1. `bun run typecheck` → exit 0.
2. `bun run --cwd server test` → ≥1004 pass, 0 fail. **No pre-existing test modified** except `queue.test.ts`, `book-shorts.test.ts`, `services.test.ts`, `book-footage.test.ts` and `book-api.test.ts`, each only *extended*.
3. `bun run build` → exit 0. `docker compose build` → exit 0.
4. Engine boundary violation fails CI (demonstrated).
5. Every wave-0b trace passes, and each has been shown capable of failing.
6. A two-segment footage-enabled book performs **one** pool download.
7. `manifest.json` exists in every workspace a render touches, and nothing reads it yet.

## Rollback

Waves 0a, 0b and 1 are additive — revert the commits. Wave 2a: stop writing the manifest. Wave 3.5a is the only behaviour change; `footage_enabled` already defaults `false` (`bookSchema.ts:267`), so reverting T15 restores the previous path for the small number of books that opted in.
