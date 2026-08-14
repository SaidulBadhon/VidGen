/**
 * The OCR pass: paragraph assembly, the resume record, and what it publishes.
 *
 * Nothing here touches an engine, a socket, a PDF or a database. That is the
 * point — every decision that changes what a listener will eventually hear is a
 * pure function over page text, and the expensive half of this pipeline (seven
 * seconds a page, half an hour a book) is exactly the half you cannot afford to
 * discover a bug in by running it.
 *
 * The cases that get the most attention are the ones where recognised text
 * differs from read text: a page break that is not a paragraph break, a word
 * split by one, a page the engine could not read at all, and the provenance that
 * has to survive all three so a reviewer sees what was guessed rather than read.
 */

import { describe, expect, test } from "bun:test";

import {
  assembleOcrParagraphs,
  buildOcrStructure,
  continuesAcrossPageBreak,
  findRecognizedPage,
  ocrRunFingerprint,
  ocrTaskProgress,
  parseOcrManifest,
  recognizedPages,
  shouldRecognizePage,
  splitOcrParagraphs,
  summarizeOcrRun,
  weakerProvenance,
  OCR_PAGES_PER_CHAPTER,
  OCR_PROGRESS_CEILING,
  OCR_PROGRESS_FLOOR,
  type OcrManifest,
  type OcrPageRecord,
  type OcrPageText,
} from "../src/tasks/ocrPipeline.ts";
import {
  decideExtractionOutcome,
  pdfScanReport,
  NO_TEXT_MESSAGE,
  OCR_DISABLED_MESSAGE,
} from "../src/routes/v1/book.ts";
import type { PdfScanReport } from "../src/services/book/extract/index.ts";
import type { BookStructure, ExtractionResult, OcrProvenance } from "../src/services/book/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function provenance(confidence: number, provider = "ollama:minicpm-v:latest"): OcrProvenance {
  return { provider, confidence };
}

function page(number: number, text: string, confidence = 0.8): OcrPageText {
  return { page: number, text, provenance: provenance(confidence) };
}

function record(page: number, text: string, overrides: Partial<OcrPageRecord> = {}): OcrPageRecord {
  return { page, text, provider: "tesseract", confidence: 0.9, ...overrides };
}

function manifest(pages: OcrPageRecord[], fingerprint = "fp"): OcrManifest {
  return { version: 1, fingerprint, pages };
}

function emptyStructure(): BookStructure {
  return { title: "", author: "", language: "", chapters: [], blocks: [] };
}

function scanReport(overrides: Partial<PdfScanReport> = {}): PdfScanReport {
  return { totalPages: 1, textPages: 0, scannedPages: [1], ...overrides };
}

// ---------------------------------------------------------------------------
// Paragraphs within one page
// ---------------------------------------------------------------------------

describe("splitOcrParagraphs", () => {
  test("splits on blank lines and joins the lines inside a paragraph", () => {
    const paragraphs = splitOcrParagraphs(
      "The harbour was quiet\nthat morning.\n\nShe counted the boats\ntwice before leaving.",
    );

    expect(paragraphs).toEqual([
      "The harbour was quiet that morning.",
      "She counted the boats twice before leaving.",
    ]);
  });

  test("treats a run of blank lines, and blank lines carrying spaces, as one break", () => {
    expect(splitOcrParagraphs("one\n\n\n\ntwo\n \nthree")).toEqual(["one", "two", "three"]);
  });

  test("heals a word broken by the line wrap, closing the halves without a space", () => {
    expect(splitOcrParagraphs("the light-\nhouse keeper")).toEqual(["the lighthouse keeper"]);
  });

  test("keeps a real compound that the wrap happened to split", () => {
    // "Saxon" is capitalised, so the hyphen belongs to the word rather than to
    // the line ending.
    expect(splitOcrParagraphs("an Anglo-\nSaxon charter")).toEqual(["an Anglo-Saxon charter"]);
  });

  test("leaves a mid-line hyphen alone", () => {
    expect(splitOcrParagraphs("a well-known face")).toEqual(["a well-known face"]);
  });

  test("returns nothing for a page the engine found blank", () => {
    expect(splitOcrParagraphs("")).toEqual([]);
    expect(splitOcrParagraphs("   \n\n \t \n")).toEqual([]);
  });

  test("normalises carriage returns before splitting", () => {
    expect(splitOcrParagraphs("one\r\n\r\ntwo")).toEqual(["one", "two"]);
  });
});

