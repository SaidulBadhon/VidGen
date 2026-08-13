/**
 * Cross-posting to TikTok, Instagram and YouTube Shorts via upload-post.com.
 * Ported from python-version/app/services/upload_post.py.
 *
 * Docs: https://docs.upload-post.com
 */

import { existsSync } from "node:fs";
import { basename } from "node:path";
import { appConfig } from "../config/settings.ts";
import { logger, errorMessage } from "../utils/logger.ts";

const API_BASE = "https://api.upload-post.com";

export interface CrossPostResult {
  success: boolean;
  error?: string;
  message?: string;
  request_id?: string;
  [key: string]: unknown;
}

export interface YoutubeExtra {
  youtube_title?: string;
  youtube_description?: string;
  tags?: string[];
  privacyStatus?: string;
  containsSyntheticMedia?: boolean;
}

export function isConfigured(): boolean {
  const app = appConfig();
  return Boolean(app.upload_post_api_key && app.upload_post_username && app.upload_post_enabled);
}

export function isAutoUploadEnabled(): boolean {
  return isConfigured() && Boolean(appConfig().upload_post_auto_upload);
}

export function getPlatforms(): string[] {
  return appConfig().upload_post_platforms ?? [];
}

export function getYoutubePrivacyStatus(): string {
  return appConfig().upload_post_youtube_privacy_status ?? "public";
}

/**
 * Uploads one video to the requested platforms.
 *
 * Never throws: publishing failures are reported as data so the task layer can
 * record them against an already-successful video generation.
 */
export async function uploadVideo(options: {
  videoPath: string;
  title: string;
  platforms?: string[];
  youtubeExtra?: YoutubeExtra;
  signal?: AbortSignal;
}): Promise<CrossPostResult> {
  const app = appConfig();

  if (!isConfigured()) {
    logger.warning("Upload-Post is not configured. Skipping cross-post.");
    return { success: false, error: "Upload-Post not configured" };
  }
  if (!existsSync(options.videoPath)) {
    logger.error(`Video file not found: ${options.videoPath}`);
    return { success: false, error: `Video file not found: ${options.videoPath}` };
  }

  const platforms = options.platforms ?? getPlatforms();
  logger.info(`Cross-posting video to ${platforms.join(", ")} via Upload-Post...`);

  try {
    const form = new FormData();
    form.append(
      "video",
      new Blob([await Bun.file(options.videoPath).arrayBuffer()], { type: "video/mp4" }),
      basename(options.videoPath),
    );
    form.append("user", app.upload_post_username);
    form.append("title", options.title.slice(0, 2200));
    for (const platform of platforms) form.append("platform[]", platform);

    const extra = options.youtubeExtra;
    if (extra && platforms.some((platform) => platform.startsWith("youtube"))) {
      if (extra.youtube_title) form.append("youtube_title", extra.youtube_title.slice(0, 100));
      if (extra.youtube_description) form.append("youtube_description", extra.youtube_description);
      for (const tag of extra.tags ?? []) form.append("tags[]", tag);
      form.append("privacyStatus", extra.privacyStatus ?? getYoutubePrivacyStatus());
      // Generated narration and stock footage are synthetic media; declaring it
      // is a YouTube policy requirement, not an option.
      form.append("containsSyntheticMedia", "true");
    }

    const response = await fetch(`${API_BASE}/api/upload`, {
      method: "POST",
      headers: { Authorization: `Apikey ${app.upload_post_api_key}` },
      body: form,
      signal: options.signal ?? AbortSignal.timeout(600_000),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      logger.warning(`Cross-post failed: HTTP ${response.status} ${detail}`);
      return { success: false, error: `HTTP ${response.status}: ${detail}` };
    }

    const result = (await response.json()) as CrossPostResult;
    if (result.success) {
      logger.success(`Video cross-posted successfully! Request ID: ${result.request_id ?? "unknown"}`);
    } else {
      logger.warning(`Cross-post failed: ${result.message ?? result.error ?? "Unknown error"}`);
    }
    return result;
  } catch (error) {
    logger.error(`Failed to cross-post video: ${errorMessage(error)}`);
    return { success: false, error: errorMessage(error) };
  }
}

/** Recent upload history, used by the settings panel to confirm the account. */
export async function getUploadStatus(): Promise<CrossPostResult> {
  const app = appConfig();
  if (!isConfigured()) return { success: false, error: "Upload-Post not configured" };

  try {
    const response = await fetch(
      `${API_BASE}/api/uploadposts/status?${new URLSearchParams({ user: app.upload_post_username })}`,
      {
        headers: { Authorization: `Apikey ${app.upload_post_api_key}` },
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!response.ok) return { success: false, error: `HTTP ${response.status}` };
    return (await response.json()) as CrossPostResult;
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}
