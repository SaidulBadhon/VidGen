/**
 * Minimal ZIP reader, sized for EPUB.
 *
 * EPUB is a ZIP container and Bun ships no archive reader, so rather than take
 * on a dependency this reads the format directly — `node:zlib` already provides
 * raw inflate and the central directory is a handful of fixed-width fields.
 * Only what EPUB actually uses is supported (stored and deflated entries, no
 * ZIP64, no encryption); anything else fails loudly rather than guessing.
 *
 * The input is an untrusted upload, so the reader treats every number the
 * archive supplies as a claim to be checked: offsets are range-checked before
 * they are followed, output is capped so a zip bomb cannot exhaust memory, and
 * entry names that escape the archive root are rejected outright.
 *
 * CRC-32 is deliberately not validated. Deflate already fails on a corrupt
 * stream, stored entries are bounded by the directory's own sizes, and a
 * checksum mismatch would not change what the reader can do about it.
 */

import { inflateRawSync } from "node:zlib";
import { BookExtractionError } from "./types.ts";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;

/** The archive comment is 16-bit length-prefixed, so the record starts within this window. */
const EOCD_SEARCH_WINDOW = EOCD_SIZE + 0xffff;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** Bit 0 of the general purpose flags marks the entry as encrypted. */
const FLAG_ENCRYPTED = 0x1;

/** Bit 11 of the general purpose flags declares the entry name is UTF-8. */
const FLAG_UTF8_NAMES = 0x800;

/** Value a size or offset takes when the real one lives in a ZIP64 record. */
const ZIP64_MARKER = 0xffffffff;

/**
 * Ceiling on entry count. A heavily illustrated book runs to a few thousand
 * files, so this leaves generous headroom while still bounding the work a
 * crafted directory can ask for.
 */
export const MAX_ZIP_ENTRIES = 20_000;

/**
 * Ceiling on total decompressed bytes. Sized for a real illustrated book rather
 * than for the text alone, since the reader cannot know which entries matter
 * until the package document has been parsed.
 */
export const MAX_ZIP_TOTAL_BYTES = 256 * 1024 * 1024;

const UTF8 = new TextDecoder("utf-8");
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });

export interface ZipReadOptions {
  /**
   * Entries to bother reading. Images and fonts are almost all of an
   * illustrated EPUB's bytes and none of its text, so skipping them keeps peak
   * memory proportional to what the caller will actually use.
   */
  include?: (name: string) => boolean;
  maxEntries?: number;
  maxTotalBytes?: number;
}

/**
 * Reads file entries into memory, keyed by their archive path.
 *
 * EPUBs are small and every part of extraction needs random access to them, so
 * eager reading is simpler than a lazy handle and costs nothing in practice.
 *
 * When two entries share a name the first wins: a later duplicate would replace
 * content already resolved, which is a shadowing trick rather than a legitimate
 * archive layout.
 */
export function readZip(buffer: Uint8Array, options: ZipReadOptions = {}): Map<string, Uint8Array> {
  const include = options.include;
  const maxEntries = options.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_ZIP_TOTAL_BYTES;

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const eocd = findEndOfCentralDirectory(view);

  const entryCount = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || directorySize === ZIP64_MARKER || directoryOffset === ZIP64_MARKER) {
    throw new BookExtractionError("zip64 archives are not supported");
  }
  if (entryCount > maxEntries) {
    throw new BookExtractionError(`zip archive declares ${entryCount} entries, more than the ${maxEntries} allowed`);
  }
  requireRange(view, directoryOffset, directorySize, "central directory");

  const entries = new Map<string, Uint8Array>();
  let remainingBytes = maxTotalBytes;
  let cursor = directoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    requireRange(view, cursor, CENTRAL_SIZE, `central directory entry ${index}`);
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new BookExtractionError(`malformed zip archive: entry ${index} has no central directory header`);
    }

    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);

    requireRange(view, cursor + CENTRAL_SIZE, nameLength, `name of entry ${index}`);
    const nameStart = cursor + CENTRAL_SIZE;
    const name = decodeEntryName(buffer.subarray(nameStart, nameStart + nameLength), flags);
    cursor = nameStart + nameLength + extraLength + commentLength;

    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw new BookExtractionError(
        `the file is DRM-protected or password-protected (${name} is encrypted) and cannot be read`,
      );
    }
    requireSafeEntryName(name);

    // Directory markers carry no data and nothing downstream looks them up.
    if (name.endsWith("/")) continue;
    if (entries.has(name)) continue;
    if (include && !include(name)) continue;

    const data = readEntryData(
      buffer,
      view,
      { name, method, localOffset, compressedSize },
      remainingBytes,
      maxTotalBytes,
    );
    remainingBytes -= data.length;
    entries.set(name, data);
  }

  return entries;
}

