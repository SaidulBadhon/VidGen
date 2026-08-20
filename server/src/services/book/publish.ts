/**
 * YouTube listing copy for long-form book chapters.
 *
 * The upload dialog used to wait on the LLM. Listings are written earlier —
 * during a segment render, or in the background from the segments table — so
 * opening Upload only has to pick channels.
 */

import {
  getBook,
  getBookSegment,
  patchBookSegment,
  readEditedBookStructure,
} from "../../db/books.ts";
import { generateBookSegmentPublishMetadata } from "../llm/index.ts";

export const MAX_SEGMENT_LISTING_EXCERPT = 4000;

/**
 * Fallback listings are a title, a credit line, and hashtags. Anything this
 * short is treated as a stub so the real copy can be written automatically.
 */
export const STUB_YOUTUBE_DESCRIPTION_MAX = 160;

export function youtubeListingIsStub(description: string | undefined | null): boolean {
  return (description ?? "").trim().length <= STUB_YOUTUBE_DESCRIPTION_MAX;
}

/** Joins kept block text into the excerpt the listing prompt is grounded in. */
export function clipSegmentExcerpt(
  texts: readonly string[],
  maxChars = MAX_SEGMENT_LISTING_EXCERPT,
): string {
  const parts: string[] = [];
  let used = 0;
  for (const raw of texts) {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    const clipped = text.length > remaining ? `${text.slice(0, remaining).trimEnd()}…` : text;
    parts.push(clipped);
    used += clipped.length + 2;
    if (text.length > remaining) break;
  }
  return parts.join("\n\n");
}

export async function excerptForSegment(bookId: string, blockIds: readonly string[]): Promise<string> {
  const loaded = await readEditedBookStructure(bookId);
  if (!loaded || blockIds.length === 0) return "";
  const wanted = new Set(blockIds);
  const texts: string[] = [];
  for (const block of [...loaded.edited.blocks].sort((a, b) => a.order - b.order)) {
    if (!wanted.has(block.id)) continue;
    texts.push(block.text);
  }
  return clipSegmentExcerpt(texts);
}

/**
 * Writes an AI description and tags onto the segment when it still has a stub.
 *
 * The chapter title is left alone. A fallback stub is not stored: leaving the
 * field empty lets a later pass try again instead of locking in the credit-line
 * placeholder.
 */
export async function writeBookSegmentListing(options: {
  bookId: string;
  index: number;
  expectedRevision: number;
}): Promise<boolean> {
  const book = await getBook(options.bookId);
  if (!book || book.revision !== options.expectedRevision) return false;
  const segment = await getBookSegment(options.bookId, options.index);
  if (!segment || !youtubeListingIsStub(segment.description)) return false;

  const excerpt = await excerptForSegment(options.bookId, segment.block_ids);
  const metadata = await generateBookSegmentPublishMetadata({
    bookTitle: book.title,
    author: book.author,
    language: book.language,
    chapterTitle: segment.title,
    excerpt,
    episode: options.index + 1,
  });
  if (youtubeListingIsStub(metadata.description)) return false;

  const current = await getBook(options.bookId);
  if (!current || current.revision !== options.expectedRevision) return false;
  return patchBookSegment(options.bookId, options.index, {
    description: metadata.description,
    tags: metadata.tags,
  });
}