// ---------------------------------------------------------------------------
// Paragraphs across a page break
// ---------------------------------------------------------------------------

describe("continuesAcrossPageBreak", () => {
  test("joins when the page ends mid-sentence and the next opens in lower case", () => {
    expect(continuesAcrossPageBreak("she opened the door and", "stepped into the hall.")).toBe(true);
  });

  test("joins a word cut in half by the page break", () => {
    expect(continuesAcrossPageBreak("the light-", "house keeper")).toBe(true);
  });

  test("does not join when the previous page closed a sentence", () => {
    expect(continuesAcrossPageBreak("she opened the door.", "stepped into the hall")).toBe(false);
  });

  test("sees through a closing quote onto the full stop it covers", () => {
    expect(continuesAcrossPageBreak('"I will not," she said.', "the room fell quiet")).toBe(false);
  });

  test("does not join when the next page opens a new sentence", () => {
    expect(continuesAcrossPageBreak("she opened the door and", "The hall was empty.")).toBe(false);
  });

  test("looks past an opening quote to the lower-case text behind it", () => {
    expect(continuesAcrossPageBreak("he muttered something about", '"nothing at all"')).toBe(true);
    expect(continuesAcrossPageBreak("he muttered something about", "'nothing at all'")).toBe(true);
    // The quote does not make a capitalised opening into a continuation.
    expect(continuesAcrossPageBreak("he muttered something about", '"Nothing at all"')).toBe(false);
  });

  test("never joins onto or from an empty page", () => {
    expect(continuesAcrossPageBreak("", "stepped into the hall")).toBe(false);
    expect(continuesAcrossPageBreak("she opened the door and", "   ")).toBe(false);
  });

  test("leaves an em dash at the foot of the page as a word boundary", () => {
    // Not a wrapped word, so the halves are joined with a space rather than
    // closed up — but they are still one paragraph.
    expect(continuesAcrossPageBreak("she stopped —", "or seemed to")).toBe(true);
  });
});

describe("assembleOcrParagraphs", () => {
  test("carries one paragraph across the page boundary instead of breaking it", () => {
    const paragraphs = assembleOcrParagraphs([
      page(1, "It was the best of times, it was"),
      page(2, "the worst of times."),
    ]);

    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]!.text).toBe("It was the best of times, it was the worst of times.");
    // Attributed to where it started, which is where a reader would look for it.
    expect(paragraphs[0]!.page).toBe(1);
  });

  test("heals a word split by the page break", () => {
    const paragraphs = assembleOcrParagraphs([page(4, "they reached the light-"), page(5, "house at dusk.")]);
    expect(paragraphs[0]!.text).toBe("they reached the lighthouse at dusk.");
  });

  test("keeps separate paragraphs separate across the boundary", () => {
    const paragraphs = assembleOcrParagraphs([
      page(1, "The chapter ended there."),
      page(2, "A new thought began."),
    ]);

    expect(paragraphs.map((paragraph) => paragraph.text)).toEqual([
      "The chapter ended there.",
      "A new thought began.",
    ]);
  });

  test("only the first paragraph of a page can continue the previous one", () => {
    const paragraphs = assembleOcrParagraphs([
      page(1, "the sentence runs on"),
      page(2, "and finishes here.\n\nthen a second paragraph"),
    ]);

    expect(paragraphs.map((paragraph) => paragraph.text)).toEqual([
      "the sentence runs on and finishes here.",
      "then a second paragraph",
    ]);
  });

  test("skips a page the engine read as blank without disturbing its neighbours", () => {
    const paragraphs = assembleOcrParagraphs([
      page(1, "the sentence runs on"),
      page(2, "   "),
      page(3, "and finishes here."),
    ]);

    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]!.text).toBe("the sentence runs on and finishes here.");
  });

  test("a joined paragraph carries the weaker of the two pages' provenance", () => {
    const paragraphs = assembleOcrParagraphs([
      page(1, "the sentence runs on", 0.91),
      page(2, "and finishes here.", 0.34),
    ]);

    expect(paragraphs[0]!.ocr?.confidence).toBe(0.34);
  });
});

