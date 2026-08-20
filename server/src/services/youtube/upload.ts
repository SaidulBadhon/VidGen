/**
 * YouTube Data API v3 resumable upload.
 *
 * A video is started with a metadata POST, then the file is PUT in 8 MiB
 * chunks. Chunked transfer is what keeps a long book chapter from depending on
 * a single TCP connection staying up for the whole file.
 */

import { existsSync } from "node:fs";
import {
  YOUTUBE_CATEGORY_PEOPLE_BLOGS,
  YOUTUBE_UPLOAD_CHUNK_BYTES,
  YOUTUBE_UPLOAD_URL,
  clampYoutubeDescription,
  clampYoutubeTags,
  clampYoutubeTitle,
  contentRangeHeader,
  googleApiErrorText,
  videoMimeType,
  youtubeVideoStatus,
  youtubeWatchUrl,
  type YoutubePrivacyStatus,
} from "./helpers.ts";

export interface YoutubeVideoMetadata {
  title: string;
  description?: string;
  tags?: string[];
  privacyStatus?: YoutubePrivacyStatus;
  publishAt?: string;
  madeForKids?: boolean;
}

export interface YoutubeUploadSuccess {
  videoId: string;
  videoUrl: string;
  title: string;
}

function snippetAndStatus(metadata: YoutubeVideoMetadata): Record<string, unknown> {
  return {
    snippet: {
      title: clampYoutubeTitle(metadata.title),
      description: clampYoutubeDescription(metadata.description ?? ""),
      tags: clampYoutubeTags(metadata.tags ?? []),
      categoryId: YOUTUBE_CATEGORY_PEOPLE_BLOGS,
    },
    status: youtubeVideoStatus({
      privacyStatus: metadata.privacyStatus,
      publishAt: metadata.publishAt,
      madeForKids: metadata.madeForKids,
    }),
  };
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

/**
 * Uploads one local file and returns the YouTube video id.
 *
 * The access token is only sent on the initial session request; the Location
 * URL Google returns is already authorized for the subsequent PUTs.
 */
export async function uploadYoutubeVideo(options: {
  accessToken: string;
  videoPath: string;
  metadata: YoutubeVideoMetadata;
  signal?: AbortSignal;
}): Promise<YoutubeUploadSuccess> {
  if (!existsSync(options.videoPath)) {
    throw new Error(`video file not found: ${options.videoPath}`);
  }

  const file = Bun.file(options.videoPath);
  const size = file.size;
  if (!size) throw new Error("video file is empty");

  const mime = videoMimeType(options.videoPath);
  const init = await fetch(
    `${YOUTUBE_UPLOAD_URL}?${new URLSearchParams({ uploadType: "resumable", part: "snippet,status" })}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mime,
        "X-Upload-Content-Length": String(size),
      },
      body: JSON.stringify(snippetAndStatus(options.metadata)),
      signal: options.signal ?? AbortSignal.timeout(60_000),
    },
  );

  if (!init.ok) {
    throw new Error(`YouTube upload session failed: ${await readError(init)}`);
  }

  const uploadUrl = init.headers.get("Location");
  if (!uploadUrl) throw new Error("YouTube did not return an upload URL");

  let offset = 0;
  let lastBody: Record<string, unknown> | null = null;

  while (offset < size) {
    if (options.signal?.aborted) throw new Error("YouTube upload was cancelled");

    const end = Math.min(offset + YOUTUBE_UPLOAD_CHUNK_BYTES, size);
    const chunk = file.slice(offset, end);
    const put = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(end - offset),
        "Content-Type": mime,
        "Content-Range": contentRangeHeader(offset, end, size),
      },
      body: chunk,
      signal: options.signal ?? AbortSignal.timeout(300_000),
    });

    if (end < size) {
      if (put.status !== 308) {
        throw new Error(`YouTube chunk upload failed: ${await readError(put)}`);
      }
      const range = put.headers.get("Range");
      const match = range?.match(/bytes=0-(\d+)/);
      offset = match ? Number(match[1]) + 1 : end;
      continue;
    }

    if (!put.ok) {
      throw new Error(`YouTube upload failed: ${await readError(put)}`);
    }
    lastBody = (await put.json().catch(() => null)) as Record<string, unknown> | null;
    offset = end;
  }

  const videoId = typeof lastBody?.id === "string" ? lastBody.id : "";
  if (!videoId) throw new Error("YouTube accepted the file but returned no video id");

  const snippet = (lastBody?.snippet ?? {}) as Record<string, unknown>;
  return {
    videoId,
    videoUrl: youtubeWatchUrl(videoId),
    title: typeof snippet.title === "string" ? snippet.title : clampYoutubeTitle(options.metadata.title),
  };
}
