/**
 * PDF extraction.
 *
 * The layout logic — lines, columns, de-hyphenation, page furniture, headings —
 * is all pure functions over coordinates, so it is exercised from synthetic item
 * arrays where every number is visible in the test rather than buried in a
 * binary. The pdf.js path on top of it is checked against real (if tiny) PDFs
 * assembled inline, because the only way to know the reader agrees with the
 * format is to hand it the format.
 */

import { describe, expect, test } from "bun:test";

import { BookExtractionError } from "../src/services/book/types.ts";
import { classifyBlocks } from "../src/services/book/filter/structural.ts";
import {
  assembleBlocks,
  assignHeadingLevels,
  classifyPageFurniture,
  detectColumnSplit,
  encodePng,
  extractPdf,
  groupItemsIntoLines,
  imageToRgba,
  isPageNumberText,
  joinLineTexts,
  layoutPage,
  modalFontSize,
  orderLinesForReading,
  PDF_IMAGE_KIND,
  renderPdfPageToPng,
  type DraftBlock,
  type PdfLine,
  type PdfTextItem,
  type PlacedLine,
} from "../src/services/book/extract/pdf.ts";
import { detectBookFormat, extractBook } from "../src/services/book/extract/index.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

interface PdfPageSpec {
  /** Content stream operators for the page. */
  content: string;
  width?: number;
  height?: number;
}

/**
 * Writes a real, if minimal, PDF.
 *
 * There is no cross-reference table: pdf.js rebuilds one by indexing every
 * object when the trailer does not lead it to a usable one, which keeps the
 * fixture readable and still exercises the same parse a shipped file gets.
 */
function buildPdf(pages: readonly PdfPageSpec[], info?: string): Uint8Array {
  const objects: string[] = ["", ""];
  const add = (body: string) => objects.push(body);

  const fontId = add("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>");
  const pageIds: number[] = [];

  for (const page of pages) {
    const length = encoder.encode(page.content).length;
    const contentId = add(`<</Length ${length}>>stream\n${page.content}\nendstream `);
    pageIds.push(
      add(
        `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${page.width ?? 200} ${page.height ?? 200}]` +
          `/Contents ${contentId} 0 R/Resources<</Font<</F1 ${fontId} 0 R>>>>>>`,
      ),
    );
  }

  objects[0] = "<</Type/Catalog/Pages 2 0 R>>";
  objects[1] = `<</Type/Pages/Kids[${pageIds.map((id) => `${id} 0 R`).join(" ")}]/Count ${pageIds.length}>>`;

  let trailer = "<</Root 1 0 R";
  if (info) trailer += `/Info ${add(info)} 0 R`;
  trailer += ">>";

  const body = objects.map((object, index) => `${index + 1} 0 obj${object}endobj`).join("\n");
  return encoder.encode(`%PDF-1.4\n${body}\ntrailer${trailer}\n`);
}

function showText(text: string, x: number, y: number, size = 12): string {
  return `BT /F1 ${size} Tf ${x} ${y} Td (${text.replace(/[\\()]/g, (char) => `\\${char}`)}) Tj ET`;
}

function concat(parts: readonly (string | Uint8Array)[]): Uint8Array {
  const chunks = parts.map((part) => (typeof part === "string" ? encoder.encode(part) : part));
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.length;
  }
  return output;
}

interface PdfImageSpec {
  width: number;
  height: number;
  /** Sample bytes, or packed bits when `bitsPerComponent` is 1. */
  pixels: Uint8Array;
  colorSpace?: string;
  bitsPerComponent?: number;
}

/** A single page painting the given image XObjects, and nothing else: a scan. */
function buildImagePdf(images: readonly PdfImageSpec[]): Uint8Array {
  const content = images
    .map((image, index) => `q ${image.width} 0 0 ${image.height} 10 10 cm /Im${index} Do Q`)
    .join(" ");
  const resources = images.map((_, index) => `/Im${index} ${5 + index} 0 R`).join("");

  const parts: (string | Uint8Array)[] = [
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R" +
      `/Resources<</XObject<<${resources}>>>>>>endobj\n` +
      `4 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj\n`,
  ];

  for (const [index, image] of images.entries()) {
    parts.push(
      `${5 + index} 0 obj<</Type/XObject/Subtype/Image/Width ${image.width}/Height ${image.height}` +
        `/ColorSpace${image.colorSpace ?? "/DeviceRGB"}/BitsPerComponent ${image.bitsPerComponent ?? 8}` +
        `/Length ${image.pixels.length}>>stream\n`,
      image.pixels,
      "\nendstream endobj\n",
    );
  }

  parts.push("trailer<</Root 1 0 R>>\n");
  return concat(parts);
}

