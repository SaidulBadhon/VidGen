/**
 * Plain text and Markdown to book structure.
 *
 * The only structure a text file reliably carries is the blank line between
 * paragraphs, so that is what drives the parse. Markdown headings are honoured
 * because so many public-domain texts are distributed that way, but nothing
 * else about Markdown is interpreted — the goal is narratable prose, not a
 * renderer, and a mis-read emphasis marker costs more than it gains.
 */

import type { ParsedBlock } from "./html.ts";
import { BookExtractionError, type Block, type BookStructure, type Chapter, type ExtractionResult } from "../types.ts";

/** `## Title`, with the optional closing run of hashes Markdown allows. */
const ATX_HEADING = /^(#{1,6})\s+(.*?)\s*#*$/;

/** The `===` or `---` rule that underlines a Setext heading. */
const SETEXT_UNDERLINE = /^(=+|-{2,})$/;

export function extractPlainText(data: Uint8Array, filename: string): ExtractionResult {
  const parsed = parseTextBlocks(new TextDecoder("utf-8").decode(data));
  if (parsed.length === 0) throw new BookExtractionError("the file contains no readable text");

  return { structure: buildStructure(parsed, stemOf(filename)), warnings: [] };
}

export function parseTextBlocks(source: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let pending: string[] = [];

  const flush = () => {
    const text = pending.join(" ").replace(/\s+/g, " ").trim();
    pending = [];
    if (text) blocks.push({ kind: "paragraph", text });
  };

  for (const rawLine of source.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line === "") {
      flush();
      continue;
    }

    const atx = ATX_HEADING.exec(line);
    if (atx) {
      flush();
      const text = atx[2]!.trim();
      if (text) blocks.push({ kind: "heading", text, level: atx[1]!.length });
      continue;
    }

    const underline = SETEXT_UNDERLINE.exec(line);
    if (underline) {
      // A rule only underlines a heading when exactly one line sits above it.
      // Anywhere else it is a horizontal rule, which carries no text at all.
      if (pending.length === 1) {
        const text = pending[0]!;
        pending = [];
        if (text) blocks.push({ kind: "heading", text, level: underline[1]!.startsWith("=") ? 1 : 2 });
        continue;
      }
      if (pending.length === 0) continue;
    }

    pending.push(line);
  }

  flush();
  return blocks;
}

/**
 * Groups blocks into chapters at the shallowest heading level present.
 *
 * A text using only `##` should still break on `##`, so the level is taken from
 * the document rather than fixed at 1. Anything before the first such heading
 * becomes an opening chapter named after the file.
 */
function buildStructure(parsed: ParsedBlock[], fallbackTitle: string): BookStructure {
  const chapterLevel = parsed.reduce((shallowest, block) => {
    if (block.kind !== "heading") return shallowest;
    return Math.min(shallowest, block.level ?? 1);
  }, Number.POSITIVE_INFINITY);

  const chapters: Chapter[] = [];
  const blocks: Block[] = [];

  for (const parsedBlock of parsed) {
    const startsChapter = parsedBlock.kind === "heading" && (parsedBlock.level ?? 1) === chapterLevel;
    if (startsChapter || chapters.length === 0) {
      const index = chapters.length;
      chapters.push({
        id: `ch-${index}`,
        title: startsChapter ? parsedBlock.text : fallbackTitle,
        level: startsChapter ? parsedBlock.level ?? 1 : 1,
        order: index,
        blockIds: [],
      });
    }

    const chapterIndex = chapters.length - 1;
    const chapter = chapters[chapterIndex]!;
    const block: Block = {
      id: `${chapterIndex}:${chapter.blockIds.length}`,
      kind: parsedBlock.kind,
      text: parsedBlock.text,
      chapterId: chapter.id,
      order: blocks.length,
    };
    if (parsedBlock.level !== undefined) block.level = parsedBlock.level;

    blocks.push(block);
    chapter.blockIds.push(block.id);
  }

  return { title: fallbackTitle, author: "", language: "", chapters, blocks };
}

function stemOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
