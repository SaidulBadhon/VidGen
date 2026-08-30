/**
 * Stock footage under book narration.
 *
 * The short-video pipeline already turns a script into search terms, downloads
 * matching clips and concatenates them; a book segment deliberately bypassed all
 * of it in favour of one held still. This module reuses that machinery at the
 * scale a book needs, which is a different scale entirely — and the difference
 * is the reason for almost every decision below.
 *
 * Measured on a real 74-segment book before any of this was written:
 *
 *   downloading fresh footage per segment  ~230 GB per book   (dead on arrival)
 *   one pooled download, reordered per seg   ~4.7 GB per book
 *
 * A short video needs 60 seconds of picture. A book chapter needs 816, and a
 * book needs seventeen hours of it. Nothing here works if each segment shops for
 * its own clips, so the pool is per BOOK and each segment draws a different
 * ordering from it.
 */

import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { downloadVideos } from "../material/download.ts";
import { combineVideos } from "../video/combine.ts";
import * as llm from "../llm/index.ts";
import { booksDir } from "../../utils/paths.ts";
import { logger, errorMessage } from "../../utils/logger.ts";
import type { VideoAspectValue } from "../../models/schema.ts";

/**
 * How much distinct footage one book keeps on disk.
 *
 * Thirty minutes is roughly twice the length of an average chapter, so a segment
 * can be assembled without repeating a clip inside itself while still costing
 * about 1.7 GB once rather than 230 GB per book. Raising this buys variety
 * across chapters at a linear cost in disk and download time.
 */
export const POOL_TARGET_SECONDS = 1800;

/** Clip length combineVideos slices the pool into. */
export const FOOTAGE_CLIP_SECONDS = 5;

/** Terms asked of the LLM. The short pipeline uses 8 when ordering matters. */
const TERM_COUNT = 8;

/**
 * Words that survive keyword extraction but carry no visual meaning.
 *
 * Deliberately short. This is a fallback for hosts with no LLM configured, and a
 * long hand-built stoplist is a worse use of maintenance than the LLM path it
 * stands in for.
 */
const STOPWORDS = new Set(
  ("the a an and or but if then than that this those these of in on at to for from by with without into onto upon" +
    " is are was were be been being am do does did done have has had having will would shall should can could may" +
    " might must not no nor so as it its it's he she they them his her their our your my me i you we us who whom" +
    " which what when where why how all any both each few more most other some such only own same too very just" +
    " over under again further once here there because while about against between during before after above below" +
    " up down out off then said say says one two three said mr mrs said upon shall")
    .split(/\s+/),
);

