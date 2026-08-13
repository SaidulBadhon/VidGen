/**
 * EPUB and plain-text extraction.
 *
 * The ZIP and XHTML parsers are hand-written to keep the dependency list tight,
 * so the fixtures here are hand-written too: a small ZIP writer builds a real
 * archive in memory and the EPUB cases are assembled from it end to end, which
 * is the only way to be sure the readers agree with the format rather than with
 * each other.
 */

import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";

import { BookExtractionError } from "../src/services/book/types.ts";
import { readZip, readZipText, tryReadZipText } from "../src/services/book/zip.ts";
import { cleanText, decodeEntities, parseHtmlBlocks } from "../src/services/book/extract/html.ts";
import { parseTextBlocks } from "../src/services/book/extract/text.ts";
import { extractEpub } from "../src/services/book/extract/epub.ts";
import { detectBookFormat, extractBook } from "../src/services/book/extract/index.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

interface ZipEntry {
  name: string;
  data: Uint8Array | string;
  deflate?: boolean;
  /** Records a different method without changing the bytes, to test rejection. */
  method?: number;
  encrypted?: boolean;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Writes a genuine (if minimal) zip archive, so the reader is tested against the format. */
function buildZip(files: ZipEntry[]): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const plain = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
    const stored = file.deflate ? new Uint8Array(deflateRawSync(plain)) : plain;
    const method = file.method ?? (file.deflate ? 8 : 0);
    const flags = 0x800 | (file.encrypted ? 0x1 : 0);
    const checksum = crc32(plain);

    const header = new Uint8Array(30 + name.length);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, 0x04034b50, true);
    headerView.setUint16(4, 20, true);
    headerView.setUint16(6, flags, true);
    headerView.setUint16(8, method, true);
    headerView.setUint32(14, checksum, true);
    headerView.setUint32(18, stored.length, true);
    headerView.setUint32(22, plain.length, true);
    headerView.setUint16(26, name.length, true);
    header.set(name, 30);

    const directory = new Uint8Array(46 + name.length);
    const directoryView = new DataView(directory.buffer);
    directoryView.setUint32(0, 0x02014b50, true);
    directoryView.setUint16(4, 20, true);
    directoryView.setUint16(6, 20, true);
    directoryView.setUint16(8, flags, true);
    directoryView.setUint16(10, method, true);
    directoryView.setUint32(16, checksum, true);
    directoryView.setUint32(20, stored.length, true);
    directoryView.setUint32(24, plain.length, true);
    directoryView.setUint16(28, name.length, true);
    directoryView.setUint32(42, offset, true);
    directory.set(name, 46);

    local.push(header, stored);
    central.push(directory);
    offset += header.length + stored.length;
  }

  const directorySize = central.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);

  return concat([...local, ...central, end]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((size, part) => size + part.length, 0);
  const output = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    output.set(part, cursor);
    cursor += part.length;
  }
  return output;
}

interface EpubDocument {
  /** Archive path below `OEBPS/`, which is also the manifest href unless `href` differs. */
  path: string;
  body: string;
  id?: string;
  href?: string;
  mediaType?: string;
  linear?: string;
}

interface EpubOptions {
  title?: string;
  author?: string;
  language?: string;
  documents: EpubDocument[];
  /** `<nav>` elements for an EPUB 3 navigation document. */
  nav?: string;
  /** `<navPoint>` elements for an EPUB 2 NCX. */
  ncx?: string;
  /** `<reference>` elements for an EPUB 2 guide. */
  guide?: string;
  extraFiles?: ZipEntry[];
  omitContainer?: boolean;
  deflate?: boolean;
}

function xhtml(body: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n' +
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
    "<head><title>Ignored page title</title></head>" +
    `<body>${body}</body></html>`
  );
}

