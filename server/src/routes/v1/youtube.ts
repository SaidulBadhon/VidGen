/**
 * YouTube channel OAuth and upload API.
 *
 * Connecting a channel is a top-level browser redirect through Google, not an
 * XHR: the callback lands here, stores the refresh token, and sends the user
 * back to Settings.
 */

import { Hono } from "hono";
import { z } from "zod";
import { existsSync } from "node:fs";
import { badRequest, conflict, notFound, HttpException } from "../../http/errors.ts";
import { getResponse } from "../../utils/misc.ts";
import { logger, errorMessage } from "../../utils/logger.ts";
import {
  CROSS_POST_STATE_PENDING,
  CROSS_POST_STATE_PROCESSING,
  TASK_STATE_COMPLETE,
} from "../../models/const.ts";
import { clampYoutubeTags, listingForBookSegment, parseYoutubePublishAt, playlistIdsForChannels, youtubePublishAtError, youtubeUploadSucceeded, YOUTUBE_PRIVACY_STATUSES } from "../../services/youtube/helpers.ts";
import {
  authorizationUrl,
  exchangeAuthorizationCode,
  fetchYoutubeChannelProfile,
  googleOAuthConfig,
  googleOAuthCredentials,
  isYoutubeOAuthConfigured,
  listYoutubePlaylists,
  createYoutubePlaylist,
  playlistInsertErrorMessage,
  YOUTUBE_PLAYLIST_TITLE_MAX,
  hasYoutubePlaylistScope,
  fetchGoogleTokenScopes,
  originFromUrl,
  suggestedRedirectUri,
} from "../../services/youtube/index.ts";
import {
  getBook,
  getBookSegment,
  getBookShort,
  patchBookSegment,
  patchBookShort,
} from "../../db/books.ts";
import { excerptForSegment } from "../../services/book/publish.ts";
import * as llm from "../../services/llm/index.ts";
import {
  consumeOAuthState,
  createOAuthState,
  deleteYoutubeChannel,
  getYoutubeChannel,
  listPublicYoutubeChannels,
  listYoutubeChannels,
  patchYoutubeChannel,
  upsertYoutubeChannel,
} from "../../db/youtube.ts";
import { getTask } from "../../tasks/state.ts";
import {
  accessTokenFor,
  defaultYoutubePrivacy,
  queueYoutubeUpload,
  resolveChannelsOrThrow,
} from "../../tasks/youtubeUpload.ts";

export const youtubeRouter = new Hono();

const uploadBodySchema = z.object({
  source: z.enum(["task", "book_short", "book_segment"]),
  task_id: z.string().min(1).optional(),
  book_id: z.string().min(1).optional(),
  short_index: z.number().int().min(0).optional(),
  segment_index: z.number().int().min(0).optional(),
  video_index: z.number().int().min(0).optional(),
  channel_ids: z.array(z.string().min(1)).min(1),
  title: z.string().trim().min(1).max(100).optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  privacy_status: z.enum(YOUTUBE_PRIVACY_STATUSES).optional(),
  playlist_ids: z.record(z.string().min(1), z.string()).optional(),
  publish_at: z.string().trim().min(1).optional(),
});

const listingBodySchema = z.object({
  source: z.enum(["task", "book_short", "book_segment"]),
  task_id: z.string().min(1).optional(),
  book_id: z.string().min(1).optional(),
  short_index: z.number().int().min(0).optional(),
  segment_index: z.number().int().min(0).optional(),
});

const createPlaylistBodySchema = z.object({
  title: z.string().trim().min(1).max(YOUTUBE_PLAYLIST_TITLE_MAX),
  description: z.string().optional(),
  privacy_status: z.enum(YOUTUBE_PRIVACY_STATUSES).optional(),
});

function publicListing(metadata: { youtubeTitle: string; description: string; tags: string[] }) {
  return { title: metadata.youtubeTitle, description: metadata.description, tags: metadata.tags };
}

function frontendSettingsPath(query: string): string {
  return `/settings/youtube${query}`;
}

youtubeRouter.get("/youtube/status", async (c) => {
  const origin = c.req.query("origin")?.trim() || originFromUrl(c.req.url);
  const channels = await listYoutubeChannels();
  return c.json(
    getResponse(200, {
      configured: isYoutubeOAuthConfigured(),
      redirect_uri: suggestedRedirectUri(origin || undefined),
      redirect_uri_from_env: Boolean(process.env.GOOGLE_REDIRECT_URI?.trim()),
      channel_count: channels.length,
      privacy_status: await defaultYoutubePrivacy(),
    }),
  );
});

youtubeRouter.get("/youtube/channels", async (c) => {
  const channels = await listPublicYoutubeChannels();
  return c.json(getResponse(200, { channels }));
});

