/**
 * Background music library: validation, storage, listing and lookup.
 * Ported from python-version/app/services/bgm.py.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { getFfmpegBinary, rootDir, songDir, uploadedBgmDir } from "../utils/paths.ts";
import { resolvePathWithinDirectory, UnsafePathError } from "../utils/fileSecurity.ts";
import { logger, errorMessage } from "../utils/logger.ts";

/**
 * Background music is normally a few MB. An explicit server-side cap stops an
 * oversized upload from filling the disk and starving concurrent renders.
 */
export const MAX_BGM_UPLOAD_BYTES = 30 * 1024 * 1024;

const INTERNAL_UPLOAD_PREFIX = ".bgm-upload-";
const WINDOWS_INVALID_FILENAME_CHARS = new Set(['<', '>', ':', '"', '|', '?', '*']);
const WINDOWS_RESERVED_FILENAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

/**
 * ffmpeg decodes the music, so MP3 is not a requirement. The list stays to
 * mainstream, unambiguous audio extensions so a container like MP4 cannot be
 * uploaded as background music.
 */
export const SUPPORTED_BGM_EXTENSIONS = [
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".flac",
  ".ogg",
  ".opus",
  ".wma",
] as const;

export class BgmUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BgmUploadError";
  }
}

export class BgmServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BgmServiceError";
  }
}

/**
 * Single rule for "does this task need any background music at all".
 *
 * Deliberately source-agnostic: with no type selected or a non-positive volume,
 * random, custom and every AI provider must all skip file lookup, paid
 * generation and mixing alike.
 */
export function shouldUseBgm(bgmType: string | null | undefined, bgmVolume: number | null | undefined): boolean {
  if (!String(bgmType ?? "").trim()) return false;
  const volume = Number(bgmVolume ?? 0);
  return Number.isFinite(volume) && volume > 0;
}

