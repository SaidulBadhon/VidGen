/**
 * YouTube OAuth URL building, listing limits, and the public channel shape.
 * No network: Google is not called from these tests.
 */

import { describe, expect, test } from "bun:test";

import {
  YOUTUBE_SCOPES,
  YOUTUBE_TAGS_MAX_CHARS,
  YOUTUBE_TITLE_MAX,
  YOUTUBE_UPLOAD_CHUNK_BYTES,
  buildAuthorizationUrl,
  clampYoutubeDescription,
  clampYoutubeTags,
  clampYoutubeTitle,
  contentRangeHeader,
  intentFromUploadFields,
  listingForBookSegment,
  publicYoutubeChannel,
  resolveOAuthRedirectUri,
  googleApiErrorText,
  playlistIdsForChannels,
  hasYoutubePlaylistScope,
  videoMimeType,
  withYoutubeEpisodeSuffix,
  youtubeWatchUrl,
  parseYoutubeUploadIntent,
  parseYoutubePublishAt,
  youtubePublishAtError,
  youtubeVideoStatus,
  shouldResumeYoutubeUpload,
  shouldSkipYoutubeAutoUpload,
  nextYoutubePublishSlot,
  INTERRUPTED_YOUTUBE_UPLOAD_ERROR,
} from "../src/services/youtube/helpers.ts";
import {
  isSystemYoutubePlaylistId,
  parseCreatedYoutubePlaylist,
  parseYoutubePlaylists,
  clampYoutubePlaylistTitle,
  YOUTUBE_PLAYLIST_TITLE_MAX,
} from "../src/services/youtube/playlists.ts";
import { defaultSettings, settingsSchema } from "../src/config/schema.ts";

