/**
 * Vision-model OCR through Ollama's native `/api/generate`.
 *
 * This engine is the dangerous one, and everything in this file is shaped by
 * that. Tesseract fails loudly: a listener hears mangled words and knows the
 * page was bad. A vision model fails *silently* — it writes fluent, plausible
 * text in the same register as the book, and it omits things without saying so.
 * Narrated aloud, neither is detectable.
 *
 * Measured against minicpm-v on a rendered book page, character accuracy was not
 * the problem. Three other behaviours were, and they are why this file is more
 * than a fetch call:
 *
 *  - It invents structural labels that are nowhere on the page — `Title:`,
 *    `Subtitle:`, `Body Text:`, `Footer:` — which narrate as if the labels were
 *    printed. Naming those exact strings in the prompt and forbidding them did
 *    *not* stop it. Reframing the model's role away from "assistant" did. See
 *    OCR_VISION_PROMPT.
 *  - Even the working prompt still added markdown emphasis the page does not
 *    contain, so prompting is necessary and not sufficient; the guards below run
 *    regardless, because the operator may point this at any vision model.
 *  - Runs differ in what they omit. One prompt silently dropped the page number
 *    another captured. Nothing in the output distinguishes a complete page from
 *    a partial one, which is the single strongest reason the confidence here is
 *    a low constant and every block reaches human review.
 */

import { Buffer } from "node:buffer";

import { getDefaultOllamaBaseUrl } from "../../../config/runtime.ts";
import { logger, errorMessage } from "../../../utils/logger.ts";
import {
  emptyOcrResult,
  OcrUnavailableError,
  type OcrOptions,
  type OcrProvider,
  type OcrResult,
} from "./types.ts";

export const OLLAMA_PROVIDER_ID = "ollama";

/**
 * Tagged explicitly: a bare `minicpm-v` was rejected by `/api/generate` in
 * testing even while `/api/tags` listed it.
 */
export const DEFAULT_VISION_MODEL = "minicpm-v:latest";

/** Emitted instead of inventing content for a page with nothing readable on it. */
export const NO_TEXT_SENTINEL = "[[NO_TEXT]]";

/** Roughly 2s of inference per page plus a one-off model load, with headroom. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** `isAvailable()` sits on a hot path and must not stall an import. */
const AVAILABILITY_TIMEOUT_MS = 3_000;

/** The verification generate has to absorb a cold model load. */
const VERIFY_TIMEOUT_MS = 60_000;

/**
 * Hard ceiling on generated tokens.
 *
 * Vision models degenerate into loops on an unreadable page. Capping the decode
 * stops that at the source rather than waiting out the timeout; the over-long
 * guard below catches whatever still gets through.
 */
const MAX_PREDICT_TOKENS = 3_072;

/**
 * More characters than any single book page carries.
 *
 * A dense large-format page runs to roughly 4,500 characters, so output past
 * this is the model generating rather than reading.
 */
export const MAX_PLAUSIBLE_PAGE_CHARACTERS = 8_000;

/**
 * The confidence every vision transcription is assigned. Never derived.
 *
 * 0.45 is chosen, not measured, and it has to satisfy three things at once:
 *
 *  - It sits below the default `ocr_min_confidence` (0.75), so a page escalated
 *    to the vision model is never thereby marked trustworthy. Escalation buys a
 *    second opinion, not a clean bill of health — especially given that runs
 *    were observed to drop page furniture silently.
 *  - It sorts vision blocks above essentially all successful Tesseract output in
 *    the review screen's least-certain-first ordering, which is where a human
 *    has to see them before anything is narrated.
 *  - It doubles as the crossover point when both engines ran. Tesseract only
 *    loses to the vision model when it scored below 0.45 — i.e. when most of its
 *    words were outright guesses. Between 0.45 and the threshold, Tesseract's
 *    mediocre-but-honest output is preferred over an unverifiable transcription,
 *    because an engine that fails loudly is worth more here than one that does
 *    not.
 *
 * Accuracy being good in testing is not a reason to raise it. The number does
 * not describe how well the model reads; it describes that nothing in the
 * output tells us whether it read at all.
 */
export const VISION_CONFIDENCE = 0.45;

/** Applied when the model added text of its own: it was not obeying the prompt. */
const PREAMBLE_PENALTY = 0.8;

