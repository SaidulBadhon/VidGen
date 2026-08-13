/**
 * Shared HTTP behaviour for stock-material providers.
 *
 * Centralises the proxy and TLS settings so all three providers behave the same
 * way, and keeps secret redaction in one place.
 */

import { getSettings } from "../../config/settings.ts";
import { logger } from "../../utils/logger.ts";
import { errorMessage, errorName } from "../../utils/logger.ts";
import { redactSecrets } from "../../utils/misc.ts";

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";

/**
 * Whether to verify TLS certificates for provider calls.
 *
 * On by default so material search and download cannot be tampered with in
 * transit; only corporate proxies with self-signed certificates should turn it
 * off, and doing so is logged every time.
 */
export function getTlsVerify(): boolean {
  const value = getSettings().app.tls_verify;
  const enabled =
    typeof value === "string"
      ? !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase())
      : Boolean(value);

  if (!enabled) {
    logger.warning(
      "TLS certificate verification is disabled by tls_verify=false. " +
        "Only use this in trusted proxy environments.",
    );
  }
  return enabled;
}

/** Configured proxy URL, if any. */
export function getProxyUrl(target: string): string | undefined {
  const proxy = getSettings().proxy;
  const url = target.startsWith("https:") ? proxy.https || proxy.http : proxy.http || proxy.https;
  return url?.trim() || undefined;
}

export interface ProviderFetchOptions extends RequestInit {
  timeoutMs?: number;
}

/** Fetch with the app's proxy, TLS and timeout policy applied. */
export async function providerFetch(url: string, options: ProviderFetchOptions = {}): Promise<Response> {
  const { timeoutMs = 60_000, signal, ...rest } = options;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }

  const proxy = getProxyUrl(url);

  try {
    return await fetch(url, {
      ...rest,
      signal: controller.signal,
      ...(proxy ? { proxy } : {}),
      ...(getTlsVerify() ? {} : { tls: { rejectUnauthorized: false } }),
    } as RequestInit);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Formats a provider error for logs without leaking credentials.
 *
 * Logging only the error type would lose the DNS, certificate and timeout
 * detail that makes these failures diagnosable, but the raw message can echo a
 * full request URL — including an API key passed as a query parameter.
 */
export function describeProviderError(error: unknown, ...secrets: (string | undefined)[]): string {
  const proxies = Object.values(getSettings().proxy);
  const safe = redactSecrets(errorMessage(error), ...secrets, ...proxies);
  return `error=${errorName(error)}, detail=${safe}`;
}

/**
 * Detects a Cloudflare challenge page instead of parsing it as provider JSON.
 *
 * Cloudflare usually sets `cf-mitigated: challenge`, but some deployments only
 * return an HTML interstitial, so the body is checked as a fallback. The body is
 * never logged — it is a large, valueless HTML blob.
 */
export async function isCloudflareChallenge(response: Response): Promise<boolean> {
  if (String(response.headers.get("cf-mitigated") ?? "").toLowerCase() === "challenge") return true;

  const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("text/html")) return false;

  const body = (await response.clone().text()).toLowerCase();
  return body.includes("just a moment") || body.includes("/cdn-cgi/challenge-platform/");
}

/**
 * Keeps only a publicly shareable HTTP(S) page address.
 *
 * Download URLs can carry API keys, signed JWTs or temporary tokens. The task
 * record only needs a link back to the provider's public asset page, so query
 * strings are dropped and userinfo-bearing URLs are rejected outright.
 */
export function safePublicUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    const parsed = new URL(value.trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (!parsed.hostname) return null;
    if (parsed.username || parsed.password) return null;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return null;
  }
}
