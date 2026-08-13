/**
 * SubtitleCue[] → ASS (Advanced SubStation Alpha) document.
 *
 * The PNG overlay path in video/generate.ts spends one ffmpeg input per cue and
 * therefore has to composite long videos in several full re-encodes. A whole
 * chapter of captions fits in one ASS file instead, which libass draws in a
 * single pass, so long-form renders stop paying for generational quality loss.
 *
 * Styling follows video/textRender.ts as closely as the format allows. Three
 * differences are accepted for long-form and are not bugs:
 *   - the rounded, translucent backing plate: ASS `BorderStyle=3` only draws a
 *     square box, so rounded corners are lost (its translucency is kept);
 *   - the legacy full-width rectangle: the ASS box always hugs the text rather
 *     than spanning 90% of the frame;
 *   - pixel-exact wrapping: libass measures and wraps internally, so line
 *     breaks may fall in different places than the Skia-measured wrapper.
 * A boxed style also drops the glyph stroke, because `BorderStyle=3` reuses the
 * outline slot for the box colour.
 *
 * Fonts: `params.font_name` is a *filename* under resource/fonts, but ASS names
 * a font *family*. The family (and whether the file is the bold face) is read
 * from the font's own sfnt `name` table, and callers pass `fontsdir` pointing at
 * fontDir() so fontconfig can actually find the bundled file — see
 * buildSubtitlesFilter in video/still.ts.
 */

import { closeSync, openSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import type { SubtitleCue } from "./srt.ts";
import { hexToRgb, resolveBackgroundColor } from "../video/textRender.ts";
import { resolveSubtitleY } from "../video/generate.ts";
import { logger, errorMessage } from "../../utils/logger.ts";
import { fontDir } from "../../utils/paths.ts";
import { aspectToResolution, type VideoParams } from "../../models/schema.ts";

// ---------------------------------------------------------------------------
// Geometry constants, mirrored from textRender.ts / generate.ts
// ---------------------------------------------------------------------------

/** Safe area kept clear at the top and bottom, as in resolveSubtitleY. */
const SAFE_MARGIN_RATIO = 0.05;

/** textRender wraps to 90% of the frame; ASS gets the same box from margins. */
const HORIZONTAL_MARGIN_RATIO = 0.05;

/** Box padding as a fraction of the font size, as in renderCueImage. */
const BOX_PADDING_RATIO = 0.6;
const ROUNDED_BOX_PADDING_RATIO = 0.4;

/**
 * ASS colours carry *transparency*, so 0 is opaque and 255 invisible. The
 * rounded plate is drawn at 140/255 opacity by the PNG renderer.
 */
const OPAQUE = 0;
const ROUNDED_PLATE_TRANSPARENCY = 255 - 140;

export const ASS_ALIGN_BOTTOM_CENTER = 2;
export const ASS_ALIGN_MIDDLE_CENTER = 5;
export const ASS_ALIGN_TOP_CENTER = 8;

export const DEFAULT_FONT_FILE = "MicrosoftYaHeiBold.ttc";

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

function hexByte(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value) || 0))
    .toString(16)
    .toUpperCase()
    .padStart(2, "0");
}

/**
 * Converts the app's `#RRGGBB` strings to an ASS `&HAABBGGRR` literal.
 *
 * Two traps live here: the channel order is reversed (BGR, not RGB) and the
 * leading pair is alpha-as-transparency, where 00 means fully opaque. Anything
 * malformed degrades to black, matching hexToRgb.
 */
export function hexToAssColor(color: string | boolean | null | undefined, transparency = OPAQUE): string {
  const [r, g, b] = hexToRgb(color);
  const alpha = Number.isFinite(transparency) ? (transparency as number) : OPAQUE;
  return `&H${hexByte(alpha)}${hexByte(b)}${hexByte(g)}${hexByte(r)}`;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Formats seconds as ASS `H:MM:SS.cc`.
 *
 * Centiseconds are the format's whole resolution, and the hour field carries no
 * leading zero. Rounding rather than truncating keeps a cue from disappearing a
 * hundredth early at the boundary.
 */
export function formatAssTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalCentiseconds = Math.round(safe * 100);

  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = (totalCentiseconds - centiseconds) / 100;

  return (
    `${Math.floor(totalSeconds / 3600)}:` +
    `${pad2(Math.floor(totalSeconds / 60) % 60)}:` +
    `${pad2(totalSeconds % 60)}.` +
    `${pad2(centiseconds)}`
  );
}

