/**
 * EPUB to book structure.
 *
 * Everything works off the OPF package document: the spine gives reading order,
 * the manifest resolves it to files, and the navigation document (EPUB 3) or
 * NCX (EPUB 2) supplies chapter titles. Both navigation generations are read
 * because plenty of shipping books still carry only the older one.
 *
 * Anything the file gets wrong that can be worked around becomes a warning
 * rather than a failure — a book that is 95% readable is far more use to
 * someone than a hard error — so `BookExtractionError` is reserved for files
 * that are not usable EPUBs at all.
 */

import { cleanText, parseHtmlBlocks, readTag, type ParsedBlock } from "./html.ts";
import { readZip, readZipText, tryReadZipText } from "../zip.ts";
import {
  BookExtractionError,
  type Block,
  type Chapter,
  type ChapterLandmark,
  type ExtractionResult,
} from "../types.ts";

/** Media types the spine may point at and this module can read as text. */
const DOCUMENT_MEDIA_TYPES = new Set([
  "application/xhtml+xml",
  "text/html",
  "application/xml",
  "text/xml",
  "application/x-dtbook+xml",
]);

/**
 * Resources that are never text, skipped before the archive is read.
 *
 * Images and fonts are the bulk of an illustrated EPUB and none of its prose,
 * so leaving them unread keeps peak memory proportional to the book's text.
 * The list is an exclusion rather than an inclusion so that a content document
 * with an unusual extension is still picked up.
 */
const BINARY_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "ico", "svg",
  "ttf", "otf", "woff", "woff2", "eot", "pdf", "zip", "bin",
  "mp3", "m4a", "m4b", "wav", "ogg", "oga", "opus", "mp4", "m4v", "webm", "mov",
]);

/**
 * Landmark names from both generations, mapped onto the shared vocabulary.
 *
 * EPUB 2's `guide` and EPUB 3's `landmarks` overlap heavily but disagree on a
 * few names — `text` versus `bodymatter` most importantly — so one table covers
 * both and the caller does not have to care which it is reading.
 */
const LANDMARK_TYPES: Record<string, ChapterLandmark> = {
  cover: "cover",
  toc: "toc",
  "title-page": "titlepage",
  titlepage: "titlepage",
  "copyright-page": "copyright",
  copyright: "copyright",
  text: "bodymatter",
  bodymatter: "bodymatter",
  frontmatter: "frontmatter",
  backmatter: "backmatter",
  index: "index",
  bibliography: "bibliography",
  glossary: "glossary",
  acknowledgements: "acknowledgements",
  acknowledgments: "acknowledgements",
};

interface XmlElement {
  attributes: Record<string, string>;
  /** Markup between the tags; empty for a self-closing element. */
  inner: string;
}

interface ManifestItem {
  /** Archive path, already resolved against the package document's directory. */
  href: string;
  mediaType: string;
  properties: string;
}

interface NavEntry {
  href: string;
  label: string;
  /** Nesting depth in the table of contents, 1 for a top-level entry. */
  depth: number;
  epubType: string;
}