youtubeRouter.get("/youtube/channels/:id/playlists", async (c) => {
  const id = c.req.param("id");
  const channel = await getYoutubeChannel(id);
  if (!channel) throw notFound("YouTube channel not found");
  const accessToken = await accessTokenFor(channel);
  const playlists = await listYoutubePlaylists(accessToken);
  return c.json(getResponse(200, { playlists }));
});

youtubeRouter.post("/youtube/channels/:id/playlists", async (c) => {
  const id = c.req.param("id");
  const body = createPlaylistBodySchema.parse(await c.req.json());
  const channel = await getYoutubeChannel(id);
  if (!channel) throw notFound("YouTube channel not found");
  const accessToken = await accessTokenFor(channel);
  try {
    if (!hasYoutubePlaylistScope(channel.granted_scopes)) {
      const scopes = await fetchGoogleTokenScopes(accessToken);
      if (scopes) {
        await patchYoutubeChannel(id, { granted_scopes: scopes, error: null });
        channel.granted_scopes = scopes;
      }
      if (!hasYoutubePlaylistScope(channel.granted_scopes)) {
        throw badRequest(playlistInsertErrorMessage(new Error("insufficient authentication scopes")));
      }
    }
    const playlist = await createYoutubePlaylist({
      accessToken,
      title: body.title,
      description: body.description ?? "",
      privacyStatus: body.privacy_status ?? "public",
    });
    logger.info(`created YouTube playlist ${playlist.title} (${playlist.id}) on ${channel.title}`);
    return c.json(getResponse(200, { playlist }));
  } catch (error) {
    if (error instanceof HttpException) throw error;
    throw badRequest(playlistInsertErrorMessage(error));
  }
});

youtubeRouter.patch("/youtube/channels/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as { auto_upload?: unknown } | null;
  if (!body || typeof body.auto_upload !== "boolean") {
    throw badRequest("auto_upload must be a boolean");
  }
  const updated = await patchYoutubeChannel(id, { auto_upload: body.auto_upload });
  if (!updated) throw notFound("YouTube channel not found");
  if (body.auto_upload) {
    const { queueUnpublishedAutoYoutubeUploads } = await import("../../tasks/youtubeUpload.ts");
    void queueUnpublishedAutoYoutubeUploads().catch((error) => {
      logger.warning(`YouTube unpublished auto-upload sweep failed: ${errorMessage(error)}`);
    });
  }
  const channels = await listPublicYoutubeChannels();
  return c.json(getResponse(200, { channels }));
});

youtubeRouter.delete("/youtube/channels/:id", async (c) => {
  const id = c.req.param("id");
  const deleted = await deleteYoutubeChannel(id);
  if (!deleted) throw notFound("YouTube channel not found");
  logger.info(`disconnected YouTube channel ${id}`);
  return c.json(getResponse(200, { id }));
});

youtubeRouter.get("/youtube/oauth/start", async (c) => {
  const origin = c.req.query("origin")?.trim() || originFromUrl(c.req.url);
  const config = googleOAuthConfig(origin || undefined);
  if (!config) {
    throw badRequest(
      "YouTube OAuth is not configured. Set Google Client ID and Client Secret in Settings, then save.",
    );
  }

  const state = await createOAuthState(config.redirectUri);
  return c.json(
    getResponse(200, {
      url: authorizationUrl(config, state),
      redirect_uri: config.redirectUri,
    }),
  );
});

youtubeRouter.get("/youtube/oauth/callback", async (c) => {
  const denied = c.req.query("error");
  if (denied) {
    return c.redirect(frontendSettingsPath(`?error=${encodeURIComponent(denied)}`));
  }

  const code = c.req.query("code")?.trim() ?? "";
  const state = c.req.query("state")?.trim() ?? "";
  if (!code || !state) {
    return c.redirect(frontendSettingsPath("?error=missing_code"));
  }

  const stored = await consumeOAuthState(state);
  if (!stored) {
    return c.redirect(frontendSettingsPath("?error=expired_state"));
  }

  const credentials = googleOAuthCredentials();
  if (!credentials) {
    return c.redirect(frontendSettingsPath("?error=not_configured"));
  }

  const config = { ...credentials, redirectUri: stored.redirect_uri };

  try {
    const tokens = await exchangeAuthorizationCode(config, code);
    const profile = await fetchYoutubeChannelProfile(tokens.access_token);
    const grantedScopes = tokens.scope?.trim() || (await fetchGoogleTokenScopes(tokens.access_token)) || "";
    if (!tokens.refresh_token) {
      const existing = (await listYoutubeChannels()).find((channel) => channel.channel_id === profile.channelId);
      if (!existing) {
        return c.redirect(frontendSettingsPath("?error=no_refresh_token"));
      }
    }

    const saved = await upsertYoutubeChannel({
      channel_id: profile.channelId,
      title: profile.title,
      custom_url: profile.customUrl,
      thumbnail_url: profile.thumbnailUrl,
      google_account_email: profile.email,
      refresh_token: tokens.refresh_token || "",
      access_token: tokens.access_token,
      access_token_expires_at: new Date(Date.now() + tokens.expires_in * 1000),
      granted_scopes: grantedScopes || null,
    });
    logger.success(`connected YouTube channel ${saved.title} (${saved.channel_id})`);
    if (!hasYoutubePlaylistScope(grantedScopes)) {
      return c.redirect(frontendSettingsPath("?connected=1&playlist=0"));
    }
    return c.redirect(frontendSettingsPath("?connected=1"));
  } catch (error) {
    const detail = errorMessage(error).replace(/\[object Object\]/g, "").trim() || "callback_failed";
    logger.warning(`YouTube OAuth callback failed: ${detail}`);
    return c.redirect(frontendSettingsPath(`?error=${encodeURIComponent(detail.slice(0, 400))}`));
  }
});

