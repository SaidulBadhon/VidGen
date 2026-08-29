/**
 * Mongo-backed application settings, replacing config.toml.
 *
 * Settings are loaded once at startup and cached in memory so every service can
 * read them synchronously — the Python code read a module-level dict the same
 * way. Writes go through `updateSettings`, which validates, persists, and
 * refreshes the cache in one step.
 */

import { settingsCollection } from "../db/client.ts";
import { logger } from "../utils/logger.ts";
import {
  DEFAULT_VOICE_NAME,
  SECRET_FIELDS,
  defaultSettings,
  settingsSchema,
  type Settings,
  type SettingsSection,
} from "./schema.ts";

const SETTINGS_ID = "settings" as const;

/** Exactly what is in Mongo. Writes merge over this, never over `cache`. */
let stored: Settings = defaultSettings();
/** `stored` with the environment applied. This is what every service reads. */
let cache: Settings = defaultSettings();
let loaded = false;

interface EnvBinding {
  readonly section: SettingsSection;
  readonly key: string;
  /** First non-empty variable wins; the plural form is the documented name. */
  readonly envVars: readonly string[];
  /** Comma-separated in the environment, a key-rotation list in settings. */
  readonly list?: boolean;
}

/**
 * Settings the environment can supply, and which then win over the document.
 *
 * Provider credentials belong in `.env` for anything scripted or containerised:
 * the deployment already has a secrets mechanism there, whereas a key that
 * lives only in Mongo has to be re-entered through the UI on every fresh
 * volume. The settings UI shows these fields read-only so the two sources can
 * never disagree without the user seeing why.
 */
const ENV_BINDINGS: readonly EnvBinding[] = [
  { section: "app", key: "endpoint", envVars: ["ENDPOINT"] },

  // LLM providers.
  { section: "app", key: "gemini_api_key", envVars: ["GEMINI_API_KEY"] },
  { section: "app", key: "openai_api_key", envVars: ["OPENAI_API_KEY"] },
  { section: "app", key: "gemma_api_key", envVars: ["GEMMA_API_KEY"] },

  // Video material providers.
  { section: "app", key: "pexels_api_keys", envVars: ["PEXELS_API_KEYS", "PEXELS_API_KEY"], list: true },
  { section: "app", key: "pixabay_api_keys", envVars: ["PIXABAY_API_KEYS", "PIXABAY_API_KEY"], list: true },
  { section: "app", key: "coverr_api_keys", envVars: ["COVERR_API_KEYS", "COVERR_API_KEY"], list: true },
  {
    section: "app",
    key: "twelvelabs_api_keys",
    envVars: ["TWELVELABS_API_KEYS", "TWELVELABS_API_KEY"],
    list: true,
  },

  { section: "app", key: "google_client_id", envVars: ["GOOGLE_CLIENT_ID"] },
  { section: "app", key: "google_client_secret", envVars: ["GOOGLE_CLIENT_SECRET"] },

  // Semantic footage library. The URL is bound as well as the key because it is
  // deployment topology rather than a preference: the compose file hands the
  // container `http://qdrant:6333`, while a host-run server and CLI reach the
  // same service on the published loopback port from the stored default.
  { section: "qdrant", key: "url", envVars: ["QDRANT_URL"] },
  { section: "qdrant", key: "api_key", envVars: ["QDRANT_API_KEY"] },
];

/** The bound value from the environment, or undefined when nothing is set. */
function envValue(binding: EnvBinding): string | string[] | undefined {
  for (const name of binding.envVars) {
    const raw = process.env[name]?.trim();
    // An empty variable means "not set", so a blank line in .env cannot wipe a
    // key that was configured through the UI.
    if (!raw) continue;
    if (!binding.list) return raw;

    const keys = raw.split(",").map((key) => key.trim()).filter(Boolean);
    if (keys.length > 0) return keys;
  }
  return undefined;
}

/**
 * Overlays the environment onto a stored settings object.
 *
 * Returns a copy: the caller keeps the pristine document, which is what makes
 * a later `updateSettings` incapable of persisting an environment secret.
 */
export function applyEnvOverrides(settings: Settings): Settings {
  const effective = structuredClone(settings) as Settings;

  for (const binding of ENV_BINDINGS) {
    const value = envValue(binding);
    if (value === undefined) continue;
    (effective[binding.section] as Record<string, unknown>)[binding.key] = value;
  }

  return effective;
}

/** Dotted paths currently supplied by the environment, for the settings UI. */
export function envManagedSettingPaths(): string[] {
  return ENV_BINDINGS.filter((binding) => envValue(binding) !== undefined).map(
    (binding) => `${binding.section}.${binding.key}`,
  );
}

/**
 * Loads settings from Mongo, seeding the document on first run.
 * Must be awaited during startup before any service reads settings.
 */
export async function initSettings(): Promise<Settings> {
  const collection = settingsCollection();
  const existing = await collection.findOne({ _id: SETTINGS_ID });

  if (!existing) {
    stored = defaultSettings();
    await collection.insertOne({ _id: SETTINGS_ID, data: stored, updated_at: new Date() });
    logger.info("seeded default settings document");
  } else {
    // Parsing through the schema fills in any field added since the document
    // was written, so an upgrade never needs a migration step.
    const parsed = settingsSchema.safeParse(existing.data ?? {});
    if (!parsed.success) {
      logger.warning(
        `stored settings failed validation, falling back to defaults for the invalid fields: ${parsed.error.message}`,
      );
      stored = mergeSettings(defaultSettings(), (existing.data ?? {}) as PartialSettings);
    } else {
      stored = parsed.data;
    }
  }

  const logLevel = process.env.LOG_LEVEL?.trim();
  if (logLevel) logger.debug(`log level from environment: ${logLevel}`);

  const fromEnv = envManagedSettingPaths();
  if (fromEnv.length > 0) {
    logger.info(`settings supplied by the environment: ${fromEnv.join(", ")}`);
  }

  cache = applyEnvOverrides(stored);
  loaded = true;
  return cache;
}

