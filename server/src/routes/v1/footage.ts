/**
 * Read-only HTTP surface over the semantic footage library.
 *
 * Deliberately read-only. Indexing, pulling and reconciling are long, exclusive
 * and expensive, and they belong to `footageCli.ts` where an operator can watch
 * them; exposing them here would put an hour of provider spend behind one
 * unauthenticated POST.
 */

import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { Filter } from "mongodb";

import { footageIndexCollection } from "../../db/client.ts";
import type { FootageIndexDocument } from "../../db/types.ts";
import { badRequest, HttpException, notFound } from "../../http/errors.ts";
import { parseByteRange } from "../../http/staticFiles.ts";
import { isCacheClipName, searchFootage, stats } from "../../services/footage/index.ts";
import type { FootageFilter, FootagePayload } from "../../services/footage/qdrant.ts";
import { ensureThumb } from "../../services/footage/thumbs.ts";
import { resolvePathWithinDirectory, UnsafePathError } from "../../utils/fileSecurity.ts";
import { errorMessage, logger } from "../../utils/logger.ts";
import { cacheVideosDir } from "../../utils/paths.ts";
import { getResponse } from "../../utils/misc.ts";

export const footageRouter = new Hono();

/**
 * The search body.
 *
 * `filter` is passed to Qdrant as-is: it is that server's filter language, not
 * one this app redefines, and `queryPoints` already answers `[]` rather than
 * throwing when the server rejects a malformed one. Narrowing it to a
 * hand-written subset here would only mean re-implementing — and drifting from
 * — a schema Qdrant already validates.
 */
const footageSearchRequestSchema = z.object({
  query: z.string().min(1, "a footage search needs a query"),
  limit: z.number().int().positive().optional(),
  filter: z.record(z.unknown()).optional(),
});

/**
 * What the library holds, and where it disagrees with itself.
 *
 * A full scroll of the collection, so it is a maintenance endpoint — the
 * render path never calls it. `stats()` reports `points` and `drift` as null
 * rather than zero when Qdrant does not answer, and that distinction is
 * preserved on the wire: "unknown" and "empty" send an operator to two
 * different places.
 */
footageRouter.get("/footage/stats", async (c) => {
  return c.json(getResponse(200, await stats()));
});

footageRouter.post("/footage/search", async (c) => {
  const body = footageSearchRequestSchema.parse(await c.req.json());

  let matches;
  try {
    matches = await searchFootage(body.query, body.limit, body.filter as FootageFilter | undefined);
  } catch (error) {
    // `searchFootage` throws only on the embedding half — an unset API key, a
    // wrong model — which is a configuration fault rather than an empty
    // library. The Qdrant half degrades to `[]` on its own and never lands
    // here. Reported as a 400 so the message reaches the caller instead of
    // being flattened into "internal server error".
    throw badRequest(error instanceof Error ? error.message : "footage search failed");
  }

  return c.json(getResponse(200, { query: body.query, count: matches.length, matches }));
});

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

/**
 * The gallery's page size, and its ceiling.
 *
 * The ceiling is not politeness. One item carries a paragraph of prose, so a
 * page is tens of kilobytes before it is tens of items, and an unbounded
 * `limit` would let one request ask for the entire library's descriptions in a
 * single response body.
 */
const DEFAULT_LIST_LIMIT = 60;
const MAX_LIST_LIMIT = 200;

/**
 * How deep a semantic page can go.
 *
 * `searchFootage` caps its own limit at 100, so a ranked result set has a hard
 * floor under it that no query string can raise. Stated here so `total` on the
 * search path is understood as "how many ranked hits exist", not "how many
 * clips could ever match" — relevance has no tail worth paging into.
 */
const MAX_SEARCH_DEPTH = 100;

/** Query flags arrive as text; every spelling a browser or curl might send. */
const booleanFlag = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((value) => value === "true" || value === "1" || value === "yes");

/**
 * The gallery query.
 *
 * `aspect` takes the orientation word, not a ratio. That is not a stylistic
 * choice: the Qdrant payload stores `landscape`/`portrait`/`square`, and
 * `compare.ts` documents the measurement — filtering on `"9:16"` matches zero
 * of 1,512 points while `"portrait"` matches 756. Accepting the ratio here
 * would hand the caller a silently empty gallery.
 */
