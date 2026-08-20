/**
 * Channel playlists: list them for the upload picker, then insert the new video.
 */

import { YOUTUBE_API_BASE, googleApiErrorText, type YoutubePrivacyStatus } from "./helpers.ts";

export interface YoutubePlaylist {
  id: string;
  title: string;
  item_count: number;
}

/** YouTube playlist titles are capped at 150 characters. */
export const YOUTUBE_PLAYLIST_TITLE_MAX = 150;

const MAX_PLAYLIST_PAGES = 10;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return `HTTP ${response.status}`;
  try {
    return googleApiErrorText(JSON.parse(text), `HTTP ${response.status}`);
  } catch {
    return text.slice(0, 300);
  }
}

/** Watch Later, Liked, Favorites, and the implicit uploads feed. */
export function isSystemYoutubePlaylistId(id: string): boolean {
  const upper = id.toUpperCase();
  return upper === "WL" || upper === "LL" || upper === "FL" || upper.startsWith("UU");
}

export function parseYoutubePlaylists(body: unknown): {
  playlists: YoutubePlaylist[];
  nextPageToken: string | null;
} {
  const record = asRecord(body);
  const items = Array.isArray(record?.items) ? record.items : [];
  const playlists: YoutubePlaylist[] = [];
  for (const item of items) {
    const row = asRecord(item);
    if (!row || typeof row.id !== "string" || !row.id.trim()) continue;
    if (isSystemYoutubePlaylistId(row.id)) continue;
    const snippet = asRecord(row.snippet);
    const title = typeof snippet?.title === "string" ? snippet.title.trim() : "";
    if (!title) continue;
    const details = asRecord(row.contentDetails);
    const rawCount = details?.itemCount;
    const itemCount = typeof rawCount === "number" ? rawCount : Number(rawCount) || 0;
    playlists.push({ id: row.id, title, item_count: itemCount });
  }
  const next = typeof record?.nextPageToken === "string" && record.nextPageToken ? record.nextPageToken : null;
  return { playlists, nextPageToken: next };
}

export async function listYoutubePlaylists(accessToken: string, signal?: AbortSignal): Promise<YoutubePlaylist[]> {
  const collected: YoutubePlaylist[] = [];
  let pageToken = "";
  for (let page = 0; page < MAX_PLAYLIST_PAGES; page++) {
    const params = new URLSearchParams({
      part: "snippet,contentDetails",
      mine: "true",
      maxResults: "50",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetch(`${YOUTUBE_API_BASE}/playlists?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    const body = await readJson(response);
    if (!response.ok) {
      throw new Error(`failed to list YouTube playlists: ${googleApiErrorText(body, `HTTP ${response.status}`)}`);
    }
    const parsed = parseYoutubePlaylists(body);
    collected.push(...parsed.playlists);
    if (!parsed.nextPageToken) break;
    pageToken = parsed.nextPageToken;
  }
  return collected;
}

export function playlistInsertErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/insufficient|scope/i.test(message)) {
    return "reconnect this channel in Settings to grant playlist access, then upload again";
  }
  return message;
}

export function clampYoutubePlaylistTitle(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  if (trimmed.length <= YOUTUBE_PLAYLIST_TITLE_MAX) return trimmed;
  return trimmed.slice(0, YOUTUBE_PLAYLIST_TITLE_MAX - 1).trimEnd() + "…";
}

export function parseCreatedYoutubePlaylist(body: unknown): YoutubePlaylist {
  const record = asRecord(body);
  const id = typeof record?.id === "string" ? record.id.trim() : "";
  const snippet = asRecord(record?.snippet);
  const title = typeof snippet?.title === "string" ? snippet.title.trim() : "";
  if (!id || !title) {
    throw new Error("YouTube accepted the playlist but returned no id");
  }
  const details = asRecord(record?.contentDetails);
  const rawCount = details?.itemCount;
  const itemCount = typeof rawCount === "number" ? rawCount : Number(rawCount) || 0;
  return { id, title, item_count: itemCount };
}

export async function createYoutubePlaylist(options: {
  accessToken: string;
  title: string;
  description?: string;
  privacyStatus?: YoutubePrivacyStatus;
  signal?: AbortSignal;
}): Promise<YoutubePlaylist> {
  const title = clampYoutubePlaylistTitle(options.title);
  if (!title) throw new Error("playlist title is required");

  const response = await fetch(`${YOUTUBE_API_BASE}/playlists?${new URLSearchParams({ part: "snippet,status" })}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({
      snippet: {
        title,
        description: options.description ?? "",
      },
      status: {
        privacyStatus: options.privacyStatus ?? "public",
      },
    }),
    signal: options.signal ?? AbortSignal.timeout(30_000),
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(`failed to create YouTube playlist: ${googleApiErrorText(body, `HTTP ${response.status}`)}`);
  }
  return parseCreatedYoutubePlaylist(body);
}

export async function addVideoToYoutubePlaylist(options: {
  accessToken: string;
  playlistId: string;
  videoId: string;
  signal?: AbortSignal;
}): Promise<void> {
  const response = await fetch(`${YOUTUBE_API_BASE}/playlistItems?${new URLSearchParams({ part: "snippet" })}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({
      snippet: {
        playlistId: options.playlistId,
        resourceId: {
          kind: "youtube#video",
          videoId: options.videoId,
        },
      },
    }),
    signal: options.signal ?? AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`failed to add video to playlist: ${await readError(response)}`);
  }
}
