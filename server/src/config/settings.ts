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
  SECRET_FIELDS,
  defaultSettings,
  settingsSchema,
  type Settings,
  type SettingsSection,
} from "./schema.ts";

const SETTINGS_ID = "settings" as const;

let cache: Settings = defaultSettings();
let loaded = false;

/** Env vars that win over the stored document, for container deployments. */
function applyEnvOverrides(settings: Settings): Settings {
  const endpoint = process.env.ENDPOINT?.trim();
  if (endpoint) settings.app.endpoint = endpoint;

  const logLevel = process.env.LOG_LEVEL?.trim();
  if (logLevel) {
    // Kept only so the value shows up in the settings UI as read-only context.
    logger.debug(`log level from environment: ${logLevel}`);
  }
  return settings;
}

/**
 * Loads settings from Mongo, seeding the document on first run.
 * Must be awaited during startup before any service reads settings.
 */
export async function initSettings(): Promise<Settings> {
  const collection = settingsCollection();
  const existing = await collection.findOne({ _id: SETTINGS_ID });

  if (!existing) {
    const seeded = defaultSettings();
    await collection.insertOne({ _id: SETTINGS_ID, data: seeded, updated_at: new Date() });
    logger.info("seeded default settings document");
    cache = applyEnvOverrides(seeded);
    loaded = true;
    return cache;
  }

  // Parsing through the schema fills in any field added since the document was
  // written, so an upgrade never needs a migration step.
  const parsed = settingsSchema.safeParse(existing.data ?? {});
  if (!parsed.success) {
    logger.warning(
      `stored settings failed validation, falling back to defaults for the invalid fields: ${parsed.error.message}`,
    );
    cache = applyEnvOverrides(mergeSettings(defaultSettings(), (existing.data ?? {}) as PartialSettings));
  } else {
    cache = applyEnvOverrides(parsed.data);
  }

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
  const candidate = mergeSettings(getSettings(), patch);
  const parsed = settingsSchema.parse(candidate);

  await settingsCollection().updateOne(
    { _id: SETTINGS_ID },
    { $set: { data: parsed, updated_at: new Date() } },
    { upsert: true },
  );

  cache = applyEnvOverrides(parsed);
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

/** Test seam: installs a settings object without touching Mongo. */
export function __setSettingsForTest(settings: Settings): void {
  cache = settings;
  loaded = true;
}

export { SECRET_PLACEHOLDER };