/** A page whose entire content is one 4x3 RGB image. */
function scannedPagePdf(): Uint8Array {
  return buildImagePdf([{ width: 4, height: 3, pixels: new Uint8Array(4 * 3 * 3).fill(0x40) }]);
}

/** Width and height out of a PNG's IHDR chunk. */
function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * A page that paints a bitmap and nothing else: a scanned leaf in miniature.
 *
 * The sample bytes stay below 0x80 so that the declared stream length matches
 * what UTF-8 encoding actually produces.
 */
const SCANNED_PAGE = "q 100 0 0 100 20 20 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x00\x40\x60\x20 EI Q";

/** The smallest usable book: one page, one line of text. */
function tinyPdf(): Uint8Array {
  return buildPdf([{ content: showText("Hello Audiobook", 20, 100, 18) }]);
}

const item = (text: string, x: number, y: number, fontSize = 10): PdfTextItem => ({
  text,
  x,
  y,
  // Helvetica averages a little under half an em per character, which is close
  // enough for gap arithmetic and keeps the expectations readable.
  width: text.length * fontSize * 0.5,
  fontSize,
});

const line = (left: number, right: number, y: number, text = "line", fontSize = 10): PdfLine => ({
  text,
  left,
  right,
  y,
  fontSize,
});

const placed = (text: string, y: number, overrides: Partial<PlacedLine> = {}): PlacedLine => ({
  text,
  left: 50,
  right: 400,
  y,
  fontSize: 10,
  page: 1,
  positionFromTop: 0.5,
  ...overrides,
});

const columnLines = (left: number, right: number, count: number): PdfLine[] =>
  Array.from({ length: count }, (_, index) => line(left, right, 700 - index * 12, `col ${left} ${index}`));

// ---------------------------------------------------------------------------
// Line assembly
// ---------------------------------------------------------------------------

describe("groupItemsIntoLines", () => {
  test("groups runs sharing a baseline and orders lines top to bottom", () => {
    const lines = groupItemsIntoLines([
      item("world", 60, 100),
      item("the second line", 20, 80),
      item("Hello", 20, 100),
    ]);

    expect(lines.map((entry) => entry.text)).toEqual(["Hello world", "the second line"]);
    expect(lines[0]?.left).toBe(20);
    expect(lines[0]?.right).toBe(60 + 5 * 10 * 0.5);
  });

  test("separates runs on a wide advance gap and closes up an adjacent one", () => {
    expect(groupItemsIntoLines([item("Hel", 20, 100), item("lo", 35, 100)])[0]?.text).toBe("Hello");
    expect(groupItemsIntoLines([item("one", 20, 100), item("two", 60, 100)])[0]?.text).toBe("one two");
  });

  test("absorbs baseline drift within a line but splits genuinely separate ones", () => {
    const drifted = groupItemsIntoLines([item("raised", 20, 102), item("normal", 70, 100)]);
    expect(drifted).toHaveLength(1);

    const separate = groupItemsIntoLines([item("upper", 20, 100), item("lower", 20, 88)]);
    expect(separate.map((entry) => entry.text)).toEqual(["upper", "lower"]);
  });

  test("takes the line's font size from the run carrying most of its characters", () => {
    const lines = groupItemsIntoLines([item("a footnote marker", 20, 100, 9), item("12", 130, 100, 6)]);
    expect(lines[0]?.fontSize).toBe(9);
  });

  test("ignores whitespace-only runs", () => {
    expect(groupItemsIntoLines([item("   ", 20, 100), item("", 40, 100)])).toEqual([]);
  });
});

describe("joinLineTexts", () => {
  test("rejoins a word broken across a line", () => {
    expect(joinLineTexts(["the inter-", "national waters"])).toBe("the international waters");
  });

  test("leaves a legitimate hyphen inside a line alone", () => {
    expect(joinLineTexts(["a well-known fact", "carried on"])).toBe("a well-known fact carried on");
  });

  test("keeps the hyphen when the next line opens in upper case", () => {
    expect(joinLineTexts(["the Anglo-", "Saxon kings"])).toBe("the Anglo-Saxon kings");
  });

  test("does not treat a hyphen after a digit as a broken word", () => {
    expect(joinLineTexts(["the 1914-", "1918 war"])).toBe("the 1914-1918 war");
  });

  test("joins ordinary lines with a single space and drops empty ones", () => {
    expect(joinLineTexts(["first", "  ", "second"])).toBe("first second");
  });
});

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

