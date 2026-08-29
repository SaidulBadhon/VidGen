/**
 * Read-only HTTP surface over the semantic footage library.
 *
 * Deliberately read-only. Indexing, pulling and reconciling are long, exclusive
 * and expensive, and they belong to `footageCli.ts` where an operator can watch
 * them; exposing them here would put an hour of provider spend behind one
 * unauthenticated POST.
 */

import { Hono } from "hono";
import { z } from "zod";
import { badRequest } from "../../http/errors.ts";
import { searchFootage, stats } from "../../services/footage/index.ts";
import type { FootageFilter } from "../../services/footage/qdrant.ts";
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
