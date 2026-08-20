/**
 * Pure YouTube helpers: OAuth URLs, listing limits, and the public channel
 * shape. Kept free of fetch and Mongo so the tests can cover the contract
 * without a Google project or a database.
 */

import type { YoutubeUploadIntent } from "../../db/types.ts";

export const YOUTUBE_TITLE_MAX = 100;
export const YOUTUBE_DESCRIPTION_MAX = 5000;
export const YOUTUBE_TAGS_MAX_CHARS = 500;
export const YOUTUBE_CATEGORY_PEOPLE_BLOGS = "22";

/** Multiples of 256 KiB, as the resumable-upload protocol requires. */
export const YOUTUBE_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;

/** Exact manage scopes that can create playlists and insert videos. `youtube.upload` is not enough. */
export const YOUTUBE_PLAYLIST_SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
] as const;

export function grantedYoutubeScopes(scope?: string | null): string[] {
  if (!scope) return [];
  return scope.split(/\s+/).filter(Boolean);
}

export function hasYoutubePlaylistScope(scope?: string | null): boolean {
  const granted = new Set(grantedYoutubeScopes(scope));
  return YOUTUBE_PLAYLIST_SCOPES.some((needed) => granted.has(needed));
}

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
export const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
export const YOUTUBE_UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";

export const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

export type YoutubePrivacyStatus = "public" | "unlisted" | "private";

export const YOUTUBE_PRIVACY_STATUSES = ["public", "unlisted", "private"] as const;

/** YouTube rejects a publishAt that is already due; keep a minute of slack for clock skew. */
export const YOUTUBE_PUBLISH_AT_MIN_LEAD_MS = 60_000;

/**
 * Normalizes a datetime to the RFC 3339 UTC string YouTube expects, or
 * undefined when the value is empty or not a real date.
 */
export function parseYoutubePublishAt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

export function youtubePublishAtError(iso: string, now = Date.now()): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "publish_at is not a valid datetime";
  if (date.getTime() < now + YOUTUBE_PUBLISH_AT_MIN_LEAD_MS) {
    return "scheduled publish time must be at least one minute in the future";
  }
  return null;
}

/**
 * YouTube only accepts publishAt on a private video. A scheduled listing is
 * stored private and goes public at that timestamp.
 */
export function youtubeVideoStatus(options: {
  privacyStatus?: YoutubePrivacyStatus;
  publishAt?: string;
  madeForKids?: boolean;
}): {
  privacyStatus: YoutubePrivacyStatus;
  selfDeclaredMadeForKids: boolean;
  publishAt?: string;
} {
  const publishAt = parseYoutubePublishAt(options.publishAt);
  return {
    privacyStatus: publishAt ? "private" : (options.privacyStatus ?? "unlisted"),
    selfDeclaredMadeForKids: Boolean(options.madeForKids),
    ...(publishAt ? { publishAt } : {}),
  };
}

/** Left on rows by older recovery; a restart retries these instead of leaving the message. */
export const INTERRUPTED_YOUTUBE_UPLOAD_ERROR =
  "YouTube upload was interrupted before the process completed";

export interface YoutubeOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface PublicYoutubeChannel {
  id: string;
  channel_id: string;
  title: string;
  custom_url: string | null;
  thumbnail_url: string | null;
  google_account_email: string | null;
  auto_upload: boolean;
  playlist_access: boolean;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  connected_at: Date;
}

/** Stored channel minus the tokens the browser must never see. */
export function publicYoutubeChannel(doc: {
  _id: string;
  channel_id: string;
  title: string;
  custom_url?: string | null;
  thumbnail_url?: string | null;
  google_account_email?: string | null;
  auto_upload: boolean;
  granted_scopes?: string | null;
  error?: string | null;
  created_at: Date;
  updated_at: Date;
  connected_at: Date;
  refresh_token?: string;
  access_token?: string;
  access_token_expires_at?: Date;
}): PublicYoutubeChannel {
  return {
    id: doc._id,
    channel_id: doc.channel_id,
    title: doc.title,
    custom_url: doc.custom_url ?? null,
    thumbnail_url: doc.thumbnail_url ?? null,
    google_account_email: doc.google_account_email ?? null,
    auto_upload: doc.auto_upload,
    playlist_access: hasYoutubePlaylistScope(doc.granted_scopes),
    error: doc.error ?? null,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    connected_at: doc.connected_at,
  };
}

export function youtubeWatchUrl(videoId: string): string {
  return `https://youtu.be/${videoId}`;
}

export function clampYoutubeTitle(value: string, fallback = "Untitled video"): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  const source = trimmed || fallback;
  if (source.length <= YOUTUBE_TITLE_MAX) return source;
  return source.slice(0, YOUTUBE_TITLE_MAX - 1).trimEnd() + "…";
}

