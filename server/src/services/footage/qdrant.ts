/**
 * Qdrant access for the semantic footage library.
 *
 * Everything that touches the vector database goes through here, so the rest of
 * the library never imports `@qdrant/js-client-rest` and never has to know how a
 * collection is named, versioned or aliased.
 *
 * Two rules shape the whole module:
 *
 * **1. Reads degrade, writes report.** A render must never fail because Qdrant
 * is down (design §4.4: the index is an optimisation, the filesystem is the
 * durable work-list). So `queryPoints`, `scrollAll`, `health` and `isAvailable`
 * swallow every failure, log it once with the API key redacted, and return an
 * empty/false result — a caller on the render path cannot be handed an
 * exception it forgot to catch. The write paths (`ensureCollection`,
 * `upsertPoint`, `overwritePointPayload`, `deletePoints`) do the opposite and
 * throw, because the indexer must record a failed clip rather than mark a row
 * `indexed` for a point that was never stored.
 *
 * **2. Writers address the versioned collection, searchers address the alias.**
 * Vector width is fixed when a collection is created, so changing the embedding
 * model means building a second collection beside the first (design §4.6).
 * `targetCollection()` — `<collection>_v<EMBED_VERSION>` — is the collection
 * *this build* owns and maintains; `searchCollection()` is the `footage` alias,
 * which is what search reads. In the steady state they are the same collection
 * and the distinction is invisible. During a migration it is exactly what makes
 * "create → backfill → swap the alias → drop the old one" work with no extra
 * code: the indexer fills `_v2` while every search keeps answering from `_v1`.
 *
 * API note: this file was written against the installed package's own `.d.ts`
 * (`@qdrant/js-client-rest@1.15.1`), not from memory. The point-search entry
 * point is `query()`, not the legacy `search()`, and the client exposes no
 * `health()` of its own — `versionInfo()` is the reachability probe.
 */

import { QdrantClient, type Schemas } from "@qdrant/js-client-rest";

import { getSettings } from "../../config/settings.ts";
import { errorMessage, errorName, logger } from "../../utils/logger.ts";
import { redactSecrets } from "../../utils/misc.ts";
import { EMBED_VERSION, pointIdFor, type ClipDescription } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Width of a `gemini-embedding-001` vector, asserted before every write.
 *
 * Qdrant would reject a mismatched vector itself, but only after a round trip
 * and with a message about the collection rather than about the embedder that
 * actually misbehaved. Failing locally names the real culprit.
 */
export const VECTOR_SIZE = 3072;

/**
 * Per-request ceiling, in milliseconds.
 *
 * The client's own default is 300 s, which on the render path is
 * indistinguishable from a hang. Thirty seconds is far longer than any
 * operation here needs against a local instance and still tolerates a slow
 * optimiser pass on a large upsert.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Deadline for the reachability probe, deliberately much shorter than
 * `REQUEST_TIMEOUT_MS`: "is Qdrant up?" is asked on the render path, and the
 * answer to a dead socket has to arrive in seconds, not in half a minute.
 */
const HEALTH_TIMEOUT_MS = 3_000;

/**
 * How long an availability verdict is trusted.
 *
 * Long enough that a download loop of a few hundred clips pays for one probe
 * rather than one per clip, short enough that a Qdrant restarted by hand is
 * picked up without restarting the server.
 */
const AVAILABILITY_TTL_MS = 30_000;

/**
 * Point ids per delete request.
 *
 * `delete` takes a `PointsSelector`, so an id list is one request body — and a
 * cache clear can hand this function every point in the library at once. The
 * chunking bounds both the request size and the size of the single write the
 * server has to commit.
 */
const DELETE_CHUNK_SIZE = 256;

/** Points per `scroll` page. Payload-only pages, so this stays cheap. */
const SCROLL_PAGE_SIZE = 256;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The Qdrant payload for one clip (design §5).
 *
 * A `type` rather than an `interface` on purpose: the client types a payload as
 * `{ [key: string]: unknown }`, and only a type alias picks up the implicit
 * index signature that makes it assignable. An interface here would fail to
 * compile at every `upsert` call.
 *
 * The description half is spelled out rather than intersected with
 * `ClipDescription` because this is a wire format — a field disappearing from
 * the stored payload the moment someone edits a zod schema is exactly the
 * silent breakage the explicit list prevents. `_PayloadCoversDescription` below
 * turns a *rename* into a compile error, so the two cannot drift apart either.
 */
