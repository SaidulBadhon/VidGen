/**
 * Cover stills for long-form segments: a generated title card, or an uploaded
 * picture with the book and chapter names burned on when the render asks for it.
 *
 * The still encode fits whatever image it is given into the output frame, so
 * titles have to be drawn *after* that same fit — otherwise a portrait cover in
 * a 16:9 video would scale the lettering into the letterbox. Overlay files are
 * therefore always produced at the target resolution. Book and chapter titles
 * can sit in different cells of the 3×3 grid; they only stack when they share
 * one.
 */

import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import {
  COVER_TITLE_POSITIONS,
  DEFAULT_COVER_TITLE_POSITION,
  type CoverTitlePosition,
} from "./types.ts";
import { registerSubtitleFont, resolveSubtitleFontPath, wrapText } from "../video/textRender.ts";

export { COVER_TITLE_POSITIONS, DEFAULT_COVER_TITLE_POSITION, type CoverTitlePosition };

export const COVER_BACKGROUND = "#14161c";
const COVER_TITLE_COLOR = "#f5f5f7";
const COVER_AUTHOR_COLOR = "#9aa0ad";
const COVER_CHAPTER_COLOR = "#d5d8e0";
const COVER_TEXT_SHADOW = "rgba(0,0,0,0.92)";

export interface CoverOverlayFlags {
  burn_book_title?: boolean;
  burn_chapter_title?: boolean;
}

export interface CoverStillOptions {
  /** Uploaded cover; omit to start from the plain title-card background. */
  sourcePath?: string | null;
  bookTitle: string;
  chapterTitle: string;
  width: number;
  height: number;
  fontFile: string;
  burnBookTitle: boolean;
  burnChapterTitle: boolean;
  /** Where the book title sits; defaults to bottom-centre. */
  bookPosition?: CoverTitlePosition | string | null;
  /** Where the chapter title sits; defaults to bottom-centre. */
  chapterPosition?: CoverTitlePosition | string | null;
}

export interface CoverOverlayCopy {
  bookTitle: string;
  chapterTitle: string;
}

export interface CoverTitleLayout {
  x: number;
  y: number;
  textAlign: "left" | "center" | "right";
  maxWidth: number;
}

export type CoverScrimKind = "top" | "center" | "bottom";

export interface CoverScrim {
  kind: CoverScrimKind;
  y: number;
  height: number;
}

/** True when the still should be re-rasterised with titles on top. */
export function wantsCoverTitleBurn(params: CoverOverlayFlags): boolean {
  return Boolean(params.burn_book_title || params.burn_chapter_title);
}

/**
 * The strings that will actually be drawn.
 *
 * Empty after trim is treated as off: a book with no title, or a segment that
 * never got a chapter name, must not burn a blank plate over the cover.
 */
export function coverOverlayCopy(input: {
  bookTitle: string;
  chapterTitle: string;
  burnBookTitle: boolean;
  burnChapterTitle: boolean;
}): CoverOverlayCopy {
  return {
    bookTitle: input.burnBookTitle ? input.bookTitle.trim() : "",
    chapterTitle: input.burnChapterTitle ? input.chapterTitle.trim() : "",
  };
}

/** Unknown or missing values fall back to the original bottom-centre overlay. */
export function resolveCoverTitlePosition(value: string | null | undefined): CoverTitlePosition {
  if (value && (COVER_TITLE_POSITIONS as readonly string[]).includes(value)) {
    return value as CoverTitlePosition;
  }
  return DEFAULT_COVER_TITLE_POSITION;
}

/**
 * Positions stored on a render. A book burned before the two pads existed has
 * a single `cover_title_position`; both titles inherit it so a retry does not
 * jump them to the default.
 */
export function coverTitlePositionsFromParams(params: {
  cover_book_title_position?: string | null;
  cover_chapter_title_position?: string | null;
  cover_title_position?: string | null;
}): { book: CoverTitlePosition; chapter: CoverTitlePosition } {
  const legacy = params.cover_title_position;
  return {
    book: resolveCoverTitlePosition(params.cover_book_title_position ?? legacy),
    chapter: resolveCoverTitlePosition(params.cover_chapter_title_position ?? legacy),
  };
}

function coverTitleAnchor(position: CoverTitlePosition): {
  h: "left" | "center" | "right";
  v: CoverScrimKind;
} {
  const h: "left" | "center" | "right" = position.endsWith("left")
    ? "left"
    : position.endsWith("right")
      ? "right"
      : "center";
  const v: "top" | "center" | "bottom" = position.startsWith("top")
    ? "top"
    : position.startsWith("bottom")
      ? "bottom"
      : "center";
  return { h, v };
}

