/**
 * LLM provider registry.
 *
 * Keeps the "what a provider is" metadata in one place — dropdown order,
 * defaults, which fields the UI must collect — while `services/llm.ts` owns
 * "how to call it" via the Vercel AI SDK.
 *
 * The Python version carried 16 providers; this rewrite intentionally ships
 * Gemini, OpenAI and Gemma (served by Ollama). Adding another OpenAI-compatible
 * provider is one entry here plus its keys in the settings schema.
 */

export type LlmAdapter = "google" | "openai" | "openai-compatible";

export interface LlmProviderSpec {
  readonly providerId: string;
  readonly defaultLabel: string;
  readonly adapter: LlmAdapter;
  readonly apiKeyUrl: string;
  readonly defaultModel: string;
  readonly defaultBaseUrl: string;
  readonly requiresApiKey: boolean;
  readonly requiresModelName: boolean;
  readonly requiresBaseUrl: boolean;
  readonly showApiKey: boolean;
  readonly showBaseUrl: boolean;
  /** Historical defaults that should silently migrate to `defaultModel`. */
  readonly deprecatedModels: readonly string[];
  readonly deprecatedBaseUrls: readonly string[];
}

export const DEFAULT_LLM_PROVIDER_ID = "gemini";

/** Tuple order is the order the UI shows. */
export const LLM_PROVIDER_REGISTRY: readonly LlmProviderSpec[] = [
  {
    providerId: "gemini",
    defaultLabel: "Google Gemini",
    adapter: "google",
    apiKeyUrl: "https://aistudio.google.com/app/apikey",
    defaultModel: "gemini-3.1-pro-preview",
    defaultBaseUrl: "",
    requiresApiKey: true,
    requiresModelName: true,
    requiresBaseUrl: false,
    showApiKey: true,
    showBaseUrl: false,
    deprecatedModels: ["gemini-pro", "gemini-1.0-pro"],
    deprecatedBaseUrls: [],
  },
  {
    providerId: "openai",
    defaultLabel: "OpenAI / ChatGPT",
    adapter: "openai",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-5.5",
    defaultBaseUrl: "https://api.openai.com/v1",
    requiresApiKey: true,
    requiresModelName: true,
    requiresBaseUrl: true,
    showApiKey: true,
    showBaseUrl: true,
    deprecatedModels: [],
    deprecatedBaseUrls: [],
  },
  {
    providerId: "gemma",
    defaultLabel: "Gemma (Ollama)",
    adapter: "openai-compatible",
    apiKeyUrl: "https://ollama.com/library/gemma3",
    defaultModel: "gemma3",
    // Left empty so the environment-aware default in config/runtime.ts applies:
    // localhost on a host, host.docker.internal or the gateway in a container.
    defaultBaseUrl: "",
    requiresApiKey: false,
    requiresModelName: true,
    requiresBaseUrl: false,
    showApiKey: false,
    showBaseUrl: true,
    deprecatedModels: [],
    deprecatedBaseUrls: [],
  },
] as const;

export const LLM_PROVIDER_IDS = LLM_PROVIDER_REGISTRY.map((p) => p.providerId);

export function getLlmProvider(providerId: string | undefined): LlmProviderSpec | undefined {
  const normalized = String(providerId ?? "").toLowerCase();
  return LLM_PROVIDER_REGISTRY.find((provider) => provider.providerId === normalized);
}

/** Settings key for one of a provider's fields, e.g. `gemini_api_key`. */
export function providerConfigKey(spec: LlmProviderSpec, suffix: string): string {
  return `${spec.providerId}_${suffix}`;
}

/** Resolves an empty or retired model name to the provider's current default. */
export function resolveModelName(spec: LlmProviderSpec, configuredModel: string | undefined): string {
  const modelName = (configuredModel ?? "").trim();
  if (!modelName || spec.deprecatedModels.includes(modelName)) {
    return spec.defaultModel;
  }
  return modelName;
}

/** Resolves an empty or retired base URL to the provider's current default. */
export function resolveBaseUrl(spec: LlmProviderSpec, configuredBaseUrl: string | undefined): string {
  const baseUrl = (configuredBaseUrl ?? "").trim();
  const deprecated = new Set(spec.deprecatedBaseUrls.map((url) => url.replace(/\/+$/, "")));
  if (!baseUrl || deprecated.has(baseUrl.replace(/\/+$/, ""))) {
    return spec.defaultBaseUrl;
  }
  return baseUrl;
}