/**
 * The transcription prompt.
 *
 * The first four sentences are the wording that measurably worked. Three other
 * phrasings were tried against minicpm-v and all three produced invented
 * structural labels, including one that named `Title`, `Body Text`, `Header` and
 * `Footer` and forbade them outright. What suppressed them was not a stronger
 * prohibition but denying the model its assistant role: an OCR engine has no
 * reason to label anything.
 *
 * The last two sentences are additions in the same register, covering the
 * failure that matters most for narration — quietly finishing a sentence the
 * page cuts off. They were not part of the measured prompt, so if label
 * hallucination ever returns, they are the first thing to remove.
 */
export const OCR_VISION_PROMPT = [
  "You are an OCR engine, not an assistant.",
  "Output the exact characters visible in the image and nothing else.",
  'Never add labels, headings, categories, or descriptions such as "Title:", "Body Text:" or "Footer:".',
  "Never explain.",
  "Never continue, complete or correct the text; stop exactly where the page stops.",
  "Keep the line breaks as they appear.",
  `If unreadable, output exactly ${NO_TEXT_SENTINEL}.`,
].join(" ");

/** Distinctive fragments of the prompt, used to catch the model echoing it back. */
const PROMPT_FINGERPRINTS = [
  "you are an ocr engine",
  "the exact characters visible in the image",
  "never add labels, headings, categories",
  "stop exactly where the page stops",
];

// ---------------------------------------------------------------------------
// Sanitisation — pure, and the only thing standing between a hallucination and
// a narrator reading it out
// ---------------------------------------------------------------------------

export type VisionGuard =
  | "blank_page"
  | "code_fence_stripped"
  | "markdown_stripped"
  | "structural_labels_stripped"
  | "preamble_stripped"
  | "meta_commentary"
  | "prompt_echo"
  | "over_long";

export interface VisionSanitisation {
  /** The transcription to keep. Empty whenever nothing survived. */
  text: string;
  /** False when the output was commentary or invention rather than a transcription. */
  accepted: boolean;
  confidence: number;
  guards: VisionGuard[];
  /** Human-readable, surfaced beside the block in the review UI. */
  notes: string[];
}

/**
 * Phrases that are model commentary wherever they appear.
 *
 * Kept narrow on purpose. A bare "I cannot" is ordinary dialogue in a novel, so
 * only the task-shaped forms count.
 */