describe("weakerProvenance", () => {
  test("keeps the lower confidence of the two", () => {
    expect(weakerProvenance(provenance(0.9), provenance(0.4))?.confidence).toBe(0.4);
    expect(weakerProvenance(provenance(0.2), provenance(0.8))?.confidence).toBe(0.2);
  });

  test("tolerates either side being absent", () => {
    expect(weakerProvenance(undefined, provenance(0.5))?.confidence).toBe(0.5);
    expect(weakerProvenance(provenance(0.5), undefined)?.confidence).toBe(0.5);
    expect(weakerProvenance(undefined, undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe("buildOcrStructure", () => {
  const options = { title: "A Scanned Book", author: "Anon", language: "en", totalPages: 25 };

  function pagesOfProse(count: number): OcrPageText[] {
    return Array.from({ length: count }, (_, index) => page(index + 1, `Paragraph on page ${index + 1}.`));
  }

  test("gives every block an id, a chapter and a page", () => {
    const structure = buildOcrStructure(pagesOfProse(3), options);

    expect(structure.blocks).toHaveLength(3);
    for (const [index, block] of structure.blocks.entries()) {
      expect(block.id).toBe(`0:${index}`);
      expect(block.chapterId).toBe("ch-0");
      expect(block.page).toBe(index + 1);
      expect(block.kind).toBe("paragraph");
    }
  });

  test("numbers order contiguously from zero across chapters", () => {
    const structure = buildOcrStructure(pagesOfProse(25), options);
    expect(structure.blocks.map((block) => block.order)).toEqual(
      structure.blocks.map((_, index) => index),
    );
  });

  test("restarts block ids within each chapter and keeps them unique overall", () => {
    const structure = buildOcrStructure(pagesOfProse(25), options);

    expect(structure.chapters.length).toBeGreaterThan(1);
    for (const [chapterIndex, chapter] of structure.chapters.entries()) {
      expect(chapter.id).toBe(`ch-${chapterIndex}`);
      expect(chapter.blockIds).toEqual(chapter.blockIds.map((_, index) => `${chapterIndex}:${index}`));
    }

    const ids = structure.blocks.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every chapter's blockIds resolve to blocks that name it back", () => {
    const structure = buildOcrStructure(pagesOfProse(25), options);
    const byId = new Map(structure.blocks.map((block) => [block.id, block]));

    for (const chapter of structure.chapters) {
      for (const blockId of chapter.blockIds) {
        expect(byId.get(blockId)?.chapterId).toBe(chapter.id);
      }
    }
  });

  test("splits into page bands when a scan offers no headings to split on", () => {
    const structure = buildOcrStructure(pagesOfProse(25), options);

    expect(structure.chapters).toHaveLength(Math.ceil(25 / OCR_PAGES_PER_CHAPTER));
    expect(structure.chapters[0]!.title).toBe("Pages 1-10");
    expect(structure.chapters[2]!.title).toBe("Pages 21-25");
  });

  test("attaches provenance to every recognised block", () => {
    const structure = buildOcrStructure(pagesOfProse(12), options);

    expect(structure.blocks.length).toBeGreaterThan(0);
    for (const block of structure.blocks) {
      expect(block.ocr).toBeDefined();
      expect(block.ocr!.provider).toBe("ollama:minicpm-v:latest");
      expect(block.ocr!.confidence).toBe(0.8);
    }
  });

  test("carries the book's metadata through", () => {
    const structure = buildOcrStructure(pagesOfProse(1), options);
    expect(structure.title).toBe("A Scanned Book");
    expect(structure.author).toBe("Anon");
    expect(structure.language).toBe("en");
  });

  test("still produces a chapter when nothing was recognised at all", () => {
    const structure = buildOcrStructure([], options);
    expect(structure.blocks).toEqual([]);
    expect(structure.chapters).toHaveLength(1);
    expect(structure.chapters[0]!.id).toBe("ch-0");
  });

  test("a paragraph spanning a band boundary belongs to the chapter it started in", () => {
    const structure = buildOcrStructure(
      [page(10, "the sentence runs on"), page(11, "and finishes here.")],
      options,
    );

    expect(structure.blocks).toHaveLength(1);
    expect(structure.blocks[0]!.page).toBe(10);
    expect(structure.chapters).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Resume record
// ---------------------------------------------------------------------------

describe("ocrRunFingerprint", () => {
  test("is stable for the same file, engine and language", () => {
    const identity = { sourceHash: "abc", provider: "ollama", language: "eng" };
    expect(ocrRunFingerprint(identity)).toBe(ocrRunFingerprint({ ...identity }));
  });

  test("changes when the engine or the language changes", () => {
    const base = { sourceHash: "abc", provider: "ollama", language: "eng" };
    expect(ocrRunFingerprint({ ...base, provider: "tesseract" })).not.toBe(ocrRunFingerprint(base));
    expect(ocrRunFingerprint({ ...base, language: "deu" })).not.toBe(ocrRunFingerprint(base));
    expect(ocrRunFingerprint({ ...base, sourceHash: "def" })).not.toBe(ocrRunFingerprint(base));
  });
});

describe("parseOcrManifest", () => {
  test("reads back a manifest written for the same run", () => {
    const parsed = parseOcrManifest(manifest([record(1, "one"), record(2, "two")]), "fp");
    expect(parsed?.pages).toHaveLength(2);
  });

  test("refuses a manifest belonging to a different engine or file", () => {
    expect(parseOcrManifest(manifest([record(1, "one")], "other"), "fp")).toBeNull();
  });

  test("refuses a manifest from a future format version", () => {
    expect(parseOcrManifest({ version: 99, fingerprint: "fp", pages: [] }, "fp")).toBeNull();
  });

  test("refuses anything that is not a manifest", () => {
    expect(parseOcrManifest(null, "fp")).toBeNull();
    expect(parseOcrManifest("nonsense", "fp")).toBeNull();
    expect(parseOcrManifest({ version: 1, fingerprint: "fp" }, "fp")).toBeNull();
  });

  test("drops a half-written entry rather than the whole run", () => {
    const parsed = parseOcrManifest(
      {
        version: 1,
        fingerprint: "fp",
        pages: [record(1, "one"), { page: 2 }, { page: 0, text: "", provider: "", confidence: 1 }],
      },
      "fp",
    );

    expect(parsed?.pages.map((entry) => entry.page)).toEqual([1]);
  });
});

describe("shouldRecognizePage", () => {
  test("reads a page nothing is known about", () => {
    expect(shouldRecognizePage(null, 1)).toBe(true);
    expect(shouldRecognizePage(manifest([record(1, "one")]), 2)).toBe(true);
  });

  test("never pays twice for a page already read", () => {
    expect(shouldRecognizePage(manifest([record(1, "one")]), 1)).toBe(false);
  });

  test("does not re-read a page that genuinely came back blank", () => {
    expect(shouldRecognizePage(manifest([record(1, "")]), 1)).toBe(false);
  });

  test("retries a page the engine failed on, since those failures are transient", () => {
    const failed = record(1, "", { error: "the model timed out" });
    expect(shouldRecognizePage(manifest([failed]), 1)).toBe(true);
  });

  test("finds the stored outcome for a page", () => {
    expect(findRecognizedPage(manifest([record(3, "three")]), 3)?.text).toBe("three");
    expect(findRecognizedPage(manifest([record(3, "three")]), 4)).toBeNull();
    expect(findRecognizedPage(null, 3)).toBeNull();
  });
});

describe("recognizedPages", () => {
  test("returns the successful pages of this run, in page order", () => {
    const stored = manifest([
      record(3, "three"),
      record(1, "one"),
      record(2, "", { error: "unreadable" }),
      record(9, "not part of this run"),
    ]);

    expect(recognizedPages(stored, [1, 2, 3]).map((entry) => entry.page)).toEqual([1, 3]);
  });

  test("is empty without a manifest", () => {
    expect(recognizedPages(null, [1, 2])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Progress accounting
// ---------------------------------------------------------------------------

describe("summarizeOcrRun", () => {
  test("counts read, failed and attempted pages apart from each other", () => {
    const progress = summarizeOcrRun(
      [record(1, "one"), record(2, "", { error: "timeout" }), record(3, "three")],
      10,
    );

    expect(progress.done).toBe(2);
    expect(progress.failed).toBe(1);
    expect(progress.attempted).toBe(3);
    expect(progress.total).toBe(10);
  });

  test("averages confidence over the pages that were actually read", () => {
    const progress = summarizeOcrRun(
      [
        record(1, "one", { confidence: 0.4 }),
        record(2, "two", { confidence: 0.8 }),
        record(3, "", { error: "timeout", confidence: 0 }),
      ],
      3,
    );

    expect(progress.meanConfidence).toBeCloseTo(0.6, 10);
  });

  test("reports zero confidence rather than a division by zero", () => {
    expect(summarizeOcrRun([], 10).meanConfidence).toBe(0);
  });

  test("counts a resumed run's earlier pages, not just this run's", () => {
    // The records come from the manifest, so a run that resumed at page 200
    // still reports 200 done rather than starting its count over.
    const stored = Array.from({ length: 200 }, (_, index) => record(index + 1, "text"));
    expect(summarizeOcrRun(stored, 300).done).toBe(200);
  });
});

describe("ocrTaskProgress", () => {
  test("starts at the floor and ends at the ceiling, leaving room for assembly", () => {
    expect(ocrTaskProgress(0, 300)).toBe(OCR_PROGRESS_FLOOR);
    expect(ocrTaskProgress(300, 300)).toBe(OCR_PROGRESS_CEILING);
  });

  test("rises monotonically through the run", () => {
    const half = ocrTaskProgress(150, 300);
    expect(half).toBeGreaterThan(ocrTaskProgress(100, 300));
    expect(half).toBeLessThan(ocrTaskProgress(200, 300));
  });

  test("cannot exceed the ceiling however the counts arrive", () => {
    expect(ocrTaskProgress(400, 300)).toBe(OCR_PROGRESS_CEILING);
    expect(ocrTaskProgress(-5, 300)).toBe(OCR_PROGRESS_FLOOR);
    expect(ocrTaskProgress(1, 0)).toBe(OCR_PROGRESS_CEILING);
  });
});

// ---------------------------------------------------------------------------
// What an empty extraction means
// ---------------------------------------------------------------------------

describe("decideExtractionOutcome", () => {
  test("accepts anything that produced blocks", () => {
    expect(decideExtractionOutcome({ blockCount: 12, scan: null, ocrEnabled: false })).toEqual({
      action: "accept",
    });
  });

  test("refuses a non-PDF with no text, as it always did", () => {
    expect(decideExtractionOutcome({ blockCount: 0, scan: null, ocrEnabled: true })).toEqual({
      action: "reject",
      message: NO_TEXT_MESSAGE,
    });
  });

  test("refuses a PDF that is simply empty rather than scanned", () => {
    const scan = scanReport({ totalPages: 4, textPages: 0, scannedPages: [] });
    expect(decideExtractionOutcome({ blockCount: 0, scan, ocrEnabled: true })).toEqual({
      action: "reject",
      message: NO_TEXT_MESSAGE,
    });
  });

  test("refuses a scan when OCR is switched off, and names the setting", () => {
    const outcome = decideExtractionOutcome({
      blockCount: 0,
      scan: scanReport({ totalPages: 3, scannedPages: [1, 2, 3] }),
      ocrEnabled: false,
    });

    expect(outcome).toEqual({ action: "reject", message: OCR_DISABLED_MESSAGE });
    // A refusal nobody can act on is the failure this replaced.
    expect(OCR_DISABLED_MESSAGE).toContain("ocr_provider");
    expect(OCR_DISABLED_MESSAGE).not.toBe(NO_TEXT_MESSAGE);
  });

  test("sends a scan to OCR when an engine is configured", () => {
    const outcome = decideExtractionOutcome({
      blockCount: 0,
      scan: scanReport({ totalPages: 3, scannedPages: [3, 1, 2] }),
      ocrEnabled: true,
    });

    expect(outcome).toEqual({ action: "ocr", pages: [1, 2, 3] });
  });

  test("does not divert a PDF that has some text layer, however little", () => {
    const outcome = decideExtractionOutcome({
      blockCount: 1,
      scan: scanReport({ totalPages: 300, textPages: 1, scannedPages: [2, 3] }),
      ocrEnabled: true,
    });

    expect(outcome).toEqual({ action: "accept" });
  });
});

describe("pdfScanReport", () => {
  test("finds the report a PDF extraction carries", () => {
    const result: ExtractionResult = { structure: emptyStructure(), warnings: [] };
    const withScan = { ...result, scan: scanReport() };
    expect(pdfScanReport(withScan)?.scannedPages).toEqual([1]);
  });

  test("is null for a format that has no pages to scan", () => {
    expect(pdfScanReport({ structure: emptyStructure(), warnings: [] })).toBeNull();
  });
});