describe("detectColumnSplit", () => {
  test("finds the gutter between two well-separated columns", () => {
    const split = detectColumnSplit([...columnLines(50, 240, 6), ...columnLines(300, 490, 6)]);
    expect(split).toEqual({ gutterStart: 240, gutterEnd: 300 });
  });

  test("ignores a full-width title when looking for the gutter", () => {
    const split = detectColumnSplit([
      line(50, 490, 760, "A Title Across Both Columns"),
      ...columnLines(50, 240, 6),
      ...columnLines(300, 490, 6),
    ]);
    expect(split).toEqual({ gutterStart: 240, gutterEnd: 300 });
  });

  test("reads single-column prose as single-column", () => {
    expect(detectColumnSplit(columnLines(50, 490, 12))).toBeUndefined();
  });

  test("is not fooled by a ragged right edge", () => {
    const ragged = Array.from({ length: 12 }, (_, index) => line(50, 400 + index * 8, 700 - index * 12));
    expect(detectColumnSplit(ragged)).toBeUndefined();
  });

  test("refuses to split a page with too few lines to be sure", () => {
    expect(detectColumnSplit([...columnLines(50, 240, 3), ...columnLines(300, 490, 3)])).toBeUndefined();
  });

  test("refuses when most lines span the page anyway", () => {
    const split = detectColumnSplit([
      ...Array.from({ length: 9 }, (_, index) => line(50, 490, 900 - index * 12, "wide")),
      ...columnLines(50, 240, 6),
      ...columnLines(300, 490, 6),
    ]);
    expect(split).toBeUndefined();
  });

  test("refuses a gutter narrower than a real one", () => {
    expect(detectColumnSplit([...columnLines(50, 268, 6), ...columnLines(272, 490, 6)])).toBeUndefined();
  });
});

describe("layoutPage", () => {
  /** Six runs down a column, each 150pt wide, on a shared baseline grid. */
  const columnItems = (label: string, x: number, count = 6): PdfTextItem[] =>
    Array.from({ length: count }, (_, index) => item(`${label} line number ${index} xxxx`, x, 700 - index * 14));

  test("keeps columns apart when both sit on the same baselines", () => {
    const lines = layoutPage([...columnItems("right", 320), ...columnItems("left", 50)]);

    expect(lines.map((entry) => entry.text)).toEqual([
      ...Array.from({ length: 6 }, (_, index) => `left line number ${index} xxxx`),
      ...Array.from({ length: 6 }, (_, index) => `right line number ${index} xxxx`),
    ]);
  });

  test("bands a run that crosses the gutter above the columns it introduces", () => {
    const lines = layoutPage([
      item("a title running the full width of the page xx", 50, 760),
      ...columnItems("left", 50),
      ...columnItems("right", 320),
    ]);

    expect(lines[0]?.text).toBe("a title running the full width of the page xx");
    expect(lines[1]?.text).toBe("left line number 0 xxxx");
    expect(lines[7]?.text).toBe("right line number 0 xxxx");
  });

  test("reads a page with too few lines a side as one column", () => {
    const lines = layoutPage([...columnItems("left", 50, 3), ...columnItems("right", 320, 3)]);

    expect(lines).toHaveLength(3);
    expect(lines[0]?.text).toBe("left line number 0 xxxx right line number 0 xxxx");
  });
});

describe("orderLinesForReading", () => {
  test("reads the left column out in full before the right", () => {
    const ordered = orderLinesForReading([...columnLines(300, 490, 5), ...columnLines(50, 240, 5)]);
    expect(ordered.map((entry) => entry.text)).toEqual([
      "col 50 0", "col 50 1", "col 50 2", "col 50 3", "col 50 4",
      "col 300 0", "col 300 1", "col 300 2", "col 300 3", "col 300 4",
    ]);
  });

  test("keeps a spanning line between the bands it separates", () => {
    const ordered = orderLinesForReading([
      line(50, 490, 780, "title"),
      ...columnLines(50, 240, 5),
      ...columnLines(300, 490, 5),
      line(50, 490, 200, "footer"),
    ]);

    expect(ordered[0]?.text).toBe("title");
    expect(ordered[1]?.text).toBe("col 50 0");
    expect(ordered[6]?.text).toBe("col 300 0");
    expect(ordered[ordered.length - 1]?.text).toBe("footer");
  });

  test("leaves a single-column page in top-to-bottom order", () => {
    const ordered = orderLinesForReading([line(50, 490, 100, "second"), line(50, 490, 200, "first")]);
    expect(ordered.map((entry) => entry.text)).toEqual(["first", "second"]);
  });
});

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

describe("isPageNumberText", () => {
  test("recognises a number however it is decorated", () => {
    for (const text of ["12", "- 12 -", "[12]", "· 7 ·", "Page 12", "p. 12", "xiv", "IX"]) {
      expect(isPageNumberText(text)).toBe(true);
    }
  });

  test("leaves prose and numbered titles alone", () => {
    for (const text of ["", "Chapter 12", "1984 was a year", "civil", "did", "12 Rules"]) {
      expect(isPageNumberText(text)).toBe(false);
    }
  });
});

