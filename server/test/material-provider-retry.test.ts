/**
 * Pexels and Coverr previously went straight from `providerFetch` to
 * `response.json()`. A 429 produced a body with no `videos`/`hits` key, logged
 * "unsupported response" and returned `[]` — indistinguishable from "this term
 * has no footage". These cover the status handling that replaced it.
 *
 * No network: the fetcher and the sleep are injected.
 */
import { describe, expect, test } from "bun:test";
import {
  PROVIDER_RETRY_ATTEMPTS,
  fetchProviderJson,
  providerRetryDelayMs,
} from "../src/services/material/search.ts";

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const init = { status, headers: { "content-type": "application/json", ...headers } };
  return new Response(typeof body === "string" ? body : JSON.stringify(body), init);
}

/** Returns each queued response in turn, recording how many calls happened. */
function fetcherFor(responses: Response[]) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    return responses[calls.length - 1] ?? reply(500, {});
  }) as never;
  return { fn, calls };
}

const noSleep = async () => {};

describe("providerRetryDelayMs", () => {
  test("honours a usable Retry-After, in seconds", () => {
    expect(providerRetryDelayMs(reply(429, {}, { "retry-after": "2" }))).toBe(2000);
  });

  test("caps a large Retry-After so a render cannot stall", () => {
    expect(providerRetryDelayMs(reply(429, {}, { "retry-after": "3600" }))).toBe(3000);
  });

  test("falls back to the base delay when the header is missing or junk", () => {
    expect(providerRetryDelayMs(reply(429, {}))).toBe(1500);
    expect(providerRetryDelayMs(reply(429, {}, { "retry-after": "soon" }))).toBe(1500);
    expect(providerRetryDelayMs(reply(429, {}, { "retry-after": "-5" }))).toBe(1500);
    expect(providerRetryDelayMs(undefined)).toBe(1500);
  });
});

describe("fetchProviderJson", () => {
  test("returns parsed JSON on a 200", async () => {
    const { fn, calls } = fetcherFor([reply(200, { videos: [{ id: 1 }] })]);
    const data = await fetchProviderJson<{ videos: unknown[] }>("pexels", "u", {}, fn, noSleep);
    expect(data).toEqual({ videos: [{ id: 1 }] });
    expect(calls.length).toBe(1);
  });

  test("retries a 429 and succeeds on the second attempt", async () => {
    const { fn, calls } = fetcherFor([reply(429, { error: "rate limited" }), reply(200, { videos: [] })]);
    const data = await fetchProviderJson<{ videos: unknown[] }>("pexels", "u", {}, fn, noSleep);
    expect(data).toEqual({ videos: [] });
    expect(calls.length).toBe(2);
  });

  test("gives up after the attempt ceiling on a sustained 429, returning null not junk", async () => {
    const { fn, calls } = fetcherFor([reply(429, {}), reply(429, {})]);
    const data = await fetchProviderJson("pexels", "u", {}, fn, noSleep);
    expect(data).toBeNull();
    expect(calls.length).toBe(PROVIDER_RETRY_ATTEMPTS);
  });

  test("retries a 5xx", async () => {
    const { fn, calls } = fetcherFor([reply(503, {}), reply(200, { hits: [] })]);
    expect(await fetchProviderJson<{ hits: unknown[] }>("coverr", "u", {}, fn, noSleep)).toEqual({ hits: [] });
    expect(calls.length).toBe(2);
  });

  test("does NOT retry a 401 — a bad key will not improve by being asked again", async () => {
    const { fn, calls } = fetcherFor([reply(401, {}), reply(200, { videos: [] })]);
    expect(await fetchProviderJson("pexels", "u", {}, fn, noSleep)).toBeNull();
    expect(calls.length).toBe(1);
  });

  test("does not retry a 404", async () => {
    const { fn, calls } = fetcherFor([reply(404, {})]);
    expect(await fetchProviderJson("pexels", "u", {}, fn, noSleep)).toBeNull();
    expect(calls.length).toBe(1);
  });

  test("returns null on a 200 carrying non-JSON, rather than throwing", async () => {
    const { fn } = fetcherFor([reply(200, "<html>maintenance</html>")]);
    expect(await fetchProviderJson("pexels", "u", {}, fn, noSleep)).toBeNull();
  });

  test("waits the backoff it computed, honouring Retry-After", async () => {
    const slept: number[] = [];
    const { fn } = fetcherFor([reply(429, {}, { "retry-after": "2" }), reply(200, { videos: [] })]);
    await fetchProviderJson("pexels", "u", {}, fn, async (ms) => {
      slept.push(ms);
    });
    expect(slept).toEqual([2000]);
  });
});