const META_ANYWHERE: readonly RegExp[] = [
  /\bas an ai\b/i,
  /\bi (?:cannot|can'?t|can not|am unable to) (?:read|transcribe|make out|decipher|provide|assist|help|process|extract)\b/i,
  /\bunable to (?:read|transcribe|extract|make out|decipher) (?:the|this|any)\b/i,
];

/**
 * Phrases that are commentary only at the edges of the output.
 *
 * "The image shows" and "I'm sorry" occur in real books; a model's framing of
 * the task occurs at the start or the very end. Restricting these to the margins
 * keeps a novel's dialogue out of the guard while still catching the model.
 */
const META_AT_EDGES: readonly RegExp[] = [
  /\bi(?:'m| am) sorry\b/i,
  /\b(?:the|this) (?:image|picture|photo|scan|page|document) (?:shows|show|depicts|appears|contains|seems|is a|is an)\b/i,
  /\bhere (?:is|are) the (?:transcription|transcribed|text|content)\b/i,
  /\bno (?:readable |legible |visible |discernible )?text (?:is |was |can be )?(?:visible|present|found|detected|seen|read)\b/i,
  /\bi (?:don'?t|do not) (?:see|have) (?:any )?(?:readable )?text\b/i,
];

/** How much of each end counts as "the edge" for the patterns above. */
const EDGE_WINDOW = 240;

/**
 * Labels a vision model prepends to the parts of a page it has classified.
 *
 * Observed verbatim from minicpm-v on a page containing none of these words.
 * The list stays deliberately short — every entry is a phrase that essentially
 * never opens a line of a real book, which is what makes stripping it safe.
 */
const STRUCTURAL_LABEL =
  /^[ \t]*(?:title|subtitle|heading|header|footer|body[ \t]*text|running[ \t]*head|page(?:[ \t]*number)?|caption)[ \t]*:[ \t]*/i;

/** Openers a chat model puts in front of the thing it was actually asked for. */
const PREAMBLE_OPENER =
  /^(?:sure|certainly|of course|okay|ok|alright)?[,.!:]?\s*(?:here(?:'s| is| are)\b|below (?:is|are)\b|the following is\b|transcription\b|transcribed text\b|ocr(?: output| result)?\b)/i;

/** A preamble must also name what it is introducing, or it is just prose. */
const PREAMBLE_SUBJECT = /\b(?:transcription|transcribed|text|image|page|content|document|ocr)\b/i;

/** Beyond this the "first line" is prose, not a label. */
const MAX_PREAMBLE_LENGTH = 120;

export interface SanitiseOptions {
  /** Overrides the page-length ceiling. */
  maxCharacters?: number;
}

/**
 * Turns raw model output into either a transcription or nothing.
 *
 * The bias is entirely one way: a guard that fires wrongly costs one page that a
 * reviewer has to re-run, and it is visible in the review UI because the reason
 * is recorded. A guard that fails to fire costs invented prose spoken aloud in
 * the author's voice. Everything ambiguous is therefore rejected.
 */
export function sanitiseVisionTranscription(
  raw: string,
  options: SanitiseOptions = {},
): VisionSanitisation {
  const guards: VisionGuard[] = [];
  const notes: string[] = [];
  const blank = (note: string): VisionSanitisation => ({
    text: "",
    accepted: true,
    confidence: 0,
    guards: [...guards, "blank_page"],
    notes: [...notes, note],
  });
  const reject = (guard: VisionGuard, note: string): VisionSanitisation => ({
    text: "",
    accepted: false,
    confidence: 0,
    guards: [...guards, guard],
    notes: [...notes, note],
  });

  const trimmed = String(raw ?? "").trim();
  let text = stripCodeFence(trimmed);
  if (text !== trimmed) {
    guards.push("code_fence_stripped");
    notes.push("the model wrapped its answer in a markdown code fence");
  }
  text = text.trim();
  if (!text) return blank("the model returned nothing for this page");

  // Checked before the regexes so a runaway generation is not also scanned.
  const ceiling = options.maxCharacters ?? MAX_PLAUSIBLE_PAGE_CHARACTERS;
  if (text.length > ceiling) {
    return reject(
      "over_long",
      `the model produced ${text.length} characters, more than a page can hold (${ceiling}); ` +
        "treated as generated rather than read",
    );
  }

  const lowered = text.toLowerCase();
  const echoed = PROMPT_FINGERPRINTS.find((fingerprint) => lowered.includes(fingerprint));
  if (echoed) {
    return reject("prompt_echo", `the model echoed the instructions back ("${echoed}")`);
  }

  // The sentinel is the model doing the right thing, so it is honoured before
  // anything else can interpret the words around it.
  if (text.includes(NO_TEXT_SENTINEL)) {
    const remainder = text.split(NO_TEXT_SENTINEL).join(" ").trim();
    if (!remainder) return blank("the model reported no readable text on this page");
    text = remainder;
    notes.push("the model reported no readable text but also produced some");
  }

  // Markdown comes off first: it wraps both the preamble and the invented
  // labels, so removing it lets one plain pattern match `Title:` and
  // `**Title:**` alike.
  const plain = stripMarkdown(text);
  if (plain !== text) {
    guards.push("markdown_stripped");
    notes.push("removed markdown the page does not contain");
    text = plain;
  }

  const preamble = stripPreamble(text);
  if (preamble.stripped) {
    guards.push("preamble_stripped");
    notes.push(`removed a conversational preamble: "${preamble.removed}"`);
    text = preamble.text;
    if (!text.trim()) {
      return reject("meta_commentary", "the model answered with a preamble and no transcription");
    }
  }

  const labelled = stripStructuralLabels(text);
  if (labelled.removed.length > 0) {
    guards.push("structural_labels_stripped");
    notes.push(`removed invented structural labels: ${labelled.removed.join(", ")}`);
    text = labelled.text;
  }

  text = text.trim();
  if (!text) return blank("nothing survived once the model's own additions were removed");

  const commentary = findMetaCommentary(text);
  if (commentary) {
    return reject(
      "meta_commentary",
      `the model commented on the page instead of transcribing it ("${commentary}")`,
    );
  }

  // Markdown alone is formatting noise and expected even from a well-behaved
  // model. A preamble or an invented label is the model narrating the page, so
  // the result is worth less than a clean one.
  const invented =
    guards.includes("preamble_stripped") || guards.includes("structural_labels_stripped");

  return {
    text,
    accepted: true,
    confidence: invented ? VISION_CONFIDENCE * PREAMBLE_PENALTY : VISION_CONFIDENCE,
    guards,
    notes,
  };
}

/** Removes a ```-fenced wrapper, which vision models add unbidden. */
function stripCodeFence(raw: string): string {
  const text = raw.trim();
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
  return match ? (match[1] ?? "") : text;
}

/**
 * Removes markdown a printed page cannot contain.
 *
 * Emphasis and heading markers are characters the model added, and narrated
 * aloud they are at best silent and at worst read out. Single `*` and `_` are
 * left alone: those do appear in real books.
 */
function stripMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^[ \t]{0,3}#{1,6}[ \t]+/, ""))
    .join("\n")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`{1,3}([^`\n]+)`{1,3}/g, "$1");
}

/** Drops `Title:`-style prefixes, keeping whatever followed them. */
function stripStructuralLabels(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const lines = text.split("\n").map((line) => {
    const match = STRUCTURAL_LABEL.exec(line);
    if (!match) return line;

    removed.push(match[0].trim());
    return line.slice(match[0].length);
  });

  return { text: lines.join("\n"), removed };
}

function stripPreamble(text: string): { text: string; stripped: boolean; removed: string } {
  const newline = text.indexOf("\n");
  const firstLine = (newline === -1 ? text : text.slice(0, newline)).trim();
  if (!PREAMBLE_OPENER.test(firstLine) || !PREAMBLE_SUBJECT.test(firstLine)) {
    return { text, stripped: false, removed: "" };
  }

  // "Here is the transcription: CHAPTER ONE" keeps the part after the colon.
  const colon = firstLine.search(/[:：]/);
  if (colon !== -1 && colon <= MAX_PREAMBLE_LENGTH) {
    const head = firstLine.slice(0, colon);
    const tail = firstLine.slice(colon + 1).trimStart();
    const rest = newline === -1 ? "" : text.slice(newline + 1);
    const joined = tail && rest ? `${tail}\n${rest}` : tail || rest;
    return { text: joined.trimStart(), stripped: true, removed: head.trim() };
  }

  if (firstLine.length > MAX_PREAMBLE_LENGTH) return { text, stripped: false, removed: "" };
  const rest = newline === -1 ? "" : text.slice(newline + 1);
  return { text: rest.trimStart(), stripped: true, removed: firstLine };
}

/** The matched commentary, or "" when the output reads like a transcription. */
function findMetaCommentary(text: string): string {
  for (const pattern of META_ANYWHERE) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }

  const edges =
    text.length <= EDGE_WINDOW * 2
      ? text
      : `${text.slice(0, EDGE_WINDOW)}\n${text.slice(-EDGE_WINDOW)}`;
  for (const pattern of META_AT_EDGES) {
    const match = pattern.exec(edges);
    if (match) return match[0];
  }

  return "";
}

// ---------------------------------------------------------------------------
// Ollama plumbing
// ---------------------------------------------------------------------------

/**
 * Ollama's native API root.
 *
 * `getDefaultOllamaBaseUrl()` yields the OpenAI-compatible base (`.../v1`),
 * which is what the chat client wants. `/api/generate` and `/api/tags` sit one
 * level above it, and only the native endpoint accepts the `images` array this
 * needs, so the suffix is trimmed rather than a second setting introduced.
 */
export function toOllamaNativeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * Whether the configured model is one of the ones the server lists.
 *
 * Ollama reports fully qualified names (`minicpm-v:latest`) while people
 * configure the bare one, so an untagged name matches its `:latest` build.
 *
 * Being listed is necessary but *not* sufficient: right after a pull the tag can
 * exist while its blobs do not, and `/api/generate` then rejects the very name
 * `/api/tags` just returned. `verifyModelUsable` is what settles that.
 */
export function isModelPresent(available: readonly string[], model: string): boolean {
  const wanted = model.trim().toLowerCase();
  if (!wanted) return false;

  const wantedTagged = wanted.includes(":") ? wanted : `${wanted}:latest`;
  return available.some((name) => {
    const candidate = name.trim().toLowerCase();
    const candidateTagged = candidate.includes(":") ? candidate : `${candidate}:latest`;
    return candidateTagged === wantedTagged;
  });
}

/** True when the server's rejection means "this model is not usable". */
export function isModelMissingResponse(status: number, body: string): boolean {
  if (status === 404) return true;
  return /model\s+'?[^']*'?\s+not found|no such model|pull the model/i.test(body);
}

/** Composes a deadline with the caller's cancellation into one signal. */
function deadline(timeoutMs: number, signal?: AbortSignal): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);

  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener("abort", onAbort, { once: true });

  return {
    signal: controller.signal,
    dispose(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export interface OllamaVisionProviderOptions {
  model?: string;
  /** Native API root. Detected from the runtime when absent. */
  baseUrl?: string;
  timeoutMs?: number;
  maxCharacters?: number;
  /** Overrides the built-in prompt. Empty keeps OCR_VISION_PROMPT. */
  prompt?: string;
}

async function resolveBaseUrl(configured?: string): Promise<string> {
  return toOllamaNativeBaseUrl(configured?.trim() || (await getDefaultOllamaBaseUrl()));
}

export interface OllamaVisionProbe {
  baseUrl: string;
  model: string;
  /** The server answered `/api/version`. */
  reachable: boolean;
  version: string;
  /** The model appears in `/api/tags`. Necessary, not sufficient. */
  modelListed: boolean;
  /**
   * `/api/generate` accepted the model. `undefined` when the check was skipped.
   * This is the only reliable answer, because a freshly pulled tag can be listed
   * while its blobs are still incomplete.
   */
  modelUsable?: boolean;
  /** Everything the server has, so a typo in the model name is obvious. */
  availableModels: string[];
  /** The next thing to do. Empty when the vision path is ready. */
  hint: string;
}

export interface ProbeOptions extends OllamaVisionProviderOptions {
  /**
   * Confirm the model really runs by asking it for a single token.
   * On by default: the cheap listing check is exactly the one that lies.
   */
  verify?: boolean;
}

/**
 * Reports whether vision OCR can actually run right now.
 *
 * A diagnostic, not a test helper: the things that go wrong — the server is not
 * running, the model was never pulled, the model was pulled but is broken — have
 * different fixes and are indistinguishable from a failed page. Never throws.
 */
export async function probeOllamaVision(options: ProbeOptions = {}): Promise<OllamaVisionProbe> {
  const model = options.model?.trim() || DEFAULT_VISION_MODEL;
  const timeoutMs = options.timeoutMs ?? AVAILABILITY_TIMEOUT_MS;

  let baseUrl = "";
  try {
    baseUrl = await resolveBaseUrl(options.baseUrl);
  } catch (error) {
    return {
      baseUrl: "",
      model,
      reachable: false,
      version: "",
      modelListed: false,
      availableModels: [],
      hint: `could not work out the Ollama address: ${errorMessage(error)}`,
    };
  }

  const version = await getJson<{ version?: string }>(`${baseUrl}/api/version`, timeoutMs);
  if (!version) {
    return {
      baseUrl,
      model,
      reachable: false,
      version: "",
      modelListed: false,
      availableModels: [],
      hint: `no Ollama server at ${baseUrl}; start it with \`ollama serve\``,
    };
  }

  const tags = await getJson<{ models?: Array<{ name?: string; model?: string }> }>(
    `${baseUrl}/api/tags`,
    timeoutMs,
  );
  const availableModels = (tags?.models ?? [])
    .map((entry) => entry.name ?? entry.model ?? "")
    .filter(Boolean);
  const modelListed = isModelPresent(availableModels, model);

  const base = { baseUrl, model, reachable: true, version: version.version ?? "", modelListed, availableModels };

  if (options.verify === false) {
    return {
      ...base,
      hint: modelListed ? "" : `model '${model}' is not installed; run \`ollama pull ${model}\``,
    };
  }

  const verified = await verifyModelUsable(baseUrl, model, VERIFY_TIMEOUT_MS);
  if (verified.usable) return { ...base, modelUsable: true, hint: "" };

  return {
    ...base,
    modelUsable: false,
    hint: modelListed
      ? `model '${model}' is listed but /api/generate rejected it (${verified.detail || "no detail"}); ` +
        `its blobs are probably incomplete, so run \`ollama pull ${model}\` again`
      : `model '${model}' is not installed; run \`ollama pull ${model}\``,
  };
}

