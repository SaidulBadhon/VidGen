/** Small shared helpers. Ported from python-version/app/utils/utils.py. */

import { extname } from "node:path";

export function getUuid(removeHyphen = false): string {
  const id = crypto.randomUUID();
  return removeHyphen ? id.replace(/-/g, "") : id;
}

export function md5(text: string): string {
  return new Bun.CryptoHasher("md5").update(text, "utf8").digest("hex");
}

export function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text, "utf8").digest("hex");
}

/** Lowercase extension without the leading dot, e.g. `"MP4"` -> `"mp4"`. */
export function parseExtension(filename: string): string {
  return extname(filename).toLowerCase().replace(/^\./, "");
}

const CLIP_SPEED_MIN = 0.5;
const CLIP_SPEED_MAX = 2.0;

/**
 * Clamps clip playback speed into the range the UI offers.
 *
 * NaN slips past ordinary comparisons and would propagate into every duration
 * calculation; infinities, zero and negatives are not playable speeds either.
 * All of them fall back to the default so API and internal callers can never
 * build an invalid timeline.
 */
export function normalizeClipSpeed(value: unknown, defaultValue = 1.0): number {
  const speed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(speed) || speed <= 0) return defaultValue;
  return Math.min(Math.max(speed, CLIP_SPEED_MIN), CLIP_SPEED_MAX);
}

/** Standard API envelope. `data`/`message` are omitted when empty, as before. */
export function getResponse<T>(status: number, data?: T, message?: string) {
  const body: { status: number; data?: T; message?: string } = { status };
  if (data !== undefined && data !== null && data !== "") body.data = data;
  if (message) body.message = message;
  return body;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pretty JSON for logs, with binary blobs elided. */
export function toJson(obj: unknown): string {
  try {
    return JSON.stringify(
      obj,
      (_key, value) => {
        if (value instanceof Uint8Array || value instanceof ArrayBuffer) return "*** binary data ***";
        if (typeof value === "bigint") return value.toString();
        return value;
      },
      2,
    );
  } catch {
    return String(obj);
  }
}

/**
 * Rotates through a list of API keys.
 *
 * Providers hand out per-key rate limits, so spreading calls across the
 * configured keys is what makes multi-key configuration useful.
 */
const keyCounters = new Map<string, number>();

export function rotateApiKey(configKey: string, keys: string | string[] | undefined): string {
  if (!keys || (Array.isArray(keys) && keys.length === 0)) {
    throw new Error(`${configKey} is not set. Configure it in Settings before generating.`);
  }
  if (typeof keys === "string") return keys;
  if (keys.length === 1) return keys[0]!;

  const next = (keyCounters.get(configKey) ?? 0) + 1;
  keyCounters.set(configKey, next);
  return keys[next % keys.length]!;
}

/** Wraps `fetch` with a timeout, since provider calls must not hang forever. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 60_000, signal, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);

  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }

  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Removes secrets from text destined for logs.
 *
 * Connection errors often carry the full request URL, and some providers pass
 * their key as a query parameter, so both the raw and URL-encoded forms are
 * replaced. Keeping the rest of the message preserves the DNS/TLS/timeout
 * detail that makes these errors diagnosable.
 */
export function redactSecrets(message: string, ...secrets: (string | undefined)[]): string {
  let safe = String(message);
  for (const secret of secrets) {
    if (!secret) continue;
    safe = safe.split(secret).join("***");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) safe = safe.split(encoded).join("***");
  }
  return safe;
}