/** Deterministic PRNG so a retried segment rebuilds the same montage. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash, for seeding and for cache keys. */
function hash32(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Search terms from the text alone, with no LLM.
 *
 * Not as good as generateTerms and not meant to be. It exists because this
 * feature must work on a host with no model configured — which is the state this
 * repo was actually in when the feature was built — rather than failing the
 * render or silently producing no footage.
 *
 * Titles come first because they are the most reliably visual thing a book
 * offers: "A Tale Of Two Cities" and a chapter name search far better than the
 * commonest nouns in a paragraph of dialogue.
 */
export function footageKeywords(input: {
  bookTitle: string;
  author?: string;
  chapterTitle: string;
  text: string;
  amount?: number;
}): string[] {
  const amount = input.amount ?? TERM_COUNT;
  const terms: string[] = [];

  const title = input.bookTitle.trim();
  const chapter = input.chapterTitle.trim();
  if (title) terms.push(title);
  if (chapter && chapter.toLowerCase() !== title.toLowerCase()) terms.push(chapter);

  const counts = new Map<string, number>();
  for (const raw of input.text.toLowerCase().split(/[^\p{L}']+/u)) {
    const word = raw.replace(/^'+|'+$/g, "");
    // Three letters filters out most pronouns and particles the stoplist misses.
    if (word.length < 4 || STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word]) => word);

  // Pair the two commonest words so at least one term reads as a scene rather
  // than a noun; a single word tends to return portraits and product shots.
  if (ranked.length >= 2) terms.push(`${ranked[0]} ${ranked[1]}`);
  for (const word of ranked) {
    if (terms.length >= amount) break;
    if (!terms.some((t) => t.toLowerCase().includes(word))) terms.push(word);
  }

  return terms.slice(0, amount);
}

/**
 * Search terms for one segment: the LLM when it is configured, keywords when it
 * is not.
 *
 * Any LLM failure degrades rather than propagates — a missing API key, a rate
 * limit and a malformed completion all mean "use keywords", because none of them
 * is a reason to leave a chapter with no picture.
 */
export async function footageSearchTerms(input: {
  bookTitle: string;
  author?: string;
  chapterTitle: string;
  text: string;
}): Promise<{ terms: string[]; source: "llm" | "keywords" }> {
  try {
    const terms = await llm.generateTerms({
      videoSubject: input.bookTitle,
      videoScript: input.text.slice(0, 4000),
      amount: TERM_COUNT,
      matchScriptOrder: true,
    });
    if (terms.length > 0) return { terms, source: "llm" };
    logger.warning("book footage: the LLM returned no search terms; falling back to keywords");
  } catch (error) {
    logger.warning(`book footage: term generation unavailable (${errorMessage(error)}); falling back to keywords`);
  }
  return { terms: footageKeywords(input), source: "keywords" };
}

interface PoolManifest {
  key: string;
  clips: string[];
}

function poolManifestPath(bookId: string): string {
  return join(booksDir(bookId), "footage-pool.json");
}

/** Identity of a pool: re-download only when what it was built from changes. */
export function footagePoolKey(input: {
  terms: readonly string[];
  source: string;
  aspect: string;
}): string {
  return String(hash32(JSON.stringify({ terms: [...input.terms].sort(), source: input.source, aspect: input.aspect })));
}

/**
 * The book's shared clip pool, downloaded once.
 *
 * Reuse is the whole point, so the manifest is checked before anything is
 * fetched and clips that have since been deleted are filtered out rather than
 * trusted. A pool that has lost most of its files is rebuilt; one that has lost
 * a few is used as-is, because combineVideos loops what it is given and a
 * slightly smaller pool is not worth another 1.7 GB of downloads.
 */
export async function ensureBookFootagePool(options: {
  bookId: string;
  terms: string[];
  source: string;
  aspect: VideoAspectValue;
  targetSeconds?: number;
  signal?: AbortSignal;
}): Promise<string[]> {
  const key = footagePoolKey({ terms: options.terms, source: options.source, aspect: options.aspect });
  const manifestPath = poolManifestPath(options.bookId);

  if (existsSync(manifestPath)) {
    try {
      const manifest = (await Bun.file(manifestPath).json()) as PoolManifest;
      if (manifest.key === key) {
        const alive = manifest.clips.filter((clip) => existsSync(clip));
        if (alive.length > 0 && alive.length >= manifest.clips.length / 2) {
          logger.info(`book footage: reusing pool of ${alive.length} clips for ${options.bookId}`);
          return alive;
        }
      }
    } catch (error) {
      logger.warning(`book footage: unreadable pool manifest, rebuilding (${errorMessage(error)})`);
    }
  }

  const clips = await downloadVideos({
    // The pool belongs to the book, not to any one segment's task, so it is
    // keyed by book id — that is what stops 74 segments each shopping alone.
    taskId: `book-${options.bookId}`,
    searchTerms: options.terms,
    source: options.source,
    videoAspect: options.aspect,
    audioDuration: options.targetSeconds ?? POOL_TARGET_SECONDS,
    maxClipDuration: FOOTAGE_CLIP_SECONDS,
    matchScriptOrder: false,
    signal: options.signal,
  });

  if (clips.length === 0) return [];

  // Temp-then-rename: the manifest is a cache key for gigabytes of downloads,
  // and a half-written one would be parsed as a valid pool.
  const temp = `${manifestPath}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temp, JSON.stringify({ key, clips } satisfies PoolManifest, null, 2));
  await rename(temp, manifestPath);

  logger.success(`book footage: pooled ${clips.length} clips for ${options.bookId}`);
  return clips;
}

/**
 * One segment's picture, cut from the shared pool.
 *
 * Returns null instead of throwing. Footage is the best case, not the only one:
 * the caller falls back to the template bed and then to the held still, and a
 * chapter that cannot find clips must still render.
 *
 * The ordering is seeded from the segment index so two chapters of the same book
 * get visibly different montages while a retry of one chapter rebuilds the same
 * montage it had before.
 *
 * `ordered` is the exception, and the only one. A scene-matched list is already
 * in the narration's order, one clip per scene; shuffling it would discard the
 * whole point of having matched it. Everything else — the seeded PRNG, the clip
 * length, the speed — is identical either way, so the two modes differ by one
 * argument rather than by a second code path.
 */
export async function buildSegmentFootage(options: {
  clips: string[];
  audioFile: string;
  outputFile: string;
  aspect: VideoAspectValue;
  segmentIndex: number;
  threads?: number;
  /** True when `clips` is scene-matched and its order must be preserved. */
  ordered?: boolean;
  signal?: AbortSignal;
}): Promise<string | null> {
  if (options.clips.length === 0) return null;

  try {
    await combineVideos({
      combinedVideoPath: options.outputFile,
      videoPaths: options.clips,
      audioFile: options.audioFile,
      videoAspect: options.aspect,
      videoConcatMode: options.ordered ? "sequential" : "random",
      videoTransitionMode: null,
      maxClipDuration: FOOTAGE_CLIP_SECONDS,
      threads: options.threads ?? 2,
      clipSpeed: 1,
      signal: options.signal,
      random: seededRandom(hash32(`${options.outputFile}:${options.segmentIndex}`)),
    });
  } catch (error) {
    logger.warning(`book footage: montage failed for segment ${options.segmentIndex}: ${errorMessage(error)}`);
    return null;
  }

  if (!existsSync(options.outputFile)) return null;
  return options.outputFile;
}

/** Directory combineVideos scratches its per-clip temporaries into. */
export function footageWorkDir(outputFile: string): string {
  return dirname(outputFile);
}