youtubeRouter.post("/youtube/uploads", async (c) => {
  const body = uploadBodySchema.parse(await c.req.json());
  if (!isYoutubeOAuthConfigured()) {
    throw badRequest("YouTube OAuth is not configured");
  }

  const channels = await resolveChannelsOrThrow(body.channel_ids);
  const publishAt = parseYoutubePublishAt(body.publish_at);
  if (body.publish_at && !publishAt) throw badRequest("publish_at is not a valid datetime");
  if (publishAt) {
    const scheduleError = youtubePublishAtError(publishAt);
    if (scheduleError) throw badRequest(scheduleError);
  }
  const privacy = publishAt ? "private" : (body.privacy_status ?? (await defaultYoutubePrivacy()));
  const playlistIds = playlistIdsForChannels(
    channels.map((channel) => channel._id),
    body.playlist_ids,
  );

  if (body.source === "task") {
    const taskId = body.task_id?.trim();
    if (!taskId) throw badRequest("task_id is required");
    const task = await getTask(taskId);
    if (!task) throw notFound("task not found", taskId);
    if (task.state !== TASK_STATE_COMPLETE) throw conflict("task has not finished rendering", taskId);
    if (
      task.youtube_upload_state === CROSS_POST_STATE_PENDING ||
      task.youtube_upload_state === CROSS_POST_STATE_PROCESSING
    ) {
      throw conflict("a YouTube upload is already in progress for this task", taskId);
    }
    if (youtubeUploadSucceeded(task.youtube_upload_results)) {
      throw conflict("this video was already uploaded to YouTube", taskId);
    }

    const videos = (task.videos ?? []).filter((path) => existsSync(path));
    if (videos.length === 0) throw badRequest("this task has no local video file to upload", taskId);
    const selected =
      body.video_index === undefined ? videos : videos[body.video_index] ? [videos[body.video_index]!] : [];
    if (selected.length === 0) throw badRequest("video_index is out of range", taskId);

    const title = body.title || String(task.params?.video_subject || "Untitled video");
    const schedulingError = await queueYoutubeUpload({
      target: { type: "task", taskId },
      videoPaths: selected,
      channelIds: channels.map((channel) => channel._id),
      title,
      description: body.description ?? "",
      tags: body.tags ?? [],
      privacyStatus: privacy,
      playlistIds,
      publishAt,
    });
    if (schedulingError) throw conflict(schedulingError, taskId);

    return c.json(getResponse(200, { task_id: taskId, channels: channels.length, videos: selected.length }));
  }

  const bookId = body.book_id?.trim();
  if (!bookId) throw badRequest("book_id is required");

  if (body.source === "book_segment") {
    const index = body.segment_index;
    if (index === undefined) throw badRequest("segment_index is required");

    const [book, segment] = await Promise.all([getBook(bookId), getBookSegment(bookId, index)]);
    if (!book) throw notFound("book not found", bookId);
    if (!segment) throw notFound("segment not found", bookId);
    if (segment.state !== "complete" || !segment.video_path || !existsSync(segment.video_path)) {
      throw conflict("this segment has no rendered video to upload", bookId);
    }
    if (
      segment.youtube_upload_state === CROSS_POST_STATE_PENDING ||
      segment.youtube_upload_state === CROSS_POST_STATE_PROCESSING
    ) {
      throw conflict("a YouTube upload is already in progress for this segment", bookId);
    }
    if (youtubeUploadSucceeded(segment.youtube_upload_results)) {
      throw conflict("this video was already uploaded to YouTube", bookId);
    }

    const fallback = listingForBookSegment({
      bookTitle: book.title,
      author: book.author,
      segmentTitle: segment.title,
      episode: index + 1,
    });
    const title = body.title || segment.youtube_title || fallback.title;
    const description = body.description ?? segment.description ?? fallback.description;
    const tags = body.tags ?? segment.tags ?? fallback.tags;

    await patchBookSegment(bookId, index, {
      youtube_title: title,
      description,
      tags,
    });

    const schedulingError = await queueYoutubeUpload({
      target: { type: "book_segment", bookId, index },
      videoPaths: [segment.video_path],
      channelIds: channels.map((channel) => channel._id),
      title,
      description,
      tags,
      privacyStatus: privacy,
      playlistIds,
      publishAt,
    });
    if (schedulingError) throw conflict(schedulingError, bookId);

    return c.json(getResponse(200, { book_id: bookId, index, channels: channels.length }));
  }

  const index = body.short_index;
  if (index === undefined) throw badRequest("book_id and short_index are required");

  const short = await getBookShort(bookId, index);
  if (!short) throw notFound("short not found", bookId);
  if (short.state !== "complete" || !short.video_path || !existsSync(short.video_path)) {
    throw conflict("this short has no rendered video to upload", bookId);
  }
  if (
    short.youtube_upload_state === CROSS_POST_STATE_PENDING ||
    short.youtube_upload_state === CROSS_POST_STATE_PROCESSING
  ) {
    throw conflict("a YouTube upload is already in progress for this short", bookId);
  }
  if (youtubeUploadSucceeded(short.youtube_upload_results)) {
    throw conflict("this video was already uploaded to YouTube", bookId);
  }

  const title = body.title || short.youtube_title || short.title;
  const schedulingError = await queueYoutubeUpload({
    target: { type: "book_short", bookId, index },
    videoPaths: [short.video_path],
    channelIds: channels.map((channel) => channel._id),
    title,
    description: body.description ?? short.description ?? "",
    tags: body.tags ?? short.tags ?? [],
    privacyStatus: privacy,
    playlistIds,
    publishAt,
  });
  if (schedulingError) throw conflict(schedulingError, bookId);

  return c.json(getResponse(200, { book_id: bookId, index, channels: channels.length }));
});