describe("classifyPageFurniture", () => {
  const head = (page: number, text: string) => ({ page, text, positionFromTop: 0.04 });
  const foot = (page: number, text: string) => ({ page, text, positionFromTop: 0.96 });

  test("labels a line repeated in the margin across pages as a running head", () => {
    const verdicts = classifyPageFurniture(
      [head(1, "A Study in Scarlet"), head(2, "A Study in Scarlet"), head(3, "A Study in Scarlet")],
      3,
    );
    expect(verdicts).toEqual(["running_head", "running_head", "running_head"]);
  });

  test("matches a running head whose page number changes", () => {
    const verdicts = classifyPageFurniture(
      [foot(1, "The Harbour   12"), foot(2, "The Harbour   13"), foot(3, "The Harbour   14")],
      3,
    );
    expect(verdicts).toEqual(["running_head", "running_head", "running_head"]);
  });

  test("labels a bare number in the margin as a page number", () => {
    const verdicts = classifyPageFurniture([foot(1, "12"), foot(2, "13")], 2);
    expect(verdicts).toEqual(["page_number", "page_number"]);
  });

  test("leaves the same text alone when it sits in the body", () => {
    const body = (page: number) => ({ page, text: "A Study in Scarlet", positionFromTop: 0.5 });
    expect(classifyPageFurniture([body(1), body(2), body(3)], 3)).toEqual([undefined, undefined, undefined]);
  });

  test("leaves a margin line that appears only once alone", () => {
    const verdicts = classifyPageFurniture([head(1, "A note to the reader"), head(2, "Something else")], 2);
    expect(verdicts).toEqual([undefined, undefined]);
  });

  test("leaves a long margin line alone even when it repeats", () => {
    const long = "this margin line is far too long to be a running head and is really prose";
    const verdicts = classifyPageFurniture([head(1, long), head(2, long), head(3, long)], 3);
    expect(verdicts).toEqual([undefined, undefined, undefined]);
  });

  test("cannot call anything a running head on a one-page document", () => {
    expect(classifyPageFurniture([head(1, "A Study in Scarlet")], 1)).toEqual([undefined]);
  });
});

// ---------------------------------------------------------------------------
// Blocks and headings
// ---------------------------------------------------------------------------

describe("modalFontSize", () => {
  test("takes the size most of the book's characters are set in", () => {
    expect(
      modalFontSize([
        placed("a long stretch of ordinary body text", 700),
        placed("more ordinary body text follows it", 688),
        placed("A TITLE", 760, { fontSize: 24 }),
      ]),
    ).toBe(10);
  });

  test("ignores page furniture", () => {
    expect(
      modalFontSize([
        placed("body text set at ten point", 700),
        placed("running head", 780, { fontSize: 8, furniture: "running_head" }),
      ]),
    ).toBe(10);
  });

  test("reports nothing for a book with no lines", () => {
    expect(modalFontSize([])).toBe(0);
  });
});

describe("assembleBlocks", () => {
  test("joins wrapped lines into one paragraph and breaks on a wide gap", () => {
    const blocks = assembleBlocks(
      [
        placed("the first paragraph runs", 700),
        placed("on to a second line", 688),
        placed("a new paragraph after white space", 640),
      ],
      10,
    );

    expect(blocks.map((block) => block.text)).toEqual([
      "the first paragraph runs on to a second line",
      "a new paragraph after white space",
    ]);
    expect(blocks.every((block) => block.kind === "paragraph")).toBe(true);
  });

  test("breaks on a first-line indent", () => {
    const blocks = assembleBlocks(
      [placed("the first paragraph ends here", 700), placed("and this one is indented", 688, { left: 62 })],
      10,
    );
    expect(blocks).toHaveLength(2);
  });

  test("breaks between pages", () => {
    const blocks = assembleBlocks(
      [placed("the end of one page", 100), placed("the top of the next", 88, { page: 2 })],
      10,
    );
    expect(blocks.map((block) => block.page)).toEqual([1, 2]);
  });

  test("breaks where the reading order steps back up into the next column", () => {
    const blocks = assembleBlocks(
      [placed("the foot of the left column", 200), placed("the head of the right column", 700, { left: 300 })],
      10,
    );
    expect(blocks).toHaveLength(2);
  });

  test("emits page furniture as its own block, keeping its kind", () => {
    const blocks = assembleBlocks(
      [
        placed("A Study in Scarlet", 780, { positionFromTop: 0.04, furniture: "running_head" }),
        placed("the body of the page begins", 700),
        placed("12", 40, { positionFromTop: 0.96, furniture: "page_number" }),
      ],
      10,
    );

    expect(blocks.map((block) => block.kind)).toEqual(["running_head", "paragraph", "page_number"]);
  });

  test("reads a meaningfully larger line as a heading", () => {
    const blocks = assembleBlocks(
      [placed("Chapter One", 760, { fontSize: 18 }), placed("the chapter opens quietly", 700)],
      10,
    );
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "paragraph"]);
  });

  test("does not promote body text set a hair larger", () => {
    const blocks = assembleBlocks([placed("barely larger than the body", 760, { fontSize: 11 })], 10);
    expect(blocks[0]?.kind).toBe("paragraph");
  });
});

