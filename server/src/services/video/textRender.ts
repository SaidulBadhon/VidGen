/**
 * Subtitle text measurement, wrapping and rasterisation.
 *
 * The Python version rendered subtitles with MoviePy `TextClip` plus a bespoke
 * wrap algorithm, a translucent rounded backing plate, and centring based on
 * visible glyph pixels. None of that is expressible in ASS/libass, so the
 * layout maths is ported here on top of Skia via @napi-rs/canvas and each cue
 * is rasterised to a transparent PNG that ffmpeg overlays.
 *
 * Ported from `wrap_text`, `create_text_clip`, `_rounded_subtitle_background_clip`
 * and `_get_visible_center_position` in python-version/app/services/video.py.
 */

import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import { basename } from "node:path";
import { logger } from "../../utils/logger.ts";

// ---------------------------------------------------------------------------
// Font handling
// ---------------------------------------------------------------------------

const registeredFonts = new Map<string, string>();

/**
 * Registers a font file and returns the family name to use in `ctx.font`.
 *
 * A stable synthetic family name avoids collisions between the bundled fonts
 * and anything installed on the host, which would otherwise silently change
 * subtitle metrics between machines.
 */
export function registerSubtitleFont(fontPath: string): string {
  const cached = registeredFonts.get(fontPath);
  if (cached) return cached;

  const family = `vidgen-${basename(fontPath).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]+/g, "-")}`;
  const ok = GlobalFonts.registerFromPath(fontPath, family);
  if (!ok) {
    logger.warning(`failed to register subtitle font: ${fontPath}; falling back to a system font`);
  }
  registeredFonts.set(fontPath, family);
  return family;
}

function cssFont(family: string, fontSize: number): string {
  return `${fontSize}px "${family}"`;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export interface TextSize {
  width: number;
  height: number;
  ascent: number;
  descent: number;
}

/** Measuring context; 1x1 is enough since only metrics are read. */
let measureContext: SKRSContext2D | undefined;

function getMeasureContext(): SKRSContext2D {
  measureContext ??= createCanvas(1, 1).getContext("2d");
  return measureContext;
}

/**
 * Measures one line the way PIL's `getbbox` did: advance width, and ink height
 * from the top of the ascenders to the bottom of the descenders.
 */
export function measureText(text: string, family: string, fontSize: number): TextSize {
  const ctx = getMeasureContext();
  ctx.font = cssFont(family, fontSize);

  const trimmed = text.trim();
  if (!trimmed) {
    return { width: 0, height: fontSize, ascent: fontSize, descent: 0 };
  }

  const metrics = ctx.measureText(trimmed);
  const ascent = metrics.actualBoundingBoxAscent ?? fontSize * 0.8;
  const descent = metrics.actualBoundingBoxDescent ?? fontSize * 0.2;

  return {
    width: metrics.width,
    height: ascent + descent,
    ascent,
    descent,
  };
}

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

/**
 * Closing punctuation that must never start a line.
 *
 * When a CJK sentence is split by character the trailing full stop or comma can
 * land alone on the next line, which stretches the subtitle plate and reads as
 * a stray dot below the text.
 */
const LINE_START_PUNCTUATION = "，。！？；：、,.!?;:)]}）】》」』”’";

export interface WrapResult {
  text: string;
  lines: string[];
  /** Single-line ink height multiplied by the line count, as in the original. */
  height: number;
  /** Ink height of one line. */
  lineHeight: number;
}

/**
 * Wraps subtitle text to a pixel width.
 *
 * Wrapping must happen before rasterising: measuring with the real font is the
 * only way to keep large font sizes and long CJK sentences inside the frame.
 */
export function wrapText(text: string, maxWidth: number, family: string, fontSize: number): WrapResult {
  const limit = Math.floor(maxWidth);
  const measure = (value: string) => measureText(value, family, fontSize);

  const full = measure(text);
  const lineHeight = full.height;

  if (full.width <= limit) {
    return { text, lines: [text], height: lineHeight, lineHeight };
  }

  /**
   * Character-level split for a single token wider than the line.
   *
   * Common for CJK, which has no spaces, and for very long URLs. When the
   * candidate overflows, the last valid prefix is committed and the current
   * character starts the next line — it is never pushed back onto the full one.
   */
  const splitLongToken = (token: string): string[] => {
    const out: string[] = [];
    let current = "";
    for (const char of token) {
      const candidate = `${current}${char}`;
      if (measure(candidate).width <= limit || !current) {
        current = candidate;
        continue;
      }
      out.push(current);
      current = char;
    }
    if (current) out.push(current);
    return out;
  };

  const lines: string[] = [];
  let current = "";

  for (const word of text.split(" ")) {
    const candidate = current ? `${current} ${word}`.trim() : word;
    if (measure(candidate).width <= limit) {
      current = candidate;
      continue;
    }

    if (current) lines.push(current);

    if (measure(word).width <= limit) {
      current = word;
    } else {
      lines.push(...splitLongToken(word));
      current = "";
    }
  }

  if (current) lines.push(current);

  // Pull the previous line's last character down so an orphaned closing mark
  // rejoins the text it belongs to.
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!;
    const previous = lines[index - 1]!;
    if (!line || !LINE_START_PUNCTUATION.includes(line[0]!)) continue;
    if (previous.length <= 1) continue;

    const candidate = `${previous[previous.length - 1]}${line}`;
    if (measure(candidate).width <= limit) {
      lines[index] = candidate;
      lines[index - 1] = previous.slice(0, -1);
    }
  }

  const cleaned = lines.map((line) => line.trim()).filter(Boolean);
  return {
    text: cleaned.join("\n"),
    lines: cleaned,
    height: lines.length * lineHeight,
    lineHeight,
  };
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/**
 * Parses `#RRGGBB`. Values arrive from API and UI parameters, so anything
 * malformed falls back to black rather than failing the render.
 */
export function hexToRgb(color: string | boolean | undefined | null): [number, number, number] {
  if (typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color)) {
    return [
      parseInt(color.slice(1, 3), 16),
      parseInt(color.slice(3, 5), 16),
      parseInt(color.slice(5, 7), 16),
    ];
  }
  return [0, 0, 0];
}