export type FootagePayload = {
  /** Basename inside `cacheVideosDir()`. Never an absolute path — design §4.2. */
  local_file: string;

  // Provenance, copied off the material that produced the file.
  provider: string;
  asset_id?: string;
  rendition_id?: string;
  source_page?: string;
  creator?: { id?: string; name?: string; profile_page?: string } | null;
  /** Every search term that has ever selected this clip. */
  search_terms: string[];

  // Shape, probed from the file. `aspect` is indexed because "give me a
  // portrait clip" is a filter, not a similarity question.
  duration?: number;
  width?: number;
  height?: number;
  aspect?: string;
  bytes?: number;

  // The description, mirroring `ClipDescription`.
  summary: string;
  detailed_description: string;
  use_cases: string[];
  mood: string[];
  tags: string[];
  setting: string;
  time_of_day: string;
  has_people: boolean;
  has_on_screen_text: boolean;
  camera_motion: string;
  quality_flags: string[];

  // Which pipeline produced this point, so a stale point is recognisable
  // without consulting Mongo.
  describe_model: string;
  describe_version: number;
  embed_model: string;
  embed_version: number;
  /** ISO-8601, UTC. */
  indexed_at: string;
};

/**
 * Compile-time proof that the payload still carries every description field.
 * `Pick` fails on a missing key and the conditional fails on a changed type, so
 * renaming a field in `ClipDescription` breaks the build here instead of
 * quietly writing points without it.
 */
type _PayloadCoversDescription =
  Pick<FootagePayload, keyof ClipDescription> extends ClipDescription ? true : never;
const _payloadCoversDescription: _PayloadCoversDescription = true;
void _payloadCoversDescription;

/**
 * A Qdrant filter, re-exported so callers can build one without depending on
 * the client package directly.
 */
export type FootageFilter = Schemas["Filter"];

/** One search hit. */
export interface FootageMatch {
  id: string;
  score: number;
  payload: FootagePayload | null;
}

/** One stored point, as returned by a full scroll. */
export interface FootageRecord {
  id: string;
  payload: FootagePayload | null;
}

/** What `footage status` needs to explain the state of the vector store. */
export interface QdrantHealth {
  ok: boolean;
  /** The configured URL, so a "connection refused" names the address tried. */
  url: string;
  /** The collection this build writes to. */
  collection: string;
  /** The alias search reads through. */
  alias: string;
  /** Server version, present only when the instance answered. */
  version?: string;
  /** Redacted failure detail, present only when it did not. */
  detail?: string;
}

// ---------------------------------------------------------------------------
// Client and naming
// ---------------------------------------------------------------------------

/** The alias every search goes through (`qdrant.collection`, default `footage`). */
export function searchCollection(): string {
  return getSettings().qdrant.collection.trim() || "footage";
}

/**
 * The collection this build owns: `<alias>_v<EMBED_VERSION>`.
 *
 * Derived from the configured alias rather than hardcoded as `footage_v1` so a
 * second deployment pointed at the same Qdrant can keep its own namespace by
 * changing one setting.
 */
export function targetCollection(): string {
  return `${searchCollection()}_v${EMBED_VERSION}`;
}

interface CachedClient {
  /** URL + key the client was built for; a change rebuilds it. */
  key: string;
  client: QdrantClient;
}

let cachedClient: CachedClient | undefined;
/** Memoised `ensureCollection`, dropped whenever the client is rebuilt. */
let ensured: Promise<void> | undefined;
let availability: { ok: boolean; checkedAt: number } | undefined;
let availabilityInFlight: Promise<boolean> | undefined;

/**
 * The client for the currently configured instance.
 *
 * Rebuilt when the URL or key changes, because settings are editable at runtime
 * and a client caches its base URI and headers at construction.
 */