describe("assignHeadingLevels", () => {
  const heading = (text: string, fontSize: number): DraftBlock => ({ kind: "heading", text, page: 1, fontSize });

  test("ranks heading sizes into levels, largest first", () => {
    const levels = assignHeadingLevels([
      heading("Part One", 24),
      heading("Chapter One", 18),
      heading("A Subsection", 14),
      { kind: "paragraph", text: "prose", page: 1, fontSize: 10 },
    ]);

    expect(levels.map((block) => block.level)).toEqual([1, 2, 3, undefined]);
  });

  test("caps the depth at six", () => {
    const sizes = [30, 28, 26, 24, 22, 20, 18, 16];
    const levels = assignHeadingLevels(sizes.map((size) => heading(`h${size}`, size)));
    expect(levels.map((block) => block.level)).toEqual([1, 2, 3, 4, 5, 6, 6, 6]);
  });
});

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

describe("extractPdf", () => {
  test("reads the text of a real pdf", async () => {
    const result = await extractPdf(tinyPdf(), "hello.pdf");

    expect(result.structure.blocks.map((block) => block.text)).toEqual(["Hello Audiobook"]);
    expect(result.structure.blocks[0]?.page).toBe(1);
    expect(result.scan).toEqual({ totalPages: 1, textPages: 1, scannedPages: [] });
  });

  test("takes the title and author from the document information dictionary", async () => {
    const data = buildPdf(
      [{ content: showText("Some body text on the page", 20, 100, 10) }],
      "<</Title(A Study in Scarlet)/Author(Arthur Conan Doyle)>>",
    );
    const result = await extractPdf(data, "upload.pdf");

    expect(result.structure.title).toBe("A Study in Scarlet");
    expect(result.structure.author).toBe("Arthur Conan Doyle");
  });

  test("falls back to the filename when the pdf declares no title", async () => {
    const result = await extractPdf(tinyPdf(), "/uploads/a-study-in-scarlet.pdf");
    expect(result.structure.title).toBe("a-study-in-scarlet");
  });

  test("splits chapters at the shallowest heading level", async () => {
    const chapter = (title: string, body: string) => ({
      content: [
        showText(title, 20, 170, 18),
        showText(body, 20, 140, 10),
        showText("and the paragraph continues on a second line", 20, 128, 10),
      ].join("\n"),
    });

    const result = await extractPdf(
      buildPdf([chapter("Chapter One", "a first stretch of ordinary body text"), chapter("Chapter Two", "a second stretch of ordinary body text")]),
      "book.pdf",
    );

    expect(result.structure.chapters.map((entry) => entry.title)).toEqual(["Chapter One", "Chapter Two"]);
    expect(result.structure.blocks.filter((block) => block.kind === "heading")).toHaveLength(2);
  });

  test("gives chapters and blocks the ids the pipeline expects", async () => {
    const result = await extractPdf(
      buildPdf([
        {
          content: [
            showText("Chapter One", 20, 170, 18),
            showText("a first stretch of ordinary body text", 20, 140, 10),
            showText("Chapter Two", 20, 100, 18),
            showText("a second stretch of ordinary body text", 20, 70, 10),
          ].join("\n"),
        },
      ]),
      "book.pdf",
    );

    const { blocks, chapters } = result.structure;
    expect(chapters.map((chapter) => chapter.id)).toEqual(["ch-0", "ch-1"]);
    expect(blocks.map((block) => block.id)).toEqual(["0:0", "0:1", "1:0", "1:1"]);
    expect(blocks.map((block) => block.order)).toEqual([0, 1, 2, 3]);
    expect(chapters.flatMap((chapter) => chapter.blockIds)).toEqual(blocks.map((block) => block.id));
    expect(blocks.every((block) => block.chapterId.startsWith("ch-"))).toBe(true);
  });

  test("keeps the global order contiguous across pages", async () => {
    const pages = Array.from({ length: 4 }, (_, index) => ({
      content: showText(`a paragraph of body text on page ${index + 1}`, 20, 100, 10),
    }));
    const result = await extractPdf(buildPdf(pages), "book.pdf");

    expect(result.structure.blocks.map((block) => block.order)).toEqual([0, 1, 2, 3]);
    expect(result.structure.blocks.map((block) => block.page)).toEqual([1, 2, 3, 4]);
  });

  test("falls back to page bands when the pdf has no headings, and says so", async () => {
    const pages = Array.from({ length: 12 }, (_, index) => ({
      content: showText(`a paragraph of body text on page ${index + 1}`, 20, 100, 10),
    }));
    const result = await extractPdf(buildPdf(pages), "flat.pdf");

    expect(result.structure.chapters.map((chapter) => chapter.title)).toEqual(["Pages 1-10", "Pages 11-12"]);
    expect(result.warnings.some((warning) => /no headings to split on/.test(warning))).toBe(true);
  });

  test("reports a page that has no text layer but does have an image", async () => {
    const result = await extractPdf(
      buildPdf([{ content: showText("a page with a proper text layer", 20, 100, 10) }, { content: SCANNED_PAGE }]),
      "mixed.pdf",
    );

    expect(result.scan).toEqual({ totalPages: 2, textPages: 1, scannedPages: [2] });
    expect(result.warnings.some((warning) => /1 of 2 pages have no text layer/.test(warning))).toBe(true);
  });

  test("returns a valid structure with an unmistakable warning when every page is scanned", async () => {
    const result = await extractPdf(buildPdf([{ content: SCANNED_PAGE }, { content: SCANNED_PAGE }]), "scan.pdf");

    expect(result.scan).toEqual({ totalPages: 2, textPages: 0, scannedPages: [1, 2] });
    expect(result.structure.blocks).toEqual([]);
    expect(result.structure.chapters).toHaveLength(1);
    expect(result.warnings.some((warning) => /scanned pdf and needs OCR/.test(warning))).toBe(true);
  });

  test("refuses a file that is not a pdf at all", async () => {
    await expect(extractPdf(encoder.encode("this is just some prose"), "book.pdf")).rejects.toThrow(
      BookExtractionError,
    );
  });

  test("names password protection as its own failure", async () => {
    const locked = new TextDecoder()
      .decode(tinyPdf())
      .replace(
        "trailer<</Root 1 0 R>>",
        "9 0 obj<</Filter/Standard/V 1/R 2" +
          "/O <2222222222222222222222222222222222222222222222222222222222222222>" +
          "/U <1111111111111111111111111111111111111111111111111111111111111111>/P -1>>endobj\n" +
          "trailer<</Root 1 0 R/Encrypt 9 0 R" +
          "/ID[<0102030405060708090a0b0c0d0e0f10><0102030405060708090a0b0c0d0e0f10>]>>",
      );

    await expect(extractPdf(encoder.encode(locked), "locked.pdf")).rejects.toThrow(/password-protected/);
  });

  test("leaves the caller's bytes intact", async () => {
    const data = tinyPdf();
    await extractPdf(data, "hello.pdf");

    // pdf.js transfers whatever buffer it is handed, so the copy taken on the
    // way in is the only thing keeping a second pass — OCR, say — possible.
    expect(data.byteLength).toBeGreaterThan(0);
    expect((await extractPdf(data, "hello.pdf")).structure.blocks).toHaveLength(1);
  });
});

