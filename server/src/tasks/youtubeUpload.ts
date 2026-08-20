/**
 * Background uploads to connected YouTube channels.
 *
 * Runs on the same kind of bounded pool as upload-post.com cross-posting: the
 * rendered file is already finished, and a publishing failure must not mark
 * the video itself as failed.
 */

import { existsSync } from "node:fs";
import type { Filter } from "mongodb";
import { appConfig } from "../config/settings.ts";
import {
  CROSS_POST_STATE_COMPLETE,
  CROSS_POST_STATE_FAILED,
  CROSS_POST_STATE_PENDING,
  CROSS_POST_STATE_PROCESSING,
  TASK_STATE_COMPLETE,
  type CrossPostState,
} from "../models/const.ts";
import { logger, errorMessage } from "../utils/logger.ts";
import { sleep } from "../utils/misc.ts";
import * as llm from "../services/llm/index.ts";
import { resolveContentLanguage } from "../config/settings.ts";
import {
  googleOAuthCredentials,
  intentFromUploadFields,
  isInvalidGrant,
  addVideoToYoutubePlaylist,
  listingForBookSegment,
  parseYoutubeUploadIntent,
  playlistInsertErrorMessage,
  hasYoutubePlaylistScope,
  fetchGoogleTokenScopes,
  refreshAccessToken,
  shouldResumeYoutubeUpload,
  shouldSkipYoutubeAutoUpload,
  uploadYoutubeVideo,
  INTERRUPTED_YOUTUBE_UPLOAD_ERROR,
  type YoutubePrivacyStatus,
} from "../services/youtube/index.ts";
import type {
  BookSegmentDocument,
  BookShortDocument,
  TaskDocument,
  YoutubeChannelDocument,
  YoutubeUploadIntent,
  YoutubeUploadResult,
} from "../db/types.ts";
import { getBook, getBookSegment, getBookShort, patchBookSegment, patchBookShort } from "../db/books.ts";
import {
  claimNextYoutubePublishAt,
  getYoutubeChannel,
  getYoutubeChannelsByIds,
  listAutoUploadChannels,
  listYoutubeChannels,
  patchYoutubeChannel,
} from "../db/youtube.ts";
import { parseBookShortRequestId } from "../services/book/shorts.ts";
import { BoundedPool } from "./queue.ts";
import { PROCESS_OWNER_ID, isOwnerAlive } from "./owner.ts";
import { getTask, patchTask } from "./state.ts";
import { bookSegmentsCollection, bookShortsCollection, tasksCollection } from "../db/client.ts";

const STATE_WRITE_ATTEMPTS = 3;
const STATE_RETRY_DELAY_MS = 100;
const TOKEN_EXPIRY_SKEW_MS = 60_000;

const pool = new BoundedPool(2, () => Math.max(1, Number(appConfig().upload_post_max_pending_tasks) || 10));

export interface YoutubeUploadJob {
  /** Where the outcome is stored so the UI can show it next to the video. */
  target:
    | { type: "task"; taskId: string }
    | { type: "book_short"; bookId: string; index: number }
    | { type: "book_segment"; bookId: string; index: number };
  videoPaths: string[];
  channelIds: string[];
  title: string;
  description: string;
  tags: string[];
  privacyStatus: YoutubePrivacyStatus;
  playlistIds?: Record<string, string>;
  publishAt?: string;
}

type YoutubeUploadStateFields = {
  youtube_upload_state?: typeof CROSS_POST_STATE_PENDING | typeof CROSS_POST_STATE_PROCESSING | typeof CROSS_POST_STATE_COMPLETE | typeof CROSS_POST_STATE_FAILED | null;
  youtube_upload_results?: YoutubeUploadResult[] | null;
  youtube_upload_error?: string | null;
  youtube_upload_owner?: string | null;
  youtube_upload_intent?: YoutubeUploadIntent | null;
};

