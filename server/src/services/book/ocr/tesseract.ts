/**
 * Tesseract adapter.
 *
 * Tesseract is the honest engine of the two: when it cannot read a page it says
 * so, both by emitting visibly broken characters and by scoring the words it
 * guessed. That per-word score is the whole reason this adapter asks for TSV
 * rather than plain text — it is what decides whether a page is good enough to
 * narrate, whether it should escalate to the vision model, and where the page
 * lands in the review screen's least-certain-first ordering.
 *
 * The binary is optional, exactly like whisper.cpp: `isAvailable()` answers
 * without spawning anything and `recognize()` explains how to install it rather
 * than failing obscurely.
 */

import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { logger } from "../../../utils/logger.ts";
import {
  clampConfidence,
  meanConfidence,
  OcrUnavailableError,
  type OcrOptions,
  type OcrProvider,
  type OcrResult,
  type OcrWord,
} from "./types.ts";

export const TESSERACT_PROVIDER_ID = "tesseract";

/** Long enough for a dense page on a slow CPU, short enough to bound an import. */
const DEFAULT_TIMEOUT_MS = 120_000;

const INSTALL_HINT =
  "Install it (`brew install tesseract` on macOS, `apt-get install -y tesseract-ocr` " +
  'on Debian/Ubuntu), set app.tesseract_path, or switch app.ocr_provider to "ollama".';

/**
 * Locates the tesseract binary.
 *
 * Mirrors `resolveWhisperBinary()`, including the deliberate asymmetry: an
 * explicitly configured path that does not exist resolves to null rather than
 * quietly falling back to PATH, because a typo in a setting should surface as
 * "not found" and not as "ran something else".
 *
 * The `tesseract_path` setting wins over `TESSERACT_PATH`, which wins over PATH.
 */
export function resolveTesseractBinary(configuredPath?: string): string | null {
  const configured = configuredPath?.trim() || process.env.TESSERACT_PATH?.trim() || "";
  if (configured) return existsSync(configured) ? configured : null;

  return Bun.which("tesseract");
}

// ---------------------------------------------------------------------------
// TSV parsing — pure, and the part worth testing hardest
// ---------------------------------------------------------------------------

/** Column order tesseract has emitted since 4.x, used when the header is absent. */
const CANONICAL_COLUMNS = [
  "level",
  "page_num",
  "block_num",
  "par_num",
  "line_num",
  "word_num",
  "left",
  "top",
  "width",
  "height",
  "conf",
  "text",
] as const;

interface ColumnIndex {
  block: number;
  par: number;
  line: number;
  left: number;
  top: number;
  width: number;
  height: number;
  conf: number;
  text: number;
}

function columnIndex(names: readonly string[]): ColumnIndex {
  const at = (name: string) => names.indexOf(name);
  return {
    block: at("block_num"),
    par: at("par_num"),
    line: at("line_num"),
    left: at("left"),
    top: at("top"),
    width: at("width"),
    height: at("height"),
    conf: at("conf"),
    text: at("text"),
  };
}