export const footageListQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIST_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  aspect: z.enum(["landscape", "portrait", "square"]).optional(),
  provider: z.string().trim().min(1).optional(),
  has_people: booleanFlag.optional(),
  min_duration: z.coerce.number().nonnegative().optional(),
  sort: z.enum(["newest", "oldest", "longest", "shortest"]).optional(),
});

export type FootageListQuery = z.infer<typeof footageListQuerySchema>;

/** One clip as the gallery renders it: enough to show it and to explain it. */
export interface FootageItem {
  local_file: string;
  duration: number;
  width: number;
  height: number;
  aspect: string;
  bytes: number;
  provider: string;
  asset_id?: string;
  source_page?: string;
  creator?: { name?: string; profile_page?: string };
  search_terms: string[];
  summary: string;
  detailed_description: string;
  use_cases: string[];
  mood: string[];
  tags: string[];
  setting: string;
  time_of_day: string;
  camera_motion: string;
  has_people: boolean;
  has_on_screen_text: boolean;
  quality_flags: string[];
  indexed_at: string;
  /** Present only on the semantic path, where order means something. */
  score?: number;
}

/**
 * Orientation from a shape.
 *
 * Duplicates the indexer's private `orientationOf` deliberately: this one
 * exists because Mongo rows have no `aspect` field at all — only the Qdrant
 * payload does — so the listing path has to derive what the search path reads.
 * Both must produce the same three words or a filtered gallery would disagree
 * with a filtered search over the same clips.
 */
export function orientationOf(width?: number, height?: number): string {
  if (!width || !height) return "";
  if (width > height) return "landscape";
  if (width < height) return "portrait";
  return "square";
}

/** Drops empty query values so `?provider=` reads as absent, not as invalid. */
function presentQuery(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return out;
}

/**
 * The Mongo filter for a browse page.
 *
 * `description` must be an object, which is what restricts the gallery to
 * clips that can actually be described to a viewer — a row that has only ever
 * failed keeps its bytes (nothing in this library deletes a clip) but has no
 * summary, no tags and nothing to render in a tile.
 *
 * Aspect is an `$expr` rather than a stored field because the row does not have
 * one. That is a collection scan over ~1,500 documents, which is microseconds,
 * and the alternative — denormalising an `aspect` onto every row — would add a
 * second place for orientation to be wrong.
 */
export function buildListFilter(query: FootageListQuery): Filter<FootageIndexDocument> {
  // Dotted paths into `description` are how Mongo addresses a nested field, and
  // the driver's `Filter<T>` cannot express one through an optional-and-nullable
  // subdocument. Built loose, cast once, rather than weakening the document type.
  const filter: Record<string, unknown> = { description: { $type: "object" } };

  if (query.provider) filter.provider = query.provider;
  if (query.has_people !== undefined) filter["description.has_people"] = query.has_people;
  if (query.min_duration !== undefined) filter.duration = { $gte: query.min_duration };

  if (query.aspect) {
    // A clip that never probed has no shape and therefore no orientation; it is
    // excluded rather than counted as one of the three.
    filter.width = { $gt: 0 };
    filter.height = { $gt: 0 };
    filter.$expr =
      query.aspect === "landscape"
        ? { $gt: ["$width", "$height"] }
        : query.aspect === "portrait"
          ? { $lt: ["$width", "$height"] }
          : { $eq: ["$width", "$height"] };
  }

  return filter as Filter<FootageIndexDocument>;
}

/**
 * Sort order for a browse page.
 *
 * Every key is paired with `_id` because the library was indexed in bulk and
 * hundreds of rows share a timestamp to the millisecond. Without the tiebreak
 * Mongo is free to order ties differently between two calls, and a gallery
 * paging through them would show the same clip twice and skip another.
 */
export function buildListSort(sort: FootageListQuery["sort"]): Record<string, 1 | -1> {
  switch (sort) {
    case "oldest":
      return { updated_at: 1, _id: 1 };
    case "longest":
      return { duration: -1, _id: 1 };
    case "shortest":
      return { duration: 1, _id: 1 };
    default:
      return { updated_at: -1, _id: 1 };
  }
}

/**
 * The same filters, in Qdrant's language, for the semantic path.
 *
 * Applied server-side rather than by discarding hits afterwards: a post-filter
 * would ask for ten results, throw eight away, and call the remaining two "the
 * top ten portrait clips".
 */
