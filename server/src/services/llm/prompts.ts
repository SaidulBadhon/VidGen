/**
 * Prompt construction for script, search terms, social metadata and book segments.
 * Ported from python-version/app/services/llm.py.
 */

import { logger } from "../../utils/logger.ts";

/** English labels used in prompts so the model is not guessing from a code. */
const LANGUAGE_LABELS: Record<string, string> = {
  en: "English",
  zh: "Simplified Chinese",
  bn: "Bengali",
  de: "German",
  es: "Spanish",
  id: "Indonesian",
  pt: "Portuguese",
  ru: "Russian",
  tr: "Turkish",
  vi: "Vietnamese",
};

export function languageLabel(code: string): string {
  const normalized = code.trim();
  if (!normalized) return "";
  return LANGUAGE_LABELS[normalized] ?? LANGUAGE_LABELS[normalized.toLowerCase()] ?? normalized;
}

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

  const language = (options.language || "").trim();
  const languageName = languageLabel(language);

  let prompt = customSystemPrompt || DEFAULT_SCRIPT_SYSTEM_PROMPT;
  if (languageName && !customSystemPrompt) {
    prompt = prompt.replace(
      "8. respond in the same language as the video subject.",
      `8. write the entire script in ${languageName}. Do not use any other language.`,
    );
  }
  prompt += `\n\n# Initialization:\n- video subject: ${options.videoSubject}\n- number of paragraphs: ${paragraphNumber}`;
  if (languageName) prompt += `\n- language: ${languageName}`;
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
  youtube_shorts: { titleMax: 100, captionMax: 5000, hashtagCount: 6 },
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

  const captionRule =
    platform === "youtube_shorts"
      ? `"caption": a full YouTube video description (not a one-line social caption). Write 4-8 short paragraphs, aiming for 600-2500 characters and at most ${spec.captionMax}. Structure: (1) opening hook, (2) what happens in the video, (3) why it matters or the key takeaway, (4) call to action to watch, like, or subscribe. Do not put hashtags in the body; end with a blank line and a final line of 4-6 hashtags including #shorts.`
      : `"caption": an engaging description that ends with a call to action, at most ${spec.captionMax} characters. Do not put hashtags inside the caption.`;

  return `# Role: Short-Video Social Media Copywriter

## Goal
Write engaging publishing metadata for a short video that will be posted on ${label}.

## Constraints
1. Respond ONLY with a single valid minified JSON object. No markdown, no code fences, no commentary.
2. The JSON must contain exactly these keys: "title", "caption", "hashtags".
3. "title": a catchy hook, at most ${spec.titleMax} characters.
4. ${captionRule}
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

// ---------------------------------------------------------------------------
// Book segment boundaries
// ---------------------------------------------------------------------------

export const MAX_SEGMENT_TITLE_LENGTH = 120;

export interface SegmentOutlineLine {
  index: number;
  startBlockId: string;
  kind: string;
  seconds: number;
  title: string;
}

export function buildSegmentBoundariesPrompt(options: {
  bookTitle: string;
  author: string;
  language?: string;
  targetSeconds: number;
  maxSeconds: number;
  totalSeconds: number;
  units: SegmentOutlineLine[];
  chunkIndex?: number;
  chunkCount?: number;
}): string {
  const title = (options.bookTitle || "Untitled").trim();
  const author = (options.author || "").trim();
  const language = (options.language || "").trim();
  const chunkNote =
    options.chunkCount && options.chunkCount > 1
      ? `\nThis is outline chunk ${options.chunkIndex ?? 1} of ${options.chunkCount}. Only return sections that start inside this chunk.`
      : "";

  const lines = options.units
    .map((unit) => {
      const label = unit.title.replace(/\s+/g, " ").trim().slice(0, 80);
      return `${unit.index}\t${unit.startBlockId}\t${unit.kind}\t${Math.round(unit.seconds)}s\t${label}`;
    })
    .join("\n");

  const exampleId = options.units[0]?.startBlockId ?? "0:0";

  return `# Role: Audiobook Chapter Detector

## Goal
Mark the real chapter and section starts that a listener should hear. Do not turn the table of contents, copyright pages, or other unread apparatus into videos.

