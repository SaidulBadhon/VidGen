/**
 * OCR entry point: provider selection, the escalation policy, and provenance.
 *
 * This is the seam the PDF extractor talks to, and it exists to make one thing
 * impossible: recognised text reaching the narrator looking like text that was
 * read from a text layer. `recognizePage` therefore never returns a bare string.
 * It returns the transcription *and* the `OcrProvenance` to hang on the block,
 * *and* every engine result that contributed, so the review screen can show a
 * human what was recognised, by what, and how sure it was — before a word of it
 * is spoken.
 *
 * Escalation is the other half. Tesseract is tried first because it fails
 * loudly, and only a page it visibly could not read is worth handing to a model
 * that fails silently. The decision is a pure function returning a reason rather
 * than a boolean, because "why did this page go to the vision model" is a
 * question the review UI has to be able to answer.
 */

import { defaultSettings, type AppSettings } from "../../../config/schema.ts";
import { getSettings } from "../../../config/settings.ts";
import { logger, errorMessage } from "../../../utils/logger.ts";
import type { OcrProvenance } from "../types.ts";
import {
  OcrUnavailableError,
  emptyOcrResult,
  type OcrConfig,
  type OcrOptions,
  type OcrProvider,
  type OcrProviderId,
  type OcrResult,
  OCR_PROVIDER_IDS,
} from "./types.ts";
import { createTesseractProvider, resolveTesseractBinary, TESSERACT_PROVIDER_ID } from "./tesseract.ts";
import {
  createOllamaVisionProvider,
  probeOllamaVision,
  OLLAMA_PROVIDER_ID,
  type OllamaVisionProbe,
} from "./ollamaVision.ts";

export * from "./types.ts";
export {
  parseTesseractTsv,
  resolveTesseractBinary,
  imageFileExtension,
  createTesseractProvider,
  TESSERACT_PROVIDER_ID,
  type TesseractPage,
} from "./tesseract.ts";
export {
  sanitiseVisionTranscription,
  probeOllamaVision,
  isModelPresent,
  isModelMissingResponse,
  toOllamaNativeBaseUrl,
  createOllamaVisionProvider,
  OCR_VISION_PROMPT,
  NO_TEXT_SENTINEL,
  VISION_CONFIDENCE,
  DEFAULT_VISION_MODEL,
  MAX_PLAUSIBLE_PAGE_CHARACTERS,
  OLLAMA_PROVIDER_ID,
  type VisionGuard,
  type VisionSanitisation,
  type OllamaVisionProbe,
} from "./ollamaVision.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * The OCR slice of the app settings.
 *
 * Falls back to schema defaults when settings have not been loaded. OCR is a
 * leaf service and must never be the reason an import crashes — and the default
 * is `ocr_provider: ""`, which disables it, so the fallback cannot silently
 * enable an engine nobody asked for.
 */
export function resolveOcrConfig(): OcrConfig {
  let app: AppSettings;
  try {
    app = getSettings().app;
  } catch {
    app = defaultSettings().app;
  }

  return {
    provider: app.ocr_provider,
    language: app.ocr_language,
    tesseractPath: app.tesseract_path,
    ollamaModel: app.ocr_ollama_model,
    ollamaPrompt: app.ocr_ollama_prompt,
    ollamaTimeout: app.ocr_ollama_timeout,
    minConfidence: app.ocr_min_confidence,
  };
}

export function createOcrProvider(id: OcrProviderId, config: OcrConfig = resolveOcrConfig()): OcrProvider {
  if (id === TESSERACT_PROVIDER_ID) {
    return createTesseractProvider({ binaryPath: config.tesseractPath, language: config.language });
  }
  return createOllamaVisionProvider({
    model: config.ollamaModel,
    prompt: config.ollamaPrompt,
    timeoutMs: Math.max(1, config.ollamaTimeout) * 1_000,
  });
}

/** Every engine this build knows about, whether or not it is installed. */
export function listOcrProviders(config: OcrConfig = resolveOcrConfig()): OcrProvider[] {
  return OCR_PROVIDER_IDS.map((id) => createOcrProvider(id, config));
}

/** The configured engine, or null when OCR is switched off. */
export function getOcrProvider(id?: string, config: OcrConfig = resolveOcrConfig()): OcrProvider | null {
  const wanted = (id ?? config.provider).trim();
  if (!wanted) return null;
  if (!OCR_PROVIDER_IDS.includes(wanted as OcrProviderId)) return null;
  return createOcrProvider(wanted as OcrProviderId, config);
}

export function isOcrEnabled(config: OcrConfig = resolveOcrConfig()): boolean {
  return config.provider !== "";
}

// ---------------------------------------------------------------------------
// Escalation policy — pure
// ---------------------------------------------------------------------------

export type EscalationReason =
  | "no_vision_provider"
  | "confident"
  | "low_confidence"
  | "implausibly_short"
  | "no_text_recognised";

