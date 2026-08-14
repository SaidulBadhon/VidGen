/**
 * OCR: TSV parsing, vision-output sanitisation, and the escalation policy.
 *
 * Neither engine is installed on the machine this suite has to pass on, and
 * neither is reachable from it, which is the point: everything that decides what
 * a listener will eventually hear is pure and tested without a binary, a model
 * or a socket. The guards get the most attention here because they are the only
 * thing between a hallucinated page and a narrator reading it out.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { appSettingsSchema, defaultSettings } from "../src/config/schema.ts";
import { __setSettingsForTest } from "../src/config/settings.ts";
import {
  clampConfidence,
  emptyOcrResult,
  meanConfidence,
  OcrUnavailableError,
  type OcrResult,
} from "../src/services/book/ocr/types.ts";
import {
  createTesseractProvider,
  imageFileExtension,
  parseTesseractTsv,
  resolveTesseractBinary,
} from "../src/services/book/ocr/tesseract.ts";
import {
  isModelMissingResponse,
  isModelPresent,
  sanitiseVisionTranscription,
  toOllamaNativeBaseUrl,
  MAX_PLAUSIBLE_PAGE_CHARACTERS,
  NO_TEXT_SENTINEL,
  OCR_VISION_PROMPT,
  VISION_CONFIDENCE,
} from "../src/services/book/ocr/ollamaVision.ts";
import {
  chooseOcrResult,
  decideEscalation,
  getOcrProvider,
  isOcrEnabled,
  listOcrProviders,
  recognizePage,
  resolveOcrConfig,
  MIN_PLAUSIBLE_PAGE_CHARACTERS,
} from "../src/services/book/ocr/index.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TSV_HEADER =
  "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";

interface RowOptions {
  level?: number;
  block?: number;
  par?: number;
  line?: number;
  word?: number;
  conf: number;
  text: string;
  box?: [number, number, number, number];
}

function tsvRow(options: RowOptions): string {
  const { level = 5, block = 1, par = 1, line = 1, word = 1, conf, text, box = [0, 0, 0, 0] } = options;
  return [level, 1, block, par, line, word, box[0], box[1], box[2], box[3], conf, text].join("\t");
}

/** The structural rows real tesseract interleaves with the words, all scored -1. */
function structuralRows(): string[] {
  return [
    tsvRow({ level: 1, conf: -1, text: "" }),
    tsvRow({ level: 2, conf: -1, text: "" }),
    tsvRow({ level: 3, conf: -1, text: "" }),
    tsvRow({ level: 4, conf: -1, text: "" }),
  ];
}

function ocrResult(text: string, confidence: number, provider = "tesseract"): OcrResult {
  return { text, confidence, provider };
}

/** Long enough that the escalation policy's short-page floor is not what fires. */
const FULL_PAGE = "The tide came in at four and the harbour master wrote it down without comment.";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

describe("meanConfidence", () => {
  test("averages the scored words", () => {
    expect(meanConfidence([{ text: "a", confidence: 0.9 }, { text: "b", confidence: 0.7 }])).toBeCloseTo(0.8);
  });

  test("ignores the rows tesseract scores -1", () => {
    const words = [
      { text: "a", confidence: 0.9 },
      { text: "", confidence: -1 },
      { text: "b", confidence: 0.7 },
    ];
    expect(meanConfidence(words)).toBeCloseTo(0.8);
  });

  test("is zero when nothing was scored", () => {
    expect(meanConfidence([])).toBe(0);
    expect(meanConfidence([{ text: "a", confidence: -1 }])).toBe(0);
  });

  test("clamps out-of-range and non-finite values", () => {
    expect(clampConfidence(1.4)).toBe(1);
    expect(clampConfidence(-2)).toBe(0);
    expect(clampConfidence(Number.NaN)).toBe(0);
  });
});

describe("OcrUnavailableError", () => {
  test("carries an install hint and repeats it in the message", () => {
    const error = new OcrUnavailableError("tesseract", "tesseract was not found.", "`brew install tesseract`");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("OcrUnavailableError");
    expect(error.providerId).toBe("tesseract");
    expect(error.installHint).toBe("`brew install tesseract`");
    expect(error.message).toContain("`brew install tesseract`");
  });
});