function intentFromJob(job: YoutubeUploadJob): YoutubeUploadIntent {
  return intentFromUploadFields({
    channelIds: job.channelIds,
    videoPaths: job.videoPaths,
    title: job.title,
    description: job.description,
    tags: job.tags,
    privacyStatus: job.privacyStatus,
    playlistIds: job.playlistIds,
    publishAt: job.publishAt,
  });
}

function existingPaths(paths: Array<string | null | undefined>): string[] {
  const found: string[] = [];
  for (const path of paths) {
    if (typeof path === "string" && path.length > 0 && existsSync(path)) found.push(path);
  }
  return found;
}

async function retryWrite<T>(run: () => Promise<T>): Promise<T | null> {
  for (let attempt = 1; attempt <= STATE_WRITE_ATTEMPTS; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= STATE_WRITE_ATTEMPTS) {
        logger.exception("failed to persist YouTube upload state after retries", error);
        return null;
      }
      logger.warning(`retry YouTube upload state update, attempt: ${attempt}, error: ${errorMessage(error)}`);
      await sleep(STATE_RETRY_DELAY_MS);
    }
  }
  return null;
}

async function persistState(job: YoutubeUploadJob, fields: YoutubeUploadStateFields): Promise<boolean | null> {
  return retryWrite(async () => {
    if (job.target.type === "task") {
      return patchTask(job.target.taskId, fields);
    }
    if (job.target.type === "book_short") {
      return patchBookShort(job.target.bookId, job.target.index, fields);
    }
    return patchBookSegment(job.target.bookId, job.target.index, fields);
  });
}

async function recordFailure(job: YoutubeUploadJob, error: unknown, results?: YoutubeUploadResult[]): Promise<void> {
  const updated = await persistState(job, {
    youtube_upload_state: CROSS_POST_STATE_FAILED,
    youtube_upload_results: results && results.length > 0 ? results : null,
    youtube_upload_error: errorMessage(error),
    youtube_upload_owner: job.target.type === "task" ? null : undefined,
  });
  if (updated === false) {
    logger.warning(
      job.target.type === "task"
        ? `discard YouTube upload failure for missing task: ${job.target.taskId}`
        : `discard YouTube upload failure for missing ${job.target.type === "book_short" ? "short" : "segment"}: ${job.target.bookId}/${job.target.index}`,
    );
  }
}

export async function accessTokenFor(channel: YoutubeChannelDocument): Promise<string> {
  const credentials = googleOAuthCredentials();
  if (!credentials) throw new Error("YouTube OAuth is not configured");

  const expiresAt = channel.access_token_expires_at instanceof Date
    ? channel.access_token_expires_at.getTime()
    : new Date(channel.access_token_expires_at).getTime();

  if (channel.access_token && expiresAt - TOKEN_EXPIRY_SKEW_MS > Date.now()) {
    if (!channel.granted_scopes) {
      const scopes = await fetchGoogleTokenScopes(channel.access_token).catch(() => null);
      if (scopes) {
        await patchYoutubeChannel(channel._id, { granted_scopes: scopes });
        channel.granted_scopes = scopes;
      }
    }
    return channel.access_token;
  }

  try {
    const tokens = await refreshAccessToken(
      { ...credentials, redirectUri: "" },
      channel.refresh_token,
    );
    const grantedScopes = tokens.scope?.trim() || channel.granted_scopes || (await fetchGoogleTokenScopes(tokens.access_token).catch(() => null));
    await patchYoutubeChannel(channel._id, {
      access_token: tokens.access_token,
      access_token_expires_at: new Date(Date.now() + tokens.expires_in * 1000),
      refresh_token: tokens.refresh_token,
      granted_scopes: grantedScopes || undefined,
      error: null,
    });
    if (grantedScopes) channel.granted_scopes = grantedScopes;
    return tokens.access_token;
  } catch (error) {
    if (isInvalidGrant(error)) {
      await patchYoutubeChannel(channel._id, {
        error: "reconnect required; Google revoked access for this channel",
      });
    }
    throw error;
  }
}