export function buildSearchFilter(query: FootageListQuery): FootageFilter | undefined {
  const must: NonNullable<FootageFilter["must"]> = [];

  if (query.aspect) must.push({ key: "aspect", match: { value: query.aspect } });
  if (query.provider) must.push({ key: "provider", match: { value: query.provider } });
  if (query.has_people !== undefined) {
    must.push({ key: "has_people", match: { value: query.has_people } });
  }
  if (query.min_duration !== undefined) {
    must.push({ key: "duration", range: { gte: query.min_duration } });
  }

  return must.length > 0 ? { must } : undefined;
}

/** Creator credit, reduced to the two fields a tile can show. */
function creditOf(
  creator: { name?: string; profile_page?: string } | null | undefined,
): FootageItem["creator"] {
  if (!creator) return undefined;
  const credit: { name?: string; profile_page?: string } = {};
  if (creator.name) credit.name = creator.name;
  if (creator.profile_page) credit.profile_page = creator.profile_page;
  return Object.keys(credit).length > 0 ? credit : undefined;
}

/**
 * A Mongo row as a gallery item.
 *
 * `indexed_at` comes from `updated_at`, the row's own clock. The Qdrant payload
 * carries a field by that name too, and the two are written in the same pass —
 * so a client sorting or displaying it gets the same instant whichever path
 * produced the item.
 */
export function itemFromRow(row: FootageIndexDocument): FootageItem {
  const description = row.description;
  return {
    local_file: row.local_file,
    duration: row.duration ?? 0,
    width: row.width ?? 0,
    height: row.height ?? 0,
    aspect: orientationOf(row.width, row.height),
    bytes: row.bytes ?? 0,
    provider: row.provider ?? "",
    ...(row.asset_id ? { asset_id: row.asset_id } : {}),
    ...(row.source_page ? { source_page: row.source_page } : {}),
    ...(creditOf(row.creator) ? { creator: creditOf(row.creator) } : {}),
    search_terms: row.search_terms ?? [],
    summary: description?.summary ?? "",
    detailed_description: description?.detailed_description ?? "",
    use_cases: description?.use_cases ?? [],
    mood: description?.mood ?? [],
    tags: description?.tags ?? [],
    setting: description?.setting ?? "",
    time_of_day: description?.time_of_day ?? "",
    camera_motion: description?.camera_motion ?? "",
    has_people: description?.has_people ?? false,
    has_on_screen_text: description?.has_on_screen_text ?? false,
    quality_flags: description?.quality_flags ?? [],
    indexed_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : "",
  };
}

/** A Qdrant hit as a gallery item, with the score that ordered it. */
export function itemFromPayload(payload: FootagePayload, score: number): FootageItem {
  return {
    local_file: payload.local_file,
    duration: payload.duration ?? 0,
    width: payload.width ?? 0,
    height: payload.height ?? 0,
    // Points written before `aspect` was added to the payload still have a
    // shape, so the orientation is recomputed rather than reported as blank.
    aspect: payload.aspect ?? orientationOf(payload.width, payload.height),
    bytes: payload.bytes ?? 0,
    provider: payload.provider ?? "",
    ...(payload.asset_id ? { asset_id: payload.asset_id } : {}),
    ...(payload.source_page ? { source_page: payload.source_page } : {}),
    ...(creditOf(payload.creator) ? { creator: creditOf(payload.creator) } : {}),
    search_terms: payload.search_terms ?? [],
    summary: payload.summary ?? "",
    detailed_description: payload.detailed_description ?? "",
    use_cases: payload.use_cases ?? [],
    mood: payload.mood ?? [],
    tags: payload.tags ?? [],
    setting: payload.setting ?? "",
    time_of_day: payload.time_of_day ?? "",
    camera_motion: payload.camera_motion ?? "",
    has_people: payload.has_people ?? false,
    has_on_screen_text: payload.has_on_screen_text ?? false,
    quality_flags: payload.quality_flags ?? [],
    indexed_at: payload.indexed_at ?? "",
    score,
  };
}

/**
 * One page of the library.
 *
 * Two sources behind one shape. With `q` the order is relevance and comes from
 * Qdrant, whose payload already holds every field an item needs — no Mongo
 * round trip per hit. Without `q` it is a filtered, sorted, counted Mongo page,
 * because "the 61st-to-120th newest portrait clip" is not a question a vector
 * store answers.
 */