function buildEpub(options: EpubOptions): Uint8Array {
  const documents = options.documents.map((document, index) => ({ ...document, id: document.id ?? `d${index}` }));

  const manifest = documents.map(
    (document) =>
      `<item id="${document.id}" href="${document.href ?? document.path}" ` +
      `media-type="${document.mediaType ?? "application/xhtml+xml"}"/>`,
  );
  if (options.nav) manifest.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
  if (options.ncx) manifest.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');

  const spine = documents.map(
    (document) => `<itemref idref="${document.id}"${document.linear ? ` linear="${document.linear}"` : ""}/>`,
  );

  const packageXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">' +
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    (options.title === undefined ? "" : `<dc:title>${options.title}</dc:title>`) +
    (options.author === undefined ? "" : `<dc:creator>${options.author}</dc:creator>`) +
    (options.language === undefined ? "" : `<dc:language>${options.language}</dc:language>`) +
    "</metadata>" +
    `<manifest>${manifest.join("")}</manifest>` +
    `<spine toc="ncx">${spine.join("")}</spine>` +
    (options.guide ? `<guide>${options.guide}</guide>` : "") +
    "</package>";

  const files: ZipEntry[] = [
    // The mimetype entry is stored rather than deflated in a real epub, which
    // is also what makes it a useful check that both methods round-trip.
    { name: "mimetype", data: "application/epub+zip" },
  ];
  if (!options.omitContainer) {
    files.push({
      name: "META-INF/container.xml",
      data:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>' +
        '<rootfile full-path="OEBPS/alternate.opf" media-type="application/x-other"/>' +
        '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
        "</rootfiles></container>",
      deflate: options.deflate,
    });
  }
  files.push({ name: "OEBPS/content.opf", data: packageXml, deflate: options.deflate });

  for (const document of documents) {
    files.push({ name: `OEBPS/${document.path}`, data: xhtml(document.body), deflate: options.deflate });
  }
  if (options.nav) {
    files.push({ name: "OEBPS/nav.xhtml", data: xhtml(options.nav), deflate: options.deflate });
  }
  if (options.ncx) {
    files.push({
      name: "OEBPS/toc.ncx",
      data:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">' +
        `<docTitle><text>${options.title ?? ""}</text></docTitle>` +
        `<navMap>${options.ncx}</navMap></ncx>`,
      deflate: options.deflate,
    });
  }
  files.push(...(options.extraFiles ?? []));

  return buildZip(files);
}

/** The smallest book the other suites can lean on: two chapters, an EPUB 3 nav. */
function sampleEpub(): Uint8Array {
  return buildEpub({
    title: "A Study in Scarlet",
    author: "Arthur Conan Doyle",
    language: "en-GB",
    documents: [
      { path: "ch1.xhtml", body: "<h1>Mr. Sherlock Holmes</h1><p>In the year 1878.</p>" },
      { path: "ch2.xhtml", body: "<h1>The Science of Deduction</h1><p>We met the next day.</p>" },
    ],
    nav:
      '<nav epub:type="toc"><ol>' +
      '<li><a href="ch1.xhtml">Chapter One</a></li>' +
      '<li><a href="ch2.xhtml">Chapter Two</a><ol><li><a href="ch2.xhtml#part2">A subsection</a></li></ol></li>' +
      "</ol></nav>",
  });
}

const kinds = (html: string) => parseHtmlBlocks(html).map((block) => block.kind);
const texts = (html: string) => parseHtmlBlocks(html).map((block) => block.text);

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