async function uploadToChannel(
  channel: YoutubeChannelDocument,
  videoPath: string,
  job: YoutubeUploadJob,
): Promise<YoutubeUploadResult> {
  try {
    const accessToken = await accessTokenFor(channel);
    const uploaded = await uploadYoutubeVideo({
      accessToken,
      videoPath,
      metadata: {
        title: job.title,
        description: job.description,
        tags: job.tags,
        privacyStatus: job.privacyStatus,
        publishAt: job.publishAt,
        madeForKids: false,
      },
    });
    const playlistId = job.playlistIds?.[channel._id];
    if (!playlistId) {
      return {
        success: true,
        channel_id: channel.channel_id,
        channel_title: channel.title,
        video_id: uploaded.videoId,
        video_url: uploaded.videoUrl,
      };
    }
    if (!hasYoutubePlaylistScope(channel.granted_scopes)) {
      const message = playlistInsertErrorMessage(new Error("insufficient authentication scopes"));
      logger.warning(`YouTube playlist insert skipped for ${channel.title}: ${message}`);
      return {
        success: true,
        channel_id: channel.channel_id,
        channel_title: channel.title,
        video_id: uploaded.videoId,
        video_url: uploaded.videoUrl,
        playlist_error: message,
      };
    }
    try {
      await addVideoToYoutubePlaylist({
        accessToken,
        playlistId,
        videoId: uploaded.videoId,
      });
      return {
        success: true,
        channel_id: channel.channel_id,
        channel_title: channel.title,
        video_id: uploaded.videoId,
        video_url: uploaded.videoUrl,
        playlist_id: playlistId,
      };
    } catch (error) {
      logger.warning(
        `YouTube playlist insert failed for ${channel.title}: ${playlistInsertErrorMessage(error)}`,
      );
      return {
        success: true,
        channel_id: channel.channel_id,
        channel_title: channel.title,
        video_id: uploaded.videoId,
        video_url: uploaded.videoUrl,
        playlist_error: playlistInsertErrorMessage(error),
      };
    }
  } catch (error) {
    return {
      success: false,
      channel_id: channel.channel_id,
      channel_title: channel.title,
      error: errorMessage(error),
    };
  }
}

async function runYoutubeUpload(job: YoutubeUploadJob): Promise<void> {
  const results: YoutubeUploadResult[] = [];

  try {
    const ownerFields =
      job.target.type === "task"
        ? { youtube_upload_owner: PROCESS_OWNER_ID }
        : {};
    const stateUpdated = await persistState(job, {
      youtube_upload_state: CROSS_POST_STATE_PROCESSING,
      youtube_upload_error: null,
      ...ownerFields,
    });

    if (stateUpdated !== true) {
      if (stateUpdated === false) {
        logger.warning("skip YouTube upload for missing source");
      } else {
        await recordFailure(job, new Error("failed to persist YouTube upload processing state"));
      }
      return;
    }

    const channels = await getYoutubeChannelsByIds(job.channelIds);
    if (channels.length === 0) {
      await recordFailure(job, new Error("none of the selected YouTube channels are still connected"));
      return;
    }

    logger.info(
      `YouTube upload started, channels: ${channels.map((channel) => channel.title).join(", ")}, videos: ${job.videoPaths.length}`,
    );

    for (const videoPath of job.videoPaths) {
      for (const channel of channels) {
        results.push(await uploadToChannel(channel, videoPath, job));
      }
    }

    const failures = results.filter((result) => !result.success);
    const state = failures.length > 0 ? CROSS_POST_STATE_FAILED : CROSS_POST_STATE_COMPLETE;
    const error =
      failures.length > 0
        ? failures.map((result) => result.error ?? "unknown upload error").join("; ")
        : null;

    if (failures.length > 0) {
      logger.warning(`YouTube upload finished with failures, failed: ${failures.length}, total: ${results.length}`);
    } else {
      logger.success(`YouTube upload completed, videos: ${results.length}`);
    }

    const finalUpdate = await persistState(job, {
      youtube_upload_state: state,
      youtube_upload_results: results,
      youtube_upload_error: error,
      youtube_upload_intent: failures.length > 0 ? intentFromJob(job) : null,
      ...(job.target.type === "task" ? { youtube_upload_owner: null } : {}),
    });

    if (finalUpdate === false) {
      logger.warning("discard YouTube upload result for missing source");
    } else if (finalUpdate === null) {
      await recordFailure(job, new Error("failed to persist final YouTube upload result"), results);
    }
  } catch (error) {
    logger.exception("YouTube upload failed", error);
    await recordFailure(job, error, results);
  }
}

