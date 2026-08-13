/**
 * Loads the repository-root `.env` into `process.env`.
 *
 * Bun only auto-loads a `.env` sitting in the process working directory, and
 * every script starts the server from `server/` (`bun run --cwd server`), so
 * the root `.env` the README documents was silently ignored. Reading it from
 * the project root instead makes one file serve `bun run dev`, `bun run start`
 * and `bun run cli` alike.
 *
 * Importing this module performs the load, because the values have to be in
 * place before the modules that read `process.env` at module scope are
 * evaluated — the Mongo connection string, the log threshold and the listen
 * address are all read that way. For the same reason this file must stay
 * dependency-free: anything it imports would be evaluated first.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Mirrors `utils/paths.ts`, which cannot be imported here (it pulls in the logger). */
function projectRoot(): string {
  if (process.env.APP_ROOT) return resolve(process.env.APP_ROOT);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

const QUOTED_VALUE = /^(['"`])([\s\S]*)\1$/;
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parses `.env` text into a key/value map.
 *
 * Deliberately small: `KEY=value` one per line, `#` comments, optional
 * `export ` prefix, and optional surrounding quotes. Escapes are expanded only
 * inside double quotes, matching the shell and every dotenv implementation, so
 * a Windows path in an unquoted value keeps its backslashes.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator === -1) continue;

    const key = line.slice(0, separator).replace(/^export\s+/, "").trim();
    if (!VALID_KEY.test(key)) continue;

    let value = line.slice(separator + 1).trim();
    const quoted = QUOTED_VALUE.exec(value);
    if (quoted) {
      value = quoted[2]!;
      if (quoted[1] === '"') {
        value = value.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
      }
    } else {
      // An unquoted value ends at the first inline comment.
      value = value.replace(/\s+#.*$/, "").trim();
    }

    values[key] = value;
  }

  return values;
}

/**
 * Applies the file's values to `process.env`, returning the names it set.
 *
 * A variable already present in the real environment always wins: Docker
 * Compose, systemd and CI set values there, and the file is only meant to be
 * the local-development default. A missing file is the normal case for a
 * container deployment, so it is not an error.
 */
export function loadDotEnv(path: string = join(projectRoot(), ".env")): string[] {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const applied: string[] = [];
  for (const [key, value] of Object.entries(parseDotEnv(content))) {
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    applied.push(key);
  }
  return applied;
}

loadDotEnv();
