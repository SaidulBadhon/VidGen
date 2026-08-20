/**
 * Google OAuth for YouTube Data API v3.
 *
 * One authorization grant is one YouTube channel: Google's account picker is
 * how a Brand Account is chosen. Connecting again with a different account
 * adds another row, which is how multi-channel upload works.
 */

import { appConfig } from "../../config/settings.ts";
import { errorMessage } from "../../utils/logger.ts";
import {
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  YOUTUBE_API_BASE,
  buildAuthorizationUrl,
  googleApiErrorText,
  resolveOAuthRedirectUri,
  type YoutubeOAuthConfig,
} from "./helpers.ts";

const GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";

export interface GoogleTokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
}

export interface YoutubeChannelProfile {
  channelId: string;
  title: string;
  customUrl: string | null;
  thumbnailUrl: string | null;
  email: string | null;
}

export function googleOAuthCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = appConfig().google_client_id?.trim() || "";
  const clientSecret = appConfig().google_client_secret?.trim() || "";
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function googleOAuthConfig(requestOrigin?: string): YoutubeOAuthConfig | null {
  const credentials = googleOAuthCredentials();
  if (!credentials) return null;

  try {
    const redirectUri = resolveOAuthRedirectUri({
      envRedirectUri: process.env.GOOGLE_REDIRECT_URI,
      requestOrigin,
    });
    return { ...credentials, redirectUri };
  } catch {
    return null;
  }
}

export function isYoutubeOAuthConfigured(): boolean {
  return Boolean(appConfig().google_client_id?.trim() && appConfig().google_client_secret?.trim());
}

export function suggestedRedirectUri(requestOrigin?: string): string {
  try {
    return resolveOAuthRedirectUri({
      envRedirectUri: process.env.GOOGLE_REDIRECT_URI,
      requestOrigin,
    });
  } catch {
    return "";
  }
}

export function authorizationUrl(config: YoutubeOAuthConfig, state: string): string {
  return buildAuthorizationUrl({
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    state,
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function tokenError(body: Record<string, unknown>, fallback: string): Error {
  return new Error(googleApiErrorText(body, fallback));
}

export async function exchangeAuthorizationCode(
  config: YoutubeOAuthConfig,
  code: string,
): Promise<GoogleTokenSet> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await readJson(response);
  if (!response.ok || typeof body.access_token !== "string") {
    throw tokenError(body, `token exchange failed: HTTP ${response.status}`);
  }
  return {
    access_token: body.access_token,
    refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    expires_in: Number(body.expires_in) || 3600,
    token_type: typeof body.token_type === "string" ? body.token_type : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
  };
}

export async function refreshAccessToken(
  config: YoutubeOAuthConfig,
  refreshToken: string,
): Promise<GoogleTokenSet> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await readJson(response);
  if (!response.ok || typeof body.access_token !== "string") {
    throw tokenError(body, `token refresh failed: HTTP ${response.status}`);
  }
  return {
    access_token: body.access_token,
    refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : refreshToken,
    expires_in: Number(body.expires_in) || 3600,
    scope: typeof body.scope === "string" ? body.scope : undefined,
  };
}

export async function fetchGoogleTokenScopes(accessToken: string): Promise<string | null> {
  const response = await fetch(`${GOOGLE_TOKENINFO_URL}?${new URLSearchParams({ access_token: accessToken })}`, {
    signal: AbortSignal.timeout(15_000),
  });
  const body = await readJson(response);
  if (!response.ok) return null;
  return typeof body.scope === "string" && body.scope.trim() ? body.scope : null;
}

export async function fetchYoutubeChannelProfile(accessToken: string): Promise<YoutubeChannelProfile> {
  const [channelResponse, userResponse] = await Promise.all([
    fetch(`${YOUTUBE_API_BASE}/channels?${new URLSearchParams({ part: "snippet", mine: "true" })}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    }),
    fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null),
  ]);

  const channelBody = await readJson(channelResponse);
  if (!channelResponse.ok) {
    throw tokenError(channelBody, `failed to read YouTube channel: HTTP ${channelResponse.status}`);
  }

  const items = Array.isArray(channelBody.items) ? channelBody.items : [];
  const first = items[0] as Record<string, unknown> | undefined;
  if (!first || typeof first.id !== "string") {
    throw new Error(
      "this Google account has no YouTube channel. Create one, or pick a Brand Account in the Google account picker.",
    );
  }

  const snippet = (first.snippet ?? {}) as Record<string, unknown>;
  const thumbnails = (snippet.thumbnails ?? {}) as Record<string, { url?: string }>;
  const thumbnail =
    thumbnails.medium?.url || thumbnails.default?.url || thumbnails.high?.url || null;

  let email: string | null = null;
  if (userResponse?.ok) {
    const user = await readJson(userResponse);
    if (typeof user.email === "string") email = user.email;
  }

  return {
    channelId: first.id,
    title: typeof snippet.title === "string" && snippet.title.trim() ? snippet.title.trim() : first.id,
    customUrl: typeof snippet.customUrl === "string" ? snippet.customUrl : null,
    thumbnailUrl: thumbnail,
    email,
  };
}

export function isInvalidGrant(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("invalid_grant") || message.includes("token has been expired or revoked");
}