youtubeRouter.post("/youtube/listing", async (c) => {
  const body = listingBodySchema.parse(await c.req.json());

  if (body.source === "task") {
    const taskId = body.task_id?.trim();
    if (!taskId) throw badRequest("task_id is required");
    const task = await getTask(taskId);
    if (!task) throw notFound("task not found", taskId);
    const metadata = await llm.generateSocialMetadata({
      videoSubject: String(task.params?.video_subject || ""),
      videoScript: task.script ?? String(task.params?.video_script || ""),
      language: String(task.params?.video_language || ""),
      platform: "youtube_shorts",
    });
    return c.json(
      getResponse(200, {
        title: metadata.title,
        description: metadata.caption,
        tags: clampYoutubeTags(metadata.hashtags),
      }),
    );
  }

  const bookId = body.book_id?.trim();
  if (!bookId) throw badRequest("book_id is required");
  const book = await getBook(bookId);
  if (!book) throw notFound("book not found", bookId);

  if (body.source === "book_segment") {
    const index = body.segment_index;
    if (index === undefined) throw badRequest("segment_index is required");
    const segment = await getBookSegment(bookId, index);
    if (!segment) throw notFound("segment not found", bookId);
    const excerpt = await excerptForSegment(bookId, segment.block_ids);
    const metadata = await llm.generateBookSegmentPublishMetadata({
      bookTitle: book.title,
      author: book.author,
      language: book.language,
      chapterTitle: segment.title,
      excerpt,
      episode: index + 1,
    });
    await patchBookSegment(bookId, index, {
      description: metadata.description,
      tags: metadata.tags,
    });
    const fallback = listingForBookSegment({
      bookTitle: book.title,
      author: book.author,
      segmentTitle: segment.title,
      episode: index + 1,
    });
    return c.json(
      getResponse(200, {
        title: segment.youtube_title || fallback.title,
        description: metadata.description,
        tags: metadata.tags,
      }),
    );
  }

  const index = body.short_index;
  if (index === undefined) throw badRequest("short_index is required");
  const short = await getBookShort(bookId, index);
  if (!short) throw notFound("short not found", bookId);
  const metadata = await llm.generateBookShortPublishMetadata({
    bookTitle: book.title,
    author: book.author,
    language: book.language,
    chapterTitle: short.chapter_title,
    title: short.title,
    hook: short.hook,
    script: short.script,
  });
  await patchBookShort(bookId, index, {
    youtube_title: metadata.youtubeTitle,
    description: metadata.description,
    tags: metadata.tags,
  });
  return c.json(getResponse(200, publicListing(metadata)));
});