export function scheduleYoutubeUpload(job: YoutubeUploadJob): string | null {
  const accepted = pool.submit(() => runYoutubeUpload(job));
  if (accepted) return null;

  const error = "YouTube upload queue is full; publishing was skipped";
  logger.warning("skip YouTube upload because queue is full");
  void persistState(job, {
    youtube_upload_state: CROSS_POST_STATE_FAILED,
    youtube_upload_error: error,
    youtube_upload_intent: intentFromJob(job),
    ...(job.target.type === "task" ? { youtube_upload_owner: null } : {}),
  });
  return error;
}

function submitYoutubeUpload(job: YoutubeUploadJob, wait: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const accepted = pool.submit(async () => {
      await runYoutubeUpload(job);
      if (wait) resolve(null);
    });
    if (!accepted) {
      const error = "YouTube upload queue is full; publishing was skipped";
      logger.warning("skip YouTube upload because queue is full");
      void persistState(job, {
        youtube_upload_state: CROSS_POST_STATE_FAILED,
        youtube_upload_error: error,
        youtube_upload_intent: intentFromJob(job),
        ...(job.target.type === "task" ? { youtube_upload_owner: null } : {}),
      });
      resolve(error);
      return;
    }
    if (!wait) resolve(null);
  });
}

/**
 * Stamps pending state and the restart payload, then hands the job to the pool.
 */
export async function queueYoutubeUpload(
  job: YoutubeUploadJob,
  options?: { wait?: boolean },
): Promise<string | null> {
  const stamped = await persistState(job, {
    youtube_upload_state: CROSS_POST_STATE_PENDING,
    youtube_upload_results: null,
    youtube_upload_error: null,
    youtube_upload_intent: intentFromJob(job),
    ...(job.target.type === "task" ? { youtube_upload_owner: PROCESS_OWNER_ID } : {}),
  });
  if (stamped !== true) {
    return stamped === false ? "the video to upload no longer exists" : "failed to persist YouTube upload state";
  }
  return submitYoutubeUpload(job, Boolean(options?.wait));
}

export async function defaultYoutubePrivacy(): Promise<YoutubePrivacyStatus> {
  return (appConfig().youtube_privacy_status ?? "unlisted") as YoutubePrivacyStatus;
}

async function listingForTask(taskId: string, videoSubject: string, videoScript: string, language: string) {
  const task = await getTask(taskId).catch(() => null);
  const parsed = parseBookShortRequestId(task?.request_id);
  if (parsed) {
    const short = await getBookShort(parsed.bookId, parsed.index).catch(() => null);
    if (short?.youtube_title?.trim() || short?.description?.trim()) {
      return {
        title: short.youtube_title || short.title || videoSubject,
        description: short.description || "",
        tags: short.tags ?? [],
      };
    }
  }

  const metadata = await llm.generateSocialMetadata({
    videoSubject,
    videoScript,
    language,
    platform: "youtube_shorts",
  });
  return {
    title: metadata.title || videoSubject,
    description: metadata.caption,
    tags: metadata.hashtags,
  };
}

function autoScheduleHours(): number {
  const hours = Number(appConfig().youtube_auto_schedule_hours);
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return Math.min(168, Math.round(hours));
}

async function withAutoSchedule(job: YoutubeUploadJob): Promise<YoutubeUploadJob> {
  const hours = autoScheduleHours();
  if (hours <= 0) return job;
  const publishAt = await claimNextYoutubePublishAt(hours * 60 * 60 * 1000);
  return { ...job, privacyStatus: "private", publishAt };
}

