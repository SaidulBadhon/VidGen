/**
 * MongoDB connection and collection accessors.
 *
 * Mongo replaces three things from the Python version at once: config.toml
 * (settings), the in-memory/Redis task state, and the on-disk material search
 * cache — the last of which becomes a plain TTL collection.
 */

import { MongoClient, type Collection, type Db } from "mongodb";
import { logger } from "../utils/logger.ts";
import type {
  BookBlockEditDocument,
  BookDecisionDocument,
  BookDocument,
  BookSegmentDocument,
  MaterialCacheDocument,
  SettingsDocument,
  TaskDocument,
} from "./types.ts";

const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017";
const MONGODB_DB = process.env.MONGODB_DB ?? "vidgen";

let client: MongoClient | undefined;
let db: Db | undefined;
let connecting: Promise<Db> | undefined;

async function createIndexes(database: Db): Promise<void> {
  // Task listing is always "newest first, paginated".
  await database.collection<TaskDocument>("tasks").createIndexes([
    { key: { created_at: -1 }, name: "created_at_desc" },
    { key: { state: 1, created_at: -1 }, name: "state_created_at" },
    { key: { cross_post_state: 1 }, name: "cross_post_state" },
  ]);

  // Mongo expires cached searches on its own, which is what the Python version
  // needed a background sweep and a file-format version for.
  await database.collection<MaterialCacheDocument>("material_cache").createIndexes([
    { key: { expires_at: 1 }, name: "expires_at_ttl", expireAfterSeconds: 0 },
    { key: { provider: 1, search_term: 1 }, name: "provider_search_term" },
  ]);

  // Books list newest first like tasks; their children are always read as a
  // whole book, so one compound index per collection covers every query.
  await database.collection<BookDocument>("books").createIndexes([
    { key: { created_at: -1 }, name: "created_at_desc" },
  ]);

  await database.collection<BookSegmentDocument>("book_segments").createIndexes([
    { key: { book_id: 1, index: 1 }, name: "book_id_index" },
  ]);

  await database.collection<BookDecisionDocument>("book_decisions").createIndexes([
    { key: { book_id: 1 }, name: "book_id" },
  ]);

  await database.collection<BookBlockEditDocument>("book_block_edits").createIndexes([
    { key: { book_id: 1 }, name: "book_id" },
  ]);
}

export async function connect(): Promise<Db> {
  if (db) return db;
  if (connecting) return connecting;

  connecting = (async () => {
    logger.info(`connecting to mongodb: ${redactUri(MONGODB_URI)} (db: ${MONGODB_DB})`);
    client = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 10_000,
      retryWrites: true,
    });
    await client.connect();
    const database = client.db(MONGODB_DB);
    await createIndexes(database);
    db = database;
    logger.success("mongodb connected");
    return database;
  })();

  try {
    return await connecting;
  } catch (error) {
    // Reset so a later call can retry instead of awaiting a settled rejection.
    connecting = undefined;
    client = undefined;
    throw error;
  }
}

export async function disconnect(): Promise<void> {
  if (client) {
    await client.close();
    logger.info("mongodb connection closed");
  }
  client = undefined;
  db = undefined;
  connecting = undefined;
}

function requireDb(): Db {
  if (!db) {
    throw new Error("database is not connected; call connect() during startup");
  }
  return db;
}

export function settingsCollection(): Collection<SettingsDocument> {
  return requireDb().collection<SettingsDocument>("settings");
}

export function tasksCollection(): Collection<TaskDocument> {
  return requireDb().collection<TaskDocument>("tasks");
}

export function materialCacheCollection(): Collection<MaterialCacheDocument> {
  return requireDb().collection<MaterialCacheDocument>("material_cache");
}

export function booksCollection(): Collection<BookDocument> {
  return requireDb().collection<BookDocument>("books");
}

export function bookSegmentsCollection(): Collection<BookSegmentDocument> {
  return requireDb().collection<BookSegmentDocument>("book_segments");
}

export function bookDecisionsCollection(): Collection<BookDecisionDocument> {
  return requireDb().collection<BookDecisionDocument>("book_decisions");
}

export function bookBlockEditsCollection(): Collection<BookBlockEditDocument> {
  return requireDb().collection<BookBlockEditDocument>("book_block_edits");
}

export function isConnected(): boolean {
  return db !== undefined;
}

/** Hides credentials in a connection string before logging it. */
function redactUri(uri: string): string {
  return uri.replace(/\/\/([^@/]+)@/, "//***@");
}

/** Cheap liveness probe for the health endpoint. */
export async function ping(): Promise<boolean> {
  try {
    await requireDb().command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}