/** Series suffix for long-form chapter uploads, e.g. "Book - Chapter 4 | Episode 4". */
export function withYoutubeEpisodeSuffix(title: string, episode: number): string {
  const suffix = ` | Episode ${episode}`;
  const trimmed = title.replace(/\s*[\u2014\u2013]\s*/g, " - ").replace(/\s+/g, " ").trim();
  if (!trimmed) return clampYoutubeTitle(`Episode ${episode}`);
  if (/(?:^|\s)\|\s*Episode\s+\d+\s*$/i.test(trimmed)) return clampYoutubeTitle(trimmed);
  const room = YOUTUBE_TITLE_MAX - suffix.length;
  const head = trimmed.length <= room ? trimmed : `${trimmed.slice(0, Math.max(1, room - 1)).trimEnd()}…`;
  return `${head}${suffix}`;
}

export function clampYoutubeDescription(value: string): string {
  if (value.length <= YOUTUBE_DESCRIPTION_MAX) return value;
  return value.slice(0, YOUTUBE_DESCRIPTION_MAX);
}

/**
 * YouTube counts every character across every tag, plus a comma between them.
 * Tags that would overflow are dropped rather than truncated: a half-tag is
 * not a useful keyword.
 */
export function clampYoutubeTags(tags: readonly string[]): string[] {
  const result: string[] = [];
  let used = 0;
  for (const raw of tags) {
    const tag = raw.replace(/^#/, "").trim();
    if (!tag) continue;
    const extra = tag.length + (result.length > 0 ? 1 : 0);
    if (used + extra > YOUTUBE_TAGS_MAX_CHARS) break;
    result.push(tag);
    used += extra;
  }
  return result;
}

/** Default listing for a long-form chapter video when the reviewer has not written one. */
export function listingForBookSegment(options: {
  bookTitle: string;
  author: string;
  segmentTitle: string;
  /** 1-based episode number shown in the segments table. */
  episode: number;
}): { title: string; description: string; tags: string[] } {
  const bookTitle = options.bookTitle.replace(/\s+/g, " ").trim() || "Untitled";
  const author = options.author.replace(/\s+/g, " ").trim();
  const chapter = options.segmentTitle.replace(/\s+/g, " ").trim() || "Chapter";
  const base = bookTitle === chapter ? bookTitle : `${bookTitle} - ${chapter}`;
  const title = withYoutubeEpisodeSuffix(base, options.episode);
  const credit = author ? `"${bookTitle}" by ${author}` : `"${bookTitle}"`;
  const description = clampYoutubeDescription(
    [chapter, "", `From ${credit}.`, "", "#audiobook #books"].join("\n"),
  );
  const tags = clampYoutubeTags([bookTitle, author, chapter, "audiobook", "books"].filter(Boolean));
  return { title, description, tags };
}

export function contentRangeHeader(offset: number, endExclusive: number, total: number): string {
  return `bytes ${offset}-${endExclusive - 1}/${total}`;
}

export function videoMimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".mkv")) return "video/x-matroska";
  return "video/mp4";
}

/**
 * Redirect URI Google will call.
 *
 * An explicit `GOOGLE_REDIRECT_URI` always wins — it is what was registered in
 * Cloud Console. Otherwise the browser origin that started the flow is used,
 * so `bun run dev` on :7777 and production on :8080 each work without a
 * second environment variable, as long as that exact URI is allow-listed.
 */
export function resolveOAuthRedirectUri(options: {
  envRedirectUri?: string;
  requestOrigin?: string;
}): string {
  const explicit = options.envRedirectUri?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;

  const origin = options.requestOrigin?.trim().replace(/\/+$/, "");
  if (!origin) {
    throw new Error(
      "set GOOGLE_REDIRECT_URI or pass the page origin so the OAuth callback can be built",
    );
  }
  return `${origin}/api/v1/youtube/oauth/callback`;
}

export function buildAuthorizationUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: "code",
    scope: YOUTUBE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
    state: options.state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export function originFromUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function usableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "[object Object]") return null;
  return trimmed;
}

/**
 * Pulls a human-readable line out of a Google / YouTube JSON error body.
 *
 * Token errors use `{ error: "invalid_client", error_description: "..." }`.
 * YouTube Data API errors nest the useful text: `{ error: { message, status } }`.
 * `String(error)` of that nested object is `[object Object]`, which is what
 * used to surface in the Connect-channel toast.
 */
export function googleApiErrorText(body: unknown, fallback: string): string {
  const record = asRecord(body);
  if (!record) return usableText(body) ?? fallback;

  const description = usableText(record.error_description);
  if (description) return description;

  const nested = asRecord(record.error);
  if (nested) {
    const nestedMessage = usableText(nested.message);
    if (nestedMessage) return nestedMessage;
    const first = Array.isArray(nested.errors) ? asRecord(nested.errors[0]) : null;
    const firstMessage = usableText(first?.message);
    if (firstMessage) return firstMessage;
    const status = usableText(nested.status);
    if (status) return status;
  }

  return usableText(record.error) ?? usableText(record.message) ?? fallback;
}