/**
 * Normalises the historically overloaded `text_background_color`, which the API
 * accepts as either a boolean or a colour string.
 */
export function resolveBackgroundColor(value: boolean | string | undefined | null): string | null {
  if (typeof value === "boolean") return value ? "#000000" : null;
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

// ---------------------------------------------------------------------------
// Rasterisation
// ---------------------------------------------------------------------------

export interface SubtitleStyle {
  fontPath: string;
  fontSize: number;
  textForeColor: string;
  strokeColor: string;
  strokeWidth: number;
  /** false or "" disables the plate; a colour string enables it. */
  textBackgroundColor: boolean | string;
  roundedSubtitleBackground: boolean;
}

export interface RenderedCueImage {
  buffer: Buffer;
  width: number;
  height: number;
}

/**
 * Rasterises one cue to a transparent PNG.
 *
 * Geometry mirrors `create_text_clip`: the plate hugs the text for the rounded
 * style and spans 90% of the frame for the legacy rectangle, padding scales
 * with the font size, and the text block is centred on its visible pixels
 * rather than on the font's line box.
 */
export function renderCueImage(text: string, videoWidth: number, style: SubtitleStyle): RenderedCueImage {
  const fontSize = Math.floor(style.fontSize);
  const strokeWidth = Math.floor(style.strokeWidth);
  const family = registerSubtitleFont(style.fontPath);

  const maxWidth = Math.floor(videoWidth * 0.9);
  const bgColor = resolveBackgroundColor(style.textBackgroundColor);
  const hasBackground = bgColor !== null;
  const roundedEnabled = Boolean(style.roundedSubtitleBackground && bgColor);

  // The rounded plate hugs the text, so it needs less breathing room; the
  // legacy rectangle keeps the wider margin so long lines never touch an edge.
  const paddingRatio = roundedEnabled ? 0.4 : 0.6;
  const padX = hasBackground ? Math.floor(fontSize * paddingRatio) : 0;
  const textMaxWidth = Math.max(1, maxWidth - 2 * padX);

  const wrapped = wrapText(text, textMaxWidth, family, fontSize);
  const lines = wrapped.lines.length > 0 ? wrapped.lines : [text];

  const interline = Math.floor(fontSize * 0.25);
  const verticalPadding = Math.floor(fontSize * 0.35);
  const lineCount = lines.length;

  // Line spacing and extra padding are included so descenders and strokes on
  // the final line are never clipped.
  const clipHeight = Math.floor(wrapped.height + verticalPadding + interline * lineCount);

  const lineMetrics = lines.map((line) => measureText(line, family, fontSize));
  const widestLine = Math.max(...lineMetrics.map((metric) => metric.width), 0);

  const boxWidth = roundedEnabled
    ? Math.max(1, Math.min(maxWidth, Math.ceil(widestLine) + 2 * padX))
    : maxWidth;

  const canvas = createCanvas(boxWidth, clipHeight);
  const ctx = canvas.getContext("2d");

  if (hasBackground) {
    const [r, g, b] = hexToRgb(bgColor);
    // The rounded plate is deliberately translucent; the legacy rectangle stays
    // fully opaque so existing configurations look unchanged.
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${roundedEnabled ? 140 / 255 : 1})`;
    if (roundedEnabled) {
      const radius = Math.max(8, Math.floor(fontSize * 0.4));
      roundRectPath(ctx, 0, 0, boxWidth, clipHeight, radius);
      ctx.fill();
    } else {
      ctx.fillRect(0, 0, boxWidth, clipHeight);
    }
  }

  ctx.font = cssFont(family, fontSize);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  // Centre the block by its visible extent — from the first line's ascender to
  // the last line's descender — because many fonts sit off-centre inside their
  // line box and would otherwise look high or low on the plate.
  const lineStep = wrapped.lineHeight + interline;
  const firstAscent = lineMetrics[0]?.ascent ?? fontSize * 0.8;
  const lastDescent = lineMetrics[lineCount - 1]?.descent ?? fontSize * 0.2;
  const visibleHeight = firstAscent + (lineCount - 1) * lineStep + lastDescent;
  const firstBaseline = (clipHeight - visibleHeight) / 2 + firstAscent;

  const centerX = boxWidth / 2;

  for (let index = 0; index < lineCount; index++) {
    const line = lines[index]!;
    const baseline = firstBaseline + index * lineStep;

    if (strokeWidth > 0) {
      // Canvas centres a stroke on the glyph outline while PIL grows it
      // outward, so the width is doubled to keep the same visual weight.
      ctx.strokeStyle = style.strokeColor || "#000000";
      ctx.lineWidth = strokeWidth * 2;
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.strokeText(line, centerX, baseline);
    }

    ctx.fillStyle = style.textForeColor || "#FFFFFF";
    ctx.fillText(line, centerX, baseline);
  }

  return { buffer: canvas.toBuffer("image/png"), width: boxWidth, height: clipHeight };
}

function roundRectPath(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Glyph coverage
// ---------------------------------------------------------------------------

const glyphSupportCache = new Map<string, boolean>();

/**
 * Whether a font can actually draw the letters and digits in the text.
 *
 * Picking a CJK-only font for Latin text (or the reverse) yields blank boxes
 * rather than an error, so the UI warns up front. Detection compares each
 * character's rendering against U+10FFFF, which is guaranteed to be missing and
 * therefore always draws the font's .notdef glyph.
 */
export function fontSupportsText(fontPath: string, text: string): boolean {
  const sample = [
    ...new Set(
      [...String(text ?? "")].filter((char) => /\p{L}|\p{N}/u.test(char)),
    ),
  ]
    .slice(0, 64)
    .join("");

  if (!sample) return true;

  const cacheKey = `${fontPath}::${sample}`;
  const cached = glyphSupportCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let supported = true;
  try {
    const family = registerSubtitleFont(fontPath);
    const notdef = renderGlyphSignature("\u{10FFFF}", family);

    for (const char of sample) {
      const signature = renderGlyphSignature(char, family);
      if (signature === "" || signature === notdef) {
        supported = false;
        break;
      }
    }
  } catch (error) {
    // A probe failure must not block generation; the warning is advisory only.
    logger.warning(`failed to inspect subtitle font glyphs: ${fontPath}, ${String(error)}`);
    supported = true;
  }

  glyphSupportCache.set(cacheKey, supported);
  return supported;
}

/** Rasterises one character and hashes the pixels, for glyph comparison. */
function renderGlyphSignature(char: string, family: string): string {
  const size = 48;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.font = cssFont(family, 30);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#FFFFFF";
  ctx.fillText(char, 2, 2);

  const { data } = ctx.getImageData(0, 0, size, size);
  let ink = 0;
  const hasher = new Bun.CryptoHasher("md5");
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]! > 0) ink++;
  }
  if (ink === 0) return "";
  hasher.update(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  return hasher.digest("hex");
}
