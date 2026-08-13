/**
 * XHTML/HTML to narratable blocks.
 *
 * A DOM library would be the obvious tool, but the question being asked is only
 * block-level — which container a run of text sits in, and what its `epub:type`
 * says about it — so a hand-written tag scanner answers it without adding a
 * dependency. The scanner is exported because epub.ts reuses it for the package
 * and navigation documents: those are XML with the same tag syntax, and one
 * parser that is well tested beats two that are each half tested.
 *
 * Traversal rule: the innermost open block owns the text. A `<blockquote>`
 * wrapping a `<p>` therefore yields one block, not the quote's text and the
 * paragraph's text twice over; the wrapper only contributes its meaning, which
 * is why the enclosing quote or code kind still wins over a bare paragraph.
 */

import type { BlockKind } from "../types.ts";

/**
 * A block before it has an identity.
 *
 * Ids and global reading order can only be assigned once the whole book is
 * assembled, so the per-document parsers produce just the parts they can know.
 */
export interface ParsedBlock {
  kind: BlockKind;
  text: string;
  /** Heading depth 1-6. Absent for every other kind, matching `Block`. */
  level?: number;
}

export interface HtmlTag {
  /** Lowercased, namespace prefix included: `epub:switch` stays as written. */
  name: string;
  attributes: Record<string, string>;
  closing: boolean;
  selfClosing: boolean;
  /** Index just past the closing `>`. */
  end: number;
}

const HEADING_LEVELS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/** Elements that open a block, and what that block narrates as. */
const BLOCK_ELEMENTS: Record<string, BlockKind> = {
  p: "paragraph",
  li: "list_item",
  dd: "list_item",
  dt: "list_item",
  blockquote: "quote",
  pre: "code",
  code: "code",
  figcaption: "caption",
  caption: "caption",
};

/**
 * Elements that carry no meaning but still end the block before them.
 *
 * Without them two adjacent `<div>`s would run together into one sentence.
 */
const SEPARATOR_ELEMENTS = new Set([
  "body", "div", "section", "article", "aside", "nav", "header", "footer",
  "main", "figure", "hgroup", "ul", "ol", "dl", "table", "thead", "tbody",
  "tfoot", "tr", "td", "th", "address", "details", "summary", "form",
]);

/** Elements whose entire content is furniture rather than prose. */
const DISCARDED_ELEMENTS = new Set(["head", "script", "style", "svg", "noscript", "template"]);

/** Void elements that read as a word break rather than as nothing. */
const BREAK_ELEMENTS = new Set(["br", "hr"]);

/**
 * `epub:type` values that mark a note *body*.
 *
 * `noteref` is deliberately absent: it marks the superscript reference inside a
 * sentence, not the note itself, so treating it as a block would cut a
 * paragraph in three and label a fragment of prose as apparatus.
 */
const NOTE_BODY_TYPES = new Set(["footnote", "endnote", "rearnote"]);

const NOTE_REFERENCE_TYPE = "noteref";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  // Written as an escape because a literal one is invisible in the table above.
  nbsp: "\u00a0",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

const ENTITY = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;
const TAG_NAME = /^([a-zA-Z][^\s/>]*)/;
const TAG_START = /[a-zA-Z/]/;

interface Frame {
  tag: string;
  kind: BlockKind;
  level?: number;
  /** True for a real block, false for a container that only separates text. */
  block: boolean;
  /** `epub:type` marked this subtree as a note body. */
  note: boolean;
}

/**
 * Parses a content document into blocks, dropping anything that cleans up empty.
 */
export function parseHtmlBlocks(html: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const stack: Frame[] = [];
  let buffer = "";
  let reference: { tag: string; depth: number; saved: string } | null = null;

  const append = (text: string) => {
    if (!reference) buffer += text;
  };

  const flush = () => {
    const text = cleanText(buffer);
    buffer = "";
    if (!text) return;
    const { kind, level } = resolveKind(stack);
    blocks.push(level === undefined ? { kind, text } : { kind, text, level });
  };

  const closeFrame = (name: string) => {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (stack[index]!.tag !== name) continue;
      flush();
      stack.length = index;
      return;
    }
    // A stray close tag from broken markup: keep collecting rather than guess.
  };

  let cursor = 0;
  while (cursor < html.length) {
    const open = html.indexOf("<", cursor);
    if (open === -1) {
      append(html.slice(cursor));
      break;
    }
    append(html.slice(cursor, open));

    if (html.startsWith("<!--", open)) {
      const commentEnd = html.indexOf("-->", open + 4);
      cursor = commentEnd === -1 ? html.length : commentEnd + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", open)) {
      const sectionEnd = html.indexOf("]]>", open + 9);
      append(html.slice(open + 9, sectionEnd === -1 ? html.length : sectionEnd));
      cursor = sectionEnd === -1 ? html.length : sectionEnd + 3;
      continue;
    }
    if (html.startsWith("<!", open) || html.startsWith("<?", open)) {
      const declarationEnd = findTagEnd(html, open);
      cursor = declarationEnd === -1 ? html.length : declarationEnd + 1;
      continue;
    }

    const tag = readTag(html, open);
    if (!tag) {
      // Not markup at all — a bare `<` in prose, as in "a < b".
      append("<");
      cursor = open + 1;
      continue;
    }
    cursor = tag.end;

    if (reference) {
      // Everything inside a note reference is the marker itself, which is
      // navigation furniture, so the whole subtree is dropped.
      if (tag.name === reference.tag && !tag.selfClosing) {
        reference.depth += tag.closing ? -1 : 1;
        if (reference.depth === 0) {
          buffer = reference.saved;
          reference = null;
        }
      }
      continue;
    }

    if (tag.closing) {
      closeFrame(tag.name);
      continue;
    }

    if (DISCARDED_ELEMENTS.has(tag.name)) {
      if (!tag.selfClosing) cursor = skipElement(html, tag.name, tag.end);
      continue;
    }
    if (BREAK_ELEMENTS.has(tag.name)) {
      append(" ");
      continue;
    }

    const epubType = tag.attributes["epub:type"] ?? "";
    if (!tag.selfClosing && hasEpubType(epubType, NOTE_REFERENCE_TYPE)) {
      reference = { tag: tag.name, depth: 1, saved: buffer };
      buffer = "";
      continue;
    }

    const frame = frameFor(tag.name, epubType, stack);
    if (!frame) continue;

    flush();
    if (!tag.selfClosing) stack.push(frame);
  }

  flush();
  return blocks;
}