footageRouter.get("/footage/list", async (c) => {
  const query = footageListQuerySchema.parse(presentQuery(c.req.query()));
  const limit = query.limit ?? DEFAULT_LIST_LIMIT;
  const offset = query.offset ?? 0;

  if (query.q) {
    // The full ranked set every time, then sliced, rather than `offset + limit`
    // results. A depth that tracked the page would make `total` shrink as the
    // caller paged backwards into it — page 1 of 2 reporting "2 results" and
    // page 2 reporting "4" is not a number a paginator can use. One local
    // Qdrant query for a hundred payloads costs far less than the embedding
    // call that precedes it.
    let matches;
    try {
      matches = await searchFootage(query.q, MAX_SEARCH_DEPTH, buildSearchFilter(query));
    } catch (error) {
      // Same split as `/footage/search`: only the embedding half throws, and it
      // throws for configuration faults, which deserve their message on the
      // wire rather than a generic 500.
      throw badRequest(errorMessage(error) || "footage search failed");
    }

    const ranked = matches
      .filter((match) => match.payload != null)
      .map((match) => itemFromPayload(match.payload as FootagePayload, match.score));

    return c.json(
      getResponse(200, { total: ranked.length, items: ranked.slice(offset, offset + limit) }),
    );
  }

  const filter = buildListFilter(query);
  const collection = footageIndexCollection();
  const [total, rows] = await Promise.all([
    collection.countDocuments(filter),
    collection.find(filter).sort(buildListSort(query.sort)).skip(offset).limit(limit).toArray(),
  ]);

  return c.json(getResponse(200, { total, items: rows.map(itemFromRow) }));
});

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/**
 * Turns a URL segment into a path inside the clip cache, or refuses.
 *
 * `storage/cache_videos` has never been reachable over HTTP before this router,
 * so this function is the entire boundary between "one directory of stock
 * footage" and "the filesystem". It is two independent layers on purpose:
 *
 *  1. **An allow-list.** `isCacheClipName` is the library's own definition of
 *     a clip — `vid-<md5>.mp4` — shared with the indexer, the CLI and the cache
 *     cleaner. Nothing containing a separator, a `..`, a NUL or any other
 *     extension gets past it, so traversal is rejected on the shape of the name
 *     before any path is built.
 *  2. **Containment.** `resolvePathWithinDirectory` then proves the resolved
 *     real path still sits under the cache directory, which is what catches a
 *     symlink planted inside it — something no amount of name checking can see.
 *
 * Hono has already percent-decoded the parameter, so `%2e%2e%2f` arrives here
 * as `../` and is refused by the first layer. Decoding it a second time would
 * be the bug, not the fix: it would turn `%252e` into `..` after the check.
 */
export function resolveCacheClip(name: string | undefined): string {
  const candidate = String(name ?? "");
  if (!isCacheClipName(candidate)) {
    throw new UnsafePathError("path is outside the allowed directory");
  }
  return resolvePathWithinDirectory(cacheVideosDir(false), candidate);
}

/**
 * Maps a refusal to a status.
 *
 * A well-formed name for a clip that is not on disk is a 404; anything else is
 * a 403, because the request asked for something it was never allowed to ask
 * for. Mirrors `serveTaskFile`, and the log line is what makes a probe visible.
 */
function clipPathError(name: string | undefined, error: unknown): HttpException {
  if (error instanceof UnsafePathError) {
    if (error.message === "file does not exist") return notFound("clip not found");
    logger.warning(`rejected footage file request: name=${JSON.stringify(name)}, reason=${error.message}`);
    return new HttpException({ statusCode: 403, message: "invalid clip name" });
  }
  throw error;
}

/**
 * Immutable, because the name is a hash of the source URL.
 *
 * `vid-<md5(url)>.mp4` cannot change content without changing name, and a
 * poster is a pure function of the clip. A year is the maximum the spec allows
 * and it is the honest value here.
 */
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

/**
 * The poster frame for a clip, generated on first request.
 *
 * Deliberately not a static file route: the cache directory is allowed to be
 * empty or deleted, and the first viewer to scroll past a tile refills it.
 */