/** Cached settings. Throws if startup has not loaded them yet. */
export function getSettings(): Settings {
  if (!loaded) {
    throw new Error("settings have not been loaded; call initSettings() during startup");
  }
  return cache;
}

/** Convenience accessor for the largest section. */
export function appConfig() {
  return getSettings().app;
}

/**
 * App-wide language stored in Mongo (`ui.language`).
 *
 * Empty means the operator has not chosen one yet; callers that can auto-detect
 * should keep doing so, and callers that need a language should fall back.
 */
export function preferredLanguage(): string {
  if (!loaded) return "";
  return (getSettings().ui.language ?? "").trim();
}

/**
 * Per-request language wins when set and not `"auto"`; otherwise the stored
 * preference. Empty still means auto-detect for callers that support it.
 */
export function resolveContentLanguage(explicit?: string | null): string {
  const requested = (explicit ?? "").trim();
  if (requested && requested.toLowerCase() !== "auto") return requested;
  return preferredLanguage();
}

/**
 * App-wide narration voice stored in Mongo (`ui.voice_name`).
 *
 * Empty means the operator has not chosen one yet; generation falls back to
 * the bundled default so a first-boot video still has a voice.
 */
export function preferredVoiceName(): string {
  if (!loaded) return DEFAULT_VOICE_NAME;
  return (getSettings().ui.voice_name ?? "").trim() || DEFAULT_VOICE_NAME;
}

/**
 * Per-request voice wins when set (including the explicit "no-voice" sentinel);
 * otherwise the stored preference, then the bundled default.
 */
export function resolveVoiceName(explicit?: string | null): string {
  const requested = (explicit ?? "").trim();
  if (requested) return requested;
  return preferredVoiceName();
}

export type PartialSettings = {
  [S in SettingsSection]?: Partial<Settings[S]>;
};

/** Section-wise shallow merge; each section is a flat key/value map. */
function mergeSettings(base: Settings, patch: PartialSettings): Settings {
  // Indexed writes across a union of section types defeat narrowing, so the
  // merge is done through a permissive record and validated by zod afterwards.
  const merged: Record<string, unknown> = { ...base };
  for (const section of Object.keys(patch) as SettingsSection[]) {
    const sectionPatch = patch[section];
    if (!sectionPatch) continue;
    merged[section] = { ...base[section], ...sectionPatch };
  }
  return merged as Settings;
}

/**
 * Validates and persists a partial settings update.
 *
 * A section is merged over the current values rather than replaced, so the UI
 * can save one panel without resending everything it did not display.
 */
export async function updateSettings(patch: PartialSettings): Promise<Settings> {
  if (!loaded) {
    throw new Error("settings have not been loaded; call initSettings() during startup");
  }

  // Merged over the stored document rather than the effective one, so a value
  // that only ever came from the environment is not copied into Mongo — where
  // it would outlive the variable and shadow a later change to it.
  const parsed = settingsSchema.parse(mergeSettings(stored, patch));

  await settingsCollection().updateOne(
    { _id: SETTINGS_ID },
    { $set: { data: parsed, updated_at: new Date() } },
    { upsert: true },
  );

  stored = parsed;
  cache = applyEnvOverrides(stored);
  logger.info(`settings updated: ${Object.keys(patch).join(", ")}`);
  return cache;
}

/** Sets one key without a read-modify-write round trip from the caller. */
export async function setSetting<S extends SettingsSection, K extends keyof Settings[S]>(
  section: S,
  key: K,
  value: Settings[S][K],
): Promise<Settings> {
  return updateSettings({ [section]: { [key]: value } } as PartialSettings);
}

const SECRET_PLACEHOLDER = "__stored__";

/**
 * Settings safe to send to the browser.
 *
 * Secrets become a placeholder rather than being dropped, so the UI can show
 * "a key is configured" without ever holding the value.
 */
export function redactSettings(settings: Settings = getSettings()): Settings {
  const copy = structuredClone(settings) as Settings;
  for (const [section, key] of SECRET_FIELDS) {
    const container = copy[section] as Record<string, unknown>;
    const value = container[key];
    if (Array.isArray(value)) {
      container[key] = value.map(() => SECRET_PLACEHOLDER);
    } else if (typeof value === "string" && value) {
      container[key] = SECRET_PLACEHOLDER;
    }
  }
  return copy;
}

/**
 * Drops placeholder secrets from an incoming patch.
 *
 * Without this, saving a panel the user never edited would overwrite real keys
 * with the mask the UI displayed.
 */
export function stripPlaceholderSecrets(patch: PartialSettings): PartialSettings {
  const cleaned: PartialSettings = structuredClone(patch);
  for (const [section, key] of SECRET_FIELDS) {
    const sectionPatch = cleaned[section] as Record<string, unknown> | undefined;
    if (!sectionPatch || !(key in sectionPatch)) continue;

    const value = sectionPatch[key];
    if (value === SECRET_PLACEHOLDER) {
      delete sectionPatch[key];
    } else if (Array.isArray(value) && value.every((entry) => entry === SECRET_PLACEHOLDER)) {
      delete sectionPatch[key];
    }
  }
  return cleaned;
}

/**
 * Test seam: installs a settings object without touching Mongo.
 *
 * The environment is deliberately not overlaid — a test asserting on a key
 * would otherwise depend on whatever the developer has exported in their shell.
 */
export function __setSettingsForTest(settings: Settings): void {
  stored = settings;
  cache = settings;
  loaded = true;
}

export { SECRET_PLACEHOLDER };
