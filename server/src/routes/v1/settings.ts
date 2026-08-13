/**
 * Settings API.
 *
 * Replaces the Streamlit basic-configuration panel that wrote config.toml.
 * Secrets never leave the server: reads return a placeholder and writes that
 * still contain the placeholder are dropped rather than persisted.
 */

import { Hono } from "hono";
import { readdirSync } from "node:fs";
import {
  redactSettings,
  stripPlaceholderSecrets,
  updateSettings,
  type PartialSettings,
} from "../../config/settings.ts";
import { SUPPORTED_VIDEO_CODECS } from "../../config/schema.ts";
import { LLM_PROVIDER_REGISTRY } from "../../config/llmProviders.ts";
import { fontDir } from "../../utils/paths.ts";
import { getResponse } from "../../utils/misc.ts";
import { badRequest } from "../../http/errors.ts";

export const settingsRouter = new Hono();

settingsRouter.get("/settings", (c) => c.json(getResponse(200, redactSettings())));

settingsRouter.post("/settings", async (c) => {
  const body = (await c.req.json().catch(() => null)) as PartialSettings | null;
  if (!body || typeof body !== "object") {
    throw badRequest("request body must be a settings object");
  }

  const updated = await updateSettings(stripPlaceholderSecrets(body));
  return c.json(getResponse(200, redactSettings(updated)));
});

/**
 * Static metadata the settings UI needs: provider list, encoder whitelist, and
 * the fonts actually present in resource/fonts.
 */
settingsRouter.get("/settings/metadata", (c) => {
  return c.json(
    getResponse(200, {
      llm_providers: LLM_PROVIDER_REGISTRY.map((provider) => ({
        provider_id: provider.providerId,
        label: provider.defaultLabel,
        api_key_url: provider.apiKeyUrl,
        default_model: provider.defaultModel,
        default_base_url: provider.defaultBaseUrl,
        requires_api_key: provider.requiresApiKey,
        requires_base_url: provider.requiresBaseUrl,
        show_api_key: provider.showApiKey,
        show_base_url: provider.showBaseUrl,
      })),
      video_codecs: ["", ...SUPPORTED_VIDEO_CODECS],
      fonts: listFonts(),
      subtitle_positions: ["top", "center", "bottom", "custom"],
      video_aspects: ["16:9", "9:16", "1:1"],
      video_sources: ["pexels", "pixabay", "coverr", "local"],
      transition_modes: [null, "Shuffle", "FadeIn", "FadeOut", "SlideIn", "SlideOut", "ZoomIn", "ZoomOut"],
    }),
  );
});

function listFonts(): string[] {
  try {
    return readdirSync(fontDir())
      .filter((name) => /\.(ttf|ttc|otf)$/i.test(name))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