## Constraints
1. Respond ONLY with a single valid minified JSON object. No markdown, no code fences, no commentary.
2. The JSON must be: {"skip_block_ids":["..."],"sections":[{"start_block_id":"...","title":"..."}]}
3. Every id MUST be copied exactly from the outline below. Do not invent ids.
4. skip_block_ids are outline start_block_ids that must not be narrated: table of contents listings, "Contents" headings, running heads, page numbers, copyright/publisher boilerplate, and duplicate chapter titles that only appear as a list before the body. Do not skip narratable prose, a preface, a prologue, or the title/author lines that open the book.
5. Sections are genuine narrative starts only — the first body occurrence of a chapter or titled section, never its table-of-contents echo. Do not start a section at the first outline id just because it is first.
6. The first section should be the first real chapter or section of the book body (or a narratable prologue/preface). Title and author lines before that may stay; the contents list must not.
7. Prefer published chapter titles (Chapter I, Book the First, I. The Period, and similar) over generic "Part N" labels. Title text is the chapter/section name only — do not repeat the book title or author in the title field.
8. A heading that is only a number (1, 12, I) is a chapter start, not a page number. Title it "Chapter N". If the next outline line is a name or year (Camilla, 2009), keep that number as the start and put the name after it: "Chapter 8 — Camilla". Do not skip numbered chapter headings.
9. Do NOT slice the book into equal ${options.targetSeconds}-second chunks. Length is handled later. Your job is only to mark genuine starts and unread ids.
10. Titles at most ${MAX_SEGMENT_TITLE_LENGTH} characters, in the book's language, without surrounding quotes.
11. Include a section start when the outline kind is "heading" or "marker" and the title looks like a real chapter or book division that is followed by body text. Every numbered chapter heading in the body must be a section start. You may also start a section at a "prose" id when a scene clearly changes and no heading is present.${chunkNote}

## Length context
- Target video length: ${options.targetSeconds} seconds
- Maximum video length: ${options.maxSeconds} seconds
- Approximate remaining narration in this outline: ${Math.round(options.totalSeconds)} seconds
These numbers are for orientation only; do not invent extra splits just to hit the target.

## Outline columns
index, start_block_id, kind, estimated_seconds, title_or_preview

## Book
- title: ${title}${author ? `\n- author: ${author}` : ""}${language ? `\n- language: ${language}` : ""}

## Outline
${lines}

## Output Example
{"skip_block_ids":["${exampleId}"],"sections":[{"start_block_id":"${exampleId}","title":"I. The Period"}]}`;
}

// ---------------------------------------------------------------------------
// Book hook shorts
// ---------------------------------------------------------------------------

export interface BookShortPassageLine {
  blockId: string;
  kind: string;
  text: string;
}

export function buildBookShortsPrompt(options: {
  bookTitle: string;
  author: string;
  language?: string;
  chapterTitle: string;
  targetSeconds: number;
  targetWords: number;
  chunkIndex: number;
  chunkCount: number;
  lines: BookShortPassageLine[];
}): string {
  const title = (options.bookTitle || "Untitled").trim();
  const author = (options.author || "").trim();
  const language = (options.language || "").trim();
  const languageName = languageLabel(language);
  const exampleId = options.lines[0]?.blockId ?? "0:0";
  const passage = options.lines
    .map((line) => `[${line.blockId} ${line.kind}] ${line.text}`)
    .join("\n");

  return `# Role: Viral Book-Trailer Writer for YouTube Shorts and TikTok

## Goal
Write spoken scripts for ${options.targetSeconds}-second portrait videos that hook a scroller into watching the full book video of "${title}". Each script is a funny, surprising, or emotionally sharp beat taken from THIS passage only — not a summary of the whole book.

