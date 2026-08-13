/**
 * Prompt construction for script, search terms and social metadata.
 * Ported from python-version/app/services/llm.py.
 */

import { logger } from "../../utils/logger.ts";

export const MIN_SCRIPT_PARAGRAPH_NUMBER = 1;
export const MAX_SCRIPT_PARAGRAPH_NUMBER = 10;
export const MAX_SCRIPT_PROMPT_LENGTH = 2000;
export const MAX_SCRIPT_SYSTEM_PROMPT_LENGTH = 8000;

export const DEFAULT_SCRIPT_SYSTEM_PROMPT = `# Role: Video Script Generator

## Goals:
Generate a script for a video, depending on the subject of the video.

## Constrains:
1. the script is to be returned as a string with the specified number of paragraphs.
2. do not under any circumstance reference this prompt in your response.
3. get straight to the point, don't start with unnecessary things like, "welcome to this video".
4. you must not include any type of markdown or formatting in the script, never use a title.
5. only return the raw content of the script.
6. do not include "voiceover", "narrator" or similar indicators of what should be spoken at the beginning of each paragraph or line.
7. you must not mention the prompt, or anything about the script itself. also, never talk about the amount of paragraphs or lines. just write the script.
8. respond in the same language as the video subject.`;

export function limitScriptText(text: string | undefined, maxLength: number, fieldName: string): string {
  const value = (text ?? "").trim();
  if (value.length <= maxLength) return value;

  // The API validates these lengths too; this guard protects direct internal
  // callers from sending an oversized prompt and inflating token cost.
  logger.warning(`${fieldName} is too long and will be truncated to ${maxLength} characters.`);
  return value.slice(0, maxLength);
}

export function normalizeScriptParagraphNumber(paragraphNumber: number | undefined): number {
  const value = Number(paragraphNumber || MIN_SCRIPT_PARAGRAPH_NUMBER);
  if (!Number.isFinite(value)) return MIN_SCRIPT_PARAGRAPH_NUMBER;

  const rounded = Math.trunc(value);
  if (rounded < MIN_SCRIPT_PARAGRAPH_NUMBER || rounded > MAX_SCRIPT_PARAGRAPH_NUMBER) {
    logger.warning(`script paragraph_number is out of range and will be clamped: ${rounded}`);
    return Math.max(MIN_SCRIPT_PARAGRAPH_NUMBER, Math.min(rounded, MAX_SCRIPT_PARAGRAPH_NUMBER));
  }
  return rounded;
}

/**
 * Builds the script prompt.
 *
 * The generation rules and the per-run context are concatenated separately so
 * that overriding the system prompt cannot drop the subject, language or
 * paragraph count that every run needs.
 */
export function buildScriptPrompt(options: {
  videoSubject: string;
  language?: string;
  paragraphNumber?: number;
  videoScriptPrompt?: string;
  customSystemPrompt?: string;
}): string {
  const paragraphNumber = normalizeScriptParagraphNumber(options.paragraphNumber);
  const videoScriptPrompt = limitScriptText(
    options.videoScriptPrompt,
    MAX_SCRIPT_PROMPT_LENGTH,
    "video_script_prompt",
  );
  const customSystemPrompt = limitScriptText(
    options.customSystemPrompt,
    MAX_SCRIPT_SYSTEM_PROMPT_LENGTH,
    "custom_system_prompt",
  );

  let prompt = customSystemPrompt || DEFAULT_SCRIPT_SYSTEM_PROMPT;
  prompt += `\n\n# Initialization:\n- video subject: ${options.videoSubject}\n- number of paragraphs: ${paragraphNumber}`;
  if (options.language) prompt += `\n- language: ${options.language}`;
  if (videoScriptPrompt) prompt += `\n\n# Additional User Requirements:\n${videoScriptPrompt}`;

  return prompt;
}

