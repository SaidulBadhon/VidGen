/**
 * Long-form narration: chunked synthesis, a resumable manifest, joined cues.
 *
 * A whole audiobook segment cannot go through one `tts()` call. Edge TTS gives
 * a single request `edge_tts_timeout` seconds (30 by default), cloud providers
 * cap characters per request, and one failure would throw away every minute of
 * synthesis already produced and paid for. Narration is therefore split into
 * chunks that are synthesised, validated and recorded one at a time, then
 * joined once at the end.
 *
 * Pure text/cue/manifest helpers sit at the top and are exported on their own so
 * they can be tested without ffmpeg, a network or a database.
 */

import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { PUNCTUATIONS } from "../../models/const.ts";
import { errorMessage, logger } from "../../utils/logger.ts";
import { sha256, sleep } from "../../utils/misc.ts";
import type { SubtitleCue } from "../subtitle/srt.ts";
import { deleteFiles, formatConcatPath } from "../video/concat.ts";
import { runFfmpeg, runFfprobe } from "../video/ffmpeg.ts";
import { probe } from "../video/probe.ts";
import { tts } from "./index.ts";
import { createSubtitleCues, formatTextForSubtitles } from "./subtitles.ts";
import { buildProportionalCues } from "./syntheticCues.ts";
import type { TtsCue } from "./types.ts";
import { inferTtsServerFromVoice, parseVoiceName } from "./voices.ts";

/**
 * Characters per synthesis request.
 *
 * Roughly 80 seconds of speech, which keeps one Edge TTS request comfortably
 * inside the 30s default timeout and below the smallest per-request character
 * cap among the cloud adapters.
 */
export const DEFAULT_MAX_CHARS = 1200;

/** Attempts per chunk, on top of whatever retrying the adapter already does. */
const MAX_CHUNK_ATTEMPTS = 3;

const MANIFEST_FILE = "chunks.json";
const MANIFEST_VERSION = 1;

// ---------------------------------------------------------------------------
// Chunking (pure)

/** Single-character entries of the shared punctuation list. */
const PUNCTUATION_CHARS: ReadonlySet<string> = new Set<string>(
  PUNCTUATIONS.filter((p) => p.length === 1),
);

/**
 * The subset of `PUNCTUATIONS` that ends a sentence rather than a clause.
 *
 * Listing the terminators explicitly (instead of deriving them) keeps sentence
 * splitting stable if the shared list grows; anything new in `PUNCTUATIONS`
 * still takes effect, as the weaker clause-level boundary below.
 */
const SENTENCE_ENDINGS: ReadonlySet<string> = new Set([..."?.!…？。！؟"]);

/** Everything else the app treats as punctuation: commas, colons, semicolons. */
const CLAUSE_ENDINGS: ReadonlySet<string> = new Set(
  [...PUNCTUATION_CHARS].filter((char) => !SENTENCE_ENDINGS.has(char)),
);

/** Quotes and brackets that belong to the sentence they close. */
const CLOSING_CHARS: ReadonlySet<string> = new Set([..."\"')]}»”’」』】）］"]);

const PARAGRAPH_BREAK = /(?:\r?\n)(?:[ \t]*\r?\n)+/g;

/**
 * A run of text plus the whitespace that separated it from the previous run.
 *
 * Carrying the original separator is what lets the packer rebuild chunks that
 * are exact substrings of the script: re-joining with a generic space would
 * insert one between CJK sentences and drop paragraph breaks, both of which
 * change how the engine reads the text.
 */
