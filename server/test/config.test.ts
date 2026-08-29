/**
 * `.env` parsing and the environment -> settings overlay.
 *
 * These are the two halves of "credentials come from .env": reading the file
 * into `process.env`, and letting those values win over the stored document
 * without ever being written back to it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadDotEnv, parseDotEnv } from "../src/config/dotenv.ts";
import { applyEnvOverrides, envManagedSettingPaths } from "../src/config/settings.ts";
import { defaultSettings } from "../src/config/schema.ts";

/**
 * Env vars touched by a test, restored afterwards so cases stay independent.
 *
 * This must list every variable `ENV_BINDINGS` reads, not merely the ones a
 * case sets: `envManagedSettingPaths()` reports whatever the environment
 * supplies, so a variable exported in a developer's own shell and missing from
 * here fails the two cases below for nobody else.
 */
const MANAGED_VARS = [
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "GEMMA_API_KEY",
  "PEXELS_API_KEYS",
  "PEXELS_API_KEY",
  "PIXABAY_API_KEYS",
  "PIXABAY_API_KEY",
  "COVERR_API_KEYS",
  "COVERR_API_KEY",
  "TWELVELABS_API_KEYS",
  "TWELVELABS_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "QDRANT_URL",
  "QDRANT_API_KEY",
  "ENDPOINT",
];

function clearManagedVars(): void {
  for (const name of MANAGED_VARS) delete process.env[name];
}

// Cleared before as well as after: a developer with one of these exported in
// their own shell would otherwise see failures nobody else can reproduce.
beforeEach(clearManagedVars);
afterEach(clearManagedVars);

function writeEnvFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "vidgen-env-")), ".env");
  writeFileSync(path, content, "utf8");
  return path;
}

// ---------------------------------------------------------------------------

describe("parseDotEnv", () => {
  test("reads plain assignments and skips comments and blanks", () => {
    const parsed = parseDotEnv("# a comment\n\nOPENAI_API_KEY=sk-plain\n  GEMINI_API_KEY = g-key \n");
    expect(parsed).toEqual({ OPENAI_API_KEY: "sk-plain", GEMINI_API_KEY: "g-key" });
  });

  test("strips quotes and an optional export prefix", () => {
    const parsed = parseDotEnv(`export OPENAI_API_KEY="sk-quoted"\nPEXELS_API_KEYS='one, two'\n`);
    expect(parsed.OPENAI_API_KEY).toBe("sk-quoted");
    expect(parsed.PEXELS_API_KEYS).toBe("one, two");
  });

  test("drops a trailing comment only on unquoted values", () => {
    const parsed = parseDotEnv('A=value # trailing\nB="value # kept"\n');
    expect(parsed.A).toBe("value");
    expect(parsed.B).toBe("value # kept");
  });

  test("keeps '=' and '#' inside the value", () => {
    const parsed = parseDotEnv("MONGODB_URI=mongodb://user:pa#ss@host/db?a=b\n");
    expect(parsed.MONGODB_URI).toBe("mongodb://user:pa#ss@host/db?a=b");
  });

  test("ignores malformed keys and lines without a separator", () => {
    expect(parseDotEnv("not-an-assignment\n1BAD=x\nGOOD_KEY=y\n")).toEqual({ GOOD_KEY: "y" });
  });

  test("expands escapes only inside double quotes", () => {
    const parsed = parseDotEnv('A="one\\ntwo"\nB=\'one\\ntwo\'\n');
    expect(parsed.A).toBe("one\ntwo");
    expect(parsed.B).toBe("one\\ntwo");
  });
});

describe("loadDotEnv", () => {
  test("fills process.env from the file", () => {
    const applied = loadDotEnv(writeEnvFile("OPENAI_API_KEY=sk-from-file\n"));
    expect(applied).toContain("OPENAI_API_KEY");
    expect(process.env.OPENAI_API_KEY).toBe("sk-from-file");
  });

  test("never overwrites a real environment variable", () => {
    process.env.OPENAI_API_KEY = "sk-from-shell";
    const applied = loadDotEnv(writeEnvFile("OPENAI_API_KEY=sk-from-file\n"));
    expect(applied).not.toContain("OPENAI_API_KEY");
    expect(process.env.OPENAI_API_KEY).toBe("sk-from-shell");
  });

  test("treats a missing file as no configuration", () => {
    expect(loadDotEnv(join(tmpdir(), "vidgen-absent-.env"))).toEqual([]);
  });
});