/** Validates a display filename and rejects unsupported or unsafe names. */
export function sanitizeBgmFilename(filename: string | undefined | null): string {
  const safeName = String(filename ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.trim();

  if (
    !safeName ||
    safeName === "." ||
    safeName === ".." ||
    safeName.length > 255 ||
    [...safeName].some((character) => character.charCodeAt(0) < 32) ||
    [...safeName].some((character) => WINDOWS_INVALID_FILENAME_CHARS.has(character)) ||
    safeName.toLowerCase().startsWith(INTERNAL_UPLOAD_PREFIX)
  ) {
    throw new BgmUploadError("invalid background music filename");
  }

  // Windows treats the segment before the extension as a device name, so
  // CON.mp3 and LPT1.wav cannot exist as ordinary files. Rejecting them up
  // front keeps the API's behaviour identical across platforms.
  const windowsBaseName = safeName.split(".")[0]!.replace(/[ .]+$/, "").toUpperCase();
  if (WINDOWS_RESERVED_FILENAMES.has(windowsBaseName)) {
    throw new BgmUploadError("invalid background music filename");
  }

  if (!(SUPPORTED_BGM_EXTENSIONS as readonly string[]).includes(extname(safeName).toLowerCase())) {
    const supported = SUPPORTED_BGM_EXTENSIONS.map((extension) => extension.slice(1).toUpperCase()).join(", ");
    throw new BgmUploadError(`unsupported background music format; supported formats: ${supported}`);
  }

  return safeName;
}

/**
 * Confirms the file holds a fully decodable audio stream.
 *
 * `-map 0:a:0` fails when there is no audio stream and `-xerror` promotes
 * decode errors to failures. Decoding the whole file also rejects encrypted
 * files and random data that happens to start with a valid frame header. Extra
 * streams such as cover art are fine; only the first audio stream is checked.
 */
export async function validateAudioFile(filePath: string, timeoutSeconds = 120): Promise<void> {
  if (!existsSync(filePath) || statSync(filePath).size <= 0) {
    throw new BgmUploadError("background music file is empty or missing");
  }

  let exitCode: number;
  try {
    const proc = Bun.spawn(
      [
        getFfmpegBinary(),
        "-nostdin",
        "-v",
        "error",
        "-xerror",
        "-i",
        filePath,
        "-map",
        "0:a:0",
        "-f",
        "null",
        "-",
      ],
      { stdout: "ignore", stderr: "pipe" },
    );

    const timer = setTimeout(() => proc.kill(), timeoutSeconds * 1000);
    try {
      exitCode = await proc.exited;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    throw new BgmServiceError(`failed to run FFmpeg for background music validation: ${errorMessage(error)}`);
  }

  if (exitCode !== 0) {
    throw new BgmUploadError("uploaded file must contain a decodable audio stream");
  }
}

/**
 * Persists an uploaded track under an immutable UUID name.
 *
 * The file is staged in the destination directory, validated, then moved into
 * place — so a concurrent upload or an interrupted process never leaves a
 * half-written file, and re-uploading the same name produces a new key so
 * queued tasks keep referring to the file they were created with.
 */
export async function saveBgmUpload(filename: string, data: ArrayBuffer | Uint8Array): Promise<string> {
  const safeName = sanitizeBgmFilename(filename);
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

  if (bytes.byteLength === 0) {
    throw new BgmUploadError("background music file is empty");
  }
  if (bytes.byteLength > MAX_BGM_UPLOAD_BYTES) {
    throw new BgmUploadError("background music file exceeds the 30 MB limit");
  }

  const targetDir = uploadedBgmDir(true);
  const suffix = extname(safeName).toLowerCase();
  // The staged file keeps the original extension so ffmpeg picks the right
  // demuxer for header-less formats such as raw AAC.
  const tempPath = join(targetDir, `${INTERNAL_UPLOAD_PREFIX}${crypto.randomUUID()}${suffix}`);
  const storedName = `${crypto.randomUUID().replace(/-/g, "")}${suffix}`;
  const targetPath = join(targetDir, storedName);

  try {
    await Bun.write(tempPath, bytes);
    await validateAudioFile(tempPath, 30);
    await rename(tempPath, targetPath);
    logger.info(
      `background music uploaded: original_name=${safeName}, stored_name=${storedName}, size=${bytes.byteLength} bytes`,
    );
    return storedName;
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    if (error instanceof BgmUploadError || error instanceof BgmServiceError) throw error;
    throw new BgmServiceError(`failed to persist background music upload: ${errorMessage(error)}`);
  }
}

/** Lists user uploads and built-in songs, resolved to real paths. */
export function listBgmFiles(): string[] {
  const filesByName = new Map<string, string>();

  for (const directory of [songDir(), uploadedBgmDir(true)]) {
    if (!existsSync(directory)) continue;

    for (const name of readdirSync(directory).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
      // Staged uploads carry a valid audio extension but have not been
      // validated yet, so they must never be picked as random music.
      if (name.startsWith(INTERNAL_UPLOAD_PREFIX)) continue;
      if (!(SUPPORTED_BGM_EXTENSIONS as readonly string[]).includes(extname(name).toLowerCase())) continue;

      try {
        // Enumerated entries are path-checked too: otherwise a symlink placed
        // in an allowed directory could point ffmpeg at an arbitrary file.
        filesByName.set(name, resolvePathWithinDirectory(directory, join(directory, name)));
      } catch (error) {
        logger.warning(`skip unsafe background music file: name=${name}, error=${errorMessage(error)}`);
      }
    }
  }

  return [...filesByName.keys()]
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((name) => filesByName.get(name)!);
}

/**
 * Resolves a requested track inside the two allowed directories.
 *
 * A bare filename hits the upload directory first, while absolute allow-listed
 * paths and legacy forms like `./resource/songs/lfm-aeroplane.mp3` keep working.
 */
export function resolveBgmFile(unsafePath: string): string {
  if (!unsafePath || !(SUPPORTED_BGM_EXTENSIONS as readonly string[]).includes(extname(unsafePath).toLowerCase())) {
    throw new UnsafePathError("unsupported background music path");
  }

  const candidates = [unsafePath];
  if (!isAbsolute(unsafePath)) candidates.push(join(rootDir(), unsafePath));

  let lastError: Error = new UnsafePathError("background music file does not exist");
  for (const directory of [uploadedBgmDir(true), songDir()]) {
    for (const candidate of candidates) {
      try {
        return resolvePathWithinDirectory(directory, candidate);
      } catch (error) {
        lastError = error as Error;
      }
    }
  }
  throw new UnsafePathError(lastError.message);
}

/**
 * Picks the track for a task.
 *
 * An explicit file is resolved inside the allow-list, "random" draws from the
 * library, and an empty library degrades to no music rather than failing.
 */
export function getBgmFile(bgmType = "random", bgmFile = "", random: () => number = Math.random): string {
  if (!bgmType) return "";

  if (bgmFile) {
    try {
      return resolveBgmFile(bgmFile);
    } catch (error) {
      // The value comes from user input, so it must resolve inside the allowed
      // directories — never to config files or credentials elsewhere on disk.
      logger.warning(`reject unsafe bgm file: ${bgmFile}, error: ${errorMessage(error)}`);
      return "";
    }
  }

  if (bgmType === "random") {
    const files = listBgmFiles();
    if (files.length === 0) {
      logger.warning("no background music files found");
      return "";
    }
    return files[Math.floor(random() * files.length)]!;
  }

  return "";
}