async function loadAutoUploadRow(target: YoutubeUploadJob["target"]): Promise<{
  youtube_upload_state?: string | null;
  youtube_upload_results?: YoutubeUploadResult[] | null;
} | null> {
  if (target.type === "task") return getTask(target.taskId);
  if (target.type === "book_short") return getBookShort(target.bookId, target.index);
  return getBookSegment(target.bookId, target.index);
}

async function buildAutoUploadJob(
  source: {
    target: YoutubeUploadJob["target"];
    videoPaths: string[];
    title: string;
    description: string;
    tags: string[];
  },
  channels: YoutubeChannelDocument[],
): Promise<YoutubeUploadJob | null> {
  const videoPaths = existingPaths(source.videoPaths);
  if (videoPaths.length === 0) return null;
  const row = await loadAutoUploadRow(source.target);
  if (!row || shouldSkipYoutubeAutoUpload(row)) return null;
  return {
    target: source.target,
    videoPaths,
    channelIds: channels.map((channel) => channel._id),
    title: source.title,
    description: source.description,
    tags: source.tags,
    privacyStatus: await defaultYoutubePrivacy(),
  };
}

let autoUploadChain: Promise<void> = Promise.resolve();

function enqueueSerialAutoUpload(run: () => Promise<void>): void {
  autoUploadChain = autoUploadChain
    .then(run)
    .catch((error) => {
      logger.warning(`YouTube auto-upload skipped: ${errorMessage(error)}`);
    });
}

async function performAutoUpload(source: {
  target: YoutubeUploadJob["target"];
  videoPaths: string[];
  title: string;
  description: string;
  tags: string[];
}): Promise<void> {
  const channels = await listAutoUploadChannels().catch(() => [] as YoutubeChannelDocument[]);
  if (channels.length === 0) return;
  const job = await buildAutoUploadJob(source, channels);
  if (!job) return;
  const scheduled = await withAutoSchedule(job);
  const error = await queueYoutubeUpload(scheduled, { wait: true });
  if (error) logger.warning(`YouTube auto-upload failed: ${error}`);
}

/**
 * After a finished render, upload to every channel with auto-upload on.
 * No-op when none are connected that way. Uploads run one after another; when
 * stagger hours are set, each video is scheduled that far after the last.
 * Videos that already have a YouTube id are skipped.
 */
export async function scheduleAutoYoutubeUpload(options: {
  taskId: string;
  videoPaths: string[];
  videoSubject: string;
  videoScript: string;
  videoLanguage: string;
}): Promise<string | null> {
  const channels = await listAutoUploadChannels().catch(() => [] as YoutubeChannelDocument[]);
  if (channels.length === 0 || options.videoPaths.length === 0) return null;

  enqueueSerialAutoUpload(async () => {
    const parsed = parseBookShortRequestId((await getTask(options.taskId).catch(() => null))?.request_id);
    const target: YoutubeUploadJob["target"] = parsed
      ? { type: "book_short", bookId: parsed.bookId, index: parsed.index }
      : { type: "task", taskId: options.taskId };
    const row = await loadAutoUploadRow(target);
    if (row && shouldSkipYoutubeAutoUpload(row)) return;

    const listing = await listingForTask(
      options.taskId,
      options.videoSubject,
      options.videoScript,
      resolveContentLanguage(options.videoLanguage),
    );
    await performAutoUpload({
      target,
      videoPaths: options.videoPaths,
      title: listing.title,
      description: listing.description,
      tags: listing.tags,
    });
  });
  return null;
}