export function extractEpub(data: Uint8Array, filename: string): ExtractionResult {
  const warnings: string[] = [];
  const entries = readZip(data, { include: (name) => !isBinaryResource(name) });

  const packagePath = findPackagePath(entries);
  const packageDirectory = directoryOf(packagePath);
  const packageXml = readZipText(entries, packagePath);

  const manifestElement = scanElements(packageXml, "manifest")[0];
  const spineElement = scanElements(packageXml, "spine")[0];
  if (!manifestElement || !spineElement) {
    throw new BookExtractionError("not a usable epub: the package document has no manifest or spine");
  }

  const metadata = readMetadata(packageXml, warnings);
  const items = readManifest(manifestElement, packageDirectory, warnings);
  // `linear="no"` itemrefs sit outside the main flow — endnote pages, colophons
  // — but they are still the book's own words, so they are read in place rather
  // than dropped and left for the filtering stage to judge.
  const spineIds = scanElements(spineElement.inner, "itemref")
    .map((itemref) => itemref.attributes.idref ?? "")
    .filter((idref) => idref !== "");

  const spineHrefs = spineIds.map((idref) => items.get(idref)?.href).filter((href): href is string => Boolean(href));
  requireReadableContent(entries, packagePath, spineHrefs, warnings);

  const titles = new Map<string, NavEntry>();
  const landmarks = new Map<string, ChapterLandmark>();
  readGuide(packageXml, packageDirectory, landmarks);
  readNavigation(entries, items, spineElement.attributes.toc, titles, landmarks, warnings);

  const blocks: Block[] = [];
  const chapters: Chapter[] = [];

  for (const idref of spineIds) {
    const item = items.get(idref);
    if (!item) {
      warnings.push(`the spine references an unknown manifest item "${idref}"`);
      continue;
    }
    if (item.mediaType && !DOCUMENT_MEDIA_TYPES.has(item.mediaType)) {
      warnings.push(`skipped the non-text spine entry ${item.href} (${item.mediaType})`);
      continue;
    }

    const source = tryReadZipText(entries, item.href);
    if (source === undefined) {
      warnings.push(`the spine references ${item.href}, which is missing from the archive`);
      continue;
    }

    const parsed = parseHtmlBlocks(source);
    if (parsed.length === 0) warnings.push(`${item.href} contained no readable text`);

    // The chapter is kept even when it is empty: dropping it would also drop
    // the landmark that says what it was, which is exactly the signal the
    // filtering stage needs to recognise covers and copyright pages.
    chapters.push(appendChapter(chapters.length, parsed, blocks, item, titles, landmarks));
  }

  if (chapters.length === 0) {
    throw new BookExtractionError("not a usable epub: the spine contains no readable documents");
  }

  return {
    structure: {
      title: metadata.title || stemOf(filename),
      author: metadata.author,
      language: metadata.language,
      chapters,
      blocks,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Package document
// ---------------------------------------------------------------------------

function findPackagePath(entries: Map<string, Uint8Array>): string {
  const container = tryReadZipText(entries, "META-INF/container.xml");
  if (container === undefined) {
    throw new BookExtractionError("not an epub: META-INF/container.xml is missing");
  }

  const rootfiles = scanElements(container, "rootfile");
  // A container may list several renditions; the first OPF one is the default
  // rendition every reader opens.
  const chosen =
    rootfiles.find((file) => file.attributes["media-type"] === "application/oebps-package+xml") ?? rootfiles[0];

  const path = chosen?.attributes["full-path"];
  if (!path) throw new BookExtractionError("not an epub: container.xml declares no package document");
  return resolveHref("", path);
}

function readMetadata(packageXml: string, warnings: string[]): { title: string; author: string; language: string } {
  const metadata = scanElements(packageXml, "metadata")[0];
  if (!metadata) {
    warnings.push("the package document has no metadata section");
    return { title: "", author: "", language: "" };
  }

  const title = textOf(scanElements(metadata.inner, "title")[0]);
  if (!title) warnings.push("the package document declares no dc:title");

  return {
    title,
    author: textOf(scanElements(metadata.inner, "creator")[0]),
    language: textOf(scanElements(metadata.inner, "language")[0]),
  };
}

function readManifest(
  manifest: XmlElement,
  packageDirectory: string,
  warnings: string[],
): Map<string, ManifestItem> {
  const items = new Map<string, ManifestItem>();

  for (const item of scanElements(manifest.inner, "item")) {
    const id = item.attributes.id;
    const href = item.attributes.href;
    if (!id || !href) {
      warnings.push("the manifest contains an item with no id or href");
      continue;
    }
    items.set(id, {
      href: resolveHref(packageDirectory, href),
      mediaType: (item.attributes["media-type"] ?? "").toLowerCase(),
      properties: (item.attributes.properties ?? "").toLowerCase(),
    });
  }

  return items;
}

/**
 * Rejects the file when its actual content is encrypted.
 *
 * `META-INF/encryption.xml` on its own is not DRM: the same mechanism carries
 * the IDPF font obfuscation that a great many legitimate books use. Only an
 * encrypted package document or spine document makes the book unreadable, so
 * that is what is checked, and font mangling is merely reported.
 */
function requireReadableContent(
  entries: Map<string, Uint8Array>,
  packagePath: string,
  spineHrefs: string[],
  warnings: string[],
): void {
  const encryptionXml = tryReadZipText(entries, "META-INF/encryption.xml");
  if (encryptionXml === undefined) return;

  const encrypted = new Set<string>();
  for (const reference of scanElements(encryptionXml, "CipherReference")) {
    const uri = reference.attributes.uri;
    if (uri) encrypted.add(resolveHref("", uri));
  }

  const blocked = [packagePath, ...spineHrefs].find((path) => encrypted.has(path));
  if (blocked) {
    throw new BookExtractionError(`the epub is DRM-protected: ${blocked} is encrypted and cannot be read`);
  }
  if (encrypted.size > 0) {
    warnings.push(`${encrypted.size} resource(s) are obfuscated or encrypted and were left unread`);
  }
}

function readGuide(
  packageXml: string,
  packageDirectory: string,
  landmarks: Map<string, ChapterLandmark>,
): void {
  const guide = scanElements(packageXml, "guide")[0];
  if (!guide) return;

  for (const reference of scanElements(guide.inner, "reference")) {
    const landmark = LANDMARK_TYPES[(reference.attributes.type ?? "").toLowerCase()];
    const href = reference.attributes.href;
    if (landmark && href) landmarks.set(resolveHref(packageDirectory, href), landmark);
  }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function readNavigation(
  entries: Map<string, Uint8Array>,
  items: Map<string, ManifestItem>,
  ncxId: string | undefined,
  titles: Map<string, NavEntry>,
  landmarks: Map<string, ChapterLandmark>,
  warnings: string[],
): void {
  const navItem = [...items.values()].find((item) => item.properties.split(/\s+/).includes("nav"));
  const navXml = navItem ? tryReadZipText(entries, navItem.href) : undefined;

  if (navItem && navXml !== undefined) {
    const navDirectory = directoryOf(navItem.href);
    for (const nav of scanElements(navXml, "nav")) {
      const type = (nav.attributes["epub:type"] ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const links = parseNavLinks(nav.inner, navDirectory);

      if (type.includes("landmarks")) {
        // EPUB 3 landmarks are more precise than the EPUB 2 guide, so they
        // overwrite anything the guide already claimed for the same document.
        for (const link of links) {
          const landmark = LANDMARK_TYPES[link.epubType.split(/\s+/)[0] ?? ""];
          if (landmark) landmarks.set(link.href, landmark);
        }
      } else if (type.includes("toc") || type.length === 0) {
        // An untyped nav is almost always the table of contents; a page-list or
        // any other named nav is left alone.
        recordTitles(links, titles);
      }
    }
    return;
  }

  const ncxHref = ncxId ? items.get(ncxId)?.href : undefined;
  const ncxXml = ncxHref ? tryReadZipText(entries, ncxHref) : undefined;
  if (ncxHref !== undefined && ncxXml !== undefined) {
    recordTitles(parseNcxPoints(ncxXml, directoryOf(ncxHref), 1), titles);
    return;
  }

  warnings.push("the epub has no navigation document; chapter titles fall back to their headings");
}

/**
 * Keeps the first label seen for each document.
 *
 * Sub-sections point at the same file with a fragment, and once the fragment is
 * stripped the deepest of them would otherwise end up naming the chapter.
 */
function recordTitles(links: NavEntry[], titles: Map<string, NavEntry>): void {
  for (const link of links) {
    if (link.href && link.label && !titles.has(link.href)) titles.set(link.href, link);
  }
}

function parseNavLinks(xml: string, baseDirectory: string): NavEntry[] {
  const links: NavEntry[] = [];
  let depth = 0;
  let cursor = 0;

  while (cursor < xml.length) {
    const open = xml.indexOf("<", cursor);
    if (open === -1) break;

    const tag = readTag(xml, open);
    if (!tag) {
      cursor = open + 1;
      continue;
    }
    cursor = tag.end;

    const name = localName(tag.name);
    if ((name === "ol" || name === "ul") && !tag.selfClosing) {
      depth += tag.closing ? -1 : 1;
      continue;
    }
    if (name !== "a" || tag.closing || tag.selfClosing) continue;

    const close = findClosingTag(xml, "a", tag.end);
    links.push({
      href: resolveHref(baseDirectory, tag.attributes.href ?? ""),
      label: textContent(xml.slice(tag.end, close.start)),
      depth: Math.max(1, depth),
      epubType: (tag.attributes["epub:type"] ?? "").toLowerCase(),
    });
    cursor = close.next;
  }

  return links;
}

function parseNcxPoints(xml: string, baseDirectory: string, depth: number): NavEntry[] {
  const links: NavEntry[] = [];

  for (const point of scanElements(xml, "navPoint")) {
    // A navPoint's own label and target always precede its children, so the
    // first of each inside it is this point's rather than a descendant's.
    const label = textOf(scanElements(point.inner, "navLabel")[0]);
    const src = scanElements(point.inner, "content")[0]?.attributes.src;
    if (src) links.push({ href: resolveHref(baseDirectory, src), label, depth, epubType: "" });

    links.push(...parseNcxPoints(point.inner, baseDirectory, depth + 1));
  }

  return links;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function appendChapter(
  chapterIndex: number,
  parsed: ParsedBlock[],
  blocks: Block[],
  item: ManifestItem,
  titles: Map<string, NavEntry>,
  landmarks: Map<string, ChapterLandmark>,
): Chapter {
  const chapterId = `ch-${chapterIndex}`;
  const blockIds: string[] = [];

  for (const [blockIndex, parsedBlock] of parsed.entries()) {
    const block: Block = {
      id: `${chapterIndex}:${blockIndex}`,
      kind: parsedBlock.kind,
      text: parsedBlock.text,
      chapterId,
      // `blocks` is the whole book in reading order, so its length before the
      // push is already the global index this block occupies.
      order: blocks.length,
    };
    if (parsedBlock.level !== undefined) block.level = parsedBlock.level;
    blocks.push(block);
    blockIds.push(block.id);
  }

  const navEntry = titles.get(item.href);
  const heading = parsed.find((block) => block.kind === "heading");
  const chapter: Chapter = {
    id: chapterId,
    // The navigation label is the author's own name for the chapter, so it
    // beats the first heading, which is often just "1" or a decorative image's
    // alt text, and the filename is only ever a last resort.
    title: navEntry?.label || heading?.text || stemOf(item.href),
    level: navEntry?.depth ?? heading?.level ?? 1,
    order: chapterIndex,
    blockIds,
  };

  const landmark = landmarks.get(item.href);
  if (landmark) chapter.landmark = landmark;
  return chapter;
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

/** Local name, so `<dc:title>` and `<title>` are the same element. */
function localName(name: string): string {
  return name.slice(name.indexOf(":") + 1);
}

/**
 * Every element with the given local name, not descending into a match.
 *
 * Skipping a match's interior is what makes nesting work: `scanElements` on a
 * navMap returns the top-level navPoints, and recursing into each one's `inner`
 * walks the tree a level at a time.
 */
function scanElements(xml: string, name: string): XmlElement[] {
  const target = name.toLowerCase();
  const found: XmlElement[] = [];
  let cursor = 0;

  while (cursor < xml.length) {
    const open = xml.indexOf("<", cursor);
    if (open === -1) break;

    if (xml.startsWith("<!--", open)) {
      const commentEnd = xml.indexOf("-->", open + 4);
      cursor = commentEnd === -1 ? xml.length : commentEnd + 3;
      continue;
    }

    const tag = readTag(xml, open);
    if (!tag) {
      cursor = open + 1;
      continue;
    }
    cursor = tag.end;
    if (tag.closing || localName(tag.name) !== target) continue;

    if (tag.selfClosing) {
      found.push({ attributes: tag.attributes, inner: "" });
      continue;
    }
    const close = findClosingTag(xml, target, tag.end);
    found.push({ attributes: tag.attributes, inner: xml.slice(tag.end, close.start) });
    cursor = close.next;
  }

  return found;
}

/** Where the element opened at `from` closes: `start` is its `<`, `next` past its `>`. */
function findClosingTag(xml: string, target: string, from: number): { start: number; next: number } {
  let cursor = from;
  let depth = 1;

  while (cursor < xml.length) {
    const open = xml.indexOf("<", cursor);
    if (open === -1) break;

    if (xml.startsWith("<!--", open)) {
      // A commented-out close tag would otherwise unbalance the count.
      const commentEnd = xml.indexOf("-->", open + 4);
      cursor = commentEnd === -1 ? xml.length : commentEnd + 3;
      continue;
    }

    const tag = readTag(xml, open);
    if (!tag) {
      cursor = open + 1;
      continue;
    }
    if (!tag.selfClosing && localName(tag.name) === target) {
      depth += tag.closing ? -1 : 1;
      if (depth === 0) return { start: open, next: tag.end };
    }
    cursor = tag.end;
  }

  // Unclosed: treat the rest of the document as the element's content.
  return { start: xml.length, next: xml.length };
}

function textOf(element: XmlElement | undefined): string {
  return element ? textContent(element.inner) : "";
}

/** Text content with all markup removed, entities decoded and whitespace collapsed. */
function textContent(xml: string): string {
  let text = "";
  let cursor = 0;

  while (cursor < xml.length) {
    const open = xml.indexOf("<", cursor);
    if (open === -1) {
      text += xml.slice(cursor);
      break;
    }
    text += xml.slice(cursor, open);

    const tag = readTag(xml, open);
    if (!tag) {
      text += "<";
      cursor = open + 1;
      continue;
    }
    cursor = tag.end;
  }

  return cleanText(text);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Resolves an href to an archive path.
 *
 * Hrefs are URLs, so they carry fragments and percent-encoding that the zip
 * directory does not: `chapter%201.xhtml#part2` addresses the entry
 * `chapter 1.xhtml`.
 */
function resolveHref(baseDirectory: string, href: string): string {
  const withoutFragment = href.split("#")[0] ?? "";

  let decoded = withoutFragment;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    // A stray `%` is not an escape; the raw href is the better guess.
  }

  // A leading slash means the archive root, not the filesystem root.
  if (decoded.startsWith("/")) return normalizePath(decoded.slice(1));
  return normalizePath(baseDirectory ? `${baseDirectory}/${decoded}` : decoded);
}

function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function directoryOf(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}

function stemOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function isBinaryResource(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? false : BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