## Constraints
1. Respond ONLY with a single valid minified JSON object. No markdown, no code fences, no commentary.
2. The JSON must be: {"shorts":[{"title":"...","hook":"...","script":"...","start_block_id":"..."}]}
3. Return 0 or 1 short. Return {"shorts":[]} when this passage is apparatus (contents, copyright, index) or has no hook-worthy moment.
4. Every start_block_id MUST be copied exactly from a [id kind] tag in the passage. Do not invent ids.
5. "title": a catchy on-screen title, at most 80 characters, no quotes around the whole title.
6. "hook": the first 1-2 spoken sentences, at most 220 characters. It must stop the scroll in the first 3 seconds — a question, a contradiction, a laugh, or a gut-punch. Not "in this book" or "today we".
7. "script": the full spoken narration, about ${options.targetWords} words (range ${Math.max(80, options.targetWords - 30)}-${options.targetWords + 30}). No markdown, no titles, no "voiceover", no "subscribe", no "in this video". Write as a storyteller talking to camera.
8. Tell one self-contained beat from this passage, then leave a question or unfinished turn so the viewer wants the rest of the story. Do not spoil the book's ending or later reveals.
9. Prefer funny, ironic, romantic, or high-stakes moments over plot summary. A joke that is true to the scene beats a Wikipedia recap.
10. ${languageName ? `Write title, hook and script entirely in ${languageName}.` : "Write in the same language as the passage."}
11. This is passage ${options.chunkIndex} of ${options.chunkCount}. Only use what is in the passage below.

## Book
- title: ${title}${author ? `\n- author: ${author}` : ""}${languageName ? `\n- language: ${languageName}` : ""}
- chapter or section: ${options.chapterTitle || "Untitled"}

## Passage
${passage}

## Output Example
{"shorts":[{"title":"She said yes. Then she saw the list.","hook":"She said yes. Then she saw the list.","script":"She said yes. Then she saw the list. ${title} is about to get much worse.","start_block_id":"${exampleId}"}]}`;
}

export function buildBookShortRegenPrompt(options: {
  bookTitle: string;
  author: string;
  language?: string;
  chapterTitle: string;
  title: string;
  hook: string;
  previousScript?: string;
  targetSeconds: number;
  targetWords: number;
  excerpt: string;
}): string {
  const title = (options.bookTitle || "Untitled").trim();
  const author = (options.author || "").trim();
  const languageName = languageLabel((options.language || "").trim());
  const previous = (options.previousScript || "").trim();

  return `# Role: Viral Book-Trailer Writer for YouTube Shorts and TikTok

## Goal
Rewrite the spoken script for a ${options.targetSeconds}-second portrait video that hooks a scroller into watching the full book video of "${title}". Keep the same story beat. Make it funnier or sharper than the previous draft if there is one.

## Constraints
1. Return ONLY the spoken script as plain text. No markdown, no title, no JSON, no "voiceover".
2. About ${options.targetWords} words (range ${Math.max(80, options.targetWords - 30)}-${options.targetWords + 30}).
3. Open with a hook in the first sentence. End on a curiosity gap. Do not spoil the ending.
4. Use only facts from the excerpt. Do not invent plot.
5. ${languageName ? `Write the entire script in ${languageName}.` : "Write in the same language as the excerpt."}

## Book
- title: ${title}${author ? `\n- author: ${author}` : ""}
- chapter: ${options.chapterTitle || "Untitled"}
- short title: ${options.title}
- hook: ${options.hook}
${previous ? `\n## Previous script\n${previous}\n` : ""}
## Excerpt
${options.excerpt}`;
}

// ---------------------------------------------------------------------------
// Book-short YouTube listing
// ---------------------------------------------------------------------------

export const YOUTUBE_SHORT_TITLE_MAX = 100;
export const YOUTUBE_SHORT_DESCRIPTION_MAX = 5000;
export const YOUTUBE_SHORT_TAG_COUNT = 12;
export const YOUTUBE_SHORT_TAG_MAX = 100;
export const YOUTUBE_SHORT_TAGS_MAX_CHARS = 500;

/**
 * Turns model-supplied keywords into YouTube tags.
 *
 * YouTube wants phrases, not hashtags: spaces are allowed, `#` is stripped,
 * and the combined length is capped so the Data API does not reject the set.
 */