describe("YouTube helpers", () => {
  test("builds an offline-access authorization URL with the YouTube scopes", () => {
    const url = new URL(
      buildAuthorizationUrl({
        clientId: "client.apps.googleusercontent.com",
        redirectUri: "http://127.0.0.1:7777/api/v1/youtube/oauth/callback",
        state: "abc123",
      }),
    );

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("client.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:7777/api/v1/youtube/oauth/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent select_account");
    expect(url.searchParams.get("state")).toBe("abc123");
    const scopes = url.searchParams.get("scope") ?? "";
    for (const scope of YOUTUBE_SCOPES) {
      expect(scopes).toContain(scope);
    }
  });

  test("prefers GOOGLE_REDIRECT_URI over the page origin", () => {
    expect(
      resolveOAuthRedirectUri({
        envRedirectUri: "https://videos.example.com/api/v1/youtube/oauth/callback",
        requestOrigin: "http://127.0.0.1:7777",
      }),
    ).toBe("https://videos.example.com/api/v1/youtube/oauth/callback");
  });

  test("builds the callback from the page origin when no env URI is set", () => {
    expect(resolveOAuthRedirectUri({ requestOrigin: "http://127.0.0.1:7777/" })).toBe(
      "http://127.0.0.1:7777/api/v1/youtube/oauth/callback",
    );
  });

  test("refuses to invent a redirect URI with no origin and no env", () => {
    expect(() => resolveOAuthRedirectUri({})).toThrow(/GOOGLE_REDIRECT_URI/);
  });

  test("clamps titles to YouTube's 100-character limit without splitting a word mid-ellipsis", () => {
    expect(clampYoutubeTitle("  Short title  ")).toBe("Short title");
    expect(clampYoutubeTitle("")).toBe("Untitled video");
    const long = "a".repeat(YOUTUBE_TITLE_MAX + 20);
    const clamped = clampYoutubeTitle(long);
    expect(clamped.length).toBe(YOUTUBE_TITLE_MAX);
    expect(clamped.endsWith("…")).toBe(true);
  });

  test("drops tags that would overflow the combined character budget", () => {
    const tags = clampYoutubeTags(["#shorts", "  audiobook  ", "", "a".repeat(YOUTUBE_TAGS_MAX_CHARS)]);
    expect(tags[0]).toBe("shorts");
    expect(tags[1]).toBe("audiobook");
    expect(tags.join(",").length).toBeLessThanOrEqual(YOUTUBE_TAGS_MAX_CHARS);
  });

  test("clamps descriptions", () => {
    expect(clampYoutubeDescription("ok")).toBe("ok");
    expect(clampYoutubeDescription("x".repeat(6000)).length).toBe(5000);
  });

  test("formats a resumable Content-Range header", () => {
    expect(contentRangeHeader(0, YOUTUBE_UPLOAD_CHUNK_BYTES, 20_000_000)).toBe(
      `bytes 0-${YOUTUBE_UPLOAD_CHUNK_BYTES - 1}/20000000`,
    );
    expect(contentRangeHeader(8_388_608, 10_000_000, 10_000_000)).toBe("bytes 8388608-9999999/10000000");
  });

  test("upload chunk size is a multiple of 256 KiB", () => {
    expect(YOUTUBE_UPLOAD_CHUNK_BYTES % (256 * 1024)).toBe(0);
  });

  test("guesses a mime type from the file extension", () => {
    expect(videoMimeType("/tmp/final-1.mp4")).toBe("video/mp4");
    expect(videoMimeType("clip.webm")).toBe("video/webm");
    expect(videoMimeType("clip.MOV")).toBe("video/quicktime");
    expect(videoMimeType("clip.mkv")).toBe("video/x-matroska");
  });

  test("watch URLs are youtu.be links", () => {
    expect(youtubeWatchUrl("dQw4w9wgGcQ")).toBe("https://youtu.be/dQw4w9wgGcQ");
  });

  test("builds a chapter listing that names the book", () => {
    const listing = listingForBookSegment({
      bookTitle: "Me Before You",
      author: "Jojo Moyes",
      segmentTitle: "Chapter 1",
      episode: 1,
    });
    expect(listing.title).toBe("Me Before You - Chapter 1 | Episode 1");
    expect(listing.description).toContain("Me Before You");
    expect(listing.description).toContain("Jojo Moyes");
    expect(listing.tags).toContain("Me Before You");
    expect(listing.tags).toContain("audiobook");
    expect(listing.title.length).toBeLessThanOrEqual(YOUTUBE_TITLE_MAX);
  });

  test("appends a 1-based episode suffix without duplicating it", () => {
    expect(withYoutubeEpisodeSuffix("Me Before You — Chapter 4", 4)).toBe(
      "Me Before You - Chapter 4 | Episode 4",
    );
    expect(withYoutubeEpisodeSuffix("Me Before You - Chapter 4 | Episode 4", 4)).toBe(
      "Me Before You - Chapter 4 | Episode 4",
    );
    const long = "A".repeat(YOUTUBE_TITLE_MAX);
    const suffixed = withYoutubeEpisodeSuffix(long, 12);
    expect(suffixed.endsWith(" | Episode 12")).toBe(true);
    expect(suffixed.length).toBeLessThanOrEqual(YOUTUBE_TITLE_MAX);
  });

  test("public channel projection never includes tokens", () => {
    const publicChannel = publicYoutubeChannel({
      _id: "row-1",
      channel_id: "UCabc",
      title: "Night Reads",
      custom_url: "@nightreads",
      thumbnail_url: "https://example.com/t.jpg",
      google_account_email: "owner@example.com",
      auto_upload: true,
      error: null,
      created_at: new Date("2026-01-01T00:00:00Z"),
      updated_at: new Date("2026-01-02T00:00:00Z"),
      connected_at: new Date("2026-01-01T00:00:00Z"),
      refresh_token: "secret-refresh",
      access_token: "secret-access",
      access_token_expires_at: new Date(),
    });

    expect(publicChannel.id).toBe("row-1");
    expect(publicChannel.channel_id).toBe("UCabc");
    expect(publicChannel.title).toBe("Night Reads");
    expect(publicChannel.playlist_access).toBe(false);
    expect(JSON.stringify(publicChannel)).not.toContain("secret");
    expect("refresh_token" in publicChannel).toBe(false);
    expect("access_token" in publicChannel).toBe(false);
  });

  test("playlist write access requires the manage scope, not only youtube.upload", () => {
    expect(
      hasYoutubePlaylistScope(
        "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
      ),
    ).toBe(false);
    expect(
      hasYoutubePlaylistScope(
        "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube",
      ),
    ).toBe(true);
    expect(hasYoutubePlaylistScope("https://www.googleapis.com/auth/youtube.force-ssl")).toBe(true);
    expect(hasYoutubePlaylistScope("")).toBe(false);
    expect(hasYoutubePlaylistScope(undefined)).toBe(false);
    expect(
      publicYoutubeChannel({
        _id: "row-2",
        channel_id: "UCabc",
        title: "Night Reads",
        auto_upload: false,
        error: null,
        granted_scopes: "https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/userinfo.email",
        created_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-01T00:00:00Z"),
        connected_at: new Date("2026-01-01T00:00:00Z"),
      }).playlist_access,
    ).toBe(true);
  });

  test("unwraps nested YouTube Data API errors instead of [object Object]", () => {
    expect(
      googleApiErrorText(
        {
          error: {
            code: 403,
            message: "YouTube Data API v3 has not been used in project 123 before or it is disabled.",
            status: "PERMISSION_DENIED",
          },
        },
        "fallback",
      ),
    ).toBe("YouTube Data API v3 has not been used in project 123 before or it is disabled.");
  });

  test("prefers error_description on token-endpoint failures", () => {
    expect(
      googleApiErrorText({ error: "invalid_client", error_description: "Unauthorized" }, "fallback"),
    ).toBe("Unauthorized");
  });

  test("does not stringify a nested error object", () => {
    expect(googleApiErrorText({ error: { status: "FAILED_PRECONDITION" } }, "fallback")).toBe("FAILED_PRECONDITION");
    expect(googleApiErrorText({ error: { code: 400 } }, "give up")).toBe("give up");
  });

  test("parses a stored upload intent and rejects incomplete ones", () => {
    const intent = parseYoutubeUploadIntent({
      channel_ids: ["ch-1"],
      video_paths: ["/tmp/final.mp4"],
      title: "  Night Reads  ",
      description: "Chapter 1",
      tags: ["audiobook"],
      privacy_status: "unlisted",
    });
    expect(intent).toEqual({
      channel_ids: ["ch-1"],
      video_paths: ["/tmp/final.mp4"],
      title: "Night Reads",
      description: "Chapter 1",
      tags: ["audiobook"],
      privacy_status: "unlisted",
    });
    expect(parseYoutubeUploadIntent({ title: "nope" })).toBeNull();
    expect(parseYoutubeUploadIntent(null)).toBeNull();
  });

  test("keeps playlist ids on a stored upload intent and ignores ones for other channels", () => {
    const intent = parseYoutubeUploadIntent({
      channel_ids: ["ch-1"],
      video_paths: ["/tmp/final.mp4"],
      title: "Night Reads",
      description: "Chapter 1",
      tags: ["audiobook"],
      privacy_status: "unlisted",
      playlist_ids: { "ch-1": "  PL123  ", "ch-2": "PL999" },
    });
    expect(intent?.playlist_ids).toEqual({ "ch-1": "PL123", "ch-2": "PL999" });
    expect(
      playlistIdsForChannels(["ch-1"], { "ch-1": "PL123", "other": "PLnope", "ch-1b": "" }),
    ).toEqual({ "ch-1": "PL123" });
    expect(
      intentFromUploadFields({
        channelIds: ["ch-1"],
        videoPaths: ["/tmp/final.mp4"],
        title: "Night Reads",
        description: "",
        tags: [],
        privacyStatus: "public",
        playlistIds: { "ch-1": "PL123" },
      }).playlist_ids,
    ).toEqual({ "ch-1": "PL123" });
  });

  test("stores a scheduled publish time and forces the video private", () => {
    const when = "2026-08-20T15:30:00.000Z";
    expect(parseYoutubePublishAt("  2026-08-20T15:30:00Z  ")).toBe(when);
    expect(parseYoutubePublishAt("")).toBeUndefined();
    expect(parseYoutubePublishAt("not a date")).toBeUndefined();
    expect(youtubePublishAtError(when, Date.parse("2026-08-20T15:28:00.000Z"))).toBeNull();
    expect(youtubePublishAtError(when, Date.parse("2026-08-20T15:29:30.000Z"))).toMatch(/future/);
    expect(
      youtubeVideoStatus({ privacyStatus: "public", publishAt: when }),
    ).toEqual({
      privacyStatus: "private",
      selfDeclaredMadeForKids: false,
      publishAt: when,
    });
    expect(youtubeVideoStatus({ privacyStatus: "unlisted" })).toEqual({
      privacyStatus: "unlisted",
      selfDeclaredMadeForKids: false,
    });
    const intent = parseYoutubeUploadIntent({
      channel_ids: ["ch-1"],
      video_paths: ["/tmp/final.mp4"],
      title: "Night Reads",
      description: "",
      tags: [],
      privacy_status: "public",
      publish_at: when,
    });
    expect(intent?.privacy_status).toBe("private");
    expect(intent?.publish_at).toBe(when);
    expect(
      intentFromUploadFields({
        channelIds: ["ch-1"],
        videoPaths: ["/tmp/final.mp4"],
        title: "Night Reads",
        description: "",
        tags: [],
        privacyStatus: "unlisted",
        publishAt: when,
      }).publish_at,
    ).toBe(when);
  });

  test("parses owned playlists and skips Watch Later, Liked, and uploads feeds", () => {
    expect(isSystemYoutubePlaylistId("WL")).toBe(true);
    expect(isSystemYoutubePlaylistId("LL")).toBe(true);
    expect(isSystemYoutubePlaylistId("UUabc")).toBe(true);
    expect(isSystemYoutubePlaylistId("PLabc")).toBe(false);
    const parsed = parseYoutubePlaylists({
      items: [
        { id: "PLabc", snippet: { title: "Audiobook" }, contentDetails: { itemCount: 4 } },
        { id: "WL", snippet: { title: "Watch later" }, contentDetails: { itemCount: 2 } },
        { id: "UUmine", snippet: { title: "Uploads" }, contentDetails: { itemCount: 9 } },
        { id: "PLempty", snippet: { title: "  " } },
      ],
      nextPageToken: "page-2",
    });
    expect(parsed.playlists).toEqual([{ id: "PLabc", title: "Audiobook", item_count: 4 }]);
    expect(parsed.nextPageToken).toBe("page-2");
  });

  test("parses a created playlist and clamps its title", () => {
    expect(clampYoutubePlaylistTitle("  Night Reads  ")).toBe("Night Reads");
    expect(clampYoutubePlaylistTitle("")).toBe("");
    const long = "a".repeat(YOUTUBE_PLAYLIST_TITLE_MAX + 20);
    const clamped = clampYoutubePlaylistTitle(long);
    expect(clamped.length).toBe(YOUTUBE_PLAYLIST_TITLE_MAX);
    expect(clamped.endsWith("…")).toBe(true);
    expect(
      parseCreatedYoutubePlaylist({
        id: "PLnew",
        snippet: { title: "Me Before You" },
        contentDetails: { itemCount: 0 },
      }),
    ).toEqual({ id: "PLnew", title: "Me Before You", item_count: 0 });
    expect(() => parseCreatedYoutubePlaylist({ snippet: { title: "nope" } })).toThrow(/no id/);
  });

  test("resumes pending uploads whose owner is gone, and older interrupted failures", () => {
    expect(
      shouldResumeYoutubeUpload({ state: "pending", error: null, ownerAlive: false }),
    ).toBe(true);
    expect(
      shouldResumeYoutubeUpload({ state: "processing", error: null, ownerAlive: true }),
    ).toBe(false);
    expect(
      shouldResumeYoutubeUpload({
        state: "failed",
        error: INTERRUPTED_YOUTUBE_UPLOAD_ERROR,
        ownerAlive: false,
      }),
    ).toBe(true);
    expect(
      shouldResumeYoutubeUpload({
        state: "failed",
        error: "the video file is no longer on disk",
        ownerAlive: false,
      }),
    ).toBe(false);
    expect(
      shouldResumeYoutubeUpload({ state: "complete", error: null, ownerAlive: false }),
    ).toBe(false);
  });

  test("skips auto-upload when a video is already on YouTube or still uploading", () => {
    expect(shouldSkipYoutubeAutoUpload({ youtube_upload_state: null, youtube_upload_results: null })).toBe(false);
    expect(
      shouldSkipYoutubeAutoUpload({
        youtube_upload_state: "failed",
        youtube_upload_results: [{ success: false, video_id: undefined }],
      }),
    ).toBe(false);
    expect(shouldSkipYoutubeAutoUpload({ youtube_upload_state: "pending" })).toBe(true);
    expect(shouldSkipYoutubeAutoUpload({ youtube_upload_state: "processing" })).toBe(true);
    expect(
      shouldSkipYoutubeAutoUpload({
        youtube_upload_state: "complete",
        youtube_upload_results: [{ success: true, video_id: "abc" }],
      }),
    ).toBe(true);
  });

  test("staggers the next publish slot six hours after the cursor", () => {
    const now = Date.parse("2026-08-19T12:00:00.000Z");
    const sixHours = 6 * 60 * 60 * 1000;
    const first = nextYoutubePublishSlot({ cursorMs: null, now, staggerMs: sixHours, minLeadMs: 60_000 });
    expect(first.publishAtMs).toBe(now + 60_000);
    expect(first.nextCursorMs).toBe(first.publishAtMs + sixHours);

    const second = nextYoutubePublishSlot({
      cursorMs: first.nextCursorMs,
      now: now + 5_000,
      staggerMs: sixHours,
      minLeadMs: 60_000,
    });
    expect(second.publishAtMs).toBe(first.nextCursorMs);
    expect(second.nextCursorMs - second.publishAtMs).toBe(sixHours);
  });
});

describe("YouTube settings schema", () => {
  test("defaults privacy to unlisted and empty Google credentials", () => {
    const settings = defaultSettings();
    expect(settings.app.google_client_id).toBe("");
    expect(settings.app.google_client_secret).toBe("");
    expect(settings.app.youtube_privacy_status).toBe("unlisted");
    expect(settings.app.youtube_auto_schedule_hours).toBe(6);
  });

  test("accepts a privacy status on an otherwise empty document", () => {
    const parsed = settingsSchema.parse({ app: { youtube_privacy_status: "private" } });
    expect(parsed.app.youtube_privacy_status).toBe("private");
    expect(parsed.app.max_queued_tasks).toBe(100);
  });
});