describe("readZip", () => {
  test("round-trips stored and deflated entries", () => {
    const archive = buildZip([
      { name: "stored.txt", data: "kept verbatim" },
      { name: "packed.txt", data: "compressed ".repeat(200), deflate: true },
    ]);
    const entries = readZip(archive);

    expect(entries.size).toBe(2);
    expect(readZipText(entries, "stored.txt")).toBe("kept verbatim");
    expect(readZipText(entries, "packed.txt")).toBe("compressed ".repeat(200));
  });

  test("decodes a UTF-8 entry name", () => {
    const entries = readZip(buildZip([{ name: "OEBPS/café–deux.xhtml", data: "oui" }]));
    expect(readZipText(entries, "OEBPS/café–deux.xhtml")).toBe("oui");
  });

  test("finds the directory past a trailing archive comment", () => {
    const archive = buildZip([{ name: "a.txt", data: "one" }]);
    const comment = encoder.encode("this archive has something to say");
    const withComment = concat([archive, comment]);
    new DataView(withComment.buffer).setUint16(archive.length - 2, comment.length, true);

    expect(readZipText(readZip(withComment), "a.txt")).toBe("one");
  });

  test("skips entries the caller filters out", () => {
    const archive = buildZip([
      { name: "text.xhtml", data: "keep" },
      { name: "cover.png", data: "drop" },
    ]);
    const entries = readZip(archive, { include: (name) => !name.endsWith(".png") });

    expect([...entries.keys()]).toEqual(["text.xhtml"]);
  });

  test("refuses an archive that expands beyond its byte budget", () => {
    // 40 KB of one repeated character deflates to a couple of hundred bytes:
    // the shape of a zip bomb, in miniature.
    const archive = buildZip([{ name: "bomb.txt", data: "a".repeat(40_000), deflate: true }]);
    expect(archive.length).toBeLessThan(1_000);

    expect(() => readZip(archive, { maxTotalBytes: 4_096 })).toThrow(/expands to more than/);
    expect(readZip(archive, { maxTotalBytes: 40_000 }).get("bomb.txt")).toHaveLength(40_000);
  });

  test("refuses a stored entry that exceeds the remaining budget", () => {
    const archive = buildZip([
      { name: "a.txt", data: "x".repeat(80) },
      { name: "b.txt", data: "y".repeat(80) },
    ]);
    expect(() => readZip(archive, { maxTotalBytes: 100 })).toThrow(/expands to more than/);
  });

  test("refuses an archive with more entries than allowed", () => {
    const archive = buildZip([
      { name: "a.txt", data: "one" },
      { name: "b.txt", data: "two" },
    ]);
    expect(() => readZip(archive, { maxEntries: 1 })).toThrow(/more than the 1 allowed/);
  });

  test("keeps the first of two entries sharing a name", () => {
    const entries = readZip(
      buildZip([
        { name: "dup.txt", data: "original" },
        { name: "dup.txt", data: "shadow" },
      ]),
    );
    expect(readZipText(entries, "dup.txt")).toBe("original");
  });

  test("reports a missing entry", () => {
    const entries = readZip(buildZip([{ name: "a.txt", data: "one" }]));
    expect(tryReadZipText(entries, "nope.txt")).toBeUndefined();
    expect(() => readZipText(entries, "nope.txt")).toThrow(BookExtractionError);
  });

  test("rejects a file that is not a zip", () => {
    expect(() => readZip(encoder.encode("this is prose, not an archive"))).toThrow(BookExtractionError);
    expect(() => readZip(new Uint8Array(4))).toThrow(BookExtractionError);
  });

  test("rejects a truncated archive", () => {
    const archive = buildZip([{ name: "a.txt", data: "one" }]);
    expect(() => readZip(archive.slice(0, archive.length - 6))).toThrow(BookExtractionError);
  });

  test("rejects a directory offset that points past the end", () => {
    const archive = buildZip([{ name: "a.txt", data: "one" }]);
    new DataView(archive.buffer).setUint32(archive.length - 6, 0xfffffff0 >>> 1, true);
    expect(() => readZip(archive)).toThrow(BookExtractionError);
  });

  test("rejects an entry path that escapes the archive root", () => {
    expect(() => readZip(buildZip([{ name: "../escape.txt", data: "x" }]))).toThrow(/unsafe entry path/);
    expect(() => readZip(buildZip([{ name: "/etc/passwd", data: "x" }]))).toThrow(/unsafe entry path/);
    expect(() => readZip(buildZip([{ name: "OEBPS\\ch1.xhtml", data: "x" }]))).toThrow(/unsafe entry path/);
  });

  test("rejects an encrypted entry as DRM-protected", () => {
    const archive = buildZip([{ name: "secret.xhtml", data: "locked", encrypted: true }]);
    expect(() => readZip(archive)).toThrow(/DRM-protected/);
  });

  test("rejects an unsupported compression method", () => {
    const archive = buildZip([{ name: "odd.txt", data: "x", method: 12 }]);
    expect(() => readZip(archive)).toThrow(/compression method 12/);
  });
});

// ---------------------------------------------------------------------------
// html
// ---------------------------------------------------------------------------

