/**
 * Cover still overlay: titles burned onto the frame the segment encode holds.
 */

import { describe, expect, test } from "bun:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  coverOverlayCacheName,
  coverOverlayCopy,
  coverTitlePositionsFromParams,
  layoutCoverTitleBlock,
  renderCoverStill,
  renderDefaultCover,
  resolveCoverTitlePosition,
  wantsCoverTitleBurn,
} from "../src/services/book/coverOverlay.ts";
import { fontDir } from "../src/utils/paths.ts";

const FONT = join(fontDir(), "NotoSansBengali-Bold.ttf");

describe("coverOverlayCopy", () => {
  test("drops a title the render did not ask to burn, and empty strings", () => {
    expect(
      coverOverlayCopy({
        bookTitle: "  A Quiet Harbour  ",
        chapterTitle: "Chapter One",
        burnBookTitle: true,
        burnChapterTitle: false,
      }),
    ).toEqual({ bookTitle: "A Quiet Harbour", chapterTitle: "" });

    expect(
      coverOverlayCopy({
        bookTitle: "   ",
        chapterTitle: "  ",
        burnBookTitle: true,
        burnChapterTitle: true,
      }),
    ).toEqual({ bookTitle: "", chapterTitle: "" });
  });
});

describe("wantsCoverTitleBurn", () => {
  test("is off for books rendered before the overlay existed", () => {
    expect(wantsCoverTitleBurn({})).toBe(false);
    expect(wantsCoverTitleBurn({ burn_book_title: false, burn_chapter_title: false })).toBe(false);
  });

  test("is on when either title is requested", () => {
    expect(wantsCoverTitleBurn({ burn_book_title: true })).toBe(true);
    expect(wantsCoverTitleBurn({ burn_chapter_title: true })).toBe(true);
  });
});

describe("coverOverlayCacheName", () => {
  const base = {
    width: 1920,
    height: 1080,
    bookTitle: "A Quiet Harbour",
    chapterTitle: "Chapter One",
    burnBookTitle: true,
    burnChapterTitle: true,
    sourceKind: "upload" as const,
  };

  test("is stable for the same titles and changes when the chapter does", () => {
    expect(coverOverlayCacheName(base)).toBe(coverOverlayCacheName(base));
    expect(coverOverlayCacheName(base)).not.toBe(
      coverOverlayCacheName({ ...base, chapterTitle: "Chapter Two" }),
    );
  });

  test("does not reuse a 16:9 overlay on a 9:16 frame", () => {
    expect(coverOverlayCacheName(base)).not.toBe(
      coverOverlayCacheName({ ...base, width: 1080, height: 1920 }),
    );
  });

  test("does not reuse a bottom overlay when the title moves to the top", () => {
    expect(coverOverlayCacheName(base)).not.toBe(
      coverOverlayCacheName({ ...base, bookPosition: "top" }),
    );
  });

  test("does not reuse an overlay when only the chapter pad moves", () => {
    expect(
      coverOverlayCacheName({ ...base, bookPosition: "top", chapterPosition: "bottom" }),
    ).not.toBe(
      coverOverlayCacheName({ ...base, bookPosition: "top", chapterPosition: "top" }),
    );
  });
});

describe("coverTitlePositionsFromParams", () => {
  test("lets each title keep its own pad", () => {
    expect(
      coverTitlePositionsFromParams({
        cover_book_title_position: "top_left",
        cover_chapter_title_position: "bottom_right",
      }),
    ).toEqual({ book: "top_left", chapter: "bottom_right" });
  });

  test("inherits a legacy single pad so a retry does not jump the titles", () => {
    expect(coverTitlePositionsFromParams({ cover_title_position: "top" })).toEqual({
      book: "top",
      chapter: "top",
    });
  });
});

describe("resolveCoverTitlePosition", () => {
  test("defaults missing and unknown values to the original bottom placement", () => {
    expect(resolveCoverTitlePosition(undefined)).toBe("bottom");
    expect(resolveCoverTitlePosition("north")).toBe("bottom");
    expect(resolveCoverTitlePosition("top_right")).toBe("top_right");
  });
});

describe("layoutCoverTitleBlock", () => {
  test("pins each corner and edge inside the padded frame", () => {
    const topLeft = layoutCoverTitleBlock({
      position: "top_left",
      width: 1000,
      height: 1000,
      textHeight: 100,
    });
    expect(topLeft.textAlign).toBe("left");
    expect(topLeft.x).toBe(80);
    expect(topLeft.y).toBe(70);

    const bottomRight = layoutCoverTitleBlock({
      position: "bottom_right",
      width: 1000,
      height: 1000,
      textHeight: 100,
    });
    expect(bottomRight.textAlign).toBe("right");
    expect(bottomRight.x).toBe(920);
    expect(bottomRight.y).toBe(830);

    const center = layoutCoverTitleBlock({
      position: "center",
      width: 1000,
      height: 1000,
      textHeight: 100,
    });
    expect(center.textAlign).toBe("center");
    expect(center.x).toBe(500);
    expect(center.y).toBe(450);

    const left = layoutCoverTitleBlock({
      position: "left",
      width: 1000,
      height: 1000,
      textHeight: 100,
    });
    expect(left.textAlign).toBe("left");
    expect(left.x).toBe(80);
    expect(left.y).toBe(450);
  });
});