export async function scheduleAutoYoutubeUploadForSegment(options: {
  bookId: string;
  index: number;
  videoPath: string;
}): Promise<void> {
  const channels = await listAutoUploadChannels().catch(() => [] as YoutubeChannelDocument[]);
  if (channels.length === 0 || !options.videoPath) return;

  enqueueSerialAutoUpload(async () => {
    const [book, segment] = await Promise.all([
      getBook(options.bookId).catch(() => null),
      getBookSegment(options.bookId, options.index).catch(() => null),
    ]);
    if (!segment || shouldSkipYoutubeAutoUpload(segment)) return;
    const fallback = listingForBookSegment({
      bookTitle: book?.title ?? "",
      author: book?.author ?? "",
      segmentTitle: segment.title,
      episode: options.index + 1,
    });
    await performAutoUpload({
      target: { type: "book_segment", bookId: options.bookId, index: options.index },
      videoPaths: [options.videoPath],
      title: segment.youtube_title || fallback.title,
      description: segment.description ?? fallback.description,
      tags: segment.tags ?? fallback.tags,
    });
  });
}

function isStandaloneVideoTask(task: TaskDocument): boolean {
  const requestId = String(task.request_id ?? "");
  if (requestId.startsWith("book-short:")) return false;
  if (requestId.startsWith("book-shorts-plan:")) return false;
  if (requestId.startsWith("book-ocr:")) return false;
  if (requestId.startsWith("book:")) return false;
  return true;
}

/**
 * Queues every finished video that is not already on YouTube. Used when a
 * channel turns auto-upload on, and once at startup, so a backlog is not left
 * sitting on disk.
 */
export async function queueUnpublishedAutoYoutubeUploads(): Promise<number> {
  const channels = await listAutoUploadChannels().catch(() => [] as YoutubeChannelDocument[]);
  if (channels.length === 0) return 0;

  let queued = 0;

  const shorts = await bookShortsCollection()
    .find({ state: "complete", video_path: { $type: "string" } })
    .sort({ book_id: 1, index: 1 })
    .toArray();
  for (const short of shorts) {
    if (!short.video_path || shouldSkipYoutubeAutoUpload(short)) continue;
    queued += 1;
    enqueueSerialAutoUpload(async () => {
      await performAutoUpload({
        target: { type: "book_short", bookId: short.book_id, index: short.index },
        videoPaths: [short.video_path as string],
        title: short.youtube_title || short.title,
        description: short.description ?? short.hook ?? "",
        tags: short.tags ?? [],
      });
    });
  }

  const segments = await bookSegmentsCollection()
    .find({ state: "complete", video_path: { $type: "string" } })
    .sort({ book_id: 1, index: 1 })
    .toArray();
  for (const segment of segments) {
    if (!segment.video_path || shouldSkipYoutubeAutoUpload(segment)) continue;
    queued += 1;
    const bookId = segment.book_id;
    const index = segment.index;
    const videoPath = segment.video_path;
    enqueueSerialAutoUpload(async () => {
      const book = await getBook(bookId).catch(() => null);
      const fallback = listingForBookSegment({
        bookTitle: book?.title ?? "",
        author: book?.author ?? "",
        segmentTitle: segment.title,
        episode: index + 1,
      });
      await performAutoUpload({
        target: { type: "book_segment", bookId, index },
        videoPaths: [videoPath],
        title: segment.youtube_title || fallback.title,
        description: segment.description ?? fallback.description,
        tags: segment.tags ?? fallback.tags,
      });
    });
  }

  const tasks = await tasksCollection()
    .find({ state: TASK_STATE_COMPLETE })
    .sort({ created_at: 1 })
    .toArray();
  for (const task of tasks) {
    if (!isStandaloneVideoTask(task) || shouldSkipYoutubeAutoUpload(task)) continue;
    const videoPaths = existingPaths(task.videos ?? []);
    if (videoPaths.length === 0) continue;
    queued += 1;
    enqueueSerialAutoUpload(async () => {
      const listing = await listingForTask(
        task._id,
        String(task.params?.video_subject || "Untitled video"),
        task.script ?? String(task.params?.video_script || ""),
        resolveContentLanguage(String(task.params?.video_language || "")),
      );
      await performAutoUpload({
        target: { type: "task", taskId: task._id },
        videoPaths,
        title: listing.title,
        description: listing.description,
        tags: listing.tags,
      });
    });
  }

  if (queued > 0) {
    logger.info(`queued ${queued} unpublished video(s) for staggered YouTube auto-upload`);
  }
  return queued;
}