function numberAt(fields: readonly string[], index: number, fallback: number): number {
  if (index < 0 || index >= fields.length) return fallback;
  const parsed = Number.parseFloat(fields[index] ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface TesseractPage {
  /** Words only, in reading order. */
  words: OcrWord[];
  /** Words rejoined with the line and paragraph breaks the TSV describes. */
  text: string;
  /** Mean word confidence, 0..1. */
  confidence: number;
}

/**
 * Parses tesseract's TSV output.
 *
 * Every row carries a `level`: 1 page, 2 block, 3 paragraph, 4 line, 5 word.
 * Only word rows have text and a real confidence, and the structural rows are
 * scored `-1`, so a row counts as a word when it has non-blank text and a
 * non-negative confidence. Testing that pair rather than the level itself keeps
 * the parse working on truncated or column-shifted output, which is the shape
 * malformed input actually takes.
 *
 * Never throws: a page that will not parse is a page with no text, which the
 * escalation policy then treats as a candidate for the vision model.
 */
export function parseTesseractTsv(tsv: string): TesseractPage {
  const lines = tsv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { words: [], text: "", confidence: 0 };

  const first = (lines[0] ?? "").split("\t");
  const hasHeader = first.includes("conf") && first.includes("text");
  const columns = columnIndex(hasHeader ? first : CANONICAL_COLUMNS);
  const rows = hasHeader ? lines.slice(1) : lines;

  const words: OcrWord[] = [];
  /** `block|par|line` of the word before, so breaks are emitted between groups. */
  const keys: string[] = [];

  for (const row of rows) {
    const fields = row.split("\t");
    // A row that does not reach the text column is truncated, not a word.
    if (columns.text < 0 || columns.text >= fields.length) continue;

    const text = (fields[columns.text] ?? "").trim();
    if (!text) continue;

    const confidence = numberAt(fields, columns.conf, -1);
    if (confidence < 0) continue;

    const width = numberAt(fields, columns.width, Number.NaN);
    const height = numberAt(fields, columns.height, Number.NaN);
    const left = numberAt(fields, columns.left, Number.NaN);
    const top = numberAt(fields, columns.top, Number.NaN);
    const hasBox = [left, top, width, height].every(Number.isFinite);

    words.push({
      text,
      // Tesseract reports 0..100; the rest of the pipeline speaks 0..1.
      confidence: clampConfidence(confidence / 100),
      ...(hasBox ? { bbox: { x: left, y: top, w: width, h: height } } : {}),
    });
    keys.push(
      `${numberAt(fields, columns.block, 0)}|${numberAt(fields, columns.par, 0)}|` +
        `${numberAt(fields, columns.line, 0)}`,
    );
  }

  return { words, text: joinWords(words, keys), confidence: meanConfidence(words) };
}

/**
 * Rebuilds the page layout from the block/paragraph/line columns.
 *
 * The breaks are reproduced rather than normalised away: a printed line break is
 * evidence about the page, and deciding whether it is a wrapped sentence or a
 * genuine paragraph is the extractor's job, not the recogniser's.
 */
function joinWords(words: readonly OcrWord[], keys: readonly string[]): string {
  let text = "";

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (!word) continue;

    if (index === 0) {
      text = word.text;
      continue;
    }

    const [block, par, line] = (keys[index] ?? "").split("|");
    const [previousBlock, previousPar, previousLine] = (keys[index - 1] ?? "").split("|");

    if (block !== previousBlock || par !== previousPar) text += `\n\n${word.text}`;
    else if (line !== previousLine) text += `\n${word.text}`;
    else text += ` ${word.text}`;
  }

  return text;
}

/**
 * Picks a filename extension from the image's magic bytes.
 *
 * Leptonica sniffs the header rather than trusting the name, but an extension it
 * does not recognise makes it log a warning on some builds, and a wrong one
 * makes the temp files confusing to look at when a run is being debugged.
 */
export function imageFileExtension(image: Uint8Array): string {
  const at = (offset: number, ...bytes: number[]) =>
    bytes.every((byte, index) => image[offset + index] === byte);

  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
  if (at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a)) return "tif";
  if (at(0, 0x42, 0x4d)) return "bmp";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  // Unknown headers keep the default: leptonica reads the bytes, not the name.
  return "png";
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface TesseractProviderOptions {
  /** Configured `app.tesseract_path`; "" resolves from PATH. */
  binaryPath?: string;
  /** Configured `app.ocr_language`. */
  language?: string;
}

export function createTesseractProvider(options: TesseractProviderOptions = {}): OcrProvider {
  return {
    id: TESSERACT_PROVIDER_ID,

    async isAvailable(): Promise<boolean> {
      // Deliberately only a path lookup. Spawning `tesseract --version` per page
      // would cost more than the check is worth, and this must never throw.
      try {
        return resolveTesseractBinary(options.binaryPath) !== null;
      } catch {
        return false;
      }
    },

    async recognize(image: Uint8Array, runOptions: OcrOptions): Promise<OcrResult> {
      const binary = resolveTesseractBinary(options.binaryPath);
      if (!binary) {
        throw new OcrUnavailableError(
          TESSERACT_PROVIDER_ID,
          "tesseract was not found.",
          INSTALL_HINT,
        );
      }

      const language = runOptions.language || options.language || "eng";
      const imagePath = join(tmpdir(), `vidgen-ocr-${randomUUID()}.${imageFileExtension(image)}`);
      await Bun.write(imagePath, image);

      try {
        // `stdout` is the output base, and the config name (`tsv`) must come
        // last — tesseract's own argument order, not a stylistic choice.
        const tsv = await runTesseract(
          binary,
          [imagePath, "stdout", "-l", language, "tsv"],
          runOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          runOptions.signal,
        );

        const page = parseTesseractTsv(tsv);
        return {
          text: page.text,
          confidence: page.confidence,
          words: page.words,
          provider: TESSERACT_PROVIDER_ID,
        };
      } finally {
        await unlink(imagePath).catch(() => {});
      }
    },
  };
}

/** Runs tesseract and returns stdout, surfacing its stderr on failure. */
async function runTesseract(
  binary: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const proc = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });

  // A stuck engine must not hang a book import, so the deadline kills the
  // process rather than merely abandoning the promise.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const onAbort = () => proc.kill();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
      proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
      proc.exited,
    ]);

    if (timedOut) throw new Error(`tesseract timed out after ${timeoutMs}ms`);
    if (signal?.aborted) throw new Error("tesseract was cancelled");

    if (exitCode !== 0) {
      const detail = stderr.trim().split("\n").slice(-5).join("\n");
      // A missing language pack is the one failure an operator can fix, and its
      // native message ("Error opening data file...") does not say how.
      if (/traineddata|failed loading language/i.test(stderr)) {
        throw new OcrUnavailableError(
          TESSERACT_PROVIDER_ID,
          `tesseract has no language data for this page: ${detail}`,
          "Install the language pack (`brew install tesseract-lang` on macOS, " +
            "`apt-get install -y tesseract-ocr-eng` on Debian/Ubuntu).",
        );
      }
      throw new Error(detail || `tesseract exited with code ${exitCode}`);
    }

    if (stderr.trim()) logger.debug(`tesseract: ${stderr.trim().split("\n").slice(-2).join(" ")}`);
    return stdout;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