describe("renderCoverStill", () => {
  test("writes a PNG at the output frame size", async () => {
    const png = await renderCoverStill({
      bookTitle: "A Quiet Harbour",
      chapterTitle: "Chapter One",
      width: 640,
      height: 360,
      fontFile: FONT,
      burnBookTitle: true,
      burnChapterTitle: true,
    });
    const image = await loadImage(png);
    expect(image.width).toBe(640);
    expect(image.height).toBe(360);
  });

  test("changes the picture when titles are burned onto a blank still", async () => {
    const blank = await renderCoverStill({
      bookTitle: "A Quiet Harbour",
      chapterTitle: "Chapter One",
      width: 640,
      height: 360,
      fontFile: FONT,
      burnBookTitle: false,
      burnChapterTitle: false,
    });
    const burned = await renderCoverStill({
      bookTitle: "A Quiet Harbour",
      chapterTitle: "Chapter One",
      width: 640,
      height: 360,
      fontFile: FONT,
      burnBookTitle: true,
      burnChapterTitle: true,
    });
    expect(blank.equals(burned)).toBe(false);
  });

  test("fits an uploaded cover into the frame before drawing titles", async () => {
    const source = join(tmpdir(), `vidgen-cover-src-${Date.now()}.png`);
    const portrait = createCanvas(200, 400);
    const ctx = portrait.getContext("2d");
    ctx.fillStyle = "#cc3333";
    ctx.fillRect(0, 0, 200, 400);
    await Bun.write(source, portrait.toBuffer("image/png"));

    const png = await renderCoverStill({
      sourcePath: source,
      bookTitle: "Harbour",
      chapterTitle: "One",
      width: 640,
      height: 360,
      fontFile: FONT,
      burnBookTitle: true,
      burnChapterTitle: true,
    });
    const image = await loadImage(png);
    expect(image.width).toBe(640);
    expect(image.height).toBe(360);

    const canvas = createCanvas(640, 360);
    const out = canvas.getContext("2d");
    out.drawImage(image, 0, 0);
    // Letterbox: the fitted portrait does not reach the left edge.
    const edge = out.getImageData(2, 180, 1, 1).data;
    expect(edge[0]).toBe(0);
    expect(edge[1]).toBe(0);
    expect(edge[2]).toBe(0);
    // The fitted picture sits in the centre column.
    const centre = out.getImageData(320, 180, 1, 1).data;
    expect(centre[0]).toBeGreaterThan(150);
  });

  test("top and bottom placements put ink in different halves of the frame", async () => {
    const shared = {
      bookTitle: "Harbour",
      chapterTitle: "",
      width: 640,
      height: 360,
      fontFile: FONT,
      burnBookTitle: true,
      burnChapterTitle: false,
    };
    const top = await renderCoverStill({ ...shared, bookPosition: "top" });
    const bottom = await renderCoverStill({ ...shared, bookPosition: "bottom" });
    expect(top.equals(bottom)).toBe(false);

    const sample = async (png: Buffer, y: number) => {
      const image = await loadImage(png);
      const canvas = createCanvas(640, 360);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(320, y, 1, 1).data;
    };
    const topPixel = await sample(top, 40);
    const bottomAtTop = await sample(bottom, 40);
    // The top placement draws shadowed letters near the top; the bottom
    // placement leaves that row as the blank cover field.
    expect(topPixel[0] + topPixel[1] + topPixel[2]).not.toBe(
      bottomAtTop[0] + bottomAtTop[1] + bottomAtTop[2],
    );
  });

  test("book and chapter pads can sit in opposite corners", async () => {
    const stacked = await renderCoverStill({
      bookTitle: "Harbour",
      chapterTitle: "One",
      width: 640,
      height: 360,
      fontFile: FONT,
      burnBookTitle: true,
      burnChapterTitle: true,
      bookPosition: "bottom",
      chapterPosition: "bottom",
    });
    const split = await renderCoverStill({
      bookTitle: "Harbour",
      chapterTitle: "One",
      width: 640,
      height: 360,
      fontFile: FONT,
      burnBookTitle: true,
      burnChapterTitle: true,
      bookPosition: "top_left",
      chapterPosition: "bottom_right",
    });
    expect(stacked.equals(split)).toBe(false);
  });
});

describe("renderDefaultCover", () => {
  test("draws a title card at the requested size", async () => {
    const png = renderDefaultCover("A Quiet Harbour", "R. Nyström", 320, 180, FONT);
    const image = await loadImage(png);
    expect(image.width).toBe(320);
    expect(image.height).toBe(180);
  });
});