export async function resolveChannelsOrThrow(ids: string[]): Promise<YoutubeChannelDocument[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) throw new Error("select at least one YouTube channel");
  const channels = await getYoutubeChannelsByIds(unique);
  if (channels.length !== unique.length) {
    throw new Error("one or more selected YouTube channels are no longer connected");
  }
  return channels;
}

const YOUTUBE_IN_FLIGHT_STATES: CrossPostState[] = [CROSS_POST_STATE_PENDING, CROSS_POST_STATE_PROCESSING];

function youtubeResumeQuery<T extends { youtube_upload_state?: CrossPostState | null; youtube_upload_error?: string | null }>(): Filter<T> {
  return {
    $or: [
      { youtube_upload_state: { $in: YOUTUBE_IN_FLIGHT_STATES } },
      {
        youtube_upload_state: CROSS_POST_STATE_FAILED,
        youtube_upload_error: INTERRUPTED_YOUTUBE_UPLOAD_ERROR,
      },
    ],
  } as Filter<T>;
}

async function resolveChannelIds(preferred: string[]): Promise<string[]> {
  const stillConnected = preferred.length > 0 ? await getYoutubeChannelsByIds(preferred) : [];
  if (stillConnected.length > 0) return stillConnected.map((channel) => channel._id);

  const auto = await listAutoUploadChannels().catch(() => [] as YoutubeChannelDocument[]);
  if (auto.length > 0) return auto.map((channel) => channel._id);

  const all = await listYoutubeChannels().catch(() => [] as YoutubeChannelDocument[]);
  return all.map((channel) => channel._id);
}

async function jobForTask(task: TaskDocument): Promise<YoutubeUploadJob | string> {
  const intent = parseYoutubeUploadIntent(task.youtube_upload_intent);
  const videoPaths = existingPaths(intent?.video_paths ?? task.videos ?? []);
  if (videoPaths.length === 0) return "the video file is no longer on disk";

  const channelIds = await resolveChannelIds(intent?.channel_ids ?? []);
  if (channelIds.length === 0) return "no YouTube channels are connected";

  return {
    target: { type: "task", taskId: task._id },
    videoPaths,
    channelIds,
    title: intent?.title || String(task.params?.video_subject || "Untitled video"),
    description: intent?.description ?? "",
    tags: intent?.tags ?? [],
    privacyStatus: intent?.privacy_status ?? (await defaultYoutubePrivacy()),
    playlistIds: intent?.playlist_ids,
    publishAt: intent?.publish_at,
  };
}

async function jobForShort(short: BookShortDocument): Promise<YoutubeUploadJob | string> {
  const intent = parseYoutubeUploadIntent(short.youtube_upload_intent);
  const videoPaths = existingPaths(intent?.video_paths ?? [short.video_path]);
  if (videoPaths.length === 0) return "the video file is no longer on disk";

  const channelIds = await resolveChannelIds(intent?.channel_ids ?? []);
  if (channelIds.length === 0) return "no YouTube channels are connected";

  return {
    target: { type: "book_short", bookId: short.book_id, index: short.index },
    videoPaths,
    channelIds,
    title: intent?.title || short.youtube_title || short.title,
    description: intent?.description ?? short.description ?? "",
    tags: intent?.tags ?? short.tags ?? [],
    privacyStatus: intent?.privacy_status ?? (await defaultYoutubePrivacy()),
    playlistIds: intent?.playlist_ids,
    publishAt: intent?.publish_at,
  };
}