export interface EscalationDecision {
  escalate: boolean;
  /** Machine id, for grouping in the review UI and in logs. */
  reason: EscalationReason;
  /** Human-readable, shown verbatim beside the page. */
  detail: string;
}

export interface EscalationInput {
  result: OcrResult;
  /** `ocr_min_confidence`. Mean word confidence below this is not narratable. */
  minConfidence: number;
  /** False disables escalation outright, whatever the page looks like. */
  visionAvailable: boolean;
  /** Overrides the short-page floor. */
  minCharacters?: number;
}

/**
 * Below this a "page" is barely a line of type.
 *
 * A genuine printed page carries thousands of characters. Sixty is under one
 * line, so either the page is nearly blank — in which case the vision model
 * answers `[[NO_TEXT]]` cheaply and nothing is lost — or Tesseract failed to see
 * type that is plainly there. Both are worth a second opinion; the cost is one
 * extra inference on a page that has almost nothing on it.
 */
export const MIN_PLAUSIBLE_PAGE_CHARACTERS = 60;

/**
 * Whether a Tesseract page should be re-read by the vision model.
 *
 * Ordered so the returned reason is the most informative one: no vision engine
 * at all outranks everything, then nothing recognised, then a bad score, then a
 * page too short to be real.
 */
export function decideEscalation(input: EscalationInput): EscalationDecision {
  const { result, minConfidence } = input;
  const minCharacters = input.minCharacters ?? MIN_PLAUSIBLE_PAGE_CHARACTERS;
  const text = result.text.trim();

  if (!input.visionAvailable) {
    return {
      escalate: false,
      reason: "no_vision_provider",
      detail: "no vision model is configured or reachable, so the page stands as recognised",
    };
  }

  if (text.length === 0) {
    return {
      escalate: true,
      reason: "no_text_recognised",
      detail: `${result.provider} recognised no text on this page`,
    };
  }

  if (result.confidence < minConfidence) {
    return {
      escalate: true,
      reason: "low_confidence",
      detail:
        `${result.provider} scored ${result.confidence.toFixed(2)}, ` +
        `below the ${minConfidence.toFixed(2)} threshold`,
    };
  }

  if (text.length < minCharacters) {
    return {
      escalate: true,
      reason: "implausibly_short",
      detail: `${result.provider} recognised only ${text.length} characters, too few for a page`,
    };
  }

  return {
    escalate: false,
    reason: "confident",
    detail: `${result.provider} scored ${result.confidence.toFixed(2)} on ${text.length} characters`,
  };
}

/**
 * Picks between the engines that ran.
 *
 * Highest confidence wins, and a tie keeps the earlier result — Tesseract runs
 * first, and when two engines are equally sure the one that fails loudly is the
 * safer thing to narrate. Both results are kept on the recognition either way,
 * so a reviewer never has to take this function's word for it.
 */
export function chooseOcrResult(results: readonly OcrResult[]): OcrResult {
  if (results.length === 0) return emptyOcrResult("none");

  return results.reduce((best, candidate) => (candidate.confidence > best.confidence ? candidate : best));
}

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

export interface RecognizePageOptions extends OcrOptions {
  /** Overrides `ocr_provider` for this page. */
  provider?: OcrProviderId;
  /** Overrides `ocr_min_confidence`. */
  minConfidence?: number;
  /** False keeps a poor Tesseract page rather than asking the vision model. */
  escalate?: boolean;
}

export interface PageRecognition {
  /** The transcription to use. */
  text: string;
  confidence: number;
  provider: string;
  /** Attach verbatim to `Block.ocr`; this is what reaches the review screen. */
  provenance: OcrProvenance;
  /** Every engine that ran, in the order it ran, so a reviewer can compare. */
  attempts: OcrResult[];
  /** Why the page did or did not go to the vision model. */
  escalation?: EscalationDecision;
}

/**
 * Recognises one page image.
 *
 * Throws `OcrUnavailableError` when OCR is switched off or the configured engine
 * is not installed — a caller that wants a page to fall back to "no text" rather
 * than fail should check `isOcrEnabled()` first and catch.
 */