describe("applyEnvOverrides", () => {
  test("supplies LLM keys from the environment", () => {
    process.env.GEMINI_API_KEY = "g-key";
    process.env.OPENAI_API_KEY = "sk-key";

    const effective = applyEnvOverrides(defaultSettings());
    expect(effective.app.gemini_api_key).toBe("g-key");
    expect(effective.app.openai_api_key).toBe("sk-key");
  });

  test("splits material keys into a rotation list", () => {
    process.env.PEXELS_API_KEYS = " one , two ,, three ";

    expect(applyEnvOverrides(defaultSettings()).app.pexels_api_keys).toEqual(["one", "two", "three"]);
  });

  test("accepts the singular material variable", () => {
    process.env.PEXELS_API_KEY = "only-one";

    expect(applyEnvOverrides(defaultSettings()).app.pexels_api_keys).toEqual(["only-one"]);
  });

  test("prefers the plural variable when both are set", () => {
    process.env.PEXELS_API_KEYS = "plural";
    process.env.PEXELS_API_KEY = "singular";

    expect(applyEnvOverrides(defaultSettings()).app.pexels_api_keys).toEqual(["plural"]);
  });

  test("wins over the stored value", () => {
    const stored = defaultSettings();
    stored.app.openai_api_key = "sk-stored";
    process.env.OPENAI_API_KEY = "sk-env";

    expect(applyEnvOverrides(stored).app.openai_api_key).toBe("sk-env");
  });

  test("an empty variable falls back to the stored value", () => {
    const stored = defaultSettings();
    stored.app.openai_api_key = "sk-stored";
    stored.app.pexels_api_keys = ["stored-key"];
    process.env.OPENAI_API_KEY = "   ";
    process.env.PEXELS_API_KEYS = " , ";

    const effective = applyEnvOverrides(stored);
    expect(effective.app.openai_api_key).toBe("sk-stored");
    expect(effective.app.pexels_api_keys).toEqual(["stored-key"]);
  });

  test("leaves the stored object untouched", () => {
    const stored = defaultSettings();
    process.env.OPENAI_API_KEY = "sk-env";

    applyEnvOverrides(stored);
    // This is what keeps updateSettings from persisting an environment secret.
    expect(stored.app.openai_api_key).toBe("");
  });

  // The bindings below are the first that write outside the `app` section. The
  // overlay indexes `effective[binding.section]`, so nothing special is needed
  // to support them — these cases exist to keep it that way.
  test("overrides a field outside the app section", () => {
    process.env.QDRANT_URL = "http://qdrant:6333";
    process.env.QDRANT_API_KEY = "q-key";

    const effective = applyEnvOverrides(defaultSettings());
    expect(effective.qdrant.url).toBe("http://qdrant:6333");
    expect(effective.qdrant.api_key).toBe("q-key");
  });

  test("the stored default stands when the section's variables are unset", () => {
    // The host process and the CLI reach Qdrant on the published loopback port
    // from this default; only the container is handed a URL.
    expect(applyEnvOverrides(defaultSettings()).qdrant.url).toBe("http://127.0.0.1:6333");
    expect(applyEnvOverrides(defaultSettings()).qdrant.api_key).toBe("");
  });

  test("a non-app override wins over the stored value and leaves it untouched", () => {
    const stored = defaultSettings();
    stored.qdrant.url = "http://stored:6333";
    process.env.QDRANT_URL = "http://env:6333";

    expect(applyEnvOverrides(stored).qdrant.url).toBe("http://env:6333");
    expect(stored.qdrant.url).toBe("http://stored:6333");
  });

  test("an empty non-app variable falls back to the stored value", () => {
    const stored = defaultSettings();
    stored.qdrant.url = "http://stored:6333";
    process.env.QDRANT_URL = "   ";

    expect(applyEnvOverrides(stored).qdrant.url).toBe("http://stored:6333");
  });

  test("overriding one section does not disturb another", () => {
    process.env.QDRANT_URL = "http://qdrant:6333";
    process.env.OPENAI_API_KEY = "sk-env";

    const effective = applyEnvOverrides(defaultSettings());
    expect(effective.qdrant.url).toBe("http://qdrant:6333");
    expect(effective.app.openai_api_key).toBe("sk-env");
    // `footage_index` has no bindings at all; it must survive the overlay whole.
    expect(effective.footage_index).toEqual(defaultSettings().footage_index);
  });
});

describe("envManagedSettingPaths", () => {
  test("is empty when nothing is set", () => {
    expect(envManagedSettingPaths()).toEqual([]);
  });

  test("reports only the fields the environment supplies", () => {
    process.env.OPENAI_API_KEY = "sk-env";
    process.env.PEXELS_API_KEY = "px-env";

    expect(envManagedSettingPaths().sort()).toEqual(["app.openai_api_key", "app.pexels_api_keys"]);
  });

  test("qualifies a non-app path with its own section", () => {
    process.env.QDRANT_URL = "http://qdrant:6333";
    process.env.QDRANT_API_KEY = "q-key";

    // The settings UI shows these read-only, so the section has to be right or
    // the wrong field is locked.
    expect(envManagedSettingPaths().sort()).toEqual(["qdrant.api_key", "qdrant.url"]);
  });

  test("reports across sections at once", () => {
    process.env.OPENAI_API_KEY = "sk-env";
    process.env.QDRANT_URL = "http://qdrant:6333";

    expect(envManagedSettingPaths().sort()).toEqual(["app.openai_api_key", "qdrant.url"]);
  });
});