async function jobForSegment(segment: BookSegmentDocument): Promise<YoutubeUploadJob | string> {
  const intent = parseYoutubeUploadIntent(segment.youtube_upload_intent);
  const videoPaths = existingPaths(intent?.video_paths ?? [segment.video_path]);
  if (videoPaths.length === 0) return "the video file is no longer on disk";

  const channelIds = await resolveChannelIds(intent?.channel_ids ?? []);
  if (channelIds.length === 0) return "no YouTube channels are connected";

  const book = await getBook(segment.book_id).catch(() => null);
  const fallback = listingForBookSegment({
    bookTitle: book?.title ?? "",
    author: book?.author ?? "",
    segmentTitle: segment.title,
    episode: segment.index + 1,
  });

  return {
    target: { type: "book_segment", bookId: segment.book_id, index: segment.index },
    videoPaths,
    channelIds,
    title: intent?.title || segment.youtube_title || fallback.title,
    description: intent?.description ?? segment.description ?? fallback.description,
    tags: intent?.tags ?? segment.tags ?? fallback.tags,
    privacyStatus: intent?.privacy_status ?? (await defaultYoutubePrivacy()),
    playlistIds: intent?.playlist_ids,
    publishAt: intent?.publish_at,
  };
}

async function resumeOne(jobOrError: YoutubeUploadJob | string, fail: (error: string) => Promise<void>): Promise<boolean> {
  if (typeof jobOrError === "string") {
    await fail(jobOrError);
    return false;
  }
  const error = await queueYoutubeUpload(jobOrError);
  if (error) {
    await fail(error);
    return false;
  }
  return true;
}

/**
 * Hands YouTube uploads that died with the process back to the pool.
 *
 * Generation cannot resume mid-ffmpeg; a finished video file can. Rows that an
 * older recovery already stamped with the interrupted error are included so the
 * next start retries them instead of leaving that message in the UI.
 */
export async function resumeInterruptedYoutubeUploads(): Promise<number> {
  let resumed = 0;

  const tasks = await tasksCollection().find(youtubeResumeQuery<TaskDocument>()).toArray();
  for (const task of tasks) {
    if (
      !shouldResumeYoutubeUpload({
        state: task.youtube_upload_state,
        error: task.youtube_upload_error,
        ownerAlive: isOwnerAlive(task.youtube_upload_owner),
      })
    ) {
      continue;
    }

    const ok = await resumeOne(await jobForTask(task), async (error) => {
      await patchTask(task._id, {
        youtube_upload_state: CROSS_POST_STATE_FAILED,
        youtube_upload_error: error,
        youtube_upload_owner: null,
      }).catch(() => {});
    });
    if (ok) {
      resumed += 1;
      logger.info(`resumed YouTube upload for task ${task._id}`);
    }
  }

  const shorts = await bookShortsCollection().find(youtubeResumeQuery<BookShortDocument>()).toArray();
  for (const short of shorts) {
    if (
      !shouldResumeYoutubeUpload({
        state: short.youtube_upload_state,
        error: short.youtube_upload_error,
        ownerAlive: false,
      })
    ) {
      continue;
    }

    const ok = await resumeOne(await jobForShort(short), async (error) => {
      await patchBookShort(short.book_id, short.index, {
        youtube_upload_state: CROSS_POST_STATE_FAILED,
        youtube_upload_error: error,
      }).catch(() => {});
    });
    if (ok) {
      resumed += 1;
      logger.info(`resumed YouTube upload for short ${short.book_id}/${short.index}`);
    }
  }

  const segments = await bookSegmentsCollection().find(youtubeResumeQuery<BookSegmentDocument>()).toArray();
  for (const segment of segments) {
    if (
      !shouldResumeYoutubeUpload({
        state: segment.youtube_upload_state,
        error: segment.youtube_upload_error,
        ownerAlive: false,
      })
    ) {
      continue;
    }

    const ok = await resumeOne(await jobForSegment(segment), async (error) => {
      await patchBookSegment(segment.book_id, segment.index, {
        youtube_upload_state: CROSS_POST_STATE_FAILED,
        youtube_upload_error: error,
      }).catch(() => {});
    });
    if (ok) {
      resumed += 1;
      logger.info(`resumed YouTube upload for segment ${segment.book_id}/${segment.index}`);
    }
  }

  return resumed;
}

export { getYoutubeChannel };