export function buildTermsPrompt(options: {
  videoSubject: string;
  videoScript: string;
  amount?: number;
  matchScriptOrder?: boolean;
}): string {
  const amount = Math.max(1, Number(options.amount ?? 5));
  const matchScriptOrder = Boolean(options.matchScriptOrder);

  let goal: string;
  let orderingRule: string;
  let outputExample: string;

  if (matchScriptOrder) {
    goal =
      `Generate ${amount} chronological stock-video search terms that follow ` +
      "the order of topics in the video script.";
    orderingRule =
      "6. keep the terms in the same order as the script narration; " +
      "earlier terms must describe earlier visual moments.";
    // The example length tracks `amount` so the model is not anchored to a
    // fixed count and under-generates terms for a long script.
    const exampleTerms = [
      "opening visual topic",
      ...Array.from({ length: Math.max(amount - 2, 0) }, (_, index) => `script visual topic ${index + 2}`),
      "final visual topic",
    ].slice(0, amount);
    outputExample = JSON.stringify(exampleTerms);
  } else {
    goal = `Generate ${amount} search terms for stock videos, depending on the subject of a video.`;
    orderingRule = "";
    outputExample =
      '["search term 1", "search term 2", "search term 3","search term 4", "search term 5"]';
  }

  return `# Role: Video Search Terms Generator

## Goals:
${goal}

## Constrains:
1. the search terms are to be returned as a json-array of strings.
2. each search term should consist of 1-3 words, always add the main subject of the video.
3. you must only return the json-array of strings. you must not return anything else. you must not return the script.
4. the search terms must be related to the subject of the video.
5. reply with english search terms only.
${orderingRule}

## Output Example:
${outputExample}

## Context:
### Video Subject
${options.videoSubject}

### Video Script
${options.videoScript}

Please note that you must use English for generating video search terms; Chinese is not accepted.`;
}

// ---------------------------------------------------------------------------
// Social publishing metadata
// ---------------------------------------------------------------------------

export interface SocialPlatformSpec {
  titleMax: number;
  captionMax: number;
  hashtagCount: number;
}

/** Conservative per-platform limits so callers never need to re-trim. */
export const SOCIAL_PLATFORMS: Record<string, SocialPlatformSpec> = {
  tiktok: { titleMax: 100, captionMax: 2200, hashtagCount: 5 },
  youtube_shorts: { titleMax: 100, captionMax: 5000, hashtagCount: 3 },
  instagram_reels: { titleMax: 125, captionMax: 2200, hashtagCount: 8 },
  facebook_reels: { titleMax: 125, captionMax: 2200, hashtagCount: 5 },
};

export const SOCIAL_PLATFORM_LABELS: Record<string, string> = {
  tiktok: "TikTok",
  youtube_shorts: "YouTube Shorts",
  instagram_reels: "Instagram Reels",
  facebook_reels: "Facebook Reels",
};

export const DEFAULT_SOCIAL_PLATFORM = "tiktok";
export const DEFAULT_SOCIAL_LANGUAGE = "auto";
export const MAX_SOCIAL_SUBJECT_LENGTH = 500;
export const MAX_SOCIAL_SCRIPT_LENGTH = 8000;
export const MAX_SOCIAL_LANGUAGE_LENGTH = 64;

/** Generic fallback tags, deliberately not tied to any language or country. */
export const DEFAULT_SOCIAL_HASHTAGS = [
  "#shorts",
  "#viral",
  "#trending",
  "#fyp",
  "#video",
  "#reels",
  "#creator",
  "#content",
];

export function resolveSocialPlatform(platform: string | undefined): string {
  const value = (platform ?? "").trim().toLowerCase();
  return value in SOCIAL_PLATFORMS ? value : DEFAULT_SOCIAL_PLATFORM;
}

export function normalizeSocialLanguage(language: string | undefined): string {
  const value = (language ?? "").trim();
  if (!value) return DEFAULT_SOCIAL_LANGUAGE;
  return value.slice(0, MAX_SOCIAL_LANGUAGE_LENGTH);
}