interface TextPiece {
  text: string;
  gap: string;
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

/**
 * True for the `.` in `2.5` and the `,` in `1,000`.
 *
 * Same guard as `splitStringByPunctuations`: a decimal point is not a sentence
 * boundary, and breaking there would hand the engine "2" and "5".
 */
function isNumericSeparator(text: string, index: number): boolean {
  const char = text[index];
  if (char !== "." && char !== ",") return false;
  const isDigit = (value: string | undefined) => value !== undefined && value >= "0" && value <= "9";
  return isDigit(text[index - 1]) && isDigit(text[index + 1]);
}

/** Splits on blank lines; the blank-line run becomes the next piece's gap. */
function splitParagraphs(text: string): TextPiece[] {
  const pieces: TextPiece[] = [];
  let cursor = 0;
  let gap = "";

  PARAGRAPH_BREAK.lastIndex = 0;
  let match = PARAGRAPH_BREAK.exec(text);
  while (match) {
    pieces.push({ text: text.slice(cursor, match.index), gap });
    gap = match[0];
    cursor = match.index + match[0].length;
    match = PARAGRAPH_BREAK.exec(text);
  }
  pieces.push({ text: text.slice(cursor), gap });

  return pieces.filter((piece) => piece.text.trim().length > 0);
}

/**
 * Splits after punctuation, keeping the punctuation on the left-hand piece.
 *
 * The engine's prosody comes from the text it is given: dropping the full stop
 * (as the subtitle-line splitter does) removes the pause at the end of the
 * sentence, so the character is deliberately kept.
 */
function splitAfterPunctuation(text: string, boundary: ReadonlySet<string>): TextPiece[] {
  const pieces: TextPiece[] = [];
  let current = "";
  let gap = "";
  let index = 0;

  while (index < text.length) {
    const char = text[index]!;
    current += char;
    index += 1;

    if (!boundary.has(char) || isNumericSeparator(text, index - 1)) continue;

    // "..." and '!"' end one sentence, not several.
    while (index < text.length && (boundary.has(text[index]!) || CLOSING_CHARS.has(text[index]!))) {
      current += text[index]!;
      index += 1;
    }

    let following = "";
    while (index < text.length && isWhitespace(text[index]!)) {
      following += text[index]!;
      index += 1;
    }

    // An ASCII full stop with no space after it is an abbreviation or a URL
    // ("e.g.", "example.com"), never a boundary. CJK and Arabic punctuation
    // carries no such ambiguity and is a boundary on its own.
    const isAscii = char.charCodeAt(0) < 128;
    if (isAscii && !following && index < text.length) continue;

    pieces.push({ text: current, gap });
    gap = following;
    current = "";
  }

  if (current.trim()) pieces.push({ text: current, gap });
  return pieces;
}

/** Avoids cutting a surrogate pair in half. */
function safeCutIndex(text: string, limit: number): number {
  const cut = Math.min(limit, text.length);
  const previous = text.charCodeAt(cut - 1);
  const isHighSurrogate = previous >= 0xd800 && previous <= 0xdbff;
  return Math.max(isHighSurrogate ? cut - 1 : cut, 1);
}

/**
 * Last-resort split for text with no punctuation left to break on.
 *
 * Breaks at the last whitespace that fits, so a word is never cut in two. A run
 * of non-whitespace longer than the whole limit (a pasted URL, or any CJK text,
 * which has no spaces) has no such boundary and is cut on a code point instead.
 */
function hardSplit(text: string, limit: number): TextPiece[] {
  const pieces: TextPiece[] = [];
  let rest = text;
  let gap = "";

  while (rest.length > limit) {
    let breakAt = -1;
    for (let i = Math.min(limit, rest.length - 1); i > 0; i--) {
      if (isWhitespace(rest[i]!)) {
        breakAt = i;
        break;
      }
    }

    let head: string;
    let nextGap: string;
    if (breakAt > 0) {
      let start = breakAt;
      while (start > 0 && isWhitespace(rest[start - 1]!)) start -= 1;
      let end = breakAt;
      while (end < rest.length && isWhitespace(rest[end]!)) end += 1;
      head = rest.slice(0, start);
      nextGap = rest.slice(start, end);
      rest = rest.slice(end);
    } else {
      const cut = safeCutIndex(rest, limit);
      head = rest.slice(0, cut);
      nextGap = "";
      rest = rest.slice(cut);
    }

    if (head.trim()) pieces.push({ text: head, gap });
    gap = nextGap;
  }

  if (rest.trim()) pieces.push({ text: rest, gap });
  return pieces;
}

/** Paragraph -> sentence -> clause -> characters, descending only as needed. */
function splitPiece(piece: TextPiece, limit: number, level: number): TextPiece[] {
  if (piece.text.length <= limit) return [piece];

  if (level >= 2) {
    const parts = hardSplit(piece.text, limit);
    return parts.map((part, position) => (position === 0 ? { ...part, gap: piece.gap } : part));
  }

  const parts = splitAfterPunctuation(piece.text, level === 0 ? SENTENCE_ENDINGS : CLAUSE_ENDINGS);
  if (parts.length <= 1) return splitPiece(piece, limit, level + 1);

  return parts
    .map((part, position) => (position === 0 ? { ...part, gap: piece.gap } : part))
    .flatMap((part) => splitPiece(part, limit, level + 1));
}

/** Greedily refills chunks so a book of one-line paragraphs is not one request each. */
function packPieces(pieces: TextPiece[], limit: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const piece of pieces) {
    const text = piece.text.trim();
    if (!text) continue;
    if (!current) {
      current = text;
      continue;
    }

    const candidate = current + piece.gap + text;
    if (candidate.length <= limit) {
      current = candidate;
    } else {
      chunks.push(current);
      current = text;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

/**
 * Splits narration into synthesis-sized chunks, preserving the text verbatim.
 *
 * Every chunk is a contiguous substring of the script apart from the whitespace
 * at the seams, so nothing the engine reads is added, dropped or reordered.
 */
export function chunkForTts(text: string, maxChars: number): string[] {
  const limit = Math.floor(maxChars);
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error(`invalid maxChars for chunking: ${maxChars}`);
  }

  const source = String(text ?? "");
  if (!source.trim()) return [];

  const pieces = splitParagraphs(source).flatMap((piece) => splitPiece(piece, limit, 0));
  return packPieces(pieces, limit);
}

// ---------------------------------------------------------------------------
// Cues (pure)

/**
 * Builds one chunk's subtitle cues, relative to the start of that chunk.
 *
 * `tts()` reports `TtsCue { start, end, content }`, which is not what the SRT
 * writer consumes — it needs `SubtitleCue { index, start, end, text }`. The
 * conversion runs through `createSubtitleCues()` rather than renaming the
 * field, because raw cues are per word ("金钱 / 是 / 一种") and only become
 * readable captions once aggregated against the script.
 *
 * When aggregation fails to cover the chunk, cues are re-derived by spreading
 * the probed chunk duration across its sentences. `createSubtitleCues()` alone
 * returns nothing in that case, which for a single short video means "no
 * subtitles" but here would leave a hole in the middle of a segment.
 */
export function buildChunkCues(
  ttsCues: TtsCue[],
  chunkText: string,
  chunkDuration: number,
): SubtitleCue[] {
  const formatted = formatTextForSubtitles(chunkText);
  if (!formatted.trim()) return [];

  const aligned = createSubtitleCues(ttsCues, formatted);
  if (aligned.length > 0) return aligned;

  // Both sides split the same normalised string, so the fallback always aligns.
  logger.warning("long-form chunk cues did not align with the script, using proportional timing");
  return createSubtitleCues(buildProportionalCues(formatted, chunkDuration), formatted);
}

export interface ChunkTiming {
  /** Probed duration of the chunk's audio, in seconds. */
  duration: number;
  /** Cues relative to the start of that chunk. */
  cues: SubtitleCue[];
}

/**
 * Shifts each chunk's cues onto the joined timeline and renumbers them from 1.
 *
 * Offsets are the cumulative *probed* chunk durations, kept as floats: rounding
 * each chunk (the single-clip pipeline does `Math.ceil(audioDuration)`) is
 * invisible over 60 seconds and drifts by minutes over an audiobook. If the
 * joined file's own duration diverges from the sum of the parts, every cue after
 * the divergence is approximate — `synthesizeLongform` reports that gap as
 * `durationDrift` so a caller can log it.
 */
export function offsetChunkCues(chunks: readonly ChunkTiming[]): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let offset = 0;

  for (const chunk of chunks) {
    for (const cue of chunk.cues) {
      cues.push({
        index: cues.length + 1,
        start: cue.start + offset,
        end: cue.end + offset,
        text: cue.text,
      });
    }
    offset += chunk.duration;
  }

  return cues;
}

// ---------------------------------------------------------------------------
// Manifest (pure)

export interface ChunkAudioFormat {
  codec: string;
  sampleRate: number;
  channels: number;
}

export interface ChunkManifestEntry extends ChunkAudioFormat {
  /** Position in the chunk list; entries are only reused at the same position. */
  index: number;
  hash: string;
  /** File name inside the work directory, never a path. */
  file: string;
  duration: number;
  /** Chunk-relative cues, so offsets are recomputed on every join. */
  cues: SubtitleCue[];
}

export interface ChunkManifest {
  version: number;
  chunks: ChunkManifestEntry[];
}

export interface ChunkHashInput {
  text: string;
  voiceName: string;
  voiceRate: number;
  voiceVolume: number;
  provider: string;
}

/**
 * Identity of a synthesised chunk.
 *
 * "The file exists and is not empty" proves nothing: it can be half-written, and
 * it says nothing about whether the text, voice, rate or provider still match
 * the ones the run is asking for. Reuse is gated on this hash instead.
 */
export function hashChunkInput(input: ChunkHashInput): string {
  return sha256(
    [
      String(MANIFEST_VERSION),
      input.provider,
      input.voiceName,
      String(input.voiceRate),
      String(input.voiceVolume),
      input.text,
    ].join("\u0000"),
  );
}

function isSubtitleCue(value: unknown): value is SubtitleCue {
  if (typeof value !== "object" || value === null) return false;
  const cue = value as Record<string, unknown>;
  return (
    typeof cue.index === "number" &&
    typeof cue.start === "number" &&
    Number.isFinite(cue.start) &&
    typeof cue.end === "number" &&
    Number.isFinite(cue.end) &&
    typeof cue.text === "string"
  );
}

function isManifestEntry(value: unknown): value is ChunkManifestEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.index === "number" &&
    Number.isInteger(entry.index) &&
    entry.index >= 0 &&
    typeof entry.hash === "string" &&
    entry.hash.length > 0 &&
    typeof entry.file === "string" &&
    entry.file.length > 0 &&
    !entry.file.includes("/") &&
    typeof entry.duration === "number" &&
    Number.isFinite(entry.duration) &&
    entry.duration > 0 &&
    typeof entry.codec === "string" &&
    typeof entry.sampleRate === "number" &&
    typeof entry.channels === "number" &&
    Array.isArray(entry.cues) &&
    entry.cues.every(isSubtitleCue)
  );
}

