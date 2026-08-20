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
  envManagedSettingPaths,
  redactSettings,
  stripPlaceholderSecrets,
  updateSettings,
  type PartialSettings,
} from "../../config/settings.ts";
import { SUPPORTED_VIDEO_CODECS } from "../../config/schema.ts";
import { LLM_PROVIDER_REGISTRY } from "../../config/llmProviders.ts";
import { hyperframesAvailable } from "../../services/video/hyperframes.ts";
import { listTemplates, type TemplatePart } from "../../services/video/templates.ts";
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
 *
 * `env_managed_fields` lists the settings the environment currently supplies.
 * It only changes on restart, so it belongs with the rest of the static
 * metadata rather than in the settings payload itself.
 *
 * `book_templates` is the one entry that is not a constant: it depends on
 * whether this host can actually run a HyperFrames render, which is a probe of
 * Node and Chrome rather than a compiled-in list — hence the async handler.
 * An incapable host serves `[]`, the UI hides the template control outright,
 * and the book form behaves exactly as it did before templates existed. That is
 * the point: never offer a choice the renderer would have to ignore.
 */
settingsRouter.get("/settings/metadata", async (c) => {
  return c.json(
    getResponse(200, {
      env_managed_fields: envManagedSettingPaths(),
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
      book_templates: await listBookTemplates(),
    }),
  );
});

/** One dropdown entry per book-video template, in the payload's snake_case. */
interface BookTemplateMetadata {
  id: string;
  label: string;
  description: string;
  parts: TemplatePart[];
  default_accent: string;
}

/**
 * The book-video templates this host may offer, or `[]` when it cannot render
 * one at all.
 *
 * Only the fields a dropdown draws itself from cross the wire. The durations
 * and the encode profile in the manifest are the renderer's business, and
 * publishing them here would turn an internal tuning knob into a client
 * contract we would then have to keep.
 *
 * Deliberately un-caught: `listTemplates()` already drops and logs a template
 * that lies about itself rather than throwing, so a `try` here could only
 * swallow a genuine fault — and an empty dropdown is precisely how this
 * endpoint says "no templates", which would make that fault invisible.
 */
async function listBookTemplates(): Promise<BookTemplateMetadata[]> {
  if (!(await hyperframesAvailable())) return [];

  return listTemplates().map((template) => ({
    id: template.id,
    label: template.label,
    description: template.description,
    // Frozen by the registry, and only ever serialised from here.
    parts: template.parts,
    default_accent: template.defaultAccent,
  }));
}

function listFonts(): string[] {
  try {
    return readdirSync(fontDir())
      .filter((name) => /\.(ttf|ttc|otf)$/i.test(name))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