export function clampText(text: unknown, maxLength: number): string {
  const value = (text === null || text === undefined ? "" : String(text)).trim();
  if (maxLength && value.length > maxLength) return value.slice(0, maxLength).trimEnd();
  return value;
}

/**
 * Normalises model-supplied hashtags into `#tag` form.
 *
 * Models return strings, arrays, phrases with spaces, duplicates and stray
 * punctuation. Cleaning centrally keeps the API response stable and stops empty
 * or duplicate tags reaching a publishing platform. Array entries are treated
 * as whole tags, so "du lich" becomes "#dulich" rather than two tags.
 */
export function normalizeHashtags(raw: unknown, count: number): string[] {
  let candidates: string[] = [];
  if (typeof raw === "string") {
    candidates = raw.split(/[\s,]+/);
  } else if (Array.isArray(raw)) {
    candidates = raw.map((entry) => String(entry));
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of candidates) {
    const tag = item.replace(/[^\p{L}\p{N}_]/gu, "");
    if (!tag) continue;

    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    result.push(`#${tag}`);
    if (count && result.length >= count) break;
  }
  return result;
}

function socialLanguageInstruction(language: string | undefined): string {
  const normalized = normalizeSocialLanguage(language);
  if (normalized.toLowerCase() === DEFAULT_SOCIAL_LANGUAGE) {
    return (
      "Use the same language as the video subject and script. If the subject " +
      "and script use different languages, prefer the script language."
    );
  }
  return `Write "title" and "caption" in this language: ${normalized}.`;
}

export function buildSocialMetadataPrompt(options: {
  videoSubject: string;
  videoScript?: string;
  language?: string;
  platform?: string;
}): string {
  const videoSubject = clampText(options.videoSubject, MAX_SOCIAL_SUBJECT_LENGTH);
  const videoScript = clampText(options.videoScript, MAX_SOCIAL_SCRIPT_LENGTH);
  const platform = resolveSocialPlatform(options.platform);
  const spec = SOCIAL_PLATFORMS[platform]!;
  const label = SOCIAL_PLATFORM_LABELS[platform] ?? platform;

  return `# Role: Short-Video Social Media Copywriter

## Goal
Write engaging publishing metadata for a short video that will be posted on ${label}.

## Constraints
1. Respond ONLY with a single valid minified JSON object. No markdown, no code fences, no commentary.
2. The JSON must contain exactly these keys: "title", "caption", "hashtags".
3. "title": a catchy hook, at most ${spec.titleMax} characters.
4. "caption": an engaging description that ends with a call to action, at most ${spec.captionMax} characters. Do not put hashtags inside the caption.
5. "hashtags": a JSON array of exactly ${spec.hashtagCount} strings. Each must start with "#", contain no spaces, and be relevant to the topic and to ${label}.
6. ${socialLanguageInstruction(options.language)}

## Output Example
{"title":"...","caption":"...","hashtags":["#example","#video"]}

## Context
### Video Subject
${videoSubject}

### Video Script
${videoScript}`;
}

/** Structured metadata used when the model is unavailable or unusable. */
export function fallbackSocialMetadata(
  videoSubject: string,
  videoScript: string,
  platform: string,
): { title: string; caption: string; hashtags: string[] } {
  const spec = SOCIAL_PLATFORMS[resolveSocialPlatform(platform)]!;
  const subject = (videoSubject ?? "").trim();
  const script = (videoScript ?? "").trim();

  let title = subject;
  if (!title && script) title = script.split(/[.。!！?？\n]/)[0]?.trim() ?? "";
  if (!title) title = "Short video";

  const caption = script
    ? `${clampText(script, Math.max(spec.captionMax - 60, 60))}`
    : `${title} — watch to the end and follow for more.`;

  return {
    title: clampText(title, spec.titleMax),
    caption: clampText(caption, spec.captionMax),
    hashtags: DEFAULT_SOCIAL_HASHTAGS.slice(0, spec.hashtagCount),
  };
}