/** Asks the model for one token, which is the cheapest proof that it runs. */
async function verifyModelUsable(
  baseUrl: string,
  model: string,
  timeoutMs: number,
): Promise<{ usable: boolean; detail: string }> {
  const bound = deadline(timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: "ok",
        stream: false,
        options: { temperature: 0, num_predict: 1 },
      }),
      signal: bound.signal,
    });
    if (response.ok) return { usable: true, detail: "" };
    return { usable: false, detail: (await response.text()).slice(0, 200).trim() };
  } catch (error) {
    return { usable: false, detail: errorMessage(error) };
  } finally {
    bound.dispose();
  }
}

/** A bounded GET that reports failure as `undefined` rather than throwing. */
async function getJson<T>(url: string, timeoutMs: number): Promise<T | undefined> {
  const bound = deadline(timeoutMs);
  try {
    const response = await fetch(url, { signal: bound.signal });
    if (!response.ok) return undefined;
    return (await response.json()) as T;
  } catch {
    return undefined;
  } finally {
    bound.dispose();
  }
}

export function createOllamaVisionProvider(options: OllamaVisionProviderOptions = {}): OcrProvider {
  const model = options.model?.trim() || DEFAULT_VISION_MODEL;
  const prompt = options.prompt?.trim() || OCR_VISION_PROMPT;

  return {
    id: OLLAMA_PROVIDER_ID,

    async isAvailable(): Promise<boolean> {
      // Listing only: this runs per escalated page, and the expensive proof is
      // not worth paying for repeatedly. A model that is listed but broken shows
      // up as an actionable OcrUnavailableError from `recognize()` instead.
      try {
        const probe = await probeOllamaVision({ ...options, model, verify: false });
        return probe.reachable && probe.modelListed;
      } catch {
        return false;
      }
    },

    async recognize(image: Uint8Array, runOptions: OcrOptions): Promise<OcrResult> {
      const provider = `${OLLAMA_PROVIDER_ID}:${model}`;
      const baseUrl = await resolveBaseUrl(options.baseUrl);
      const timeoutMs = runOptions.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const bound = deadline(timeoutMs, runOptions.signal);

      let payload: { response?: unknown };
      try {
        const response = await fetch(`${baseUrl}/api/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            prompt,
            images: [Buffer.from(image).toString("base64")],
            stream: false,
            // Temperature 0 is not about quality: sampling is what turns an
            // unreadable page into confident invention.
            options: { temperature: 0, num_predict: MAX_PREDICT_TOKENS },
          }),
          signal: bound.signal,
        });

        if (!response.ok) {
          const body = (await response.text()).slice(0, 300).trim();
          if (isModelMissingResponse(response.status, body)) {
            throw new OcrUnavailableError(
              OLLAMA_PROVIDER_ID,
              `Ollama cannot run model '${model}' (${body || `HTTP ${response.status}`}).`,
              `Run \`ollama pull ${model}\`. A tag can appear in \`ollama list\` while its ` +
                "blobs are still incomplete, so pull it again even if it looks installed.",
            );
          }
          throw new Error(`ollama /api/generate failed: HTTP ${response.status} ${body}`);
        }
        payload = (await response.json()) as { response?: unknown };
      } catch (error) {
        if (error instanceof OcrUnavailableError) throw error;
        if (runOptions.signal?.aborted) throw new Error("vision OCR was cancelled");
        if (bound.signal.aborted) throw new Error(`vision OCR timed out after ${timeoutMs}ms`);
        throw new OcrUnavailableError(
          OLLAMA_PROVIDER_ID,
          `could not reach Ollama at ${baseUrl}: ${errorMessage(error)}.`,
          'Start it with `ollama serve`, or set app.ocr_provider to "tesseract".',
        );
      } finally {
        bound.dispose();
      }

      const raw = typeof payload.response === "string" ? payload.response : "";
      const clean = sanitiseVisionTranscription(raw, { maxCharacters: options.maxCharacters });

      if (!clean.accepted) {
        logger.warning(`vision OCR output rejected: ${clean.notes.join("; ")}`);
        return emptyOcrResult(provider, clean.notes);
      }
      if (clean.notes.length > 0) logger.info(`vision OCR: ${clean.notes.join("; ")}`);

      return {
        text: clean.text,
        confidence: clean.confidence,
        provider,
        ...(clean.notes.length > 0 ? { notes: clean.notes } : {}),
      };
    },
  };
}