describe("emptyOcrResult", () => {
  test("is empty, unconfident, and keeps its notes", () => {
    expect(emptyOcrResult("ollama:m", ["rejected"])).toEqual({
      text: "",
      confidence: 0,
      words: [],
      provider: "ollama:m",
      notes: ["rejected"],
    });
  });
});

// ---------------------------------------------------------------------------
// tesseract: TSV
// ---------------------------------------------------------------------------

describe("parseTesseractTsv", () => {
  test("reads words, converts confidence to 0..1, and keeps the bounding box", () => {
    const tsv = [
      TSV_HEADER,
      ...structuralRows(),
      tsvRow({ conf: 96, text: "Hello", box: [36, 92, 200, 40] }),
      tsvRow({ word: 2, conf: 88, text: "world", box: [240, 92, 210, 40] }),
    ].join("\n");

    const page = parseTesseractTsv(tsv);

    expect(page.words).toHaveLength(2);
    expect(page.words[0]).toEqual({
      text: "Hello",
      confidence: 0.96,
      bbox: { x: 36, y: 92, w: 200, h: 40 },
    });
    expect(page.words[1]?.confidence).toBeCloseTo(0.88);
    expect(page.text).toBe("Hello world");
    expect(page.confidence).toBeCloseTo(0.92);
  });

  test("rebuilds lines, paragraphs and blocks from their columns", () => {
    const tsv = [
      TSV_HEADER,
      tsvRow({ conf: 90, text: "The" }),
      tsvRow({ word: 2, conf: 90, text: "tide" }),
      tsvRow({ line: 2, conf: 90, text: "came" }),
      tsvRow({ line: 2, word: 2, conf: 90, text: "in." }),
      tsvRow({ par: 2, conf: 90, text: "A" }),
      tsvRow({ par: 2, word: 2, conf: 90, text: "paragraph." }),
      tsvRow({ block: 2, conf: 90, text: "47" }),
    ].join("\n");

    // Line breaks survive because a printed break is evidence about the page;
    // deciding what it means is the extractor's job, not the recogniser's.
    expect(parseTesseractTsv(tsv).text).toBe("The tide\ncame in.\n\nA paragraph.\n\n47");
  });

  test("ignores the -1 rows when averaging", () => {
    const tsv = [
      TSV_HEADER,
      ...structuralRows(),
      tsvRow({ conf: 80, text: "kept" }),
      tsvRow({ word: 2, conf: -1, text: "unscored" }),
      tsvRow({ word: 3, conf: 60, text: "also" }),
    ].join("\n");

    const page = parseTesseractTsv(tsv);

    expect(page.words.map((word) => word.text)).toEqual(["kept", "also"]);
    expect(page.confidence).toBeCloseTo(0.7);
  });

  test("drops blank text and trims what it keeps", () => {
    const tsv = [
      TSV_HEADER,
      tsvRow({ conf: 95, text: "   " }),
      tsvRow({ word: 2, conf: 95, text: "  spaced  " }),
    ].join("\n");

    expect(parseTesseractTsv(tsv).words.map((word) => word.text)).toEqual(["spaced"]);
  });

  test("follows the header rather than assuming a column order", () => {
    const tsv = [
      "level\tblock_num\tpar_num\tline_num\ttext\tconf",
      ["5", "1", "1", "1", "Reordered", "72"].join("\t"),
    ].join("\n");

    const page = parseTesseractTsv(tsv);

    expect(page.text).toBe("Reordered");
    expect(page.confidence).toBeCloseTo(0.72);
    // No geometry columns at all, so no bounding box is invented.
    expect(page.words[0]?.bbox).toBeUndefined();
  });

  test("falls back to the canonical column order when the header is missing", () => {
    const tsv = [
      tsvRow({ conf: 91, text: "Headerless" }),
      tsvRow({ word: 2, conf: 91, text: "output" }),
    ].join("\n");

    expect(parseTesseractTsv(tsv).text).toBe("Headerless output");
  });

  test("handles CRLF line endings", () => {
    const tsv = [TSV_HEADER, tsvRow({ conf: 90, text: "Windows" })].join("\r\n");
    expect(parseTesseractTsv(tsv).text).toBe("Windows");
  });

  test("returns an empty page for empty or blank input", () => {
    for (const input of ["", "   \n\n \t ", TSV_HEADER]) {
      expect(parseTesseractTsv(input)).toEqual({ words: [], text: "", confidence: 0 });
    }
  });

  test("skips malformed rows instead of throwing", () => {
    const tsv = [
      TSV_HEADER,
      "not a row at all",
      "5\t1\t1",
      ["5", "1", "1", "1", "1", "1", "0", "0", "0", "0", "nonsense", "ignored"].join("\t"),
      tsvRow({ conf: 90, text: "Survivor" }),
    ].join("\n");

    const page = parseTesseractTsv(tsv);

    expect(page.words.map((word) => word.text)).toEqual(["Survivor"]);
    expect(page.confidence).toBeCloseTo(0.9);
  });

  test("survives output that is not TSV at all", () => {
    expect(() => parseTesseractTsv("Segmentation fault\ncore dumped")).not.toThrow();
    expect(parseTesseractTsv("Segmentation fault").words).toEqual([]);
  });
});

