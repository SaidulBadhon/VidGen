/**
 * OCR contracts shared by the recognition engines.
 *
 * The whole layer exists to serve one rule from the book pipeline: text that was
 * recognised from an image is never allowed to look like text that was read from
 * a text layer. Every engine therefore returns a confidence and its own id, and
 * `recognizePage` turns those into the `OcrProvenance` that rides along on the
 * block until a human has seen it in the review screen.
 *
 * The two engines fail in opposite ways, which is why both exist and why the
 * numbers they report are not interchangeable. Tesseract fails loudly — garbled
 * characters a listener recognises as broken — and reports a real per-word score.
 * A vision model fails silently, emitting fluent prose the author never wrote,
 * and reports nothing at all. See `ollamaVision.ts` for what its score means.
 */

export type OcrProviderId = "tesseract" | "ollama";

export const OCR_PROVIDER_IDS: readonly OcrProviderId[] = ["tesseract", "ollama"];

export interface OcrWord {
  text: string;
  /** 0..1. Engine-reported. */
  confidence: number;
  bbox?: { x: number; y: number; w: number; h: number };
}

export interface OcrResult {
  text: string;
  /** 0..1, mean or engine-reported. */
  confidence: number;
  words?: OcrWord[];
  provider: string;
  /**
   * Why this result is worth less than its confidence alone suggests, e.g. a
   * chatty preamble that had to be stripped off a vision transcription. Shown
   * verbatim in the review UI; empty when nothing was unusual.
   */
  notes?: string[];
}

export interface OcrOptions {
  /** Tesseract language code(s), e.g. `eng` or `eng+deu`. Ignored by vision models. */
  language?: string;
  /** Cancels a run that outlives the import it belongs to. */
  signal?: AbortSignal;
  /** Overrides the engine's own deadline. Milliseconds. */
  timeoutMs?: number;
  /**
   * Page image kept for review, relative to the book directory. Copied onto the
   * provenance so the reviewer can read the scan next to the transcription.
   */
  imagePath?: string;
}

export interface OcrProvider {
  readonly id: string;
  /** Cheap, and never throws: absence is an answer, not an error. */
  isAvailable(): Promise<boolean>;
  recognize(image: Uint8Array, options: OcrOptions): Promise<OcrResult>;
}

/**
 * Settings the OCR layer reads, resolved once so the pure logic below never
 * touches the settings singleton.
 */
export interface OcrConfig {
  /** "" disables OCR entirely. */
  provider: "" | OcrProviderId;
  language: string;
  /** Explicit path to the tesseract binary; "" resolves it from PATH. */
  tesseractPath: string;
  ollamaModel: string;
  /** Overrides the built-in transcription prompt; "" keeps it. */
  ollamaPrompt: string;
  /** Seconds, matching the other `*_timeout` settings. */
  ollamaTimeout: number;
  /** 0..1. Tesseract pages scoring below this escalate to the vision model. */
  minConfidence: number;
}

/**
 * An engine that is not installed, not running, or missing its model.
 *
 * Separate from a recognition failure on purpose: this one is fixed by the
 * operator, so it always carries the command that fixes it.
 */
export class OcrUnavailableError extends Error {
  readonly providerId: string;
  /** The actual command to run, quoted verbatim in the message. */
  readonly installHint: string;

  constructor(providerId: string, message: string, installHint: string) {
    super(installHint ? `${message} ${installHint}` : message);
    this.name = "OcrUnavailableError";
    this.providerId = providerId;
    this.installHint = installHint;
  }
}

/** An empty result, used wherever a page yields nothing rather than failing. */
export function emptyOcrResult(provider: string, notes?: string[]): OcrResult {
  return { text: "", confidence: 0, words: [], provider, ...(notes?.length ? { notes } : {}) };
}

/**
 * Mean word confidence, ignoring the rows Tesseract scores `-1`.
 *
 * Those rows are the page, block, paragraph and line records that share the TSV
 * with the words; averaging them in would drag every page toward zero and make
 * the escalation threshold meaningless.
 */
export function meanConfidence(words: readonly OcrWord[]): number {
  const scored = words.filter((word) => Number.isFinite(word.confidence) && word.confidence >= 0);
  if (scored.length === 0) return 0;

  const total = scored.reduce((sum, word) => sum + word.confidence, 0);
  return clampConfidence(total / scored.length);
}

export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
