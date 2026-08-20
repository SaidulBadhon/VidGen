/**
 * Connected YouTube channels and short-lived OAuth CSRF states.
 *
 * Refresh tokens never leave this module in a public payload. Reconnecting an
 * already-known channel updates the tokens in place so the row id — and any
 * auto-upload flag the user set — stay stable.
 */

import { youtubeChannelsCollection, youtubeOAuthStatesCollection, youtubeScheduleCollection } from "./client.ts";
import type { YoutubeChannelDocument, YoutubeOAuthStateDocument } from "./types.ts";
import { nextYoutubePublishSlot, OAUTH_STATE_TTL_MS, publicYoutubeChannel, type PublicYoutubeChannel } from "../services/youtube/helpers.ts";
import { getUuid } from "../utils/misc.ts";

export type { PublicYoutubeChannel };

export interface YoutubeChannelUpsert {
  channel_id: string;
  title: string;
  custom_url?: string | null;
  thumbnail_url?: string | null;
  google_account_email?: string | null;
  refresh_token: string;
  access_token: string;
  access_token_expires_at: Date;
  granted_scopes?: string | null;
}

function stripUndefined(value: object): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result;
}

export async function createOAuthState(redirectUri: string): Promise<string> {
  const state = getUuid(true);
  const now = new Date();
  await youtubeOAuthStatesCollection().insertOne({
    _id: state,
    redirect_uri: redirectUri,
    created_at: now,
    expires_at: new Date(now.getTime() + OAUTH_STATE_TTL_MS),
  });
  return state;
}

export async function consumeOAuthState(state: string): Promise<YoutubeOAuthStateDocument | null> {
  const now = new Date();
  const doc = await youtubeOAuthStatesCollection().findOneAndDelete({
    _id: state,
    expires_at: { $gt: now },
  });
  return doc ?? null;
}

export async function listYoutubeChannels(): Promise<YoutubeChannelDocument[]> {
  return youtubeChannelsCollection().find({}).sort({ created_at: 1 }).toArray();
}

export async function listPublicYoutubeChannels(): Promise<PublicYoutubeChannel[]> {
  const channels = await listYoutubeChannels();
  return channels.map(publicYoutubeChannel);
}

export async function listAutoUploadChannels(): Promise<YoutubeChannelDocument[]> {
  return youtubeChannelsCollection().find({ auto_upload: true }).sort({ created_at: 1 }).toArray();
}

export async function getYoutubeChannel(id: string): Promise<YoutubeChannelDocument | null> {
  return youtubeChannelsCollection().findOne({ _id: id });
}

export async function getYoutubeChannelsByIds(ids: string[]): Promise<YoutubeChannelDocument[]> {
  if (ids.length === 0) return [];
  return youtubeChannelsCollection()
    .find({ _id: { $in: ids } })
    .toArray();
}

export async function upsertYoutubeChannel(fields: YoutubeChannelUpsert): Promise<YoutubeChannelDocument> {
  const existing = await youtubeChannelsCollection().findOne({ channel_id: fields.channel_id });
  const now = new Date();

  if (existing) {
    const update = stripUndefined({
      title: fields.title,
      custom_url: fields.custom_url,
      thumbnail_url: fields.thumbnail_url,
      google_account_email: fields.google_account_email,
      refresh_token: fields.refresh_token || existing.refresh_token,
      access_token: fields.access_token,
      access_token_expires_at: fields.access_token_expires_at,
      granted_scopes: fields.granted_scopes || existing.granted_scopes,
      error: null,
      connected_at: now,
      updated_at: now,
    });
    await youtubeChannelsCollection().updateOne({ _id: existing._id }, { $set: update });
    return { ...existing, ...update, updated_at: now, connected_at: now } as YoutubeChannelDocument;
  }

  const created: YoutubeChannelDocument = {
    _id: getUuid(),
    channel_id: fields.channel_id,
    title: fields.title,
    custom_url: fields.custom_url ?? null,
    thumbnail_url: fields.thumbnail_url ?? null,
    google_account_email: fields.google_account_email ?? null,
    refresh_token: fields.refresh_token,
    access_token: fields.access_token,
    access_token_expires_at: fields.access_token_expires_at,
    granted_scopes: fields.granted_scopes ?? null,
    auto_upload: false,
    error: null,
    created_at: now,
    updated_at: now,
    connected_at: now,
  };
  await youtubeChannelsCollection().insertOne(created);
  return created;
}

export async function patchYoutubeChannel(
  id: string,
  fields: Partial<Pick<YoutubeChannelDocument, "auto_upload" | "access_token" | "access_token_expires_at" | "refresh_token" | "granted_scopes" | "error">>,
): Promise<boolean> {
  const update = stripUndefined(fields);
  if (Object.keys(update).length === 0) return false;
  const result = await youtubeChannelsCollection().updateOne(
    { _id: id },
    { $set: { ...update, updated_at: new Date() } },
  );
  return result.matchedCount > 0;
}

export async function deleteYoutubeChannel(id: string): Promise<boolean> {
  const result = await youtubeChannelsCollection().deleteOne({ _id: id });
  return result.deletedCount > 0;
}

const PUBLISH_CURSOR_ID = "publish_cursor" as const;
let publishClaimLock: Promise<unknown> = Promise.resolve();

function cursorMs(value: Date | string | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Reserves the next staggered publish time and advances the cursor so the
 * following auto-upload lands `staggerMs` later. Serialized in-process so two
 * finished renders cannot claim the same slot.
 */
export async function claimNextYoutubePublishAt(staggerMs: number, now = Date.now()): Promise<string> {
  const run = publishClaimLock.then(() => claimNextYoutubePublishAtUnlocked(staggerMs, now));
  publishClaimLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function claimNextYoutubePublishAtUnlocked(staggerMs: number, now: number): Promise<string> {
  const collection = youtubeScheduleCollection();
  const existing = await collection.findOne({ _id: PUBLISH_CURSOR_ID });
  const { publishAtMs, nextCursorMs } = nextYoutubePublishSlot({
    cursorMs: cursorMs(existing?.next_publish_at),
    now,
    staggerMs,
  });
  await collection.updateOne(
    { _id: PUBLISH_CURSOR_ID },
    { $set: { next_publish_at: new Date(nextCursorMs), updated_at: new Date() } },
    { upsert: true },
  );
  return new Date(publishAtMs).toISOString();
}