describe("two-column pdfs", () => {
  test("reads a real two-column page down one column at a time", async () => {
    // Six lines a side, each about 160pt wide, leaving a gutter of roughly 110pt
    // in the middle of a 600pt page.
    const column = (label: string, x: number) =>
      Array.from({ length: 6 }, (_, index) =>
        showText(`${label} column sentence number ${index}`, x, 700 - index * 14, 10),
      );

    const result = await extractPdf(
      buildPdf([{ width: 600, height: 800, content: [...column("left", 50), ...column("right", 320)].join("\n") }]),
      "columns.pdf",
    );

    const texts = result.structure.blocks.map((block) => block.text);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toBe(
      "left column sentence number 0 left column sentence number 1 left column sentence number 2 " +
        "left column sentence number 3 left column sentence number 4 left column sentence number 5",
    );
    expect(texts[1]?.startsWith("right column sentence number 0")).toBe(true);
    expect(texts[1]).not.toContain("left");
  });
});

describe("page furniture end to end", () => {
  /**
   * Three pages carrying a repeated head, a paragraph, and a page number.
   *
   * The prose differs page to page so that the filter's separate boilerplate
   * rule stays out of the way and only the furniture rules are on trial.
   */
  function furnishedPdf(): Uint8Array {
    const prose = [
      "in the year 1878 I took my degree of doctor of medicine",
      "there was neither kith nor kin whom I could claim in england",
      "under such circumstances I naturally gravitated to london",
    ];

    return buildPdf(
      prose.map((paragraph, index) => ({
        content: [
          // The 200pt page puts its margin bands above y=184 and below y=16.
          showText("A Study in Scarlet", 20, 188, 8),
          showText(paragraph, 20, 100, 10),
          showText(String(index + 1), 95, 10, 8),
        ].join("\n"),
      })),
    );
  }

  test("emits the running_head and page_number kinds the filter was written for", async () => {
    const result = await extractPdf(furnishedPdf(), "book.pdf");
    const kinds = result.structure.blocks.map((block) => block.kind);

    expect(kinds).toEqual([
      "running_head", "paragraph", "page_number",
      "running_head", "paragraph", "page_number",
      "running_head", "paragraph", "page_number",
    ]);
  });

  test("hands the structural filter blocks its furniture rules can drop", async () => {
    const result = await extractPdf(furnishedPdf(), "book.pdf");
    const decisions = classifyBlocks(result.structure);
    const byId = new Map(decisions.map((decision) => [decision.blockId, decision]));

    const furniture = result.structure.blocks.filter((block) => block.kind !== "paragraph");
    expect(furniture.every((block) => byId.get(block.id)?.keep === false)).toBe(true);
    expect(new Set(furniture.map((block) => byId.get(block.id)?.rule))).toEqual(
      new Set(["repeated_running_head", "page_number"]),
    );

    // The prose either side of the furniture still survives the pass untouched.
    const prose = result.structure.blocks.filter((block) => block.kind === "paragraph");
    expect(prose.every((block) => byId.get(block.id)?.keep === true)).toBe(true);
  });
});

