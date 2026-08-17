/**
 * Script, search-term and social-metadata endpoints.
 * Ported from python-version/app/controllers/v1/llm.py.
 */

import { Hono } from "hono";
import { resolveContentLanguage } from "../../config/settings.ts";
import * as llm from "../../services/llm/index.ts";
import { buildScriptPrompt } from "../../services/llm/prompts.ts";
import {
  videoScriptRequestSchema,
  videoSocialMetadataRequestSchema,
  videoTermsRequestSchema,
} from "../../models/schema.ts";
import { getResponse } from "../../utils/misc.ts";

export const llmRouter = new Hono();

llmRouter.post("/scripts", async (c) => {
  const body = videoScriptRequestSchema.parse(await c.req.json());
  const videoScript = await llm.generateScript({
    videoSubject: body.video_subject,
    language: body.video_language,
    paragraphNumber: body.paragraph_number,
    videoScriptPrompt: body.video_script_prompt,
    customSystemPrompt: body.custom_system_prompt,
  });
  return c.json(getResponse(200, { video_script: videoScript }));
});

llmRouter.post("/terms", async (c) => {
  const body = videoTermsRequestSchema.parse(await c.req.json());
  const videoTerms = await llm.generateTerms({
    videoSubject: body.video_subject,
    videoScript: body.video_script,
    amount: body.amount,
    matchScriptOrder: body.match_materials_to_script,
  });
  return c.json(getResponse(200, { video_terms: videoTerms }));
});

llmRouter.post("/social-metadata", async (c) => {
  const body = videoSocialMetadataRequestSchema.parse(await c.req.json());
  const metadata = await llm.generateSocialMetadata({
    videoSubject: body.video_subject,
    videoScript: body.video_script,
    language: body.language,
    platform: body.platform,
  });
  return c.json(getResponse(200, metadata));
});

/**
 * Renders the exact prompt a generation would send.
 * The UI shows this so advanced users can see what their system prompt does.
 */
llmRouter.post("/scripts/preview-prompt", async (c) => {
  const body = videoScriptRequestSchema.parse(await c.req.json());
  return c.json(
    getResponse(200, {
      prompt: buildScriptPrompt({
        videoSubject: body.video_subject,
        language: resolveContentLanguage(body.video_language),
        paragraphNumber: body.paragraph_number,
        videoScriptPrompt: body.video_script_prompt,
        customSystemPrompt: body.custom_system_prompt,
      }),
    }),
  );
});

/** Minimal round-trip against the configured provider. */
llmRouter.post("/llm/test-connection", async (c) => {
  const result = await llm.testConnection();
  return c.json(getResponse(200, result));
});