/** How wide the title may run before wrapping. Side placements keep a half-frame so the picture still shows. */
export function coverTitleMaxWidth(position: CoverTitlePosition, width: number): number {
  const { h } = coverTitleAnchor(position);
  return Math.round(width * (h === "center" ? 0.84 : 0.5));
}

/**
 * Origin of the title block inside the output frame.
 *
 * `x` is the left / centre / right edge the canvas `textAlign` draws from;
 * `y` is the top of the first line. Padding is a fraction of the frame so a
 * 9:16 still and a 16:9 still inset by the same visual amount.
 */
export function layoutCoverTitleBlock(options: {
  position: CoverTitlePosition;
  width: number;
  height: number;
  textHeight: number;
}): CoverTitleLayout {
  const { position, width, height, textHeight } = options;
  const { h, v } = coverTitleAnchor(position);
  const padX = Math.round(width * 0.08);
  const padY = Math.round(height * 0.07);

  const x = h === "left" ? padX : h === "right" ? width - padX : width / 2;
  const y =
    v === "top" ? padY : v === "bottom" ? height - padY - textHeight : (height - textHeight) / 2;

  return { x, y, textAlign: h, maxWidth: coverTitleMaxWidth(position, width) };
}

/**
 * Full-width gradient band behind a title.
 *
 * Top titles shade from the top of the frame to a little below the last line;
 * bottom titles do the same from the bottom; centred titles get a band that
 * fades out above and below. Always the full frame width — a plate around the
 * letters is not this.
 */
export function layoutCoverScrim(options: {
  position: CoverTitlePosition;
  height: number;
  textY: number;
  textHeight: number;
}): CoverScrim {
  const kind = coverTitleAnchor(options.position).v;
  const extra = Math.max(Math.round(options.height * 0.1), Math.round(options.textHeight * 0.55));
  if (kind === "top") {
    return { kind, y: 0, height: Math.min(options.height, options.textY + options.textHeight + extra) };
  }
  if (kind === "bottom") {
    const y = Math.max(0, options.textY - extra);
    return { kind, y, height: options.height - y };
  }
  const y = Math.max(0, options.textY - extra);
  const end = Math.min(options.height, options.textY + options.textHeight + extra);
  return { kind: "center", y, height: end - y };
}

/** One band per edge so a top-left book and a top-right chapter share a single top fade. */
export function mergeCoverScrims(scrims: readonly CoverScrim[]): CoverScrim[] {
  const byKind = new Map<CoverScrimKind, CoverScrim>();
  for (const scrim of scrims) {
    const existing = byKind.get(scrim.kind);
    if (!existing) {
      byKind.set(scrim.kind, { ...scrim });
      continue;
    }
    const y = Math.min(existing.y, scrim.y);
    const end = Math.max(existing.y + existing.height, scrim.y + scrim.height);
    byKind.set(scrim.kind, { kind: scrim.kind, y, height: end - y });
  }
  return [...byKind.values()];
}

/**
 * Stable filename for a burned still, so a retry of the same chapter reuses it.
 *
 * Width, height, both positions and the source kind belong in the key because a
 * 9:16 overlay cannot be stretched into a 16:9 frame, moving either title is a
 * different picture, and an upload vs a blank background are different even
 * when the titles match.
 */
export function coverOverlayCacheName(input: {
  width: number;
  height: number;
  bookTitle: string;
  chapterTitle: string;
  burnBookTitle: boolean;
  burnChapterTitle: boolean;
  sourceKind: "upload" | "blank";
  bookPosition?: CoverTitlePosition | string | null;
  chapterPosition?: CoverTitlePosition | string | null;
}): string {
  const positions = coverTitlePositionsFromParams({
    cover_book_title_position: input.bookPosition,
    cover_chapter_title_position: input.chapterPosition,
  });
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(
    JSON.stringify({
      width: input.width,
      height: input.height,
      bookTitle: input.bookTitle,
      chapterTitle: input.chapterTitle,
      burnBookTitle: input.burnBookTitle,
      burnChapterTitle: input.burnChapterTitle,
      sourceKind: input.sourceKind,
      bookPosition: positions.book,
      chapterPosition: positions.chapter,
    }),
  );
  return `${input.width}x${input.height}-${hasher.digest("hex").slice(0, 16)}.png`;
}