/**
 * Reads a manifest written by an earlier run.
 *
 * Malformed entries are dropped rather than failing the whole file: a run
 * interrupted mid-write should cost one chunk, not an hour of synthesis.
 */
export function parseChunkManifest(raw: unknown): ChunkManifest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const document = raw as Record<string, unknown>;
  if (document.version !== MANIFEST_VERSION) return null;
  if (!Array.isArray(document.chunks)) return null;

  return { version: MANIFEST_VERSION, chunks: document.chunks.filter(isManifestEntry) };
}

/** The entry that may be reused for this position, or null to re-synthesise. */
export function findReusableEntry(
  manifest: ChunkManifest | null,
  index: number,
  hash: string,
): ChunkManifestEntry | null {
  if (!manifest) return null;
  return manifest.chunks.find((entry) => entry.index === index && entry.hash === hash) ?? null;
}

/** True when every chunk can be joined without re-encoding first. */
export function formatsMatch(formats: readonly ChunkAudioFormat[]): boolean {
  const [first] = formats;
  if (!first) return true;
  return formats.every(
    (format) =>
      format.codec === first.codec &&
      format.sampleRate === first.sampleRate &&
      format.channels === first.channels,
  );
}

/**
 * Format every chunk is converted to when they disagree.
 *
 * Upmixing and upsampling are chosen over the reverse so normalisation never
 * throws away a channel or half the bandwidth of the best chunk.
 */