describe("imageFileExtension", () => {
  const withHeader = (...bytes: number[]) => new Uint8Array([...bytes, ...new Array(16).fill(0)]);

  test("recognises the formats tesseract is handed", () => {
    expect(imageFileExtension(withHeader(0x89, 0x50, 0x4e, 0x47))).toBe("png");
    expect(imageFileExtension(withHeader(0xff, 0xd8, 0xff))).toBe("jpg");
    expect(imageFileExtension(withHeader(0x49, 0x49, 0x2a, 0x00))).toBe("tif");
    expect(imageFileExtension(withHeader(0x42, 0x4d))).toBe("bmp");
  });

  test("reads WEBP's marker at its real offset", () => {
    const webp = new Uint8Array(16);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(imageFileExtension(webp)).toBe("webp");
  });

  test("defaults rather than failing on an unknown header", () => {
    expect(imageFileExtension(new Uint8Array([1, 2, 3]))).toBe("png");
    expect(imageFileExtension(new Uint8Array(0))).toBe("png");
  });
});

// ---------------------------------------------------------------------------
// tesseract: absence
// ---------------------------------------------------------------------------

describe("tesseract when it is not installed", () => {
  const MISSING = "/nonexistent/bin/tesseract";

  test("a configured path that does not exist resolves to nothing", () => {
    // Deliberately not a fallback to PATH: a typo in the setting must surface as
    // "not found" rather than as "ran some other binary".
    expect(resolveTesseractBinary(MISSING)).toBeNull();
  });

  test("isAvailable answers false without throwing or spawning", async () => {
    await expect(createTesseractProvider({ binaryPath: MISSING }).isAvailable()).resolves.toBe(false);
  });

  test("recognize explains how to install it", async () => {
    const provider = createTesseractProvider({ binaryPath: MISSING });
    const attempt = provider.recognize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {});

    await expect(attempt).rejects.toThrow(OcrUnavailableError);
    await expect(attempt).rejects.toThrow(/brew install tesseract/);
    await expect(attempt).rejects.toThrow(/apt-get install -y tesseract-ocr/);
  });
});

// ---------------------------------------------------------------------------
// vision: the prompt
// ---------------------------------------------------------------------------

describe("OCR_VISION_PROMPT", () => {
  test("denies the model its assistant role, which is what measurably worked", () => {
    // Naming the invented labels and forbidding them did not stop minicpm-v
    // emitting them; reframing the role did. If this line goes, they come back.
    expect(OCR_VISION_PROMPT).toContain("You are an OCR engine, not an assistant.");
  });

  test("offers a sentinel so a blank page never has to be invented", () => {
    expect(OCR_VISION_PROMPT).toContain(NO_TEXT_SENTINEL);
  });

  test("forbids continuing the text and naming structure", () => {
    expect(OCR_VISION_PROMPT).toContain("Never add labels");
    expect(OCR_VISION_PROMPT).toContain("Never continue, complete or correct the text");
  });
});