function wrapLimited(text: string, maxWidth: number, family: string, fontSize: number, maxLines: number): string[] {
  if (!text || maxLines <= 0) return [];
  const { lines } = wrapText(text, maxWidth, family, fontSize);
  return lines.slice(0, maxLines);
}

/**
 * Draws a plain title card used when the book has no uploaded cover and the
 * render is not burning titles onto the still.
 */
export function renderDefaultCover(
  title: string,
  author: string,
  width: number,
  height: number,
  fontFile: string,
): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const family = registerSubtitleFont(resolveSubtitleFontPath(fontFile, `${title} ${author}`));

  ctx.fillStyle = COVER_BACKGROUND;
  ctx.fillRect(0, 0, width, height);

  const titleSize = Math.round(Math.min(width, height) * 0.085);
  const authorSize = Math.round(titleSize * 0.5);
  const maxWidth = width * 0.8;

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.font = `${titleSize}px "${family}"`;
  const titleLines = wrapLimited(title || "Untitled", maxWidth, family, titleSize, 4);

  const lineHeight = titleSize * 1.3;
  const authorLine = author.trim();
  const blockHeight = titleLines.length * lineHeight + (authorLine ? authorSize * 3 : 0);
  let y = height / 2 - blockHeight / 2 + lineHeight / 2;

  ctx.fillStyle = COVER_TITLE_COLOR;
  for (const line of titleLines) {
    ctx.fillText(line, width / 2, y);
    y += lineHeight;
  }

  if (authorLine) {
    ctx.font = `${authorSize}px "${family}"`;
    ctx.fillStyle = COVER_AUTHOR_COLOR;
    const [firstAuthorLine] = wrapLimited(authorLine, maxWidth, family, authorSize, 1);
    if (firstAuthorLine) ctx.fillText(firstAuthorLine, width / 2, y + authorSize);
  }

  return canvas.toBuffer("image/png");
}