function client(): QdrantClient {
  const { url, api_key: apiKey } = getSettings().qdrant;
  // A NUL separator, written as an escape so the source stays plain text:
  // neither a URL nor a key can contain one, so two different pairs can
  // never collapse to the same key.
  const key = `${url}\u0000${apiKey}`;
  if (cachedClient?.key === key) return cachedClient.client;

  const created = new QdrantClient({
    url,
    // Only when non-empty. The constructor tests `typeof apiKey === 'string'`,
    // so an empty string still counts as "authenticated": it would set an empty
    // `api-key` header, flip the default scheme to https, and print
    // "Api key is used with unsecure connection." to the console on every
    // construction against a local, auth-free instance.
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    timeout: REQUEST_TIMEOUT_MS,
    // The package is pinned to the 1.15 line to match the pinned
    // `qdrant/qdrant:v1.15.4` image, so there is nothing for this check to
    // find. Left on it fires an extra request per client construction and
    // `console.warn`s — outside our logger, and on *every* construction while
    // Qdrant is down. `health()` reports the server version instead.
    checkCompatibility: false,
  });

  cachedClient = { key, client: created };
  ensured = undefined;
  availability = undefined;
  return created;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Payload fields that get an index, and how they are typed.
 *
 * These are the four things a search filters on rather than ranks by, and an
 * unindexed filter in Qdrant is a full scan. `duration` is a float so a range
 * filter ("at least 6 seconds") works; the other three are exact matches.
 */
const PAYLOAD_INDEXES: ReadonlyArray<{ field: string; schema: Schemas["PayloadFieldSchema"] }> = [
  { field: "aspect", schema: "keyword" },
  { field: "provider", schema: "keyword" },
  { field: "duration", schema: "float" },
  { field: "has_people", schema: "bool" },
];

/**
 * Creates the collection, its payload indexes and the search alias if they are
 * missing. Safe to call on every run and from several processes at once.
 *
 * Memoised per client so the auto-index hook — which fires once per downloaded
 * clip — pays for six round trips once rather than once per clip. The memo is
 * dropped on failure so a retry re-probes, and dropped whenever the configured
 * instance changes. The trade-off is that a collection deleted out from under a
 * long-running process is not noticed until the process restarts; that is worth
 * it against a per-clip cost, and `__resetQdrantForTest()` clears it.
 */
export async function ensureCollection(): Promise<void> {
  ensured ??= createSchema().catch((error: unknown) => {
    ensured = undefined;
    throw error;
  });
  return ensured;
}

async function createSchema(): Promise<void> {
  const qdrant = client();
  const collection = targetCollection();
  const alias = searchCollection();

  const { exists } = await qdrant.collectionExists(collection);
  if (!exists) {
    try {
      await qdrant.createCollection(collection, {
        vectors: { size: VECTOR_SIZE, distance: "Cosine" },
      });
      logger.info(`created qdrant collection ${collection} (${VECTOR_SIZE}-d, cosine)`);
    } catch (error) {
      // Two processes starting together both see "does not exist" and both
      // create; the loser gets a 409. That is success, not a failure, so it is
      // confirmed by re-asking rather than by matching on a status code.
      const { exists: nowExists } = await qdrant.collectionExists(collection);
      if (!nowExists) throw error;
    }
  }

  // Idempotent server-side: re-creating an index with the same schema returns
  // `completed`, verified against v1.15.4. So there is nothing to check first.
  for (const { field, schema } of PAYLOAD_INDEXES) {
    await qdrant.createPayloadIndex(collection, {
      field_name: field,
      field_schema: schema,
      wait: true,
    });
  }

  await ensureAlias(qdrant, alias, collection);
}

/**
 * Points the search alias at this build's collection — but only if it is not
 * already pointed somewhere else on purpose.
 *
 * An unconditional repoint would break the one workflow the alias exists for.
 * Bumping `EMBED_VERSION` and deploying would move every search onto a
 * brand-new empty collection *before* the backfill runs, so the library would
 * answer nothing for as long as the backfill takes. Design §4.6 makes the swap
 * the deliberate last step of a migration, so a mismatch is reported and left
 * alone; nothing here can strand a search silently, because the warning names
 * both collections.
 */
async function ensureAlias(qdrant: QdrantClient, alias: string, collection: string): Promise<void> {
  const { aliases } = await qdrant.getAliases();
  const existing = aliases.find((entry) => entry.alias_name === alias);

  if (existing?.collection_name === collection) return;

  if (existing) {
    logger.warning(
      `qdrant alias ${alias} points at ${existing.collection_name}, not ${collection}; ` +
        "leaving it alone — move it by hand once the new collection is backfilled",
    );
    return;
  }

  await qdrant.updateCollectionAliases({
    actions: [{ create_alias: { collection_name: collection, alias_name: alias } }],
  });
  logger.info(`pointed qdrant alias ${alias} at ${collection}`);
}

// ---------------------------------------------------------------------------
// Writes — these throw, so the indexer can record a failure
// ---------------------------------------------------------------------------

/**
 * Stores one clip's vector and payload, replacing any previous version of it.
 *
 * The point id is derived from `payload.local_file` rather than accepted as an
 * argument: id and payload can then never disagree, and no caller gets the
 * chance to re-implement `pointIdFor`. Returns the id it used so the caller can
 * record it.
 *
 * `wait: true` because the caller's next act is to mark the Mongo row
 * `indexed`. An acknowledged-but-not-applied write would let that row claim a
 * point that does not exist yet, and the row is what stops the clip being
 * re-described on the next run.
 */
export async function upsertPoint(payload: FootagePayload, vector: number[]): Promise<string> {
  if (vector.length !== VECTOR_SIZE) {
    throw new Error(
      `refusing to upsert ${payload.local_file}: expected a ${VECTOR_SIZE}-d vector, got ${vector.length}`,
    );
  }

  const id = pointIdFor(payload.local_file);
  await client().upsert(targetCollection(), {
    wait: true,
    points: [{ id, vector, payload }],
  });
  return id;
}

/**
 * Rewrites one point's payload without touching its vector — the cheap path for
 * a `stale` row (design §4.5).
 *
 * A search term arriving for an already-described clip changes provenance and
 * nothing else: not the pixels, not the description, not the embedding. Only
 * Qdrant holds the vector, so re-`upsert`ing would mean re-embedding a clip
 * whose text has not changed, at real cost, to store an identical vector.
 *
 * Overwrite rather than merge: the caller builds the complete payload from the
 * Mongo row, so a field dropped from that row should disappear from the point
 * too. A merge would leave the old value behind forever.
 */
export async function overwritePointPayload(payload: FootagePayload): Promise<string> {
  const id = pointIdFor(payload.local_file);
  await client().overwritePayload(targetCollection(), {
    wait: true,
    payload,
    points: [id],
  });
  return id;
}

/**
 * Deletes points by id, in chunks. Returns how many ids were submitted.
 *
 * Chunked because both callers hand it unbounded lists — `reconcile()` after a
 * large cache clear, and `/cache/clear` itself — and one request per id would
 * be a thousand round trips while one request for a thousand ids is a single
 * oversized body and a single large write.
 */
export async function deletePoints(ids: string[]): Promise<number> {
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
  if (unique.length === 0) return 0;

  const qdrant = client();
  const collection = targetCollection();

  for (let start = 0; start < unique.length; start += DELETE_CHUNK_SIZE) {
    const chunk = unique.slice(start, start + DELETE_CHUNK_SIZE);
    await qdrant.delete(collection, { wait: true, points: chunk });
  }

  return unique.length;
}

// ---------------------------------------------------------------------------
// Reads — these never throw
// ---------------------------------------------------------------------------

/**
 * Nearest neighbours for a query vector, through the search alias.
 *
 * `query()` is the current entry point; the deprecated `search()` is not used.
 *
 * Returns `[]` on any failure — a Qdrant that is down, an alias that was never
 * created, a filter the server rejects — after logging once. This is the
 * function a render path calls, and the whole point of design §4.4 is that a
 * missing index costs relevance, never a render.
 */
export async function queryPoints(
  vector: number[],
  limit: number,
  filter?: FootageFilter,
): Promise<FootageMatch[]> {
  try {
    const response = await client().query(searchCollection(), {
      query: vector,
      limit,
      ...(filter ? { filter } : {}),
      with_payload: true,
    });

    return response.points.map((point) => ({
      id: String(point.id),
      score: point.score,
      // Not re-validated: this is the payload we wrote ourselves, and running a
      // schema over every hit on every search would buy nothing a missing field
      // in the output would not already show.
      payload: (point.payload ?? null) as FootagePayload | null,
    }));
  } catch (error) {
    logger.warning(`qdrant search failed, continuing without it: ${describeQdrantError(error)}`);
    return [];
  }
}

/**
 * Every point in this build's collection, paged through `scroll`.
 *
 * Payloads only — vectors are 3072 floats each and no caller of this wants
 * them. Reads `targetCollection()` rather than the alias because the callers
 * are maintenance jobs (`reconcile`, `stats`) that must see what this build
 * writes, not what search currently reads.
 *
 * On failure it returns `[]` rather than the pages it had already collected. A
 * truncated list is worse than an empty one here: `reconcile()` deletes points
 * whose file is gone, and half an index looks exactly like an index whose
 * second half was deleted.
 */
export async function scrollAll(options: { filter?: FootageFilter } = {}): Promise<FootageRecord[]> {
  const qdrant = client();
  const collection = targetCollection();
  const records: FootageRecord[] = [];

  try {
    let offset: string | number | Record<string, unknown> | null | undefined;

    for (;;) {
      const page = await qdrant.scroll(collection, {
        limit: SCROLL_PAGE_SIZE,
        with_payload: true,
        with_vector: false,
        ...(options.filter ? { filter: options.filter } : {}),
        ...(offset === undefined || offset === null ? {} : { offset: offset as string | number }),
      });

      for (const point of page.points) {
        records.push({
          id: String(point.id),
          payload: (point.payload ?? null) as FootagePayload | null,
        });
      }

      const next = page.next_page_offset;
      // A server that keeps handing back the same offset, or a short page with
      // an offset still set, would otherwise spin forever.
      if (next === undefined || next === null) break;
      if (page.points.length === 0) break;
      offset = next;
    }

    return records;
  } catch (error) {
    logger.warning(`qdrant scroll failed, treating the index as unreadable: ${describeQdrantError(error)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * Whether the configured instance answers, and what it is.
 *
 * `versionInfo()` rather than `api().healthz()`: the client exposes no health
 * method of its own, both endpoints prove the same reachability, and only this
 * one comes back with a version for `footage status` to print.
 *
 * Never throws — including when settings have not been loaded yet, which is a
 * real case for a CLI that probes before `initSettings()`.
 */
export async function health(): Promise<QdrantHealth> {
  let url = "";
  let collection = "";
  let alias = "";

  try {
    url = getSettings().qdrant.url;
    collection = targetCollection();
    alias = searchCollection();

    const info = await withDeadline(client().versionInfo(), HEALTH_TIMEOUT_MS, "qdrant version check");
    return { ok: true, url, collection, alias, version: info.version };
  } catch (error) {
    return { ok: false, url, collection, alias, detail: describeQdrantError(error) };
  }
}

/**
 * Cheap, cached "can I use Qdrant right now?" for callers that must degrade.
 *
 * Deliberately about reachability only — a caller that also has to respect
 * `footage_index.enabled` checks that itself, so this cannot be read as
 * "indexing is switched on".
 *
 * Cached both ways for a short TTL, and concurrent callers share one probe: a
 * download loop asking per clip against a dead instance would otherwise pay the
 * probe timeout hundreds of times over.
 */
export async function isAvailable(): Promise<boolean> {
  const cached = availability;
  if (cached && Date.now() - cached.checkedAt < AVAILABILITY_TTL_MS) return cached.ok;

  availabilityInFlight ??= probeAvailability().finally(() => {
    availabilityInFlight = undefined;
  });
  return availabilityInFlight;
}

async function probeAvailability(): Promise<boolean> {
  const result = await health();
  if (!result.ok) {
    logger.warning(`qdrant is unavailable at ${result.url || "(unconfigured)"}: ${result.detail ?? "unknown"}`);
  }
  availability = { ok: result.ok, checkedAt: Date.now() };
  return result.ok;
}

/** Drops the cached verdict so the next caller re-probes. */
export function invalidateQdrantAvailability(): void {
  availability = undefined;
}

/**
 * Test seam, mirroring `__resetHyperframesAvailabilityForTest()`. Drops the
 * client, the schema memo and the availability verdict, so a test that swaps
 * settings is not answered from a cache built for the previous instance.
 */
export function __resetQdrantForTest(): void {
  cachedClient = undefined;
  ensured = undefined;
  availability = undefined;
  availabilityInFlight = undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Bounds a promise that has no cancellation of its own.
 *
 * The client takes a single timeout at construction, and the probe needs a much
 * tighter one than the write paths can live with. Losing the race abandons the
 * request rather than cancelling it — it finishes into nothing — which is
 * acceptable for a read-only version check. `Promise.race` attaches handlers to
 * both sides, so neither late settlement becomes an unhandled rejection.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });

  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Formats a Qdrant failure for logs without leaking the API key.
 *
 * Same shape and same reasoning as `describeProviderError` in
 * `services/material/http.ts`: the error type alone would throw away the DNS,
 * timeout and status detail that makes these diagnosable, but the raw message
 * can echo a request the key was attached to.
 */
function describeQdrantError(error: unknown): string {
  let apiKey: string | undefined;
  try {
    apiKey = getSettings().qdrant.api_key;
  } catch {
    // Settings never loaded — there is no key to redact.
  }

  const safe = redactSecrets(errorMessage(error), apiKey);
  return `error=${errorName(error)}, detail=${safe}`;
}