// ---------------------------------------------------------------------------
// vision: sanitisation
// ---------------------------------------------------------------------------

describe("sanitiseVisionTranscription", () => {
  const clean = "THE HARBOUR ACCOUNTS\n\nOne: The Pier\n\nThe tide came in at four.\n47";

  test("passes a clean transcription through with its line breaks intact", () => {
    const result = sanitiseVisionTranscription(clean);

    expect(result.accepted).toBe(true);
    expect(result.text).toBe(clean);
    expect(result.guards).toEqual([]);
    expect(result.confidence).toBe(VISION_CONFIDENCE);
  });

  test("never assigns a high confidence, however clean the output", () => {
    // The model reports nothing, and a perfect transcription and a fabricated
    // one are indistinguishable from here, so the number is a constant.
    expect(VISION_CONFIDENCE).toBeLessThan(0.75);
    expect(sanitiseVisionTranscription(clean).confidence).toBe(VISION_CONFIDENCE);
  });

  describe("the [[NO_TEXT]] sentinel", () => {
    test("reports a blank page as blank rather than as a failure", () => {
      const result = sanitiseVisionTranscription(`  ${NO_TEXT_SENTINEL}\n`);

      expect(result.accepted).toBe(true);
      expect(result.text).toBe("");
      expect(result.confidence).toBe(0);
      expect(result.guards).toContain("blank_page");
    });

    test("treats empty output as a blank page too", () => {
      expect(sanitiseVisionTranscription("   ").guards).toContain("blank_page");
    });

    test("keeps the transcription when the model emits both", () => {
      const result = sanitiseVisionTranscription(`${NO_TEXT_SENTINEL}\nCHAPTER ONE`);

      expect(result.accepted).toBe(true);
      expect(result.text).toBe("CHAPTER ONE");
      expect(result.notes.join(" ")).toContain("no readable text but also produced some");
    });
  });

  describe("preamble stripping", () => {
    test("removes a preamble line and keeps the transcription", () => {
      const result = sanitiseVisionTranscription("Here is the text from the image\nCHAPTER ONE");

      expect(result.accepted).toBe(true);
      expect(result.text).toBe("CHAPTER ONE");
      expect(result.guards).toContain("preamble_stripped");
    });

    test("splits a preamble that shares its line with the text", () => {
      const result = sanitiseVisionTranscription("Here is the transcription: CHAPTER ONE");
      expect(result.text).toBe("CHAPTER ONE");
    });

    test("scores a stripped page below a clean one", () => {
      const stripped = sanitiseVisionTranscription("Here is the transcription:\nCHAPTER ONE");
      expect(stripped.confidence).toBeLessThan(VISION_CONFIDENCE);
    });

    test("rejects output that was preamble and nothing else", () => {
      const result = sanitiseVisionTranscription("Here is the transcription of the page:");

      expect(result.accepted).toBe(false);
      expect(result.text).toBe("");
    });

    test("leaves prose that merely opens with 'Here is'", () => {
      // A guard that eats the first line of a real book is a silent deletion,
      // so the opener alone is not enough — it has to name what it introduces.
      const prose = "Here is the church, here is the steeple.\nAnd here are the people.";
      const result = sanitiseVisionTranscription(prose);

      expect(result.accepted).toBe(true);
      expect(result.text).toBe(prose);
      expect(result.guards).not.toContain("preamble_stripped");
    });
  });

  describe("invented structure", () => {
    test("strips the labels the model classified the page with", () => {
      // Observed verbatim from minicpm-v on a page containing none of these
      // words. Narrated aloud a listener hears "Title: The Harbour Accounts".
      const result = sanitiseVisionTranscription(
        "Title: THE HARBOUR ACCOUNTS\nSubtitle: One: The Pier\nBody Text: The tide came in.\nFooter: 47",
      );

      expect(result.accepted).toBe(true);
      expect(result.text).toBe("THE HARBOUR ACCOUNTS\nOne: The Pier\nThe tide came in.\n47");
      expect(result.guards).toContain("structural_labels_stripped");
      expect(result.confidence).toBeLessThan(VISION_CONFIDENCE);
    });

    test("strips markdown the page cannot contain", () => {
      const result = sanitiseVisionTranscription("**THE HARBOUR ACCOUNTS**\n\n# One: The Pier\n\nThe tide.");

      expect(result.text).toBe("THE HARBOUR ACCOUNTS\n\nOne: The Pier\n\nThe tide.");
      expect(result.guards).toContain("markdown_stripped");
      // Formatting noise is expected even from a well-behaved model, so unlike
      // an invented label it does not cost confidence.
      expect(result.confidence).toBe(VISION_CONFIDENCE);
    });

    test("strips a label the model also wrapped in markdown", () => {
      expect(sanitiseVisionTranscription("**Title:** THE HARBOUR ACCOUNTS").text).toBe(
        "THE HARBOUR ACCOUNTS",
      );
    });

    test("unwraps a code fence", () => {
      const result = sanitiseVisionTranscription("```\nCHAPTER ONE\nThe tide came in.\n```");

      expect(result.text).toBe("CHAPTER ONE\nThe tide came in.");
      expect(result.guards).toContain("code_fence_stripped");
    });

    test("leaves a single asterisk alone", () => {
      // Footnote markers and emphasis do appear in print; only doubled markdown
      // is treated as the model's own addition.
      expect(sanitiseVisionTranscription("A note.* And another.").text).toBe("A note.* And another.");
    });
  });

  describe("meta-commentary", () => {
    test("rejects a refusal", () => {
      const result = sanitiseVisionTranscription("I'm sorry, I cannot read the text in this image.");

      expect(result.accepted).toBe(false);
      expect(result.text).toBe("");
      expect(result.guards).toContain("meta_commentary");
    });

    test("rejects a description of the page", () => {
      const result = sanitiseVisionTranscription("The image shows a handwritten ledger page.");
      expect(result.accepted).toBe(false);
    });

    test("rejects a model that says a page is blank instead of using the sentinel", () => {
      expect(sanitiseVisionTranscription("No readable text is visible on this page.").accepted).toBe(false);
    });

    test("rejects an AI disclaimer wherever it appears", () => {
      const buried = `${"The tide came in at four. ".repeat(20)}As an AI, I should note this.`;
      expect(sanitiseVisionTranscription(buried).accepted).toBe(false);
    });

    test("does not reject a book that happens to describe an image mid-page", () => {
      // The descriptive patterns only count at the margins, where a model's
      // framing lives — a novel's own sentences must survive.
      const filler = "The harbour master wrote it down without comment. ".repeat(8);
      const result = sanitiseVisionTranscription(
        `${filler}The image shows nothing of the sort, he wrote. ${filler}`,
      );

      expect(result.accepted).toBe(true);
      expect(result.text).toContain("The image shows nothing of the sort");
    });
  });

  describe("runaway output", () => {
    test("rejects more text than a page can hold", () => {
      const result = sanitiseVisionTranscription("a".repeat(MAX_PLAUSIBLE_PAGE_CHARACTERS + 1));

      expect(result.accepted).toBe(false);
      expect(result.guards).toContain("over_long");
      expect(result.notes.join(" ")).toContain("generated rather than read");
    });

    test("honours a caller's tighter ceiling", () => {
      expect(sanitiseVisionTranscription("a".repeat(200), { maxCharacters: 100 }).accepted).toBe(false);
      expect(sanitiseVisionTranscription("a".repeat(80), { maxCharacters: 100 }).accepted).toBe(true);
    });

    test("rejects the model reciting its own instructions", () => {
      const result = sanitiseVisionTranscription("You are an OCR engine, not an assistant.\nCHAPTER ONE");

      expect(result.accepted).toBe(false);
      expect(result.guards).toContain("prompt_echo");
    });
  });

  test("every rejection yields empty text, never partial prose", () => {
    const rejected = [
      "I'm sorry, I cannot transcribe this.",
      "a".repeat(MAX_PLAUSIBLE_PAGE_CHARACTERS + 1),
      "Output ONLY the transcription... you are an OCR engine, not an assistant.",
    ];

    for (const raw of rejected) {
      const result = sanitiseVisionTranscription(raw);
      expect(result.accepted).toBe(false);
      expect(result.text).toBe("");
      expect(result.confidence).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// vision: Ollama plumbing
// ---------------------------------------------------------------------------

describe("toOllamaNativeBaseUrl", () => {
  test("drops the OpenAI-compatible suffix the chat client uses", () => {
    expect(toOllamaNativeBaseUrl("http://localhost:11434/v1")).toBe("http://localhost:11434");
    expect(toOllamaNativeBaseUrl("http://localhost:11434/v1/")).toBe("http://localhost:11434");
    expect(toOllamaNativeBaseUrl("http://host.docker.internal:11434/v1")).toBe(
      "http://host.docker.internal:11434",
    );
  });

  test("leaves a native root alone", () => {
    expect(toOllamaNativeBaseUrl("  http://127.0.0.1:11434/  ")).toBe("http://127.0.0.1:11434");
  });
});

describe("isModelPresent", () => {
  test("matches an untagged name against its :latest build", () => {
    expect(isModelPresent(["minicpm-v:latest"], "minicpm-v")).toBe(true);
    expect(isModelPresent(["minicpm-v"], "minicpm-v:latest")).toBe(true);
    expect(isModelPresent([" MiniCPM-V:Latest "], "minicpm-v")).toBe(true);
  });

  test("does not match a different model or an empty name", () => {
    expect(isModelPresent(["llama3:8b"], "minicpm-v")).toBe(false);
    expect(isModelPresent(["minicpm-v:q4"], "minicpm-v")).toBe(false);
    expect(isModelPresent([], "minicpm-v")).toBe(false);
    expect(isModelPresent(["minicpm-v:latest"], "  ")).toBe(false);
  });
});

describe("isModelMissingResponse", () => {
  test("recognises a model the server cannot run", () => {
    // A tag can be listed by /api/tags while its blobs are still incomplete, so
    // this has to be caught from the generate call rather than from the listing.
    expect(isModelMissingResponse(404, "")).toBe(true);
    expect(isModelMissingResponse(500, `{"error":"model 'minicpm-v:latest' not found"}`)).toBe(true);
    expect(isModelMissingResponse(400, "no such model")).toBe(true);
  });

  test("leaves an ordinary failure alone", () => {
    expect(isModelMissingResponse(500, "internal server error")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// escalation
// ---------------------------------------------------------------------------

describe("decideEscalation", () => {
  const base = { minConfidence: 0.75, visionAvailable: true };

  test("leaves a confident page alone", () => {
    const decision = decideEscalation({ ...base, result: ocrResult(FULL_PAGE, 0.94) });

    expect(decision.escalate).toBe(false);
    expect(decision.reason).toBe("confident");
  });

  test("escalates a page scored below the threshold", () => {
    const decision = decideEscalation({ ...base, result: ocrResult(FULL_PAGE, 0.41) });

    expect(decision.escalate).toBe(true);
    expect(decision.reason).toBe("low_confidence");
    expect(decision.detail).toContain("0.41");
    expect(decision.detail).toContain("0.75");
  });

  test("escalates a page too short to be a page", () => {
    const decision = decideEscalation({ ...base, result: ocrResult("47", 0.99) });

    expect(decision.escalate).toBe(true);
    expect(decision.reason).toBe("implausibly_short");
  });

  test("escalates a page nothing was recognised on", () => {
    const decision = decideEscalation({ ...base, result: ocrResult("   ", 0) });

    expect(decision.escalate).toBe(true);
    expect(decision.reason).toBe("no_text_recognised");
  });

  test("never escalates without a vision provider, however bad the page", () => {
    for (const result of [ocrResult("", 0), ocrResult("47", 0.1), ocrResult(FULL_PAGE, 0.2)]) {
      const decision = decideEscalation({ ...base, visionAvailable: false, result });

      expect(decision.escalate).toBe(false);
      expect(decision.reason).toBe("no_vision_provider");
    }
  });

  test("honours a caller's own short-page floor", () => {
    const short = ocrResult("Chapter One", 0.99);

    expect(decideEscalation({ ...base, result: short, minCharacters: 5 }).escalate).toBe(false);
    expect(decideEscalation({ ...base, result: short, minCharacters: 400 }).escalate).toBe(true);
  });

  test("the default floor is under one line of type", () => {
    expect(MIN_PLAUSIBLE_PAGE_CHARACTERS).toBeLessThan(FULL_PAGE.length);
  });
});

describe("chooseOcrResult", () => {
  test("takes the higher confidence", () => {
    const chosen = chooseOcrResult([ocrResult("garbled", 0.2), ocrResult("clean", 0.45, "ollama:m")]);
    expect(chosen.provider).toBe("ollama:m");
  });

  test("keeps the engine that fails loudly on a tie", () => {
    // Tesseract runs first, and when two engines are equally sure the one whose
    // failures a listener can hear is the safer thing to narrate.
    const chosen = chooseOcrResult([ocrResult("tess", 0.45), ocrResult("vision", 0.45, "ollama:m")]);
    expect(chosen.provider).toBe("tesseract");
  });

  test("prefers a mediocre Tesseract page over an unverifiable transcription", () => {
    const chosen = chooseOcrResult([ocrResult("mediocre", 0.6), ocrResult("fluent", VISION_CONFIDENCE, "ollama:m")]);
    expect(chosen.provider).toBe("tesseract");
  });

  test("returns an empty result rather than throwing on no attempts", () => {
    expect(chooseOcrResult([])).toEqual({ text: "", confidence: 0, words: [], provider: "none" });
  });
});

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

describe("OCR settings", () => {
  test("default to disabled, so a scan yields nothing rather than guesses", () => {
    const app = defaultSettings().app;

    expect(app.ocr_provider).toBe("");
    expect(app.ocr_language).toBe("eng");
    expect(app.tesseract_path).toBe("");
    expect(app.ocr_ollama_model).toBe("minicpm-v:latest");
    expect(app.ocr_ollama_prompt).toBe("");
    expect(app.ocr_ollama_timeout).toBe(120);
    expect(app.ocr_min_confidence).toBe(0.75);
  });

  test("accept the engines this build has", () => {
    for (const provider of ["", "tesseract", "ollama"]) {
      expect(appSettingsSchema.safeParse({ ocr_provider: provider }).success).toBe(true);
    }
  });

  test("reject an unknown engine", () => {
    expect(appSettingsSchema.safeParse({ ocr_provider: "paddle" }).success).toBe(false);
  });

  test("reject a threshold outside 0..1", () => {
    expect(appSettingsSchema.safeParse({ ocr_min_confidence: 1.5 }).success).toBe(false);
    expect(appSettingsSchema.safeParse({ ocr_min_confidence: -0.1 }).success).toBe(false);
    expect(appSettingsSchema.safeParse({ ocr_min_confidence: 0.5 }).success).toBe(true);
  });

  test("reject a non-numeric timeout", () => {
    expect(appSettingsSchema.safeParse({ ocr_ollama_timeout: "soon" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

describe("provider selection", () => {
  beforeEach(() => __setSettingsForTest(defaultSettings()));
  afterEach(() => __setSettingsForTest(defaultSettings()));

  test("reads the configured engine out of settings", () => {
    const config = resolveOcrConfig();

    expect(config.provider).toBe("");
    expect(config.language).toBe("eng");
    expect(config.minConfidence).toBe(0.75);
  });

  test("is off until an engine is chosen", () => {
    expect(isOcrEnabled()).toBe(false);
    expect(getOcrProvider()).toBeNull();
  });

  test("builds either engine on request, without touching it", () => {
    expect(getOcrProvider("tesseract")?.id).toBe("tesseract");
    expect(getOcrProvider("ollama")?.id).toBe("ollama");
    expect(listOcrProviders().map((provider) => provider.id)).toEqual(["tesseract", "ollama"]);
  });

  test("returns nothing for an engine this build does not have", () => {
    expect(getOcrProvider("paddle")).toBeNull();
  });

  test("recognizePage refuses while OCR is disabled, and says how to enable it", async () => {
    const attempt = recognizePage(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    await expect(attempt).rejects.toThrow(OcrUnavailableError);
    await expect(attempt).rejects.toThrow(/app\.ocr_provider/);
  });
});
