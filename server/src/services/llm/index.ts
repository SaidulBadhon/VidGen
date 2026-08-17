/**
 * LLM access through the Vercel AI SDK.
 *
 * The Python version hand-rolled an adapter per provider (16 of them). Here the
 * AI SDK owns transport and response shapes, so this module only resolves the
 * configured provider into a model and owns the prompts, retries and output
 * cleanup that are specific to this app.
 *
 * Ported from python-version/app/services/llm.py.
 */

import { generateObject, generateText, type LanguageModel } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";

import { appConfig, resolveContentLanguage } from "../../config/settings.ts";
import {
  DEFAULT_LLM_PROVIDER_ID,
  getLlmProvider,
  providerConfigKey,
  resolveBaseUrl,
  resolveModelName,
  type LlmProviderSpec,
} from "../../config/llmProviders.ts";
import { getDefaultOllamaBaseUrl } from "../../config/runtime.ts";
import { logger, errorMessage } from "../../utils/logger.ts";
import { redactSecrets } from "../../utils/misc.ts";
import {
  DEFAULT_SOCIAL_PLATFORM,
  SOCIAL_PLATFORMS,
  buildScriptPrompt,
  buildSegmentBoundariesPrompt,
  buildSocialMetadataPrompt,
  buildTermsPrompt,
  clampText,
  fallbackSocialMetadata,
  limitScriptText,
  normalizeHashtags,
  normalizeScriptParagraphNumber,
  resolveSocialPlatform,
  MAX_SCRIPT_PROMPT_LENGTH,
  MAX_SCRIPT_SYSTEM_PROMPT_LENGTH,
  MAX_SEGMENT_TITLE_LENGTH,
  type SegmentOutlineLine,
} from "./prompts.ts";

const MAX_RETRIES = 5;

/**
 * Reasoning models (DeepSeek R1, MiniMax M-series and similar) may wrap their
 * chain of thought in `<think>` tags. Only the final spoken text is wanted, so
 * it is stripped centrally — otherwise the UI, subtitles and TTS would all
 * treat the reasoning as script content.
 */
const THINK_BLOCK = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
const UNCLOSED_THINK_BLOCK = /<think\b[^>]*>[\s\S]*$/i;

export class LlmConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigurationError";
  }
}

interface ResolvedProvider {
  spec: LlmProviderSpec;
  model: LanguageModel;
  modelName: string;
  apiKey: string;
}

function readConfig(spec: LlmProviderSpec, suffix: string): string {
  const config = appConfig() as unknown as Record<string, unknown>;
  return String(config[providerConfigKey(spec, suffix)] ?? "");
}

/** Builds a LanguageModel from the configured provider settings. */
export async function resolveProvider(): Promise<ResolvedProvider> {
  const providerId = String(appConfig().llm_provider ?? DEFAULT_LLM_PROVIDER_ID).toLowerCase();
  const spec = getLlmProvider(providerId);
  if (!spec) {
    throw new LlmConfigurationError(`${providerId}: unsupported llm provider`);
  }

  logger.info(`llm provider: ${providerId}`);

  let apiKey = readConfig(spec, "api_key");
  const configuredModel = readConfig(spec, "model_name");
  const modelName = resolveModelName(spec, configuredModel);
  if (configuredModel && modelName !== configuredModel) {
    logger.warning(`${providerId} model '${configuredModel}' is deprecated, fallback to '${modelName}'`);
  }

  let baseUrl = resolveBaseUrl(spec, readConfig(spec, "base_url"));

  // Ollama's reachable address depends on whether we run in a container, so it
  // cannot be a static registry value.
  if (spec.providerId === "gemma") {
    apiKey ||= "ollama";
    if (!baseUrl) baseUrl = await getDefaultOllamaBaseUrl();
  }

  if (spec.requiresApiKey && !apiKey) {
    throw new LlmConfigurationError(`${providerId}: api_key is not set, configure it in Settings.`);
  }
  if (spec.requiresModelName && !modelName) {
    throw new LlmConfigurationError(`${providerId}: model_name is not set, configure it in Settings.`);
  }
  if (spec.requiresBaseUrl && !baseUrl) {
    throw new LlmConfigurationError(`${providerId}: base_url is not set, configure it in Settings.`);
  }

  let model: LanguageModel;
  switch (spec.adapter) {
    case "google": {
      const google = createGoogleGenerativeAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
      model = google(modelName);
      break;
    }
    case "openai": {
      const openai = createOpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
      model = openai(modelName);
      break;
    }
    case "openai-compatible": {
      const compatible = createOpenAICompatible({
        name: spec.providerId,
        baseURL: baseUrl,
        ...(apiKey ? { apiKey } : {}),
      });
      model = compatible(modelName);
      break;
    }
    default:
      throw new LlmConfigurationError(`${providerId}: unsupported adapter ${spec.adapter}`);
  }

  return { spec, model, modelName, apiKey };
}