describe("parseHtmlBlocks", () => {
  test("maps heading levels", () => {
    const blocks = parseHtmlBlocks("<h1>One</h1><h3>Three</h3><h6>Six</h6>");
    expect(blocks.map((block) => [block.kind, block.level])).toEqual([
      ["heading", 1],
      ["heading", 3],
      ["heading", 6],
    ]);
  });

  test("leaves level unset on everything that is not a heading", () => {
    const [block] = parseHtmlBlocks("<p>Prose.</p>");
    expect(block?.level).toBeUndefined();
  });

  test("maps the block-level elements", () => {
    expect(kinds("<p>a</p>")).toEqual(["paragraph"]);
    expect(kinds("<ul><li>a</li><li>b</li></ul>")).toEqual(["list_item", "list_item"]);
    expect(kinds("<blockquote>a</blockquote>")).toEqual(["quote"]);
    expect(kinds("<pre>a</pre>")).toEqual(["code"]);
    expect(kinds("<figure><figcaption>a</figcaption></figure>")).toEqual(["caption"]);
  });

  test("gives a nested block to the innermost element, without repeating its text", () => {
    const blocks = parseHtmlBlocks("<blockquote><p>Quoted line.</p></blockquote>");
    expect(blocks).toEqual([{ kind: "quote", text: "Quoted line." }]);
  });

  test("keeps a wrapper's own text separate from its nested blocks", () => {
    const blocks = parseHtmlBlocks("<blockquote>Lead in.<p>Quoted line.</p></blockquote>");
    expect(blocks).toEqual([
      { kind: "quote", text: "Lead in." },
      { kind: "quote", text: "Quoted line." },
    ]);
  });

  test("keeps a list item inside a quote a quote", () => {
    expect(kinds("<blockquote><ul><li>a</li></ul></blockquote>")).toEqual(["quote"]);
  });

  test("separates adjacent containers", () => {
    expect(texts("<div>First.</div><div>Second.</div>")).toEqual(["First.", "Second."]);
    expect(texts("<div><p>Nested.</p>Trailing.</div>")).toEqual(["Nested.", "Trailing."]);
  });

  test("keeps inline code inside its paragraph but promotes a standalone listing", () => {
    expect(parseHtmlBlocks("<p>Call <code>run()</code> twice.</p>")).toEqual([
      { kind: "paragraph", text: "Call run() twice." },
    ]);
    expect(kinds("<div><code>run()</code></div>")).toEqual(["code"]);
    expect(kinds("<pre><code>run()</code></pre>")).toEqual(["code"]);
  });

  test("strips inline markup while keeping its text", () => {
    expect(texts('<p>A <em>bold</em><strong>ish</strong> <a href="x">link</a>.</p>')).toEqual(["A boldish link."]);
  });

  test("drops script, style and head content", () => {
    const html = "<head><title>Title</title></head><body><style>p { color: red > blue }</style>" +
      "<script>if (a < b) { document.write('x') }</script><p>Only this.</p></body>";
    expect(parseHtmlBlocks(html)).toEqual([{ kind: "paragraph", text: "Only this." }]);
  });

  test("decodes named, decimal and hexadecimal entities", () => {
    expect(texts("<p>Tom &amp; Jerry &mdash; &#8220;quoted&#x201d; &hellip;</p>")).toEqual([
      "Tom & Jerry — “quoted” …",
    ]);
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeEntities("&notanentity; &#xZZ;")).toBe("&notanentity; &#xZZ;");
  });

  test("folds a non-breaking space into an ordinary one", () => {
    expect(texts("<p>Chapter&nbsp;IV</p>")).toEqual(["Chapter IV"]);
  });

  test("collapses whitespace runs across lines", () => {
    expect(texts("<p>\n  Wrapped   over\n\t lines.\n</p>")).toEqual(["Wrapped over lines."]);
  });

  test("drops blocks that clean up empty", () => {
    expect(parseHtmlBlocks("<p></p><p>   </p><p>&nbsp;</p><div></div><p>Real.</p>")).toEqual([
      { kind: "paragraph", text: "Real." },
    ]);
  });

  test("handles comments, self-closing tags and > inside attribute values", () => {
    const html = '<!-- <p>hidden</p> --><p>Before<br/>after</p><img src="a.png" alt="b > a"/><p title="x > y">Next.</p>';
    expect(parseHtmlBlocks(html)).toEqual([
      { kind: "paragraph", text: "Before after" },
      { kind: "paragraph", text: "Next." },
    ]);
  });

  test("treats a bare angle bracket in prose as text", () => {
    expect(texts("<p>when a &lt; b, and c < d</p>")).toEqual(["when a < b, and c < d"]);
  });

  test("recovers from unclosed elements", () => {
    expect(parseHtmlBlocks("<div><p>First.<p>Second.</div>")).toEqual([
      { kind: "paragraph", text: "First." },
      { kind: "paragraph", text: "Second." },
    ]);
  });

  test("marks a note body from epub:type", () => {
    expect(kinds('<aside epub:type="footnote"><p>A note.</p></aside>')).toEqual(["footnote"]);
    expect(kinds('<p epub:type="endnote">A note.</p>')).toEqual(["footnote"]);
    expect(kinds('<div epub:type="rearnote">A note.</div>')).toEqual(["footnote"]);
  });

  test("strips a noteref marker without breaking up the sentence", () => {
    const blocks = parseHtmlBlocks(
      '<p>The hound was real.<a epub:type="noteref" href="#fn1">12</a> Everyone agreed.</p>',
    );
    expect(blocks).toEqual([{ kind: "paragraph", text: "The hound was real. Everyone agreed." }]);
  });

  test("strips a noteref that wraps other inline markup", () => {
    const blocks = parseHtmlBlocks('<p>Real.<sup epub:type="noteref"><a href="#fn1">12</a></sup> Agreed.</p>');
    expect(blocks).toEqual([{ kind: "paragraph", text: "Real. Agreed." }]);
  });

  test("returns nothing for a document with no text", () => {
    expect(parseHtmlBlocks("<html><body><div><span> </span></div></body></html>")).toEqual([]);
  });

  test("cleanText is idempotent", () => {
    expect(cleanText("  a  &amp;  b ")).toBe("a & b");
  });
});

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