/** Reads an entry as UTF-8 text. Throws when the archive has no such entry. */
export function readZipText(entries: Map<string, Uint8Array>, path: string): string {
  const text = tryReadZipText(entries, path);
  if (text === undefined) throw new BookExtractionError(`zip entry not found: ${path}`);
  return text;
}

export function tryReadZipText(entries: Map<string, Uint8Array>, path: string): string | undefined {
  const data = entries.get(path);
  // TextDecoder drops a leading BOM, which XML parsing downstream would
  // otherwise see as stray content ahead of the declaration.
  return data === undefined ? undefined : UTF8.decode(data);
}

// ---------------------------------------------------------------------------

interface ZipEntryHeader {
  name: string;
  method: number;
  localOffset: number;
  compressedSize: number;
}

function readEntryData(
  buffer: Uint8Array,
  view: DataView,
  entry: ZipEntryHeader,
  budget: number,
  limit: number,
): Uint8Array {
  requireRange(view, entry.localOffset, LOCAL_SIZE, `local header of ${entry.name}`);
  if (view.getUint32(entry.localOffset, true) !== LOCAL_SIGNATURE) {
    throw new BookExtractionError(`malformed zip archive: ${entry.name} has no local file header`);
  }

  // Only the name and extra lengths are read here: a writer using a data
  // descriptor leaves the local header's sizes at zero, so the central
  // directory is the only trustworthy source for them.
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + LOCAL_SIZE + nameLength + extraLength;

  requireRange(view, start, entry.compressedSize, `data of ${entry.name}`);
  const raw = buffer.subarray(start, start + entry.compressedSize);

  if (entry.method === METHOD_STORED) {
    if (raw.length > budget) throw budgetExceeded(limit);
    return raw;
  }
  if (entry.method !== METHOD_DEFLATE) {
    throw new BookExtractionError(`unsupported zip compression method ${entry.method} for ${entry.name}`);
  }

  try {
    // maxOutputLength aborts the inflate itself, so a bomb is refused rather
    // than allocated and then measured.
    return new Uint8Array(inflateRawSync(raw, { maxOutputLength: budget }));
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw budgetExceeded(limit);
    throw new BookExtractionError(`failed to inflate ${entry.name}: ${(error as Error).message}`);
  }
}

function budgetExceeded(limit: number): BookExtractionError {
  return new BookExtractionError(`the archive expands to more than the ${limit} bytes allowed and was rejected`);
}

function findEndOfCentralDirectory(view: DataView): number {
  if (view.byteLength < EOCD_SIZE) {
    throw new BookExtractionError("not a zip archive: the file is too small to hold a directory");
  }

  const limit = Math.max(0, view.byteLength - EOCD_SEARCH_WINDOW);
  for (let offset = view.byteLength - EOCD_SIZE; offset >= limit; offset -= 1) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    // The signature also occurs inside compressed data and archive comments, so
    // a candidate only counts when its comment length reaches exactly the end.
    if (offset + EOCD_SIZE + view.getUint16(offset + 20, true) === view.byteLength) return offset;
  }

  throw new BookExtractionError("not a zip archive: no end-of-central-directory record found");
}

function decodeEntryName(bytes: Uint8Array, flags: number): string {
  // Without bit 11 the spec says the name is CP437, which agrees with UTF-8
  // across the ASCII range every EPUB filename lives in, so a lenient decode is
  // a better answer than a refusal. With the bit set the archive claims UTF-8,
  // and a name that then fails to decode means the directory is corrupt.
  if ((flags & FLAG_UTF8_NAMES) === 0) return UTF8.decode(bytes);

  try {
    return UTF8_STRICT.decode(bytes);
  } catch {
    throw new BookExtractionError("malformed zip archive: an entry name is not valid UTF-8");
  }
}

/**
 * Rejects names that address anything outside the archive.
 *
 * Nothing here writes an entry to disk, but the map is keyed by these names and
 * callers resolve hrefs against them, so a `../` entry is refused at the door
 * rather than trusted to stay harmless further down the pipeline.
 */
function requireSafeEntryName(name: string): void {
  const unsafe =
    name === "" ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    /^[a-zA-Z]:/.test(name) ||
    name.split("/").includes("..");

  if (unsafe) {
    throw new BookExtractionError(`zip archive contains an unsafe entry path: ${JSON.stringify(name)}`);
  }
}

function requireRange(view: DataView, offset: number, length: number, what: string): void {
  if (offset < 0 || length < 0 || offset + length > view.byteLength) {
    throw new BookExtractionError(`malformed zip archive: ${what} extends past the end of the file`);
  }
}