export function normalizeYoutubeTags(raw: unknown, count = YOUTUBE_SHORT_TAG_COUNT): string[] {
  let candidates: string[] = [];
  if (typeof raw === "string") {
    candidates = raw.split(/[,;\n]+/);
  } else if (Array.isArray(raw)) {
    candidates = raw.map((entry) => String(entry));
  }

  const seen = new Set<string>();
  const result: string[] = [];
  let used = 0;
  for (const item of candidates) {
    const tag = item
      .replace(/^#+/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, YOUTUBE_SHORT_TAG_MAX)
      .trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    if (used + tag.length > YOUTUBE_SHORT_TAGS_MAX_CHARS) continue;
    seen.add(key);
    result.push(tag);
    used += tag.length + 1;
    if (count && result.length >= count) break;
  }
  return result;
}

export function fallbackBookShortPublish(options: {
  bookTitle: string;
  author: string;
  title: string;
  hook: string;
  script: string;
}): { youtubeTitle: string; description: string; tags: string[] } {
  const bookTitle = (options.bookTitle || "Untitled").trim();
  const author = (options.author || "").trim();
  const clipTitle = (options.title || "").trim();
  const hook = (options.hook || "").trim();
  const script = (options.script || "").trim();

  const youtubeTitle = clampText(
    clipTitle || hook || script.split(/[.。!！?？\n]/)[0] || bookTitle,
    YOUTUBE_SHORT_TITLE_MAX,
  );

  const tease = hook || clampText(script, 280);
  const credit = author ? `"${bookTitle}" by ${author}` : `"${bookTitle}"`;
  const description = clampText(
    [tease, "", `A teaser from ${credit}. Watch the full book video.`, "", "#shorts #books #audiobook"]
      .filter((line) => line !== undefined)
      .join("\n"),
    YOUTUBE_SHORT_DESCRIPTION_MAX,
  );

  const tags = normalizeYoutubeTags(
    [bookTitle, author, "audiobook", "booktok", "shorts", "book trailer", clipTitle].filter(Boolean),
    YOUTUBE_SHORT_TAG_COUNT,
  );

  return { youtubeTitle, description, tags };
}

export function buildBookShortPublishPrompt(options: {
  bookTitle: string;
  author: string;
  language?: string;
  chapterTitle: string;
  title: string;
  hook: string;
  script: string;
}): string {
  const bookTitle = (options.bookTitle || "Untitled").trim();
  const author = (options.author || "").trim();
  const languageName = languageLabel((options.language || "").trim());
  const clipTitle = clampText(options.title, MAX_SOCIAL_SUBJECT_LENGTH);
  const hook = clampText(options.hook, 400);
  const script = clampText(options.script, MAX_SOCIAL_SCRIPT_LENGTH);

  return `# Role: YouTube Shorts Listing Writer for book trailers

## Goal
Write the YouTube listing for a ~60 second book-trailer Short that pulls a scroller into watching the full book video of "${bookTitle}". This is publishing metadata, not the spoken script.

## Constraints
1. Respond ONLY with a single valid minified JSON object. No markdown, no code fences, no commentary.
2. The JSON must be: {"youtube_title":"...","description":"...","tags":["..."]}
3. "youtube_title": catchy, at most ${YOUTUBE_SHORT_TITLE_MAX} characters. It may mention the book. Do not wrap the whole title in quotes.
4. "description": a full YouTube description — 4-8 short paragraphs, aiming for 800-2500 characters and at most ${YOUTUBE_SHORT_DESCRIPTION_MAX}. Structure: (1) scroll-stopping hook, (2) what this teaser shows from the chapter, (3) a sentence about the book${author ? " and author" : ""} without spoiling later chapters, (4) why someone should watch the full book video, (5) a clear call to action. Do not put hashtags in the body; end with a blank line and a final line of 4-6 hashtags including #shorts.
5. "tags": a JSON array of ${YOUTUBE_SHORT_TAG_COUNT} keyword strings for YouTube's tags field. No leading "#", spaces inside a tag are allowed (e.g. the book title). Include the book title, ${author ? "the author, " : ""}audiobook, and topic words from this teaser.
6. ${languageName ? `Write youtube_title and description in ${languageName}.` : "Write youtube_title and description in the same language as the script."} Tags may mix that language with common English discovery terms such as audiobook and shorts.

## Book
- title: ${bookTitle}${author ? `\n- author: ${author}` : ""}${languageName ? `\n- language: ${languageName}` : ""}
- chapter or section: ${options.chapterTitle || "Untitled"}

## Teaser
- on-screen title: ${clipTitle}
- opening hook: ${hook}

## Spoken script
${script}

## Output Example
{"youtube_title":"...","description":"...\\n\\n#shorts #books","tags":["${bookTitle.replace(/"/g, "")}","audiobook"]}`;
}

export function fallbackBookSegmentPublish(options: {
  bookTitle: string;
  author: string;
  chapterTitle: string;
  /** 1-based episode number; omitted keeps the chapter title unsuffixed. */
  episode?: number;
}): { youtubeTitle: string; description: string; tags: string[] } {
  const bookTitle = (options.bookTitle || "Untitled").trim();
  const author = (options.author || "").trim();
  const chapter = (options.chapterTitle || "Chapter").trim();
  const base = bookTitle === chapter ? bookTitle : `${bookTitle} - ${chapter}`;
  const suffixed =
    options.episode != null && options.episode > 0 ? `${base} | Episode ${options.episode}` : base;
  const youtubeTitle = clampText(
    suffixed.replace(/\s*[\u2014\u2013]\s*/g, " - ").replace(/\s+/g, " ").trim(),
    YOUTUBE_SHORT_TITLE_MAX,
  );
  const credit = author ? `"${bookTitle}" by ${author}` : `"${bookTitle}"`;
  const description = clampText(
    [chapter, "", `From ${credit}.`, "", "#audiobook #books"].join("\n"),
    YOUTUBE_SHORT_DESCRIPTION_MAX,
  );
  const tags = normalizeYoutubeTags(
    [bookTitle, author, chapter, "audiobook", "books"].filter(Boolean),
    YOUTUBE_SHORT_TAG_COUNT,
  );
  return { youtubeTitle, description, tags };
}

export function buildBookSegmentPublishPrompt(options: {
  bookTitle: string;
  author: string;
  language?: string;
  chapterTitle: string;
  excerpt: string;
}): string {
  const bookTitle = (options.bookTitle || "Untitled").trim();
  const author = (options.author || "").trim();
  const languageName = languageLabel((options.language || "").trim());
  const chapter = clampText(options.chapterTitle, MAX_SOCIAL_SUBJECT_LENGTH);
  const excerpt = clampText(options.excerpt, MAX_SOCIAL_SCRIPT_LENGTH);

  return `# Role: YouTube Listing Writer for audiobook chapters

## Goal
Write the YouTube description and tags for a long-form chapter video from the audiobook of "${bookTitle}". This is publishing metadata, not the spoken narration. Do not write a title — the chapter name is already set.

## Constraints
1. Respond ONLY with a single valid minified JSON object. No markdown, no code fences, no commentary.
2. The JSON must be: {"description":"...","tags":["..."]}
3. "description": a full YouTube chapter description — 5-10 short paragraphs, aiming for 1000-3500 characters and at most ${YOUTUBE_SHORT_DESCRIPTION_MAX}. Structure: (1) hook or mood-setting opener, (2) what this chapter covers using the excerpt, (3) how it fits the story so far without spoiling later chapters, (4) a line about the book${author ? " and author" : ""}, (5) why listeners should keep watching the playlist, (6) subscribe / next-chapter call to action. Do not put hashtags in the body; end with a blank line and a final line of 4-6 hashtags including #audiobook. This is NOT a YouTube Short — do not use #shorts.
4. "tags": a JSON array of ${YOUTUBE_SHORT_TAG_COUNT} keyword strings for YouTube's tags field. No leading "#", spaces inside a tag are allowed. Include the book title, ${author ? "the author, " : ""}audiobook, and topic words from this chapter.
5. ${languageName ? `Write the description in ${languageName}.` : "Write the description in the same language as the excerpt."} Tags may mix that language with common English discovery terms such as audiobook.

## Book
- title: ${bookTitle}${author ? `\n- author: ${author}` : ""}${languageName ? `\n- language: ${languageName}` : ""}
- chapter or section: ${chapter || "Untitled"}

## Excerpt
${excerpt || chapter}

## Output Example
{"description":"...\\n\\n#audiobook #books","tags":["${bookTitle.replace(/"/g, "")}","audiobook"]}`;
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
