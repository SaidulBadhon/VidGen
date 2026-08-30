/**
 * Byte-range serving, and specifically the failure that made it worth testing.
 *
 * `serveFileWithRange` used to build its body as
 * `Bun.file(path).slice(start, end + 1)`. That is correct in isolation, and was
 * correct on `/tasks/*`, but silently wrong under `/api/*`: Hono re-wraps an
 * assigned response as `new Response(res.body, res)` once middleware has
 * touched `c.res`, and Bun's conversion of a *sliced* BunFile to a stream keeps
 * the slice's start offset but loses its end — so the body ran to end-of-file
 * while the headers still promised a short range.
 *
 * Nothing reported an error. The status was 206, `Content-Range` was right, and
 * the body was the whole file. So the assertion that matters is not "the
 * response looks right" but "the bytes still match AFTER a re-wrap".
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "hono";
import { parseByteRange, serveFileWithRange } from "../src/http/staticFiles.ts";

/** Deterministic bytes, so an off-by-one shows up as a value mismatch. */
const SIZE = 12_000;
const CONTENT = new Uint8Array(SIZE).map((_, i) => i % 251);

const dir = mkdtempSync(join(tmpdir(), "vidgen-range-"));
const file = join(dir, "sample.mp4");
writeFileSync(file, CONTENT);

/** Just enough Context for the helper: it only reads the Range header. */
function ctx(range?: string): Context {
  return { req: { header: (name: string) => (name === "Range" ? range : undefined) } } as unknown as Context;
}

/** What Hono does to a response once middleware has touched `c.res`. */
function rewrap(response: Response): Response {
  return new Response(response.body, response);
}

async function bytesOf(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

describe("parseByteRange", () => {
  test("open-ended, closed, and suffix forms", () => {
    expect(parseByteRange("bytes=0-99", SIZE)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange("bytes=100-", SIZE)).toEqual({ start: 100, end: SIZE - 1 });
    expect(parseByteRange("bytes=-500", SIZE)).toEqual({ start: SIZE - 500, end: SIZE - 1 });
  });

  test("no header means the whole file", () => {
    expect(parseByteRange(null, SIZE)).toEqual({ start: 0, end: SIZE - 1 });
  });

  test("a range starting past the end is unsatisfiable", () => {
    expect(parseByteRange(`bytes=${SIZE}-`, SIZE)).toBe("unsatisfiable");
  });

  test("an end beyond the file is clamped, not rejected", () => {
    expect(parseByteRange(`bytes=0-${SIZE + 1000}`, SIZE)).toEqual({ start: 0, end: SIZE - 1 });
  });
});

describe("serveFileWithRange", () => {
  test("a partial response carries the right status, headers and length", async () => {
    const response = serveFileWithRange(ctx("bytes=0-1023"), file);
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 0-1023/${SIZE}`);
    expect(response.headers.get("Content-Length")).toBe("1024");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
  });

  // The regression. Each case reads the body only after a re-wrap, because that
  // is the step the old implementation did not survive.
  test.each([
    ["leading range", "bytes=0-1023", 0, 1024],
    ["mid-file range", "bytes=4000-4999", 4000, 1000],
    ["suffix range", "bytes=-500", SIZE - 500, 500],
    ["open-ended range", "bytes=11000-", 11000, 1000],
    ["single byte", "bytes=7-7", 7, 1],
  ])("%s survives a re-wrap with exactly its own bytes", async (_label, header, start, length) => {
    const body = await bytesOf(rewrap(serveFileWithRange(ctx(header), file)));
    expect(body.length).toBe(length);
    expect(body).toEqual(CONTENT.subarray(start, start + length));
  });

  test("a range over the buffer cap also survives a re-wrap", async () => {
    // Forces the streaming branch rather than the buffered one.
    const big = join(dir, "big.mp4");
    const bigContent = new Uint8Array(5 * 1024 * 1024).map((_, i) => i % 251);
    writeFileSync(big, bigContent);

    const body = await bytesOf(rewrap(serveFileWithRange(ctx("bytes=0-4194303"), big)));
    expect(body.length).toBe(4 * 1024 * 1024);
    expect(body).toEqual(bigContent.subarray(0, 4 * 1024 * 1024));
  });

  test("a full response is the whole file, re-wrapped", async () => {
    const response = serveFileWithRange(ctx(), file);
    expect(response.status).toBe(200);
    expect(await bytesOf(rewrap(response))).toEqual(CONTENT);
  });

  test("an unsatisfiable range is 416 with no body", async () => {
    const response = serveFileWithRange(ctx(`bytes=${SIZE + 10}-`), file);
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe(`bytes */${SIZE}`);
  });

  test("forceDownload adds a disposition without disturbing the bytes", async () => {
    const response = serveFileWithRange(ctx("bytes=0-9"), file, true);
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(await bytesOf(rewrap(response))).toEqual(CONTENT.subarray(0, 10));
  });

  test("cacheControl is passed through when given, absent when not", () => {
    expect(serveFileWithRange(ctx(), file, false, "public, max-age=31536000, immutable").headers.get("Cache-Control"))
      .toBe("public, max-age=31536000, immutable");
    expect(serveFileWithRange(ctx(), file).headers.get("Cache-Control")).toBeNull();
  });
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