describe("imageToRgba", () => {
  test("agrees with the ImageKind enum pdf.js actually hands back", async () => {
    const { ImageKind } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    expect(ImageKind.GRAYSCALE_1BPP).toBe(PDF_IMAGE_KIND.grayscale1bpp);
    expect(ImageKind.RGB_24BPP).toBe(PDF_IMAGE_KIND.rgb24);
    expect(ImageKind.RGBA_32BPP).toBe(PDF_IMAGE_KIND.rgba32);
  });

  test("expands 24-bit rgb to opaque rgba", () => {
    const rgba = imageToRgba({ width: 2, height: 1, kind: 2, data: new Uint8Array([1, 2, 3, 4, 5, 6]) });
    expect([...rgba]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  test("passes 32-bit rgba through with its alpha", () => {
    const rgba = imageToRgba({ width: 1, height: 2, kind: 3, data: new Uint8Array([1, 2, 3, 9, 4, 5, 6, 8]) });
    expect([...rgba]).toEqual([1, 2, 3, 9, 4, 5, 6, 8]);
  });

  test("unpacks 1-bit bilevel rows, a set bit being white", () => {
    // Two rows of eight pixels: the first pixel of row one, the last of row two.
    const rgba = imageToRgba({ width: 8, height: 2, kind: 1, data: new Uint8Array([0b10000000, 0b00000001]) });

    expect([...rgba.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    expect([...rgba.slice(4, 8)]).toEqual([0, 0, 0, 255]);
    expect([...rgba.slice(60, 64)]).toEqual([255, 255, 255, 255]);
    expect(rgba).toHaveLength(8 * 2 * 4);
  });

  test("pads each 1-bit row to a byte boundary", () => {
    // Three pixels a row still costs a byte a row, so row two starts at byte 1.
    const rgba = imageToRgba({ width: 3, height: 2, kind: 1, data: new Uint8Array([0b11100000, 0b00000000]) });
    expect([...rgba.slice(0, 12)]).toEqual([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
    expect([...rgba.slice(12, 16)]).toEqual([0, 0, 0, 255]);
  });

  test("refuses a layout it does not know rather than reading past the data", () => {
    expect(() => imageToRgba({ width: 1, height: 1, kind: 9, data: new Uint8Array(4) })).toThrow(
      /unsupported pixel layout/,
    );
  });

  test("refuses a truncated image", () => {
    expect(() => imageToRgba({ width: 4, height: 1, kind: 2, data: new Uint8Array(5) })).toThrow(/truncated/);
    expect(() => imageToRgba({ width: 8, height: 4, kind: 1, data: new Uint8Array(2) })).toThrow(/truncated/);
  });

  test("refuses dimensions no scan could have", () => {
    expect(() => imageToRgba({ width: 100_000, height: 100_000, kind: 2, data: new Uint8Array(0) })).toThrow(
      /megapixel limit/,
    );
    expect(() => imageToRgba({ width: 0, height: 4, kind: 2, data: new Uint8Array(0) })).toThrow(
      /unusable dimensions/,
    );
  });
});

describe("encodePng", () => {
  /**
   * Decodes with Skia rather than with this module's own code.
   *
   * The encoder is hand-written, so checking it against itself would prove
   * nothing; @napi-rs/canvas is used here purely as an independent reader.
   */
  async function decode(png: Uint8Array): Promise<{ width: number; height: number; pixels: Uint8ClampedArray }> {
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const image = await loadImage(Buffer.from(png));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return {
      width: image.width,
      height: image.height,
      pixels: context.getImageData(0, 0, image.width, image.height).data,
    };
  }

  test("writes a png an independent decoder reads back pixel for pixel", async () => {
    const pixels = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
      10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255,
    ]);
    const decoded = await decode(encodePng(pixels, 3, 2));

    expect({ width: decoded.width, height: decoded.height }).toEqual({ width: 3, height: 2 });
    expect([...decoded.pixels]).toEqual([...pixels]);
  });

  test("round-trips an image tall enough to exercise the row filter", async () => {
    const width = 5;
    const height = 40;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < pixels.length; index += 4) {
      pixels[index] = index % 256;
      pixels[index + 1] = (index * 7) % 256;
      pixels[index + 2] = (index * 13) % 256;
      pixels[index + 3] = 255;
    }

    expect([...(await decode(encodePng(pixels, width, height))).pixels]).toEqual([...pixels]);
  });

  test("writes the signature and the declared size into the header", () => {
    const png = encodePng(new Uint8ClampedArray(4 * 2 * 4), 4, 2);
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(pngSize(png)).toEqual({ width: 4, height: 2 });
    expect(new TextDecoder().decode(png.slice(png.length - 8, png.length - 4))).toBe("IEND");
  });

  test("refuses a pixel buffer too small for the size claimed", () => {
    expect(() => encodePng(new Uint8ClampedArray(8), 4, 2)).toThrow(/too small/);
  });
});

describe("renderPdfPageToPng", () => {
  test("extracts a scanned page as a png at the scan's own resolution", async () => {
    const data = scannedPagePdf();
    const png = await renderPdfPageToPng(data, 1);

    expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // 4x3 is the image's own size, not the 200x200 page it is painted onto.
    expect(pngSize(png)).toEqual({ width: 4, height: 3 });
    expect(data.byteLength).toBeGreaterThan(0);
  });

  test("never reaches pdf.js's canvas renderer", async () => {
    // `page.render()` corrupts memory in Bun and segfaults the process, taking
    // the server with it. A comment would not survive a refactor; this does.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({ data: scannedPagePdf(), verbosity: 0 });
    const document = await task.promise;
    const page = await document.getPage(1);
    const prototype = Object.getPrototypeOf(page) as { render: unknown };
    const original = prototype.render;

    let called = false;
    prototype.render = () => {
      called = true;
      throw new Error("page.render() must never be called");
    };

    try {
      await renderPdfPageToPng(scannedPagePdf(), 1);
    } finally {
      prototype.render = original;
      page.cleanup();
      await task.destroy();
    }

    expect(called).toBe(false);
  });

  test("takes the largest image when a page carries several", async () => {
    const png = await renderPdfPageToPng(
      buildImagePdf([
        { width: 2, height: 2, pixels: new Uint8Array(2 * 2 * 3).fill(0x10) },
        { width: 6, height: 5, pixels: new Uint8Array(6 * 5 * 3).fill(0x80) },
      ]),
      1,
    );

    expect(pngSize(png)).toEqual({ width: 6, height: 5 });
  });

  test("reads a bilevel scan, the shape most scanned books arrive in", async () => {
    const png = await renderPdfPageToPng(
      buildImagePdf([
        { width: 8, height: 4, pixels: new Uint8Array([0b01010101, 0b00001111, 0b01111110, 0]), colorSpace: "/DeviceGray", bitsPerComponent: 1 },
      ]),
      1,
    );

    expect(pngSize(png)).toEqual({ width: 8, height: 4 });
  });

  test("says plainly that a page with a text layer cannot be turned into an image", async () => {
    await expect(renderPdfPageToPng(tinyPdf(), 1)).rejects.toThrow(/not a scanned image/);
  });

  test("refuses a page the pdf does not have", async () => {
    await expect(renderPdfPageToPng(scannedPagePdf(), 4)).rejects.toThrow(BookExtractionError);
  });

  test("leaves the caller's bytes intact so the same upload can be read twice", async () => {
    const data = scannedPagePdf();
    await renderPdfPageToPng(data, 1);
    expect(pngSize(await renderPdfPageToPng(data, 1))).toEqual({ width: 4, height: 3 });
  });
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe("detectBookFormat", () => {
  test("routes on the %PDF magic whatever the file is called", () => {
    expect(detectBookFormat(tinyPdf(), "book.txt")).toBe("pdf");
  });

  test("falls back to the .pdf extension when the bytes say nothing", () => {
    expect(detectBookFormat(encoder.encode("not really a pdf"), "book.pdf")).toBe("pdf");
    // The magic has to open the file: prose that merely talks about %PDF is prose.
    expect(detectBookFormat(encoder.encode("a note about %PDF headers"), "notes.txt")).toBe("text");
  });
});

describe("extractBook", () => {
  test("reads an uploaded pdf through the dispatcher", async () => {
    const result = await extractBook(tinyPdf(), "hello.pdf");
    expect(result.structure.blocks.map((block) => block.text)).toEqual(["Hello Audiobook"]);
  });
});