footageRouter.get("/footage/thumb/:localFile", async (c) => {
  const name = c.req.param("localFile");

  let clip: string;
  try {
    clip = resolveCacheClip(name);
  } catch (error) {
    throw clipPathError(name, error);
  }

  let thumb: string;
  try {
    thumb = await ensureThumb(clip);
  } catch (error) {
    // The clip resolved, so this is ffmpeg failing on a file it cannot decode,
    // or timing out on one that would have hung the worker. A 500 with the
    // reason beats a broken image with no explanation anywhere.
    throw new HttpException({
      statusCode: 500,
      message: `thumbnail generation failed: ${errorMessage(error)}`,
    });
  }

  return new Response(Bun.file(thumb), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": IMMUTABLE_CACHE },
  });
});

/**
 * How large a byte range may be before it is streamed instead of buffered.
 *
 * See `serveClipRange` for why the choice exists at all. Four mebibytes covers
 * the windows a video element actually asks for while seeking, and a handful of
 * concurrent viewers at that size is megabytes of resident memory, not
 * gigabytes.
 */
const MAX_BUFFERED_RANGE = 4 * 1024 * 1024;

/**
 * The clip itself, with byte ranges — and the one place this router cannot use
 * `serveFileWithRange`.
 *
 * That helper builds its body as `Bun.file(path).slice(start, end + 1)`, which
 * is correct in isolation and correct on `/tasks/*`. It is **not** correct
 * under `/api/*`, and the reason is worth writing down because nothing about it
 * is visible from either side:
 *
 *   Hono's `Context`'s `res` setter re-wraps an assigned response —
 *   `new Response(_res.body, _res)` (hono 4.13.1, `dist/context.js`) — once
 *   anything has already touched `c.res`, which the CORS middleware mounted on
 *   `/api/*` does. Re-wrapping reads `.body` off the response, and Bun's
 *   conversion of a *sliced* `BunFile` to a stream keeps the slice's start
 *   offset but loses its end: the body then runs to end-of-file.
 *
 * Measured on this build, `Range: bytes=0-1023` against a 4,145,441-byte clip:
 * status 206 and `Content-Range: bytes 0-1023/4145441`, with 4,145,441 bytes of
 * body. Correct headers, whole file. A player seeking on that gets bytes that
 * do not match the range it was promised, and nothing anywhere reports an
 * error. (The same bug is live on `/api/v1/stream/*`, which is not this
 * router's to fix.)
 *
 * So the range arithmetic is reused — `parseByteRange` is exported, tested, and
 * owns the 416 and suffix-range cases — and only the body is built differently,
 * as one of two forms that survive being re-wrapped:
 *
 *  - **Bytes**, for a range small enough to hold. Re-wrapping preserves it
 *    exactly, `Content-Length` survives, and a 206 with a real length is what
 *    every player handles best.
 *  - **A node read stream** over `{ start, end }`, for anything larger,
 *    including a whole clip. Correct at any size and never resident; the cost
 *    is that Bun serves a stream chunked, so `Content-Length` is dropped and
 *    the client learns the total from `Content-Range` instead.
 */
async function serveClipRange(c: Context, filePath: string): Promise<Response> {
  const size = statSync(filePath).size;
  const rangeHeader = c.req.header("Range") ?? null;
  const range = parseByteRange(rangeHeader, size);

  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
    });
  }

  const { start, end } = range;
  const length = end - start + 1;
  const isPartial = rangeHeader != null;

  const headers: Record<string, string> = {
    // `isCacheClipName` admits only `.mp4`, so the type is not a lookup.
    "Content-Type": "video/mp4",
    "Content-Length": String(length),
    "Accept-Ranges": "bytes",
    "Cache-Control": IMMUTABLE_CACHE,
  };
  if (isPartial) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;

  const body =
    length <= MAX_BUFFERED_RANGE
      ? new Uint8Array(await Bun.file(filePath).slice(start, end + 1).arrayBuffer())
      : (Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>);

  return new Response(body, { status: isPartial ? 206 : 200, headers });
}

/**
 * The clip itself.
 *
 * Range support is the whole point: without it a browser must download an
 * entire clip before it can show a second of it, and cannot seek at all.
 */
footageRouter.get("/footage/clip/:localFile", async (c) => {
  const name = c.req.param("localFile");

  let clip: string;
  try {
    clip = resolveCacheClip(name);
  } catch (error) {
    throw clipPathError(name, error);
  }

  return serveClipRange(c, clip);
});
