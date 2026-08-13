/**
 * Book extraction entry point.
 *
 * Format is decided from the magic bytes first and the filename second: an
 * upload named `.txt` that is really a zip is an EPUB, and reading it as text
 * would produce a book of binary noise. The reverse does not hold — a file the
 * user calls `.epub` is routed to the EPUB reader even when the bytes disagree,
 * so the error explains what is wrong with it instead of silently narrating it.
 *
 * This dispatcher is the seam the rest of the pipeline talks to. Keeping it the
 * only entry point is what makes the hand-written EPUB parse behind it
 * replaceable without touching anything downstream.
 */

import type { BookSourceFormat, ExtractionResult } from "../types.ts";
import { extractEpub } from "./epub.ts";
import { extractPlainText } from "./text.ts";

export { extractEpub } from "./epub.ts";
export { extractPlainText, parseTextBlocks } from "./text.ts";
export { cleanText, decodeEntities, parseHtmlBlocks, type ParsedBlock } from "./html.ts";
export { readZip, readZipText, tryReadZipText, MAX_ZIP_ENTRIES, MAX_ZIP_TOTAL_BYTES } from "../zip.ts";

/** `PK\x03\x04`, the local file header signature every zip begins with. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export function detectBookFormat(data: Uint8Array, filename: string): BookSourceFormat {
  if (ZIP_MAGIC.every((byte, index) => data[index] === byte)) return "epub";
  return filename.toLowerCase().endsWith(".epub") ? "epub" : "text";
}

/**
 * Async because the formats still to come — PDF above all — will need it, and
 * changing every caller later is a worse trade than an await that resolves now.
 */
export async function extractBook(data: Uint8Array, filename: string): Promise<ExtractionResult> {
  return detectBookFormat(data, filename) === "epub"
    ? extractEpub(data, filename)
    : extractPlainText(data, filename);
}