/** Contain-fit, matching ffmpeg's `force_original_aspect_ratio=decrease` plus a centred pad. */
async function drawFittedImage(ctx: SKRSContext2D, imagePath: string, width: number, height: number): Promise<void> {
  const image = await loadImage(imagePath);
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);

  const scale = Math.min(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

/**
 * A light drop on the letters themselves. The readable shadow is the full-width
 * gradient behind them; this only keeps the glyphs from dissolving into a
 * bright patch of the cover.
 */
function paintCoverLine(
  ctx: SKRSContext2D,
  line: string,
  x: number,
  y: number,
  fontSize: number,
  color: string,
): void {
  ctx.shadowColor = COVER_TEXT_SHADOW;
  ctx.shadowBlur = Math.max(3, Math.round(fontSize * 0.22));
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = Math.max(1, Math.round(fontSize * 0.05));
  ctx.fillStyle = color;
  ctx.fillText(line, x, y);
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

function paintCoverScrim(ctx: SKRSContext2D, scrim: CoverScrim, width: number): void {
  const y0 = scrim.y;
  const y1 = scrim.y + scrim.height;
  const gradient = ctx.createLinearGradient(0, y0, 0, y1);
  if (scrim.kind === "top") {
    gradient.addColorStop(0, "rgba(0,0,0,0.82)");
    gradient.addColorStop(0.52, "rgba(0,0,0,0.5)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
  } else if (scrim.kind === "bottom") {
    gradient.addColorStop(0, "rgba(0,0,0,0)");
    gradient.addColorStop(0.48, "rgba(0,0,0,0.5)");
    gradient.addColorStop(1, "rgba(0,0,0,0.82)");
  } else {
    gradient.addColorStop(0, "rgba(0,0,0,0)");
    gradient.addColorStop(0.32, "rgba(0,0,0,0.62)");
    gradient.addColorStop(0.68, "rgba(0,0,0,0.62)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, y0, width, scrim.height);
}

function paintCoverLines(
  ctx: SKRSContext2D,
  lines: string[],
  family: string,
  fontSize: number,
  lineHeight: number,
  color: string,
  layout: CoverTitleLayout,
): void {
  ctx.textAlign = layout.textAlign;
  ctx.textBaseline = "top";
  ctx.font = `${fontSize}px "${family}"`;
  let y = layout.y;
  for (const line of lines) {
    paintCoverLine(ctx, line, layout.x, y, fontSize, color);
    y += lineHeight;
  }
}

/**
 * Rasterises the still that a segment will hold for its narration.
 *
 * When `sourcePath` is set the picture is fitted into the frame first; when it
 * is not, the same dark field the generated title card uses is filled instead,
 * so a burn with no upload does not sit on top of a second copy of the title.
 * Titles that share a grid cell stack (book above chapter); otherwise each is
 * placed on its own.
 */
export async function renderCoverStill(options: CoverStillOptions): Promise<Buffer> {
  const { width, height, fontFile, sourcePath } = options;
  const copy = coverOverlayCopy(options);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  if (sourcePath) {
    await drawFittedImage(ctx, sourcePath, width, height);
  } else {
    ctx.fillStyle = COVER_BACKGROUND;
    ctx.fillRect(0, 0, width, height);
  }

  if (!copy.bookTitle && !copy.chapterTitle) {
    return canvas.toBuffer("image/png");
  }

  const positions = coverTitlePositionsFromParams({
    cover_book_title_position: options.bookPosition,
    cover_chapter_title_position: options.chapterPosition,
  });
  const family = registerSubtitleFont(
    resolveSubtitleFontPath(fontFile, `${copy.bookTitle} ${copy.chapterTitle}`),
  );
  const minSide = Math.min(width, height);
  const bookSize = Math.round(minSide * 0.055);
  const chapterSize = Math.round(minSide * 0.036);
  const bookLineHeight = bookSize * 1.22;
  const chapterLineHeight = chapterSize * 1.28;
  const gap = Math.round(minSide * 0.018);

  const bookLines = wrapLimited(
    copy.bookTitle,
    coverTitleMaxWidth(positions.book, width),
    family,
    bookSize,
    3,
  );
  const chapterLines = wrapLimited(
    copy.chapterTitle,
    coverTitleMaxWidth(positions.chapter, width),
    family,
    chapterSize,
    2,
  );
  const stack = bookLines.length > 0 && chapterLines.length > 0 && positions.book === positions.chapter;

  const paints: {
    lines: string[];
    fontSize: number;
    lineHeight: number;
    color: string;
    layout: CoverTitleLayout;
  }[] = [];
  const scrims: CoverScrim[] = [];

  if (stack) {
    const textHeight =
      bookLines.length * bookLineHeight + chapterLines.length * chapterLineHeight + gap;
    const layout = layoutCoverTitleBlock({
      position: positions.book,
      width,
      height,
      textHeight,
    });
    scrims.push(
      layoutCoverScrim({
        position: positions.book,
        height,
        textY: layout.y,
        textHeight,
      }),
    );
    paints.push({
      lines: bookLines,
      fontSize: bookSize,
      lineHeight: bookLineHeight,
      color: COVER_TITLE_COLOR,
      layout,
    });
    paints.push({
      lines: chapterLines,
      fontSize: chapterSize,
      lineHeight: chapterLineHeight,
      color: COVER_CHAPTER_COLOR,
      layout: { ...layout, y: layout.y + bookLines.length * bookLineHeight + gap },
    });
  } else {
    if (bookLines.length) {
      const textHeight = bookLines.length * bookLineHeight;
      const layout = layoutCoverTitleBlock({
        position: positions.book,
        width,
        height,
        textHeight,
      });
      scrims.push(
        layoutCoverScrim({
          position: positions.book,
          height,
          textY: layout.y,
          textHeight,
        }),
      );
      paints.push({
        lines: bookLines,
        fontSize: bookSize,
        lineHeight: bookLineHeight,
        color: COVER_TITLE_COLOR,
        layout,
      });
    }
    if (chapterLines.length) {
      const textHeight = chapterLines.length * chapterLineHeight;
      const layout = layoutCoverTitleBlock({
        position: positions.chapter,
        width,
        height,
        textHeight,
      });
      scrims.push(
        layoutCoverScrim({
          position: positions.chapter,
          height,
          textY: layout.y,
          textHeight,
        }),
      );
      paints.push({
        lines: chapterLines,
        fontSize: chapterSize,
        lineHeight: chapterLineHeight,
        color: COVER_CHAPTER_COLOR,
        layout,
      });
    }
  }

  for (const scrim of mergeCoverScrims(scrims)) {
    paintCoverScrim(ctx, scrim, width);
  }
  for (const paint of paints) {
    paintCoverLines(ctx, paint.lines, family, paint.fontSize, paint.lineHeight, paint.color, paint.layout);
  }

  return canvas.toBuffer("image/png");
}