export function commonFormatTarget(formats: readonly ChunkAudioFormat[]): ChunkAudioFormat {
  const sampleRate = Math.max(0, ...formats.map((format) => format.sampleRate || 0));
  const channels = Math.max(0, ...formats.map((format) => format.channels || 0));
  return {
    codec: "mp3",
    sampleRate: sampleRate > 0 ? sampleRate : 44100,
    channels: channels > 0 ? channels : 1,
  };
}

// ---------------------------------------------------------------------------
// Synthesis (I/O)

export interface LongformProgress {
  /** 1-based, for display. */
  index: number;
  total: number;
  /** True when the chunk came from a previous run's manifest. */
  reused: boolean;
  duration: number;
}

export interface LongformOptions {
  text: string;
  voiceName: string;
  voiceRate: number;
  voiceVolume?: number;
  /** Path of the joined audio file. */
  outputFile: string;
  /** Directory holding the per-chunk files and the manifest. */
  workDir: string;
  maxChars?: number;
  onProgress?: (update: LongformProgress) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface LongformResult {
  audioFile: string;
  /** Probed duration of the joined file, the authoritative timeline length. */
  duration: number;
  cues: SubtitleCue[];
  chunkCount: number;
  /**
   * Joined duration minus the sum of the chunk durations the cues are offset
   * by. Anything but a few milliseconds means the subtitles drift.
   */
  durationDrift: number;
}

function chunkFileName(index: number): string {
  return `chunk-${String(index).padStart(4, "0")}.mp3`;
}

interface FfprobeAudioStream {
  codec_name?: string;
  sample_rate?: string;
  channels?: number;
}

/**
 * Reads the codec fingerprint used to decide whether chunks can be joined.
 *
 * `probe()` answers duration and sample rate but not codec or channel count, and
 * a mismatch in either is exactly what silently corrupts a concatenation.
 */
async function probeChunkFormat(filePath: string): Promise<ChunkAudioFormat> {
  const { stdout } = await runFfprobe([
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=codec_name,sample_rate,channels",
    "-print_format",
    "json",
    filePath,
  ]);

  const parsed = JSON.parse(stdout) as { streams?: FfprobeAudioStream[] };
  const stream = parsed.streams?.[0];
  return {
    codec: String(stream?.codec_name ?? ""),
    sampleRate: Number(stream?.sample_rate) || 0,
    channels: Number(stream?.channels) || 0,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("long-form synthesis was cancelled");
}

interface SynthesisedChunk {
  duration: number;
  format: ChunkAudioFormat;
  cues: SubtitleCue[];
}

/**
 * Synthesises one chunk, retrying before giving up on the whole segment.
 *
 * `tts()` returns null instead of throwing, so a bare check would report an
 * hour-long segment as "synthesis failed" with nothing to act on; the error
 * names the chunk. Audio is written to a temporary name and renamed only after
 * it probes as playable, so an interrupted run cannot leave a truncated file
 * for the next one to trust.
 */
async function synthesizeChunk(
  options: LongformOptions,
  text: string,
  index: number,
  total: number,
): Promise<SynthesisedChunk> {
  const finalFile = join(options.workDir, chunkFileName(index));
  // The extension is kept: adapters hand this path straight to ffmpeg, which
  // picks its muxer from it.
  const tempFile = join(options.workDir, `${chunkFileName(index)}.partial.mp3`);
  let lastReason = "tts returned no audio";

  for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt++) {
    throwIfAborted(options.signal);

    try {
      const result = await tts({
        text,
        voiceName: options.voiceName,
        voiceRate: options.voiceRate,
        voiceFile: tempFile,
        voiceVolume: options.voiceVolume,
        signal: options.signal,
      });

      if (!result) {
        logger.warning(`chunk ${index + 1} of ${total}: tts returned no audio (try ${attempt})`);
      } else {
        const info = await probe(tempFile);
        if (!info.hasAudio || info.duration <= 0) {
          lastReason = `synthesised file has no playable audio (duration ${info.duration})`;
          logger.warning(`chunk ${index + 1} of ${total}: ${lastReason} (try ${attempt})`);
        } else {
          const format = await probeChunkFormat(tempFile);
          await rename(tempFile, finalFile);
          return { duration: info.duration, format, cues: buildChunkCues(result.cues, text, info.duration) };
        }
      }
    } catch (error) {
      lastReason = errorMessage(error);
      logger.warning(`chunk ${index + 1} of ${total}: ${lastReason} (try ${attempt})`);
      throwIfAborted(options.signal);
    }

    await deleteFiles(tempFile);
    if (attempt < MAX_CHUNK_ATTEMPTS) await sleep(1000 * attempt);
  }

  throw new Error(
    `failed to synthesize chunk ${index + 1} of ${total} after ${MAX_CHUNK_ATTEMPTS} attempts: ${lastReason}`,
  );
}

async function readManifest(workDir: string): Promise<ChunkManifest | null> {
  const path = join(workDir, MANIFEST_FILE);
  if (!existsSync(path)) return null;
  try {
    return parseChunkManifest(await Bun.file(path).json());
  } catch (error) {
    logger.warning(`unreadable chunk manifest, starting fresh: ${errorMessage(error)}`);
    return null;
  }
}

/** Writes via a temporary file so a crash cannot leave half a manifest behind. */
async function writeManifest(workDir: string, entries: ChunkManifestEntry[]): Promise<void> {
  const path = join(workDir, MANIFEST_FILE);
  const tempPath = `${path}.tmp`;
  const manifest: ChunkManifest = { version: MANIFEST_VERSION, chunks: entries };
  await Bun.write(tempPath, JSON.stringify(manifest));
  await rename(tempPath, path);
}

/** Re-encodes chunks that disagree on codec, sample rate or channel count. */
async function normalizeChunks(
  files: string[],
  target: ChunkAudioFormat,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const normalized: string[] = [];

  for (const file of files) {
    throwIfAborted(signal);
    const output = file.replace(/\.mp3$/, ".norm.mp3");
    await runFfmpeg(
      [
        "-y",
        "-i",
        file,
        "-vn",
        "-codec:a",
        "libmp3lame",
        "-q:a",
        "2",
        "-ar",
        String(target.sampleRate),
        "-ac",
        String(target.channels),
        output,
      ],
      { signal },
    );
    normalized.push(output);
  }

  return normalized;
}

/**
 * Joins the chunks with the concat demuxer.
 *
 * The join always decodes and re-encodes. A stream copy would inherit each
 * input's MP3 encoder priming and padding and would place every file at the
 * offset its container *claims*, so an inaccurate duration opens a gap that the
 * cue offsets know nothing about. `-vn` drops any cover art a provider embedded,
 * which would otherwise make the demuxer refuse the input.
 */
async function concatChunks(
  files: string[],
  outputFile: string,
  workDir: string,
  target: ChunkAudioFormat,
  signal: AbortSignal | undefined,
): Promise<void> {
  const listFile = join(workDir, "ffmpeg-audio-concat-list.txt");
  const listBody = files.map((file) => `file '${formatConcatPath(file)}'`).join("\n") + "\n";
  await Bun.write(listFile, listBody);

  try {
    await runFfmpeg(
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listFile,
        "-vn",
        "-codec:a",
        "libmp3lame",
        "-q:a",
        "2",
        "-ar",
        String(target.sampleRate),
        "-ac",
        String(target.channels),
        outputFile,
      ],
      { signal },
    );
  } finally {
    await deleteFiles(listFile);
  }
}