// ---------------------------------------------------------------------------
// Text escaping
// ---------------------------------------------------------------------------

/**
 * Escapes narration text for an ASS Dialogue field.
 *
 * Braces open an override block and a stray backslash can turn into a line
 * break (`\N`), so both are neutralised before newlines are converted. Order
 * matters: backslashes are doubled first, so the `\N` inserted afterwards
 * survives as a real break.
 */
export function escapeAssText(text: string): string {
  return String(text ?? "")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r\n|\r|\n/g, "\\N");
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

export interface AssFont {
  /** Family name libass resolves through fontconfig. */
  family: string;
  bold: boolean;
  italic: boolean;
}

const NAME_ID_FAMILY = 1;
const NAME_ID_SUBFAMILY = 2;

/** Latin-1 is a byte-per-code-point mapping, so no decoder table is needed. */
function decodeLatin1(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/** UTF-16BE code units; surrogate pairs survive as-is through fromCharCode. */
function decodeUtf16Be(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index + 1 < bytes.byteLength; index += 2) {
    out += String.fromCharCode((bytes[index]! << 8) | bytes[index + 1]!);
  }
  return out;
}

/**
 * Parses an sfnt `name` table into nameID → string.
 *
 * Windows records (platform 3) are UTF-16BE and are preferred because they are
 * present in every font this app ships; Macintosh records are read as Latin-1
 * so a Mac-only font still yields something usable.
 */
export function parseNameTable(bytes: Uint8Array): Map<number, string> {
  const names = new Map<number, string>();
  if (bytes.byteLength < 6) return names;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(2);
  const stringOffset = view.getUint16(4);

  for (let index = 0; index < count; index++) {
    const record = 6 + index * 12;
    if (record + 12 > bytes.byteLength) break;

    const platformId = view.getUint16(record);
    const encodingId = view.getUint16(record + 2);
    const languageId = view.getUint16(record + 4);
    const nameId = view.getUint16(record + 6);
    const length = view.getUint16(record + 8);
    const offset = view.getUint16(record + 10);

    const start = stringOffset + offset;
    if (start + length > bytes.byteLength) continue;

    const raw = bytes.subarray(start, start + length);
    const value = platformId === 3 || platformId === 0 ? decodeUtf16Be(raw) : decodeLatin1(raw);
    if (!value) continue;

    // An English/Windows record overrides whatever was found first; any other
    // record is only a fallback for fonts that ship no English name at all.
    const isPreferred = platformId === 3 && encodingId === 1 && languageId === 0x409;
    if (isPreferred || !names.has(nameId)) names.set(nameId, value);
  }

  return names;
}

/**
 * Reads just the `name` table out of a font file.
 *
 * The bundled CJK collections reach 55 MB, so the file is read in three small
 * positional chunks rather than slurped. For a TrueType collection only the
 * first face is inspected; the app ships one weight per file, so the collection
 * index never carries a different family.
 */