export function playlistIdsForChannels(
  channelIds: readonly string[],
  playlistIds?: Record<string, string> | null,
): Record<string, string> {
  if (!playlistIds) return {};
  const allowed = new Set(channelIds);
  const result: Record<string, string> = {};
  for (const [channelId, playlistId] of Object.entries(playlistIds)) {
    if (!allowed.has(channelId)) continue;
    const trimmed = playlistId.trim();
    if (trimmed) result[channelId] = trimmed;
  }
  return result;
}

function parsePlaylistIds(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key || typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed) result[key] = trimmed;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function intentFromUploadFields(fields: {
  channelIds: string[];
  videoPaths: string[];
  title: string;
  description: string;
  tags: string[];
  privacyStatus: YoutubePrivacyStatus;
  playlistIds?: Record<string, string>;
  publishAt?: string;
}): YoutubeUploadIntent {
  const playlistIds = playlistIdsForChannels(fields.channelIds, fields.playlistIds);
  const publishAt = parseYoutubePublishAt(fields.publishAt);
  return {
    channel_ids: fields.channelIds,
    video_paths: fields.videoPaths,
    title: fields.title,
    description: fields.description,
    tags: fields.tags,
    privacy_status: publishAt ? "private" : fields.privacyStatus,
    ...(Object.keys(playlistIds).length > 0 ? { playlist_ids: playlistIds } : {}),
    ...(publishAt ? { publish_at: publishAt } : {}),
  };
}

export function parseYoutubeUploadIntent(value: unknown): YoutubeUploadIntent | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.channel_ids) || !row.channel_ids.every((id) => typeof id === "string" && id)) {
    return null;
  }
  if (!Array.isArray(row.video_paths) || !row.video_paths.every((path) => typeof path === "string" && path)) {
    return null;
  }
  if (typeof row.title !== "string" || !row.title.trim()) return null;
  if (typeof row.description !== "string") return null;
  if (!Array.isArray(row.tags) || !row.tags.every((tag) => typeof tag === "string")) return null;
  if (!YOUTUBE_PRIVACY_STATUSES.includes(row.privacy_status as YoutubePrivacyStatus)) return null;
  const playlistIds = parsePlaylistIds(row.playlist_ids);
  const publishAt = parseYoutubePublishAt(row.publish_at);
  return {
    channel_ids: row.channel_ids,
    video_paths: row.video_paths,
    title: row.title.trim(),
    description: row.description,
    tags: row.tags,
    privacy_status: (publishAt ? "private" : row.privacy_status) as YoutubePrivacyStatus,
    ...(playlistIds ? { playlist_ids: playlistIds } : {}),
    ...(publishAt ? { publish_at: publishAt } : {}),
  };
}

/**
 * Whether a stored YouTube upload should be handed back to the queue after a
 * restart. Pending/processing work whose owner is gone can resume; a row that
 * recovery already marked failed with the interrupted message can too, so a
 * restart after an older build still retries instead of leaving the error up.
 */
export function shouldResumeYoutubeUpload(options: {
  state?: string | null;
  error?: string | null;
  ownerAlive: boolean;
}): boolean {
  if (options.state === "pending" || options.state === "processing") {
    return !options.ownerAlive;
  }
  return options.state === "failed" && options.error === INTERRUPTED_YOUTUBE_UPLOAD_ERROR;
}

export function youtubeUploadInFlight(state?: string | null): boolean {
  return state === "pending" || state === "processing";
}

export function youtubeUploadSucceeded(
  results?: Array<{ success?: boolean; video_id?: string | null }> | null,
): boolean {
  return Boolean(results?.some((result) => result.success && Boolean(result.video_id)));
}

/** Auto-upload must not start a second copy of a video that is already on YouTube or in flight. */
export function shouldSkipYoutubeAutoUpload(row: {
  youtube_upload_state?: string | null;
  youtube_upload_results?: Array<{ success?: boolean; video_id?: string | null }> | null;
}): boolean {
  return youtubeUploadInFlight(row.youtube_upload_state) || youtubeUploadSucceeded(row.youtube_upload_results);
}

/**
 * Next publish slot for staggered auto-uploads.
 *
 * `cursorMs` is the earliest time still free. If it is in the past, the slot
 * jumps to now plus YouTube's minimum lead. The returned cursor is that slot
 * plus the stagger, so the following video lands later.
 */
export function nextYoutubePublishSlot(options: {
  cursorMs?: number | null;
  now?: number;
  staggerMs: number;
  minLeadMs?: number;
}): { publishAtMs: number; nextCursorMs: number } {
  const now = options.now ?? Date.now();
  const minStart = now + (options.minLeadMs ?? YOUTUBE_PUBLISH_AT_MIN_LEAD_MS);
  const publishAtMs = Math.max(options.cursorMs ?? 0, minStart);
  const staggerMs = Math.max(0, options.staggerMs);
  return { publishAtMs, nextCursorMs: publishAtMs + staggerMs };
}
