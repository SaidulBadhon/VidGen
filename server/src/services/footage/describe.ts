/**
 * Turning one clip on disk into a structured `ClipDescription`.
 *
 * This is the expensive half of indexing — it is the only stage that spends
 * real money — so the module is built around three constraints:
 *
 *   1. **Nothing full-size ever reaches the model.** Every clip is first
 *      re-encoded to a 360p / 2 fps / ≤60 s proxy, which turns a 211 MB master
 *      into ~1.7 MB. That gives one uniform request path with no branching on
 *      file size, no Files API, and no upload step: the bytes ride inline in
 *      the message. It also cuts video tokens, since tokens scale with frames.
 *   2. **The proxy is temporary and always removed.** It is written to
 *      `storage/temp/footage_proxies/` under a unique name and deleted in a
 *      `finally`, so a crashed or cancelled describe cannot silently fill the
 *      disk over a 1,000-clip run.
 *   3. **Every collaborator is injectable with a real default.** The model, the
 *      proxy builder, the byte reader and the deleter are all parameters, in
 *      the same shape `downloadVideosByScriptOrder` injects `searchVideos`.
 *      The repo's tests use no mocking library, so a seam that a test can pass
 *      a plain function through is the only way this file is testable at all;
 *      the recipe, the message layout and the error classification are also
 *      broken out as exported pure helpers that need neither ffmpeg nor a key.
 *
 * The description contract itself lives in `types.ts` and is deliberately not
 * restated here: `clipDescriptionSchema`'s `.describe()` strings *are* the
 * prompt, so a second copy of the field instructions in this file would be a
 * second prompt that silently disagrees with the first.
 */

import { existsSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { NoObjectGeneratedError, generateObject, type LanguageModel, type ModelMessage } from "ai";

import { getSettings } from "../../config/settings.ts";
import { errorMessage, logger } from "../../utils/logger.ts";
import { redactSecrets } from "../../utils/misc.ts";
import { storageDir } from "../../utils/paths.ts";
import { num, runFfmpeg, type RunOptions, type RunResult } from "../video/ffmpeg.ts";
import { DESCRIBE_VERSION, clipDescriptionSchema, type ClipDescription } from "./types.ts";

/** Proxies are always H.264 in MP4, so the media type is fixed. */
const PROXY_MEDIA_TYPE = "video/mp4";

/**
 * One describe call, plus one retry.
 *
 * The retry exists only for a malformed response (see `isSchemaViolation`),
 * which is the one failure a second identical request plausibly fixes. Rate
 * limits and transport errors are already retried inside the AI SDK, and a
 * clip that fails twice here is recorded and left for the next run rather than
 * blocking a batch — the file on disk is the work-list, so nothing is lost.
 */
const MAX_DESCRIBE_ATTEMPTS = 2;

/** Floor and ceiling for the derived ffmpeg timeout, in milliseconds. */
const MIN_PROXY_TIMEOUT_MS = 30_000;
const MAX_PROXY_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Where a describe gave up.
 *
 * `config` is the whole library being unusable (no key, no model name) rather
 * than this clip being bad, and a caller sweeping a directory should stop
 * instead of writing the same failure onto a thousand rows.
 */
export type DescribeStage = "config" | "proxy" | "read" | "schema" | "model";

/**
 * A describe failure, shaped so the whole thing can be recorded.
 *
 * `footage_index.errors[]` stores `{ at, message }`, so `message` is written to
 * be the record: it names the clip, the stage and the attempt count in one
 * line. `detail` keeps the underlying text on its own for a caller that wants
 * to group failures, and `cause` keeps the original error for a log.
 *
 * `detail` is passed through `redactSecrets` before it gets here whenever an
 * API key was in scope — provider errors paste the request URL into the
 * message, and these strings end up in Mongo and on the wire.
 */
export class ClipDescribeError extends Error {
  readonly clip: string;
  readonly stage: DescribeStage;
  readonly attempts: number;
  readonly detail: string;

  constructor(input: {
    clip: string;
    stage: DescribeStage;
    attempts: number;
    detail: string;
    cause?: unknown;
  }) {
    super(
      `describe failed for ${input.clip} at stage ${input.stage} ` +
        `after ${input.attempts} attempt(s): ${input.detail}`,
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = "ClipDescribeError";
    this.clip = input.clip;
    this.stage = input.stage;
    this.attempts = input.attempts;
    this.detail = input.detail;
  }
}

/** Error names the AI SDK uses for "the model answered, but not in our shape". */
const SCHEMA_ERROR_NAMES = new Set([
  "AI_NoObjectGeneratedError",
  "AI_TypeValidationError",
  "AI_JSONParseError",
  "NoObjectGeneratedError",
  "TypeValidationError",
  "JSONParseError",
]);

/**
 * True when the model replied but the reply could not be parsed or validated.
 *
 * This is the one class of failure worth an immediate second attempt: sampling
 * is not deterministic, so the same request often succeeds. It must not catch
 * a 429 or a 500, which a retry would only make worse.
 *
 * The cause chain is walked because the SDK wraps a validation failure inside
 * `NoObjectGeneratedError`, and a provider can wrap it again. Pure, so the
 * classification is testable by constructing errors by hand.
 */
export function isSchemaViolation(error: unknown, depth = 5): boolean {
  let current: unknown = error;
  for (let level = 0; level <= depth; level++) {
    if (current === null || typeof current !== "object") return false;
    if (NoObjectGeneratedError.isInstance(current)) return true;
    const name = (current as { name?: unknown }).name;
    if (typeof name === "string" && SCHEMA_ERROR_NAMES.has(name)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Wraps anything that is not already a `ClipDescribeError`. */
function asClipDescribeError(
  error: unknown,
  clip: string,
  stage: DescribeStage,
  attempts: number,
  apiKey: string,
): ClipDescribeError {
  if (error instanceof ClipDescribeError) return error;
  return new ClipDescribeError({
    clip,
    stage,
    attempts,
    detail: redactSecrets(errorMessage(error), apiKey),
    cause: error,
  });
}

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

/** The three numbers that decide what the model actually sees. */
export interface ProxyRecipe {
  height: number;
  fps: number;
  maxSeconds: number;
}

/** An ffmpeg runner with `runFfmpeg`'s shape, so a test can supply its own. */
export type FfmpegRunner = (args: string[], options?: RunOptions) => Promise<RunResult>;

export interface ProxyOptions extends Partial<ProxyRecipe> {
  /** Overrides the timeout derived from `maxSeconds`. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Output directory. Defaults to `storage/temp/footage_proxies`. */
  dir?: string;
  /** Injected process runner; defaults to the shared `runFfmpeg`. */
  runner?: FfmpegRunner;
  /** Injected filename token, so a test can pin an otherwise-random name. */
  token?: () => string;
}

/**
 * Fills a partial recipe from `footage_index` settings.
 *
 * Settings are read only for the values the caller left out. A caller that
 * supplies all three — every test, and `describeClip`, which resolves the
 * recipe once and passes it down — never touches the settings singleton, and
 * so never needs it loaded.
 */
function proxyRecipe(options: Partial<ProxyRecipe>): ProxyRecipe {
  const { height, fps, maxSeconds } = options;
  if (height !== undefined && fps !== undefined && maxSeconds !== undefined) {
    return { height, fps, maxSeconds };
  }
  const configured = getSettings().footage_index;
  return {
    height: height ?? configured.proxy_height,
    fps: fps ?? configured.proxy_fps,
    maxSeconds: maxSeconds ?? configured.proxy_max_seconds,
  };
}

/**
 * ffmpeg's argv for one proxy encode.
 *
 * Pure, because the recipe is the part most likely to be edited by someone who
 * cannot afford to re-measure it, and this is what lets a test assert it
 * without spawning anything.
 *
 * Two details that are not free choices:
 *   - `-t` sits **before** `-i`, making it an input option, so ffmpeg stops
 *     demuxing after `maxSeconds` instead of reading a 211 MB file to the end
 *     and discarding the tail. That is the difference between ~2 s and ~20 s.
 *   - `scale=-2:<height>` keeps the aspect ratio and rounds the width to an
 *     even number, which H.264's chroma subsampling requires; `-1` would round
 *     to an odd width on some sources and fail the encode.
 *   - `format=yuv420p` normalises the pixel format. `scale` alone preserves the
 *     source's format, so a 10-bit or 4:2:2 clip would make libx264 emit a
 *     High10/422 stream that the model may refuse to decode. Stock libraries
 *     carry a steady trickle of 10-bit footage, so across a thousand-clip run
 *     this is the difference between a handful of unexplained describe
 *     failures and none.
 *
 * `-an` drops audio outright: nothing downstream listens to a clip, and stock
 * footage audio is usually silence or a stripped-out music bed anyway.
 */
export function buildProxyArgs(input: ProxyRecipe & { src: string; dest: string }): string[] {
  return [
    "-y",
    "-t",
    num(input.maxSeconds),
    "-i",
    input.src,
    "-vf",
    `scale=-2:${Math.round(input.height)},fps=${num(input.fps)},format=yuv420p`,
    "-an",
    "-c:v",
    "libx264",
    "-crf",
    "32",
    "-preset",
    "veryfast",
    input.dest,
  ];
}

/**
 * A wall-clock ceiling for one encode, derived from the clip budget.
 *
 * Unbounded is not an option: a truncated or corrupt file can leave ffmpeg
 * spinning, and with bounded concurrency one such file would hold a worker
 * slot for the rest of the run. Measured encodes are ~2 s for a 60 s proxy, so
 * two seconds of budget per second of footage — floor 30 s, ceiling 5 min — is
 * roughly fifty times the real cost and still finite.
 */
export function proxyTimeoutMs(maxSeconds: number): number {
  const budget = Math.ceil(maxSeconds) * 2_000;
  return Math.min(MAX_PROXY_TIMEOUT_MS, Math.max(MIN_PROXY_TIMEOUT_MS, budget));
}

/**
 * Proxy filename for one source clip.
 *
 * The source stem is kept so a leftover file after a hard kill is traceable
 * back to its clip, and the random token makes the name unique so two workers
 * describing the same file — a sweep racing the auto-index hook — cannot write
 * over each other's encode. Anything outside a conservative character set is
 * replaced, since the stem reaches the filesystem and the source name is not
 * this module's to trust.
 */
export function proxyFileName(src: string, token: string): string {
  const name = basename(src);
  const stem = name.slice(0, name.length - extname(name).length) || "clip";
  const safe = stem.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return `${safe}-${token}.mp4`;
}

/** Eight random hex characters; collision-free enough for a temp filename. */
function defaultToken(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Encodes the describe proxy for one clip and returns its path.
 *
 * **The caller owns the file.** `describeClip` deletes it in a `finally`;
 * anything else calling this directly must do the same, with `removeProxy`.
 * Failure paths clean up after themselves, so a leak is only possible on the
 * success path.
 *
 * The ffmpeg binary is resolved by `runFfmpeg`, which goes through
 * `getFfmpegBinary()` — the same resolution every other encode in the app uses,
 * so `FFMPEG_PATH` and the test seam apply here too.
 */
export async function buildProxy(src: string, options: ProxyOptions = {}): Promise<string> {
  const clip = basename(src);
  const recipe = proxyRecipe(options);
  const dir = options.dir ?? storageDir("temp/footage_proxies", true);
  const dest = join(dir, proxyFileName(src, (options.token ?? defaultToken)()));
  const runner = options.runner ?? runFfmpeg;
  const timeoutMs = options.timeoutMs ?? proxyTimeoutMs(recipe.maxSeconds);

  try {
    await runner(buildProxyArgs({ ...recipe, src: resolve(src), dest }), {
      timeoutMs,
      signal: options.signal,
    });
  } catch (error) {
    await removeProxy(dest);
    throw new ClipDescribeError({
      clip,
      stage: "proxy",
      attempts: 1,
      detail: errorMessage(error),
      cause: error,
    });
  }

  // ffmpeg can exit 0 having written nothing, so the exit code is not the
  // evidence — the file is. An empty proxy would otherwise be sent to the
  // model and come back as an unhelpful schema violation twice over.
  const bytes = existsSync(dest) ? statSync(dest).size : 0;
  if (bytes <= 0) {
    await removeProxy(dest);
    throw new ClipDescribeError({
      clip,
      stage: "proxy",
      attempts: 1,
      detail: "ffmpeg exited cleanly but produced no proxy output",
    });
  }

  logger.debug(
    `footage proxy: ${clip} -> ${bytes} bytes ` +
      `(${recipe.height}p, ${num(recipe.fps)} fps, first ${num(recipe.maxSeconds)}s)`,
  );
  return dest;
}

/** Best-effort delete. Never throws: cleanup must not mask the real error. */
export async function removeProxy(path: string): Promise<void> {
  await unlink(path).catch(() => {});
}

/** Reads a proxy into memory for an inline request. */
async function readProxyBytes(path: string): Promise<Uint8Array> {
  return await Bun.file(path).bytes();
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * System prompt for the describer.
 *
 * The proxy caveat is load-bearing rather than politeness: the model is looking
 * at 360p CRF 32 output, so without it `quality_flags` comes back with
 * "low resolution" and "heavy compression" on every clip in the library, which
 * would make the field useless for the one thing it exists for — spotting the
 * masters that are genuinely unusable.
 */
export const DESCRIBE_SYSTEM_PROMPT =
  "You are cataloguing stock footage for a semantic search index that a video editor queries " +
  "in plain language. You are shown a heavily compressed, low-resolution, reduced-frame-rate " +
  "PROXY of one clip, not the master: judge the content only, and never report the proxy's own " +
  "resolution, frame rate or compression as a defect of the footage. Describe what is visible " +
  "in the frames and nothing else — no interpretation of intent, no invented context. " +
  "Fill in every field.";

/**
 * The user-turn instruction, which states the proxy's actual parameters.
 *
 * They are interpolated rather than hardcoded because they are settings: if
 * `proxy_max_seconds` is lowered to 20, a model told the clip was truncated at
 * 60 s would describe an ending it never saw.
 */
export function describeInstruction(recipe: ProxyRecipe): string {
  return (
    `Catalogue this clip for the footage library. What you are seeing is a proxy: ` +
    `${Math.round(recipe.height)}p, ${num(recipe.fps)} frames per second, and truncated to the ` +
    `first ${num(recipe.maxSeconds)} seconds of a longer original. Judge the footage, not the proxy.`
  );
}

/** Appended on the second attempt, naming the reason the first one failed. */
const RETRY_INSTRUCTION =
  "Your previous response could not be parsed against the required schema. Return a single JSON " +
  "object matching the schema exactly: every field present, every array non-empty except " +
  "quality_flags, no prose and no markdown fence.";

/**
 * The user turn: the proxy's bytes, then the instruction.
 *
 * Media before text is Google's documented ordering for a single-media prompt,
 * and the bytes go inline as a `file` part rather than through the Files API —
 * at ~2 MB a proxy is far below the inline limit, so there is no upload, no
 * handle to expire, and no size branch.
 *
 * Pure: the caller supplies the bytes, so a test can build the exact message
 * this module would send from a fixture, with no ffmpeg and no filesystem.
 */
export function buildDescribeMessages(
  proxy: Uint8Array,
  recipe: ProxyRecipe,
  isRetry = false,
): ModelMessage[] {
  const instruction = isRetry
    ? `${describeInstruction(recipe)}\n\n${RETRY_INSTRUCTION}`
    : describeInstruction(recipe);

  return [
    {
      role: "user",
      content: [
        { type: "file", mediaType: PROXY_MEDIA_TYPE, data: proxy },
        { type: "text", text: instruction },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface DescribeRequest {
  model: LanguageModel;
  messages: ModelMessage[];
  signal?: AbortSignal;
}

export interface DescribeResponse {
  object: ClipDescription;
  totalTokens?: number;
}

/** The one network call, isolated so a test can replace it with a function. */
export type DescribeGenerator = (request: DescribeRequest) => Promise<DescribeResponse>;

export interface ResolvedDescribeModel {
  model: LanguageModel;
  modelName: string;
  /** Kept only so failures can be redacted before they are stored. */
  apiKey: string;
}

/**
 * Builds the describe model from settings.
 *
 * Follows `resolveProvider()` in `services/llm/index.ts`: the same
 * `createGoogleGenerativeAI({ apiKey })(modelName)` construction, against the
 * same `app.gemini_api_key`. It is deliberately *not* routed through the LLM
 * module's provider registry — that resolves whatever provider the operator
 * picked for scriptwriting, which may be OpenAI or a local Ollama, neither of
 * which can read a video. The describer needs Gemini specifically.
 *
 * Exported so a bulk run can fail once, up front, instead of once per clip.
 */
export function resolveDescribeModel(clip = ""): ResolvedDescribeModel {
  const settings = getSettings();
  const apiKey = String(settings.app.gemini_api_key ?? "").trim();
  const modelName = String(settings.footage_index.describe_model ?? "").trim();

  if (!apiKey) {
    throw new ClipDescribeError({
      clip,
      stage: "config",
      attempts: 0,
      detail: "app.gemini_api_key is not set; configure it in Settings",
    });
  }
  if (!modelName) {
    throw new ClipDescribeError({
      clip,
      stage: "config",
      attempts: 0,
      detail: "footage_index.describe_model is not set",
    });
  }

  return { model: createGoogleGenerativeAI({ apiKey })(modelName), modelName, apiKey };
}

/** Default generator: `generateObject` against the shared description schema. */
async function generateDescription(request: DescribeRequest): Promise<DescribeResponse> {
  const { object, usage } = await generateObject({
    model: request.model,
    schema: clipDescriptionSchema,
    system: DESCRIBE_SYSTEM_PROMPT,
    messages: request.messages,
    abortSignal: request.signal,
  });
  return { object, totalTokens: usage?.totalTokens };
}

// ---------------------------------------------------------------------------
// describeClip
// ---------------------------------------------------------------------------

export interface DescribeDeps {
  /** Pre-built model. Supplying it skips the settings lookup entirely. */
  model?: LanguageModel;
  /** Name recorded on the row; defaults to `footage_index.describe_model`. */
  modelName?: string;
  /** Replaces the whole model call — the seam a no-network test uses. */
  generate?: DescribeGenerator;
  buildProxy?: (src: string, options: ProxyOptions) => Promise<string>;
  readProxy?: (path: string) => Promise<Uint8Array>;
  removeProxy?: (path: string) => Promise<void>;
  /** Recipe and runner overrides handed to the proxy builder. */
  proxy?: ProxyOptions;
  signal?: AbortSignal;
}

export interface ClipDescribeResult {
  description: ClipDescription;
  /** Both go into the Qdrant payload and the `footage_index` row verbatim. */
  describe_model: string;
  describe_version: number;
  proxy_bytes: number;
  attempts: number;
  elapsed_ms: number;
  total_tokens?: number;
}

/**
 * Describes one clip: proxy, read, model, delete.
 *
 * Throws `ClipDescribeError` for anything the caller should record against the
 * clip, with one exception — if `deps.signal` aborted, the original error is
 * rethrown untouched, because a cancelled run is not a property of the clip and
 * writing it into `errors[]` would poison a row that never actually failed.
 */
export async function describeClip(
  path: string,
  deps: DescribeDeps = {},
): Promise<ClipDescribeResult> {
  const clip = basename(path);
  const startedAt = Date.now();

  // Resolved first, on purpose: an unset key must not cost an ffmpeg encode per
  // file before it is discovered.
  let model = deps.model;
  let modelName = deps.modelName ?? "";
  let apiKey = "";
  if (!model) {
    const resolved = resolveDescribeModel(clip);
    model = resolved.model;
    modelName ||= resolved.modelName;
    apiKey = resolved.apiKey;
  }

  const build = deps.buildProxy ?? buildProxy;
  const read = deps.readProxy ?? readProxyBytes;
  const remove = deps.removeProxy ?? removeProxy;
  const generate = deps.generate ?? generateDescription;

  // Resolved once here so the same numbers reach the encoder and the prompt —
  // and so the builder never re-reads settings underneath us.
  const recipe = proxyRecipe(deps.proxy ?? {});
  const proxyPath = await build(path, {
    ...deps.proxy,
    ...recipe,
    signal: deps.proxy?.signal ?? deps.signal,
  });

  try {
    let bytes: Uint8Array;
    try {
      bytes = await read(proxyPath);
    } catch (error) {
      if (deps.signal?.aborted) throw error;
      throw asClipDescribeError(error, clip, "read", 1, apiKey);
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_DESCRIBE_ATTEMPTS; attempt++) {
      try {
        const response = await generate({
          model,
          messages: buildDescribeMessages(bytes, recipe, attempt > 1),
          signal: deps.signal,
        });
        return {
          description: response.object,
          describe_model: modelName,
          describe_version: DESCRIBE_VERSION,
          proxy_bytes: bytes.byteLength,
          attempts: attempt,
          elapsed_ms: Date.now() - startedAt,
          total_tokens: response.totalTokens,
        };
      } catch (error) {
        if (deps.signal?.aborted) throw error;
        lastError = error;

        if (attempt < MAX_DESCRIBE_ATTEMPTS && isSchemaViolation(error)) {
          logger.warning(
            `describe ${clip}: response did not match the schema, retrying once ` +
              `(${redactSecrets(errorMessage(error), apiKey)})`,
          );
          continue;
        }

        throw asClipDescribeError(
          error,
          clip,
          isSchemaViolation(error) ? "schema" : "model",
          attempt,
          apiKey,
        );
      }
    }

    // Unreachable: the loop either returns or throws. Present so the function
    // has no implicit fall-through and the compiler agrees.
    throw asClipDescribeError(lastError, clip, "model", MAX_DESCRIBE_ATTEMPTS, apiKey);
  } finally {
    await remove(proxyPath);
  }
}