/**
 * Removes credentials from an error before it reaches the UI or the API.
 *
 * A custom base URL can embed credentials, and some SDKs paste the request URL
 * straight into the message.
 */
function sanitizeError(error: unknown, apiKey?: string): string {
  let message = errorMessage(error);
  message = redactSecrets(message, apiKey);
  message = message.replace(/((?:https?|wss?):\/\/)([^/\s?#@]*:[^/\s?#@]*@)/gi, "$1***@");
  message = message.replace(
    /([?&](?:api[_-]?key|access[_-]?token|token|key|secret|password)=)([^&#\s]+)/gi,
    "$1***",
  );
  return message;
}

/**
 * Cleans raw model text.
 *
 * Unlike the Python version this keeps newlines: stripping them there silently
 * defeated the `paragraph_number` setting by collapsing every script into one
 * paragraph. Downstream subtitle splitting already handles newlines.
 */
function normalizeTextResponse(content: string | undefined | null, providerId: string): string {
  if (content === null || content === undefined) {
    throw new Error(`[${providerId}] returned empty text content`);
  }

  let text = String(content).replace(THINK_BLOCK, "");
  text = text.replace(UNCLOSED_THINK_BLOCK, "").trim();
  if (!text) {
    throw new Error(`[${providerId}] returned empty text content`);
  }
  return text;
}

/** Strips a markdown code fence models add even when asked for raw JSON. */
export function stripCodeFence(text: string): string {
  let value = (text ?? "").trim();
  if (value.startsWith("```")) {
    value = value.replace(/^```[a-zA-Z0-9]*\s*/, "").replace(/\s*```$/, "");
  }
  return value.trim();
}

/** Best-effort JSON recovery for models that wrap output in prose. */
export function extractJson<T>(text: string, opener: "[" | "{"): T | null {
  const closer = opener === "[" ? "]" : "}";
  try {
    return JSON.parse(stripCodeFence(text)) as T;
  } catch {
    const start = text.indexOf(opener);
    const end = text.lastIndexOf(closer);
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

/**
 * Cleans generated script text.
 *
 * Models keep adding emphasis marks, headings and bracketed stage directions
 * despite the prompt; none of that should ever be spoken by the TTS engine.
 */
export function formatScriptResponse(response: string): string {
  let text = response.replace(/\*/g, "").replace(/#/g, "");
  text = text.replace(/\[.*?\]/g, "");
  text = text.replace(/\(.*?\)/g, "");
  // Collapse runs of blank lines left behind by the removals.
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export async function generateScript(options: {
  videoSubject: string;
  language?: string;
  paragraphNumber?: number;
  videoScriptPrompt?: string;
  customSystemPrompt?: string;
}): Promise<string> {
  const paragraphNumber = normalizeScriptParagraphNumber(options.paragraphNumber);
  const videoScriptPrompt = limitScriptText(
    options.videoScriptPrompt,
    MAX_SCRIPT_PROMPT_LENGTH,
    "video_script_prompt",
  );
  const customSystemPrompt = limitScriptText(
    options.customSystemPrompt,
    MAX_SCRIPT_SYSTEM_PROMPT_LENGTH,
    "custom_system_prompt",
  );

  const language = resolveContentLanguage(options.language);
  const prompt = buildScriptPrompt({
    videoSubject: options.videoSubject,
    language,
    paragraphNumber,
    videoScriptPrompt,
    customSystemPrompt,
  });

  logger.info(
    `generating video script: subject=${options.videoSubject}, paragraph_number=${paragraphNumber}, ` +
      `has_custom_prompt=${Boolean(videoScriptPrompt)}, has_custom_system_prompt=${Boolean(customSystemPrompt)}`,
  );

  const { spec, model, apiKey } = await resolveProvider();
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { text } = await generateText({ model, prompt });
      const script = formatScriptResponse(normalizeTextResponse(text, spec.providerId));
      if (script) {
        logger.success(`completed: \n${script}`);
        return script;
      }
      lastError = "model returned an empty response";
    } catch (error) {
      lastError = sanitizeError(error, apiKey);
      logger.error(`failed to generate script: ${lastError}`);
    }

    if (attempt < MAX_RETRIES) {
      logger.warning(`failed to generate video script, trying again... ${attempt}`);
    }
  }

  throw new Error(lastError || "failed to generate video script");
}

// ---------------------------------------------------------------------------
// Search terms
// ---------------------------------------------------------------------------

const termsSchema = z.object({
  search_terms: z.array(z.string()).describe("Stock-video search terms, 1-3 English words each"),
});

export async function generateTerms(options: {
  videoSubject: string;
  videoScript: string;
  amount?: number;
  matchScriptOrder?: boolean;
}): Promise<string[]> {
  const prompt = buildTermsPrompt(options);
  logger.info(
    `subject: ${options.videoSubject}, match_script_order: ${Boolean(options.matchScriptOrder)}`,
  );

  const { spec, model, apiKey } = await resolveProvider();
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Structured output is the reliable path on hosted models.
      const { object } = await generateObject({ model, schema: termsSchema, prompt });
      const terms = object.search_terms.map((term) => String(term).trim()).filter(Boolean);
      if (terms.length > 0) {
        logger.success(`completed: \n${JSON.stringify(terms)}`);
        return terms;
      }
      lastError = "model returned no search terms";
    } catch (structuredError) {
      // Locally served models often lack strict JSON-schema support, so fall
      // back to free text plus tolerant parsing before giving up.
      logger.debug(`structured terms generation failed, falling back to text: ${errorMessage(structuredError)}`);
      try {
        const { text } = await generateText({ model, prompt });
        const cleaned = normalizeTextResponse(text, spec.providerId);
        const parsed = extractJson<unknown>(cleaned, "[");
        if (Array.isArray(parsed)) {
          const terms = parsed.filter((term) => typeof term === "string").map((term) => term.trim()).filter(Boolean);
          if (terms.length > 0) {
            logger.success(`completed: \n${JSON.stringify(terms)}`);
            return terms;
          }
        }
        lastError = "response is not a list of strings";
      } catch (textError) {
        lastError = sanitizeError(textError, apiKey);
      }
      logger.warning(`failed to generate video terms: ${lastError}`);
    }

    if (attempt < MAX_RETRIES) {
      logger.warning(`failed to generate video terms, trying again... ${attempt}`);
    }
  }

  logger.error(`failed to generate video terms: ${lastError}`);
  return [];
}

// ---------------------------------------------------------------------------
// Social metadata
// ---------------------------------------------------------------------------

const socialMetadataSchema = z.object({
  title: z.string(),
  caption: z.string(),
  hashtags: z.array(z.string()),
});

export interface SocialMetadata {
  title: string;
  caption: string;
  hashtags: string[];
}

export async function generateSocialMetadata(options: {
  videoSubject: string;
  videoScript?: string;
  language?: string;
  platform?: string;
}): Promise<SocialMetadata> {
  const platform = resolveSocialPlatform(options.platform ?? DEFAULT_SOCIAL_PLATFORM);
  const spec = SOCIAL_PLATFORMS[platform]!;
  const language = resolveContentLanguage(options.language);
  const prompt = buildSocialMetadataPrompt({ ...options, language, platform });

  try {
    const { model, apiKey } = await resolveProvider();
    try {
      const { object } = await generateObject({ model, schema: socialMetadataSchema, prompt });
      const metadata = finalizeSocialMetadata(object, spec);
      if (metadata) return metadata;
    } catch (structuredError) {
      logger.debug(
        `structured social metadata failed, falling back to text: ${sanitizeError(structuredError, apiKey)}`,
      );
      const { text } = await generateText({ model, prompt });
      const parsed = extractJson<Record<string, unknown>>(text, "{");
      const metadata = parsed ? finalizeSocialMetadata(parsed, spec) : null;
      if (metadata) return metadata;
    }
  } catch (error) {
    logger.warning(`failed to generate social metadata: ${sanitizeError(error)}`);
  }

  // Publishing must not be blocked by a copywriting failure.
  return fallbackSocialMetadata(options.videoSubject, options.videoScript ?? "", platform);
}

function finalizeSocialMetadata(
  data: Record<string, unknown>,
  spec: { titleMax: number; captionMax: number; hashtagCount: number },
): SocialMetadata | null {
  const title = clampText(data.title, spec.titleMax);
  const caption = clampText(data.caption, spec.captionMax);
  const hashtags = normalizeHashtags(data.hashtags, spec.hashtagCount);

  if (!title && !caption) return null;
  return { title, caption, hashtags };
}

// ---------------------------------------------------------------------------
// Book segment boundaries
// ---------------------------------------------------------------------------

const segmentBoundariesSchema = z.object({
  skip_block_ids: z.array(z.string()).optional(),
  sections: z.array(
    z.object({
      start_block_id: z.string(),
      title: z.string(),
    }),
  ),
});

export interface ProposedSection {
  startBlockId: string;
  title: string;
}

export interface ProposedBoundaries {
  sections: ProposedSection[];
  skipBlockIds: string[];
}

function collectSkipBlockIds(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const values = record.skip_block_ids ?? record.skipBlockIds;
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of values) {
    const id = String(value ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function finalizeProposedSections(raw: unknown): ProposedSection[] {
  const sections = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { sections?: unknown }).sections)
      ? (raw as { sections: unknown[] }).sections
      : [];

  const result: ProposedSection[] = [];
  const seen = new Set<string>();
  for (const entry of sections) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const startBlockId = String(record.start_block_id ?? record.startBlockId ?? "").trim();
    const title = clampText(record.title, MAX_SEGMENT_TITLE_LENGTH);
    if (!startBlockId || seen.has(startBlockId)) continue;
    seen.add(startBlockId);
    result.push({ startBlockId, title });
  }
  return result;
}

function finalizeProposedBoundaries(raw: unknown): ProposedBoundaries {
  return {
    sections: finalizeProposedSections(raw),
    skipBlockIds: collectSkipBlockIds(raw),
  };
}

/**
 * Asks the configured model to mark chapter/section starts from a compact outline.
 *
 * Local models often lack structured-output support, so this follows the same
 * generateObject-then-text fallback as search terms. An empty result is a
 * soft failure: the caller falls back to heuristic section detection.
 */
export async function generateSegmentBoundaries(options: {
  bookTitle: string;
  author: string;
  language?: string;
  targetSeconds: number;
  maxSeconds: number;
  totalSeconds: number;
  units: SegmentOutlineLine[];
  chunkIndex?: number;
  chunkCount?: number;
}): Promise<ProposedBoundaries> {
  if (options.units.length === 0) return { sections: [], skipBlockIds: [] };

  const language = resolveContentLanguage(options.language);
  const prompt = buildSegmentBoundariesPrompt({ ...options, language });
  logger.info(
    `detecting book sections: title=${options.bookTitle}, units=${options.units.length}` +
      (options.chunkCount && options.chunkCount > 1
        ? `, chunk=${options.chunkIndex}/${options.chunkCount}`
        : ""),
  );

  const { spec, model, apiKey } = await resolveProvider();
  let lastError = "";
  const attempts = 3;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { object } = await generateObject({ model, schema: segmentBoundariesSchema, prompt });
      const proposed = finalizeProposedBoundaries(object);
      if (proposed.sections.length > 0 || proposed.skipBlockIds.length > 0) {
        logger.success(
          `completed: ${proposed.sections.length} proposed sections, ${proposed.skipBlockIds.length} skipped ids`,
        );
        return proposed;
      }
      lastError = "model returned no sections";
    } catch (structuredError) {
      logger.debug(
        `structured section detection failed, falling back to text: ${errorMessage(structuredError)}`,
      );
      try {
        const { text } = await generateText({ model, prompt });
        const cleaned = normalizeTextResponse(text, spec.providerId);
        const parsed = extractJson<unknown>(cleaned, "{");
        const proposed = finalizeProposedBoundaries(parsed);
        if (proposed.sections.length > 0 || proposed.skipBlockIds.length > 0) {
          logger.success(
            `completed: ${proposed.sections.length} proposed sections, ${proposed.skipBlockIds.length} skipped ids`,
          );
          return proposed;
        }
        lastError = "response is not a list of sections";
      } catch (textError) {
        lastError = sanitizeError(textError, apiKey);
      }
      logger.warning(`failed to detect book sections: ${lastError}`);
    }

    if (attempt < attempts) {
      logger.warning(`failed to detect book sections, trying again... ${attempt}`);
    }
  }

  logger.error(`failed to detect book sections: ${lastError}`);
  return { sections: [], skipBlockIds: [] };
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

export interface ConnectionTestResult {
  success: boolean;
  message: string;
  elapsedSeconds: number;
  provider: string;
  model: string;
}

/**
 * Minimal round-trip against the current configuration.
 *
 * Exercises the key, base URL and model name without sending the user's subject
 * or script anywhere, and without entering the script retry loop.
 */
export async function testConnection(): Promise<ConnectionTestResult> {
  const startedAt = performance.now();
  let providerId = "";
  let modelName = "";

  try {
    const { spec, model, modelName: resolvedModel, apiKey } = await resolveProvider();
    providerId = spec.providerId;
    modelName = resolvedModel;

    try {
      const { text } = await generateText({ model, prompt: "Reply with exactly: OK" });
      const reply = normalizeTextResponse(text, spec.providerId);
      return {
        success: true,
        message: reply.slice(0, 200),
        elapsedSeconds: (performance.now() - startedAt) / 1000,
        provider: providerId,
        model: modelName,
      };
    } catch (error) {
      return {
        success: false,
        message: sanitizeError(error, apiKey),
        elapsedSeconds: (performance.now() - startedAt) / 1000,
        provider: providerId,
        model: modelName,
      };
    }
  } catch (error) {
    return {
      success: false,
      message: sanitizeError(error),
      elapsedSeconds: (performance.now() - startedAt) / 1000,
      provider: providerId,
      model: modelName,
    };
  }
}