/**
 * Synthesises long narration as chunks and joins them into one audio file.
 *
 * Re-running with the same inputs reuses everything already on disk; changing
 * the text, voice, rate or volume re-synthesises only the chunks that changed.
 */
export async function synthesizeLongform(options: LongformOptions): Promise<LongformResult> {
  const {
    text,
    outputFile,
    workDir,
    maxChars = DEFAULT_MAX_CHARS,
    voiceRate,
    voiceVolume = 1.0,
    onProgress,
    signal,
  } = options;

  const voiceName = parseVoiceName(options.voiceName);
  const chunks = chunkForTts(text, maxChars);
  if (chunks.length === 0) throw new Error("no narration text to synthesize");

  await mkdir(workDir, { recursive: true });
  await mkdir(dirname(outputFile), { recursive: true });

  const provider = inferTtsServerFromVoice(voiceName);
  const previous = await readManifest(workDir);
  const entries: ChunkManifestEntry[] = [];

  logger.info(`long-form synthesis: ${chunks.length} chunks, voice: ${voiceName}, provider: ${provider}`);

  for (const [index, chunkText] of chunks.entries()) {
    throwIfAborted(signal);

    const file = chunkFileName(index);
    const hash = hashChunkInput({ text: chunkText, voiceName, voiceRate, voiceVolume, provider });
    const reusable = findReusableEntry(previous, index, hash);

    if (reusable && existsSync(join(workDir, reusable.file))) {
      entries.push(reusable);
      await onProgress?.({ index: index + 1, total: chunks.length, reused: true, duration: reusable.duration });
      continue;
    }

    const synthesised = await synthesizeChunk({ ...options, voiceName, voiceVolume }, chunkText, index, chunks.length);
    entries.push({
      index,
      hash,
      file,
      duration: synthesised.duration,
      codec: synthesised.format.codec,
      sampleRate: synthesised.format.sampleRate,
      channels: synthesised.format.channels,
      cues: synthesised.cues,
    });

    // Written after every chunk: an interrupted run resumes from here.
    await writeManifest(workDir, entries);
    await onProgress?.({
      index: index + 1,
      total: chunks.length,
      reused: false,
      duration: synthesised.duration,
    });
  }

  await writeManifest(workDir, entries);
  throwIfAborted(signal);

  const chunkFiles = entries.map((entry) => join(workDir, entry.file));
  const formats: ChunkAudioFormat[] = entries.map((entry) => ({
    codec: entry.codec,
    sampleRate: entry.sampleRate,
    channels: entry.channels,
  }));

  const target = commonFormatTarget(formats);
  let joinInputs = chunkFiles;
  let temporaryFiles: string[] = [];

  if (!formatsMatch(formats)) {
    logger.warning(
      `long-form chunks differ in audio format, normalising to ${target.sampleRate}Hz/${target.channels}ch`,
    );
    joinInputs = await normalizeChunks(chunkFiles, target, signal);
    temporaryFiles = joinInputs;
  }

  try {
    await concatChunks(joinInputs, outputFile, workDir, target, signal);
  } finally {
    await deleteFiles(temporaryFiles);
  }

  const joined = await probe(outputFile);
  if (!joined.hasAudio || joined.duration <= 0) {
    throw new Error(`joined narration has no playable audio: ${outputFile}`);
  }

  const timings: ChunkTiming[] = entries.map((entry) => ({ duration: entry.duration, cues: entry.cues }));
  const summed = entries.reduce((total, entry) => total + entry.duration, 0);
  const durationDrift = joined.duration - summed;

  if (Math.abs(durationDrift) > 0.25) {
    logger.warning(
      `joined narration is ${durationDrift.toFixed(3)}s off the sum of its chunks; ` +
        "subtitle offsets after the divergence are approximate",
    );
  }

  return {
    audioFile: outputFile,
    duration: joined.duration,
    cues: offsetChunkCues(timings),
    chunkCount: entries.length,
    durationDrift,
  };
}