function readFontNameTable(fontPath: string): Map<number, string> | null {
  let fd: number | undefined;
  try {
    fd = openSync(fontPath, "r");

    const read = (length: number, position: number): Uint8Array => {
      const buffer = new Uint8Array(length);
      const bytesRead = readSync(fd!, buffer, 0, length, position);
      return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    };

    const header = read(16, 0);
    if (header.byteLength < 16) return null;
    const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);

    const tag = decodeLatin1(header.subarray(0, 4));
    const sfntOffset = tag === "ttcf" ? headerView.getUint32(12) : 0;

    const sfnt = read(12, sfntOffset);
    if (sfnt.byteLength < 12) return null;
    const numTables = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength).getUint16(4);

    const directory = read(numTables * 16, sfntOffset + 12);
    const directoryView = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);

    for (let index = 0; index * 16 + 16 <= directory.byteLength; index++) {
      const record = index * 16;
      if (decodeLatin1(directory.subarray(record, record + 4)) !== "name") continue;
      const offset = directoryView.getUint32(record + 8);
      const length = directoryView.getUint32(record + 12);
      return parseNameTable(read(length, offset));
    }

    return null;
  } catch (error) {
    logger.warning(`failed to read font name table: ${fontPath}, error: ${errorMessage(error)}`);
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Derives the ASS font description from name-table entries.
 *
 * Weight has to be carried separately: the bundled `MicrosoftYaHeiBold.ttc` and
 * `MicrosoftYaHeiNormal.ttc` share the family "Microsoft YaHei", so a family
 * name alone would let fontconfig pick either face.
 */
export function assFontFromNames(names: Map<number, string> | null, fallbackFamily: string): AssFont {
  const family = names?.get(NAME_ID_FAMILY)?.trim() || fallbackFamily;
  const subfamily = (names?.get(NAME_ID_SUBFAMILY) ?? "").toLowerCase();
  return {
    family,
    bold: subfamily.includes("bold"),
    italic: subfamily.includes("italic") || subfamily.includes("oblique"),
  };
}

const fontCache = new Map<string, AssFont>();

/** Resolves a font file to the family name and weight libass needs. */
export function resolveAssFont(fontPath: string): AssFont {
  const cached = fontCache.get(fontPath);
  if (cached) return cached;

  const stem = basename(fontPath).replace(/\.[^.]+$/, "");
  const resolved = assFontFromNames(readFontNameTable(fontPath), stem);
  fontCache.set(fontPath, resolved);
  return resolved;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface AssRenderOptions {
  /** Frame size the cues are composited onto; becomes PlayResX/PlayResY. */
  width: number;
  height: number;
  /** Absolute path to the font file, as buildCueOverlays resolves it. */
  fontPath: string;
  fontSize: number;
  textForeColor: string;
  strokeColor: string;
  strokeWidth: number;
  /** false or "" disables the plate; a colour string enables it. */
  textBackgroundColor: boolean | string;
  roundedSubtitleBackground: boolean;
  subtitlePosition: string;
  customPosition: number;
}

/** Builds render options from the task parameters the pipeline already has. */
export function assRenderOptionsFromParams(params: VideoParams): AssRenderOptions {
  const [width, height] = aspectToResolution(params.video_aspect);
  return {
    width,
    height,
    fontPath: join(fontDir(), params.font_name || DEFAULT_FONT_FILE),
    fontSize: params.font_size,
    textForeColor: params.text_fore_color,
    strokeColor: params.stroke_color,
    strokeWidth: params.stroke_width,
    textBackgroundColor: params.text_background_color,
    roundedSubtitleBackground: params.rounded_subtitle_background,
    subtitlePosition: params.subtitle_position,
    customPosition: params.custom_position,
  };
}

/**
 * Maps the app's subtitle position onto an ASS alignment.
 *
 * "custom" resolves to middle-centre because MarginV is ignored for middle
 * alignments — the offset has to come from a per-dialogue `\pos` instead.
 */
export function resolveAssAlignment(position: string): number {
  if (position === "top") return ASS_ALIGN_TOP_CENTER;
  if (position === "bottom") return ASS_ALIGN_BOTTOM_CENTER;
  return ASS_ALIGN_MIDDLE_CENTER;
}

/**
 * Approximates the height of a rendered cue block.
 *
 * libass lays the text out itself, so renderCueImage's exact plate height is
 * unavailable here. `\pos` still needs a block height to anchor against, so the
 * PNG renderer's proportions are reproduced: a 1.25 line box per line (ink
 * height plus interline) plus one vertical padding.
 */
export function estimateCueHeight(fontSize: number, lineCount: number): number {
  const size = Math.max(1, Math.floor(fontSize) || 1);
  return Math.max(1, lineCount) * size * 1.25 + size * 0.35;
}

/**
 * Per-dialogue override tag placing a custom-positioned cue.
 *
 * Empty for every other position, which margins handle. The anchor is the
 * centre of the block because the style aligns middle-centre, so the top edge
 * resolveSubtitleY reports is shifted down by half the estimated height.
 */
export function buildPositionTag(options: AssRenderOptions, lineCount: number): string {
  if (options.subtitlePosition !== "custom") return "";

  const cueHeight = estimateCueHeight(options.fontSize, lineCount);
  const top = resolveSubtitleY("custom", options.customPosition, options.height, cueHeight);
  return `{\\pos(${Math.round(options.width / 2)},${Math.round(top + cueHeight / 2)})}`;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

const STYLE_FORMAT =
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, " +
  "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, " +
  "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding";

const EVENT_FORMAT = "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text";

export const ASS_STYLE_NAME = "VidGen";

/** The `[V4+ Styles]` Style line for these options. */
export function buildAssStyleLine(options: AssRenderOptions): string {
  const fontSize = Math.max(1, Math.floor(options.fontSize) || 1);
  const font = resolveAssFont(options.fontPath);

  const background = resolveBackgroundColor(options.textBackgroundColor);
  const boxed = background !== null;
  const rounded = boxed && options.roundedSubtitleBackground;

  // BorderStyle=3 fills an opaque box using OutlineColour; BackColour is only
  // the drop shadow, so the plate colour must go in the outline slot.
  const borderStyle = boxed ? 3 : 1;
  const outlineColour = boxed
    ? hexToAssColor(background, rounded ? ROUNDED_PLATE_TRANSPARENCY : OPAQUE)
    : hexToAssColor(options.strokeColor || "#000000");
  const outline = boxed
    ? Math.max(1, Math.round(fontSize * (rounded ? ROUNDED_BOX_PADDING_RATIO : BOX_PADDING_RATIO)))
    : Math.max(0, Math.round(options.strokeWidth) || 0);

  const fields = [
    ASS_STYLE_NAME,
    font.family,
    fontSize,
    hexToAssColor(options.textForeColor || "#FFFFFF"),
    hexToAssColor(options.textForeColor || "#FFFFFF"),
    outlineColour,
    hexToAssColor("#000000"),
    font.bold ? -1 : 0,
    font.italic ? -1 : 0,
    0,
    0,
    100,
    100,
    0,
    0,
    borderStyle,
    outline,
    0,
    resolveAssAlignment(options.subtitlePosition),
    Math.round(options.width * HORIZONTAL_MARGIN_RATIO),
    Math.round(options.width * HORIZONTAL_MARGIN_RATIO),
    Math.round(options.height * SAFE_MARGIN_RATIO),
    1,
  ];

  return `Style: ${fields.join(",")}`;
}

/** One `[Events]` Dialogue line per cue. */
export function buildAssDialogueLine(cue: SubtitleCue, options: AssRenderOptions): string | null {
  const text = escapeAssText(cue.text);
  if (!text) return null;

  const lineCount = text.split("\\N").length;
  const start = formatAssTime(cue.start);
  const end = formatAssTime(cue.end);

  return (
    `Dialogue: 0,${start},${end},${ASS_STYLE_NAME},,0,0,0,,` +
    `${buildPositionTag(options, lineCount)}${text}`
  );
}

/** Renders the complete ASS document for a set of cues. */
export function buildAssDocument(cues: SubtitleCue[], options: AssRenderOptions): string {
  const lines: string[] = [
    "[Script Info]",
    "; Generated by VidGen",
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    // Without an explicit matrix libass guesses, which shifts caption colours
    // between builds; "None" keeps the RGB values exactly as written.
    "YCbCr Matrix: None",
    // Sizes and margins below are in pixels, so the play resolution has to be
    // the real frame size or every one of them is scaled wrong.
    `PlayResX: ${Math.round(options.width)}`,
    `PlayResY: ${Math.round(options.height)}`,
    "",
    "[V4+ Styles]",
    STYLE_FORMAT,
    buildAssStyleLine(options),
    "",
    "[Events]",
    EVENT_FORMAT,
  ];

  for (const cue of cues) {
    const dialogue = buildAssDialogueLine(cue, options);
    if (dialogue) lines.push(dialogue);
  }

  return `${lines.join("\n")}\n`;
}

export async function writeAssFile(
  filePath: string,
  cues: SubtitleCue[],
  options: AssRenderOptions,
): Promise<string> {
  await Bun.write(filePath, buildAssDocument(cues, options));
  return filePath;
}