/** Reads the tag whose `<` sits at `start`. Null when it is not a tag after all. */
export function readTag(source: string, start: number): HtmlTag | null {
  // HTML5's own rule: a `<` not followed by a letter or a slash opens nothing.
  // Without it, the `<` in "a < b" swallows everything up to the next `>` —
  // which in prose is usually the close tag of the paragraph it sits in.
  const first = source[start + 1];
  if (first === undefined || !TAG_START.test(first)) return null;

  const end = findTagEnd(source, start);
  if (end === -1) return null;

  let raw = source.slice(start + 1, end).trim();
  const closing = raw.startsWith("/");
  if (closing) raw = raw.slice(1).trim();
  const selfClosing = raw.endsWith("/");
  if (selfClosing) raw = raw.slice(0, -1);

  const name = TAG_NAME.exec(raw);
  if (!name) return null;

  return {
    name: name[1]!.toLowerCase(),
    attributes: parseAttributes(raw.slice(name[1]!.length)),
    closing,
    selfClosing,
    end: end + 1,
  };
}

export function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

  for (let match = pattern.exec(raw); match; match = pattern.exec(raw)) {
    attributes[match[1]!.toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

/**
 * Decodes entities, then collapses whitespace runs and trims.
 *
 * The order matters: `&nbsp;` becomes U+00A0, which JavaScript's `\s` already
 * covers, so it folds into an ordinary space instead of surviving as an
 * invisible character that a TTS engine would read as part of a word.
 */
export function cleanText(raw: string): string {
  return decodeEntities(raw).replace(/\s+/g, " ").trim();
}

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;

  return text.replace(ENTITY, (match: string, body: string) => {
    if (!body.startsWith("#")) return NAMED_ENTITIES[body.toLowerCase()] ?? match;

    const hexadecimal = body[1] === "x" || body[1] === "X";
    const code = Number.parseInt(hexadecimal ? body.slice(2) : body.slice(1), hexadecimal ? 16 : 10);
    return fromCodePoint(code) ?? match;
  });
}

// ---------------------------------------------------------------------------

function frameFor(name: string, epubType: string, stack: Frame[]): Frame | null {
  const note = hasEpubType(epubType, ...NOTE_BODY_TYPES);
  const level = HEADING_LEVELS[name];
  if (level !== undefined) return { tag: name, kind: "heading", level, block: true, note };

  const kind = BLOCK_ELEMENTS[name];
  if (kind) {
    // Inline `<code>` inside prose must not split the sentence around it, so it
    // only opens a block when nothing narratable is already open.
    if (name === "code" && stack[stack.length - 1]?.block) return null;
    return { tag: name, kind, block: true, note };
  }

  if (SEPARATOR_ELEMENTS.has(name) || note) return { tag: name, kind: "paragraph", block: false, note };
  return null;
}

function resolveKind(stack: Frame[]): { kind: BlockKind; level?: number } {
  const innermost = stack[stack.length - 1];
  let kind: BlockKind = innermost?.kind ?? "paragraph";

  // A paragraph inside a quote or a code listing is still quoted or code: the
  // wrapper carries the meaning and the inner element is only layout.
  if (kind === "paragraph" || kind === "list_item") {
    for (const frame of stack) {
      if (frame.kind === "quote" || frame.kind === "code") kind = frame.kind;
    }
  }
  // A note body wins outright — it is never narrated whatever it looks like.
  if (stack.some((frame) => frame.note)) kind = "footnote";

  return kind === "heading" ? { kind, level: innermost?.level } : { kind };
}

function hasEpubType(value: string, ...wanted: string[]): boolean {
  if (!value) return false;
  const declared = value.toLowerCase().split(/\s+/);
  return wanted.some((type) => declared.includes(type));
}

/**
 * Index just past `</name>`, or the end of the document when it never closes.
 *
 * A plain search rather than a tag walk, because the whole point of skipping
 * `<script>` and `<style>` is that their contents are not markup and a `<` in
 * them means nothing.
 */
function skipElement(source: string, name: string, from: number): number {
  const closing = new RegExp(`</\\s*${name}\\s*>`, "gi");
  closing.lastIndex = from;
  const match = closing.exec(source);
  return match ? match.index + match[0].length : source.length;
}

/** Index of the `>` that ends the tag, skipping any inside quoted attributes. */
function findTagEnd(source: string, start: number): number {
  let quote = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function fromCodePoint(code: number): string | null {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return null;
  // A lone surrogate would poison the string for anything that re-encodes it.
  if (code >= 0xd800 && code <= 0xdfff) return null;
  return String.fromCodePoint(code);
}