export async function recognizePage(
  image: Uint8Array,
  options: RecognizePageOptions = {},
): Promise<PageRecognition> {
  const config = resolveOcrConfig();
  const providerId = (options.provider ?? config.provider).trim();

  if (!providerId) {
    throw new OcrUnavailableError(
      "",
      "OCR is disabled, so a scanned page yields no text.",
      'Set app.ocr_provider to "tesseract" or "ollama".',
    );
  }
  const primary = getOcrProvider(providerId, config);
  if (!primary) {
    throw new OcrUnavailableError(
      providerId,
      `unknown OCR provider '${providerId}'.`,
      `Set app.ocr_provider to one of: ${OCR_PROVIDER_IDS.join(", ")}.`,
    );
  }

  const runOptions: OcrOptions = { language: config.language, ...options };
  const attempts: OcrResult[] = [await primary.recognize(image, runOptions)];
  const escalation = await maybeEscalate(image, attempts, primary, config, options, runOptions);

  const chosen = chooseOcrResult(attempts);
  return {
    text: chosen.text,
    confidence: chosen.confidence,
    provider: chosen.provider,
    provenance: {
      provider: chosen.provider,
      confidence: chosen.confidence,
      ...(options.imagePath ? { imagePath: options.imagePath } : {}),
    },
    attempts,
    ...(escalation ? { escalation } : {}),
  };
}

/** Runs the vision model when the policy asks for it, appending to `attempts`. */
async function maybeEscalate(
  image: Uint8Array,
  attempts: OcrResult[],
  primary: OcrProvider,
  config: OcrConfig,
  options: RecognizePageOptions,
  runOptions: OcrOptions,
): Promise<EscalationDecision | undefined> {
  // Only Tesseract escalates. The vision model has nothing to escalate *to*:
  // there is no second engine that is more trustworthy than it is.
  if (primary.id !== TESSERACT_PROVIDER_ID || options.escalate === false) return undefined;

  const first = attempts[0];
  if (!first) return undefined;

  const minConfidence = options.minConfidence ?? config.minConfidence;

  // Costed deliberately: the provisional decision is made assuming a vision
  // model exists, so a page that would not escalate anyway never pays for the
  // availability probe.
  const provisional = decideEscalation({ result: first, minConfidence, visionAvailable: true });
  if (!provisional.escalate) return provisional;

  const vision = createOcrProvider(OLLAMA_PROVIDER_ID, config);
  if (!(await isProviderAvailable(vision))) {
    return decideEscalation({ result: first, minConfidence, visionAvailable: false });
  }

  logger.info(`escalating page to the vision model: ${provisional.detail}`);
  try {
    attempts.push(await vision.recognize(image, runOptions));
  } catch (error) {
    // A failed second opinion must not lose the first one.
    logger.warning(`vision escalation failed, keeping the ${primary.id} result: ${errorMessage(error)}`);
  }
  return provisional;
}

/**
 * Availability, memoised briefly.
 *
 * A book is hundreds of pages, and asking a possibly-absent engine whether it
 * exists once per page is the kind of cost that turns a degraded import into a
 * stalled one. The window is short enough that starting Ollama mid-import is
 * still picked up.
 */
const AVAILABILITY_TTL_MS = 30_000;
const availabilityCache = new Map<string, { checkedAt: number; available: boolean }>();

async function isProviderAvailable(provider: OcrProvider): Promise<boolean> {
  const cached = availabilityCache.get(provider.id);
  if (cached && Date.now() - cached.checkedAt < AVAILABILITY_TTL_MS) return cached.available;

  let available = false;
  try {
    available = await provider.isAvailable();
  } catch {
    available = false;
  }
  availabilityCache.set(provider.id, { checkedAt: Date.now(), available });
  return available;
}

/** Test seam, and the way to pick up an engine that was just installed. */
export function resetOcrAvailabilityCache(): void {
  availabilityCache.clear();
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface OcrDiagnostics {
  /** The configured `ocr_provider`; "" means OCR is off. */
  provider: "" | OcrProviderId;
  enabled: boolean;
  tesseract: {
    available: boolean;
    /** Where the binary was found, or "" when it was not. */
    binaryPath: string;
    hint: string;
  };
  ollama: OllamaVisionProbe;
}

/**
 * Reports what the OCR layer can actually do on this machine right now.
 *
 * Never throws: this is the thing to run when a scanned import produced no
 * text, and it has to work precisely when everything else does not.
 */
export async function probeOcr(config: OcrConfig = resolveOcrConfig()): Promise<OcrDiagnostics> {
  let binaryPath = "";
  try {
    binaryPath = resolveTesseractBinary(config.tesseractPath) ?? "";
  } catch {
    binaryPath = "";
  }

  const ollama = await probeOllamaVision({
    model: config.ollamaModel,
    timeoutMs: 3_000,
  }).catch(
    (): OllamaVisionProbe => ({
      baseUrl: "",
      model: config.ollamaModel,
      reachable: false,
      version: "",
      modelListed: false,
      availableModels: [],
      hint: "the Ollama probe itself failed",
    }),
  );

  return {
    provider: config.provider,
    enabled: config.provider !== "",
    tesseract: {
      available: binaryPath !== "",
      binaryPath,
      hint: binaryPath
        ? ""
        : "tesseract was not found; `brew install tesseract` on macOS, " +
          "`apt-get install -y tesseract-ocr` on Debian/Ubuntu, or set app.tesseract_path",
    },
    ollama,
  };
}