describe("parseTextBlocks", () => {
  test("splits paragraphs on blank lines and joins wrapped ones", () => {
    expect(parseTextBlocks("First one,\nwrapped over lines.\n\n\nSecond one.\n")).toEqual([
      { kind: "paragraph", text: "First one, wrapped over lines." },
      { kind: "paragraph", text: "Second one." },
    ]);
  });

  test("reads ATX headings at their level", () => {
    expect(parseTextBlocks("# One\n\n### Three ###\n\nBody.")).toEqual([
      { kind: "heading", text: "One", level: 1 },
      { kind: "heading", text: "Three", level: 3 },
      { kind: "paragraph", text: "Body." },
    ]);
  });

  test("reads setext headings", () => {
    expect(parseTextBlocks("Title\n=====\n\nSubtitle\n--------\n\nBody.")).toEqual([
      { kind: "heading", text: "Title", level: 1 },
      { kind: "heading", text: "Subtitle", level: 2 },
      { kind: "paragraph", text: "Body." },
    ]);
  });

  test("treats a rule with nothing above it as a rule", () => {
    expect(parseTextBlocks("---\n\nBody.")).toEqual([{ kind: "paragraph", text: "Body." }]);
  });

  test("handles CRLF and returns nothing for an empty file", () => {
    expect(parseTextBlocks("One.\r\n\r\nTwo.")).toHaveLength(2);
    expect(parseTextBlocks("   \n\n \t \n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// epub
// ---------------------------------------------------------------------------

describe("extractEpub", () => {
  test("reads metadata and both chapters", () => {
    const { structure, warnings } = extractEpub(sampleEpub(), "scarlet.epub");

    expect(structure.title).toBe("A Study in Scarlet");
    expect(structure.author).toBe("Arthur Conan Doyle");
    expect(structure.language).toBe("en-GB");
    expect(structure.chapters).toHaveLength(2);
    expect(warnings).toEqual([]);
  });

  test("follows the spine rather than the archive order", () => {
    const book = buildEpub({
      title: "Ordered",
      documents: [
        { path: "z-last.xhtml", id: "third", body: "<p>Third.</p>" },
        { path: "a-first.xhtml", id: "first", body: "<p>First.</p>" },
        { path: "m-middle.xhtml", id: "second", body: "<p>Second.</p>" },
      ],
    });
    // The spine follows the document list, so the archive's alphabetical order
    // and the reading order disagree on purpose.
    const { structure } = extractEpub(book, "ordered.epub");

    expect(structure.blocks.map((block) => block.text)).toEqual(["Third.", "First.", "Second."]);
  });

  test("takes chapter titles from the navigation document", () => {
    const { structure } = extractEpub(sampleEpub(), "scarlet.epub");
    expect(structure.chapters.map((chapter) => chapter.title)).toEqual(["Chapter One", "Chapter Two"]);
  });

  test("does not let a sub-entry rename the chapter it points into", () => {
    const { structure } = extractEpub(sampleEpub(), "scarlet.epub");
    expect(structure.chapters[1]?.title).toBe("Chapter Two");
  });

  test("falls back to the first heading, then to the filename stem", () => {
    const book = buildEpub({
      title: "Fallbacks",
      documents: [
        { path: "ch1.xhtml", body: "<h2>Heading Wins</h2><p>Body.</p>" },
        { path: "afterword.xhtml", body: "<p>No heading at all.</p>" },
      ],
    });
    const { structure, warnings } = extractEpub(book, "fallbacks.epub");

    expect(structure.chapters.map((chapter) => chapter.title)).toEqual(["Heading Wins", "afterword"]);
    expect(structure.chapters[0]?.level).toBe(2);
    expect(warnings).toContain("the epub has no navigation document; chapter titles fall back to their headings");
  });

  test("reads chapter titles from an EPUB 2 NCX when there is no nav document", () => {
    const book = buildEpub({
      title: "Old School",
      documents: [
        { path: "ch1.html", body: "<p>One.</p>", mediaType: "text/html" },
        { path: "ch2.html", body: "<p>Two.</p>", mediaType: "text/html" },
      ],
      ncx:
        "<navPoint><navLabel><text>The First Part</text></navLabel><content src=\"ch1.html\"/>" +
        "<navPoint><navLabel><text>A Nested Part</text></navLabel><content src=\"ch2.html\"/></navPoint>" +
        "</navPoint>",
    });
    const { structure, warnings } = extractEpub(book, "old.epub");

    expect(structure.chapters.map((chapter) => chapter.title)).toEqual(["The First Part", "A Nested Part"]);
    expect(structure.chapters.map((chapter) => chapter.level)).toEqual([1, 2]);
    expect(warnings).toEqual([]);
  });

  test("maps EPUB 3 landmarks onto chapters", () => {
    const book = buildEpub({
      title: "Landmarked",
      documents: [
        { path: "cover.xhtml", body: "<p>Cover.</p>" },
        { path: "copyright.xhtml", body: "<p>All rights reserved.</p>" },
        { path: "ch1.xhtml", body: "<p>Body.</p>" },
        { path: "index.xhtml", body: "<p>Index.</p>" },
      ],
      nav:
        '<nav epub:type="toc"><ol><li><a href="ch1.xhtml">Chapter One</a></li></ol></nav>' +
        '<nav epub:type="landmarks"><ol>' +
        '<li><a epub:type="cover" href="cover.xhtml">Cover</a></li>' +
        '<li><a epub:type="copyright-page" href="copyright.xhtml">Copyright</a></li>' +
        '<li><a epub:type="bodymatter" href="ch1.xhtml">Start</a></li>' +
        '<li><a epub:type="index" href="index.xhtml">Index</a></li>' +
        "</ol></nav>",
    });
    const { structure } = extractEpub(book, "landmarked.epub");

    expect(structure.chapters.map((chapter) => chapter.landmark)).toEqual([
      "cover",
      "copyright",
      "bodymatter",
      "index",
    ]);
  });

  test("maps an EPUB 2 guide onto chapters", () => {
    const book = buildEpub({
      title: "Guided",
      documents: [
        { path: "cover.html", body: "<p>Cover.</p>" },
        { path: "title.html", body: "<p>Title page.</p>" },
        { path: "ch1.html", body: "<p>Body.</p>" },
        { path: "notes.html", body: "<p>Notes.</p>" },
      ],
      guide:
        '<reference type="cover" href="cover.html" title="Cover"/>' +
        '<reference type="title-page" href="title.html" title="Title"/>' +
        '<reference type="text" href="ch1.html" title="Beginning"/>' +
        '<reference type="acknowledgements" href="notes.html" title="Thanks"/>',
    });
    const { structure } = extractEpub(book, "guided.epub");

    expect(structure.chapters.map((chapter) => chapter.landmark)).toEqual([
      "cover",
      "titlepage",
      "bodymatter",
      "acknowledgements",
    ]);
  });

  test("lets EPUB 3 landmarks override the guide for the same document", () => {
    const book = buildEpub({
      title: "Both",
      documents: [{ path: "front.xhtml", body: "<p>Front.</p>" }],
      guide: '<reference type="text" href="front.xhtml" title="Start"/>',
      nav: '<nav epub:type="landmarks"><ol><li><a epub:type="titlepage" href="front.xhtml">Title</a></li></ol></nav>',
    });
    const { structure } = extractEpub(book, "both.epub");

    expect(structure.chapters[0]?.landmark).toBe("titlepage");
  });

  test("numbers ids and reading order to the contract", () => {
    const book = buildEpub({
      title: "Numbered",
      documents: [
        { path: "ch1.xhtml", body: "<h1>One</h1><p>First.</p><p>Second.</p>" },
        { path: "ch2.xhtml", body: "<h1>Two</h1><p>Third.</p>" },
      ],
    });
    const { structure } = extractEpub(book, "numbered.epub");

    expect(structure.chapters.map((chapter) => chapter.id)).toEqual(["ch-0", "ch-1"]);
    expect(structure.chapters[0]?.blockIds).toEqual(["0:0", "0:1", "0:2"]);
    expect(structure.chapters[1]?.blockIds).toEqual(["1:0", "1:1"]);

    // Global order is contiguous, ascending and independent of the per-chapter
    // block index, which is what lets filtering restore sequence later.
    expect(structure.blocks.map((block) => block.order)).toEqual([0, 1, 2, 3, 4]);
    expect(structure.blocks.map((block) => block.id)).toEqual(["0:0", "0:1", "0:2", "1:0", "1:1"]);
    expect(structure.blocks.map((block) => block.chapterId)).toEqual(["ch-0", "ch-0", "ch-0", "ch-1", "ch-1"]);
    expect(structure.chapters.flatMap((chapter) => chapter.blockIds)).toEqual(
      structure.blocks.map((block) => block.id),
    );
  });

  test("resolves percent-encoded and fragment-bearing hrefs", () => {
    const book = buildEpub({
      title: "Encoded",
      documents: [{ path: "chapter one.xhtml", href: "chapter%20one.xhtml#start", body: "<p>Found it.</p>" }],
      nav: '<nav epub:type="toc"><ol><li><a href="chapter%20one.xhtml#start">Chapter One</a></li></ol></nav>',
    });
    const { structure, warnings } = extractEpub(book, "encoded.epub");

    expect(warnings).toEqual([]);
    expect(structure.blocks.map((block) => block.text)).toEqual(["Found it."]);
    expect(structure.chapters[0]?.title).toBe("Chapter One");
  });

  test("extracts a linear=no spine item in place", () => {
    const book = buildEpub({
      title: "Aside",
      documents: [
        { path: "ch1.xhtml", body: "<p>Body.</p>" },
        { path: "notes.xhtml", body: "<p>Endnotes.</p>", linear: "no" },
      ],
    });
    const { structure } = extractEpub(book, "aside.epub");

    expect(structure.blocks.map((block) => block.text)).toEqual(["Body.", "Endnotes."]);
  });

  test("resolves hrefs relative to the package document's directory", () => {
    // The package sits in OEBPS/ and points at text/ below it, so a chapter is
    // only found if the base directory is applied rather than the archive root.
    const book = buildEpub({
      title: "Nested",
      documents: [{ path: "text/ch1.xhtml", body: "<p>Deep.</p>" }],
      nav: '<nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">Deep Chapter</a></li></ol></nav>',
    });
    const { structure, warnings } = extractEpub(book, "nested.epub");

    expect(warnings).toEqual([]);
    expect(structure.chapters[0]?.title).toBe("Deep Chapter");
  });

  test("warns about a chapter with no text but keeps it", () => {
    const book = buildEpub({
      title: "Sparse",
      documents: [
        { path: "blank.xhtml", body: '<div><img src="art.png" alt=""/></div>' },
        { path: "ch1.xhtml", body: "<p>Real text.</p>" },
      ],
      guide: '<reference type="cover" href="blank.xhtml" title="Cover"/>',
    });
    const { structure, warnings } = extractEpub(book, "sparse.epub");

    expect(warnings).toContain("OEBPS/blank.xhtml contained no readable text");
    expect(structure.chapters).toHaveLength(2);
    expect(structure.chapters[0]?.blockIds).toEqual([]);
    expect(structure.chapters[0]?.landmark).toBe("cover");
  });

  test("warns rather than fails on a spine entry it cannot use", () => {
    const book = buildEpub({
      title: "Patchy",
      documents: [
        { path: "cover.svg", body: "<p>x</p>", mediaType: "image/svg+xml" },
        { path: "ch1.xhtml", body: "<p>Body.</p>" },
      ],
    });
    const { structure, warnings } = extractEpub(book, "patchy.epub");

    expect(structure.chapters).toHaveLength(1);
    expect(warnings.some((warning) => warning.includes("non-text spine entry"))).toBe(true);
  });

  test("warns about missing metadata instead of failing", () => {
    const book = buildEpub({ documents: [{ path: "ch1.xhtml", body: "<p>Body.</p>" }] });
    const { structure, warnings } = extractEpub(book, "untitled-book.epub");

    expect(warnings).toContain("the package document declares no dc:title");
    expect(structure.title).toBe("untitled-book");
    expect(structure.author).toBe("");
    expect(structure.language).toBe("");
  });

  test("reads a fully deflated archive", () => {
    const book = buildEpub({
      title: "Packed",
      documents: [{ path: "ch1.xhtml", body: "<p>Compressed body.</p>" }],
      deflate: true,
    });
    expect(extractEpub(book, "packed.epub").structure.blocks[0]?.text).toBe("Compressed body.");
  });

  test("rejects a book whose content is encrypted", () => {
    const book = buildEpub({
      title: "Locked",
      documents: [{ path: "ch1.xhtml", body: "<p>Body.</p>" }],
      extraFiles: [
        {
          name: "META-INF/encryption.xml",
          data:
            '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
            '<enc:EncryptedData xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:CipherData>' +
            '<enc:CipherReference URI="OEBPS/ch1.xhtml"/>' +
            "</enc:CipherData></enc:EncryptedData></encryption>",
        },
      ],
    });
    expect(() => extractEpub(book, "locked.epub")).toThrow(/DRM-protected/);
  });

  test("accepts a book whose fonts alone are obfuscated", () => {
    const book = buildEpub({
      title: "Obfuscated",
      documents: [{ path: "ch1.xhtml", body: "<p>Body.</p>" }],
      extraFiles: [
        {
          name: "META-INF/encryption.xml",
          data:
            '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
            '<enc:EncryptedData xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:CipherData>' +
            '<enc:CipherReference URI="OEBPS/fonts/body.otf"/>' +
            "</enc:CipherData></enc:EncryptedData></encryption>",
        },
      ],
    });
    const { structure, warnings } = extractEpub(book, "obfuscated.epub");

    expect(structure.blocks).toHaveLength(1);
    expect(warnings.some((warning) => warning.includes("obfuscated"))).toBe(true);
  });

  test("rejects a file that is not an epub", () => {
    expect(() => extractEpub(encoder.encode("just some prose"), "book.epub")).toThrow(BookExtractionError);
    expect(() => extractEpub(buildZip([{ name: "a.txt", data: "one" }]), "book.epub")).toThrow(
      /container\.xml is missing/,
    );
  });

  test("rejects an epub whose spine yields nothing", () => {
    const book = buildEpub({
      title: "Hollow",
      documents: [{ path: "cover.svg", body: "<p>x</p>", mediaType: "image/svg+xml" }],
    });
    expect(() => extractEpub(book, "hollow.epub")).toThrow(/no readable documents/);
  });

  test("rejects a package document with no manifest", () => {
    const archive = buildZip([
      {
        name: "META-INF/container.xml",
        data:
          '<container><rootfiles><rootfile full-path="content.opf" ' +
          'media-type="application/oebps-package+xml"/></rootfiles></container>',
      },
      { name: "content.opf", data: "<package><metadata/></package>" },
    ]);
    expect(() => extractEpub(archive, "broken.epub")).toThrow(/manifest or spine/);
  });
});

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

describe("extractBook", () => {
  test("recognises an epub by its magic bytes whatever it is called", () => {
    const book = sampleEpub();
    expect(detectBookFormat(book, "mislabelled.txt")).toBe("epub");
    expect(detectBookFormat(encoder.encode("prose"), "book.txt")).toBe("text");
    // A file the user calls an epub is still routed to the epub reader, so the
    // error explains the problem instead of narrating binary noise.
    expect(detectBookFormat(encoder.encode("prose"), "book.epub")).toBe("epub");
  });

  test("extracts an epub", async () => {
    const { structure } = await extractBook(sampleEpub(), "scarlet.epub");
    expect(structure.title).toBe("A Study in Scarlet");
    expect(structure.chapters).toHaveLength(2);
  });

  test("extracts plain text as a single chapter named after the file", async () => {
    const { structure } = await extractBook(encoder.encode("One.\n\nTwo.\n"), "notes/my-book.txt");

    expect(structure.title).toBe("my-book");
    expect(structure.chapters).toHaveLength(1);
    expect(structure.chapters[0]?.title).toBe("my-book");
    expect(structure.blocks.map((block) => block.id)).toEqual(["0:0", "0:1"]);
    expect(structure.blocks.map((block) => block.order)).toEqual([0, 1]);
  });

  test("chapters markdown at its shallowest heading level", async () => {
    const source = "Preface text.\n\n## First\n\nBody one.\n\n### Deeper\n\n## Second\n\nBody two.";
    const { structure } = await extractBook(encoder.encode(source), "guide.md");

    expect(structure.chapters.map((chapter) => chapter.title)).toEqual(["guide", "First", "Second"]);
    expect(structure.chapters[1]?.blockIds).toEqual(["1:0", "1:1", "1:2"]);
    expect(structure.blocks.map((block) => block.order)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("rejects an empty text file", async () => {
    await expect(extractBook(new Uint8Array(0), "empty.txt")).rejects.toThrow(BookExtractionError);
  });

  test("reports a mislabelled epub as the archive problem it is", async () => {
    await expect(extractBook(encoder.encode("not an archive"), "book.epub")).rejects.toThrow(BookExtractionError);
  });
});
