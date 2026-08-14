/**
 * Book extraction entry point.
 *
 * Format is decided from the magic bytes first and the filename second: an
 * upload named `.txt` that is really a zip is an EPUB, and reading it as text
 * would produce a book of binary noise. The same goes for `%PDF`. The reverse
 * does not hold — a file the user calls `.epub` or `.pdf` is routed to that
 * reader even when the bytes disagree, so the error explains what is wrong with
 * it instead of silently narrating it.
 *
 * This dispatcher is the seam the rest of the pipeline talks to. Keeping it the
 * only entry point is what makes the hand-written EPUB parse behind it
 * replaceable without touching anything downstream.
 */

import type { BookSourceFormat, ExtractionResult } from "../types.ts";
import { extractEpub } from "./epub.ts";
import { extractPdf } from "./pdf.ts";
import { extractPlainText } from "./text.ts";

export { extractEpub } from "./epub.ts";
export { extractPlainText, parseTextBlocks } from "./text.ts";
export {
  extractPdf,
  renderPdfPageToPng,
  type PdfExtractionResult,
  type PdfScanReport,
} from "./pdf.ts";
export { cleanText, decodeEntities, parseHtmlBlocks, type ParsedBlock } from "./html.ts";
export { readZip, readZipText, tryReadZipText, MAX_ZIP_ENTRIES, MAX_ZIP_TOTAL_BYTES } from "../zip.ts";

/** `PK\x03\x04`, the local file header signature every zip begins with. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
/** `%PDF`, which every PDF opens with. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46];

export function detectBookFormat(data: Uint8Array, filename: string): BookSourceFormat {
  if (ZIP_MAGIC.every((byte, index) => data[index] === byte)) return "epub";
  if (PDF_MAGIC.every((byte, index) => data[index] === byte)) return "pdf";

  const name = filename.toLowerCase();
  if (name.endsWith(".epub")) return "epub";
  if (name.endsWith(".pdf")) return "pdf";
  return "text";
}

/** Async because PDF extraction is: pdf.js is loaded and driven asynchronously. */
export async function extractBook(data: Uint8Array, filename: string): Promise<ExtractionResult> {
  switch (detectBookFormat(data, filename)) {
    case "epub":
      return extractEpub(data, filename);
    case "pdf":
      return extractPdf(data, filename);
    default:
      return extractPlainText(data, filename);
  }
}
