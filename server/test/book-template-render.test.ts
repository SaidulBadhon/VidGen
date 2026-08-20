/**
 * How a book segment picks up a HyperFrames card and motion bed — and, far more
 * often, how it declines to.
 *
 * Two properties carry this file. The first is that a book which asked for no
 * template gets *exactly* the encode that shipped before templates existed:
 * `resolveSegmentTemplateAssets` adds no keys at all, so the still options are
 * field-for-field what they were and the ffmpeg argument list cannot have
 * moved. The second is that nothing about a template may fail a chapter — an
 * uninstalled template, a host with no Chrome, a composition that dies
 * mid-render all end at a log line and the plain still, because the narration
 * that came before them cost twenty minutes.
 *
 * No composition is rendered here. The renderer is swapped for a recorder that
 * reproduces its one documented reuse rule, because what this module owns is
 * not the render — it is which output path each part is asked for, and that
 * path *is* the cache key.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  __setCompositionRendererForTest,
  buildSegmentStillOptions,
  compositionCacheName,
  resolveSegmentTemplateAssets,
  resolveTemplateAccent,
  type SegmentTemplateAssets,
  type SegmentTemplateInput,
} from "../src/tasks/bookPipeline.ts";
import type { BookRenderParamsDocument } from "../src/db/types.ts";
import {
  __resetHyperframesAvailabilityForTest,
  type CompositionRenderOptions,
  type renderComposition,
} from "../src/services/video/hyperframes.ts";
import { __setTemplatesRootForTest, getTemplate } from "../src/services/video/templates.ts";
import { STILL_FRAMERATE, type StillSegmentOptions } from "../src/services/video/still.ts";
import { booksDir } from "../src/utils/paths.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Book ids are used as real directory names under storage/books; see cleanup. */
const scratchBookIds = new Set<string>();
const originalBinaryPath = process.env.HYPERFRAMES_PATH;

afterEach(() => {
  __setCompositionRendererForTest();
  __setTemplatesRootForTest();
  __resetHyperframesAvailabilityForTest();
  if (originalBinaryPath === undefined) delete process.env.HYPERFRAMES_PATH;
  else process.env.HYPERFRAMES_PATH = originalBinaryPath;

  for (const bookId of scratchBookIds) {
    rmSync(booksDir(bookId), { recursive: true, force: true });
  }
  scratchBookIds.clear();
});

function scratchBookId(): string {
  const bookId = `test-template-${crypto.randomUUID().slice(0, 8)}`;
  scratchBookIds.add(bookId);
  return bookId;
}

/**
 * A template tree with a card and a bed, standing in for resource/hyperframes.
 *
 * A fixture rather than the shipped `classic` template so the timings under
 * test are the ones written here, and so a future edit to a checked-in
 * composition cannot quietly change what these assertions mean.
 *
 * `realpathSync` because templatePartDir proves its result is inside the root
 * with symlinks followed, and macOS's tmpdir is a symlink into /private.
 */
function fixtureTemplates(parts: string[] = ["card", "bed"]): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vidgen-book-template-")));
  const dir = join(root, "fixture");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "template.json"),
    JSON.stringify({
      id: "fixture",
      label: "Fixture",
      parts,
      defaultAccent: "#7aa2f7",
      card: { duration: 8, fadeOutSeconds: 1.4 },
      bed: { duration: 20 },
      bedEncode: { fps: 15, crf: 26, preset: "veryfast" },
    }),
  );
  for (const part of parts) {
    mkdirSync(join(dir, part), { recursive: true });
    writeFileSync(join(dir, part, "index.html"), "<div></div>");
  }
  __setTemplatesRootForTest(root);
  return root;
}

/**
 * A binary that reports a healthy environment, so hyperframesAvailable() is
 * true without Chrome being installed.
 *
 * Written once for the whole file and warmed once, because macOS spends most
 * of a second scanning each newly written executable the first time it is
 * exec'd — per test that would cost more than the rest of the suite.
 */
let doctorBinaryPath: string | undefined;

function healthyDoctorBinary(): void {
  if (!doctorBinaryPath) {
    const dir = mkdtempSync(join(tmpdir(), "vidgen-book-doctor-"));
    doctorBinaryPath = join(dir, "hyperframes-stub");
    writeFileSync(doctorBinaryPath, `#!/bin/sh\necho '{"ok":true}'\nexit 0\n`);
    chmodSync(doctorBinaryPath, 0o755);
    Bun.spawnSync([doctorBinaryPath, "--warmup"]);
  }
  process.env.HYPERFRAMES_PATH = doctorBinaryPath;
  __resetHyperframesAvailabilityForTest();
}

/** No binary at all: the shape every host without HyperFrames installed is in. */
function noHyperframes(): void {
  process.env.HYPERFRAMES_PATH = join(tmpdir(), "vidgen-absent-hyperframes");
  __resetHyperframesAvailabilityForTest();
}

interface RecordedRender {
  templateDir: string;
  outputFile: string;
  variables: Record<string, string>;
  fps?: number;
  /** True when the file was already there, so nothing was spawned. */
  cached: boolean;
}

/**
 * A renderer that records what it was asked for.
 *
 * It reproduces renderComposition's first act — a usable render already at the
 * output path is reused and no process is started — because that is what makes
 * "the bed was not rendered twice" a statement about this module's cache key
 * rather than about the renderer's internals.
 */
function recordingRenderer(
  log: RecordedRender[],
  behaviour: { fail?: string } = {},
): typeof renderComposition {
  return async (options: CompositionRenderOptions) => {
    const cached = existsSync(options.outputFile);
    log.push({
      templateDir: options.templateDir,
      outputFile: options.outputFile,
      variables: options.variables,
      fps: options.fps,
      cached,
    });

    if (behaviour.fail) throw new Error(behaviour.fail);

    if (!cached) {
      mkdirSync(dirname(options.outputFile), { recursive: true });
      writeFileSync(options.outputFile, "not really an mp4");
    }
    options.onProgress?.(1);
    return { outputFile: options.outputFile, duration: 20, cached };
  };
}

/** Render params with every required field, defaulting to no template at all. */
function renderParams(overrides: Partial<BookRenderParamsDocument> = {}): BookRenderParamsDocument {
  return {
    voice_name: "en-US-JennyNeural",
    voice_rate: 1,
    voice_volume: 1,
    subtitle_render_mode: "soft",
    video_aspect: "16:9",
    font_name: "NotoSans-Regular.ttf",
    font_size: 60,
    text_fore_color: "#FFFFFF",
    stroke_color: "#000000",
    stroke_width: 1.5,
    text_background_color: true,
    rounded_subtitle_background: true,
    subtitle_position: "bottom",
    custom_position: 70,
    n_threads: 2,
    ...overrides,
  };
}

function templateInput(overrides: Partial<SegmentTemplateInput> = {}): SegmentTemplateInput {
  return {
    bookId: scratchBookId(),
    bookTitle: "Me Before You",
    bookAuthor: "Jojo Moyes",
    chapterTitle: "Chapter 1",
    width: 1920,
    height: 1080,
    params: renderParams(),
    ...overrides,
  };
}

/** The still options the pipeline built before templates existed. */
function baseStillOptions(): StillSegmentOptions {
  return {
    imagePath: "/storage/books/b1/cover-1920x1080.png",
    audioPath: "/storage/tasks/book/001/chapter.mp3",
    outputFile: "/storage/tasks/book/001/chapter.mp4",
    width: 1920,
    height: 1080,
    assPath: undefined,
    fontsDir: undefined,
    threads: 2,
    signal: undefined,
  };
}

function spawnCount(log: RecordedRender[]): number {
  return log.filter((entry) => !entry.cached).length;
}

// ---------------------------------------------------------------------------
// The no-template case, which is nearly every book
// ---------------------------------------------------------------------------

describe("a segment with no template", () => {
  test("adds no fields at all, so the still options are the ones that shipped", async () => {
    const log: RecordedRender[] = [];
    __setCompositionRendererForTest(recordingRenderer(log));
    fixtureTemplates();
    healthyDoctorBinary();

    const assets = await resolveSegmentTemplateAssets(
      templateInput({ params: renderParams({ template_id: "fixture", template_parts: [] }) }),
    );

    // Not toEqual({}): a key carrying `undefined` compares equal to an absent
    // one and would still be spread over the still options.
    expect(Object.keys(assets)).toEqual([]);
    expect(log).toEqual([]);
  });

  test("does not consult a template when none was chosen", async () => {
    const log: RecordedRender[] = [];
    __setCompositionRendererForTest(recordingRenderer(log));
    fixtureTemplates();
    healthyDoctorBinary();

    const assets = await resolveSegmentTemplateAssets(
      templateInput({ params: renderParams({ template_id: "", template_parts: ["card", "bed"] }) }),
    );

    expect(Object.keys(assets)).toEqual([]);
    expect(log).toEqual([]);
  });

  test("leaves the still options field-for-field identical", () => {
    const base = baseStillOptions();
    const composed = buildSegmentStillOptions(base, {});

    // Field by field, because this is the invariant: still.ts derives the whole
    // ffmpeg argument list from exactly these, and a single extra key — even an
    // undefined one — is a change to the encode of every book in the library.
    expect(Object.keys(composed)).toEqual(Object.keys(base));
    expect(composed.imagePath).toBe(base.imagePath);
    expect(composed.audioPath).toBe(base.audioPath);
    expect(composed.outputFile).toBe(base.outputFile);
    expect(composed.width).toBe(base.width);
    expect(composed.height).toBe(base.height);
    expect(composed.assPath).toBeUndefined();
    expect(composed.fontsDir).toBeUndefined();
    expect(composed.threads).toBe(base.threads);
    expect(composed.signal).toBeUndefined();
    expect(composed.bedPath).toBeUndefined();
    expect(composed.cardPath).toBeUndefined();
    expect(composed.cardDuration).toBeUndefined();
    expect(composed.bedEncode).toBeUndefined();
    // The absent fps is the whole point: still.ts then falls back to
    // STILL_FRAMERATE, which is what a held cover has always been encoded at.
    expect(composed.fps).toBeUndefined();
    expect(STILL_FRAMERATE).toBe(5);
  });

  test("adds only the template's own fields when one is in play", () => {
    const base = baseStillOptions();
    const assets: SegmentTemplateAssets = {
      bedPath: "/storage/books/b1/hyperframes/bed-abc.mp4",
      bedEncode: { fps: 15, crf: 26, preset: "veryfast" },
      cardPath: "/storage/books/b1/hyperframes/card-def.mp4",
      cardDuration: 8,
      fps: 15,
    };

    const composed = buildSegmentStillOptions(base, assets);

    expect(Object.keys(composed)).toEqual([...Object.keys(base), ...Object.keys(assets)]);
    expect(composed.bedPath).toBe(assets.bedPath);
    expect(composed.cardPath).toBe(assets.cardPath);
    expect(composed.cardDuration).toBe(8);
    expect(composed.fps).toBe(15);
    // Nothing about the audio half of the graph moved, which is what keeps the
    // body's t=0 the narration's t=0 and every subtitle cue in sync.
    expect(composed.audioPath).toBe(base.audioPath);
    expect(composed.outputFile).toBe(base.outputFile);
  });
});

// ---------------------------------------------------------------------------
// Degradation: none of these may fail a chapter
// ---------------------------------------------------------------------------

describe("degrading to the plain still", () => {
  test("completes the segment via the still path when this host cannot render compositions", async () => {
    const log: RecordedRender[] = [];
    __setCompositionRendererForTest(recordingRenderer(log));
    fixtureTemplates();
    noHyperframes();

    const notes: string[] = [];
    const assets = await resolveSegmentTemplateAssets(
      templateInput({
        params: renderParams({ template_id: "fixture", template_parts: ["card", "bed"] }),
        note: (message) => void notes.push(message),
      }),
    );

    expect(Object.keys(assets)).toEqual([]);
    expect(log).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("cannot render HyperFrames compositions");
    // And the encode it degrades to is byte-for-byte the one that shipped.
    expect(Object.keys(buildSegmentStillOptions(baseStillOptions(), assets))).toEqual(
      Object.keys(baseStillOptions()),
    );
  });

  test("survives a template id that outlived its template", async () => {
    const log: RecordedRender[] = [];
    __setCompositionRendererForTest(recordingRenderer(log));
    fixtureTemplates();
    healthyDoctorBinary();

    const notes: string[] = [];
    const assets = await resolveSegmentTemplateAssets(
      templateInput({
        params: renderParams({ template_id: "deleted-last-year", template_parts: ["bed"] }),
        note: (message) => void notes.push(message),
      }),
    );

    expect(Object.keys(assets)).toEqual([]);
    expect(log).toEqual([]);
    expect(notes[0]).toContain("not installed");
  });

  test("skips a part the template does not ship and keeps the one it does", async () => {
    const log: RecordedRender[] = [];
    __setCompositionRendererForTest(recordingRenderer(log));
    fixtureTemplates(["bed"]);
    healthyDoctorBinary();

    const notes: string[] = [];
    const assets = await resolveSegmentTemplateAssets(
      templateInput({
        params: renderParams({ template_id: "fixture", template_parts: ["card", "bed"] }),
        note: (message) => void notes.push(message),
      }),
    );

    expect(assets.cardPath).toBeUndefined();
    expect(assets.cardDuration).toBeUndefined();
    expect(assets.bedPath).toBeTruthy();
    expect(notes.some((note) => note.includes("ships no card"))).toBe(true);
    expect(log).toHaveLength(1);
  });

  test("keeps the chapter when a composition render fails", async () => {
    const log: RecordedRender[] = [];
    __setCompositionRendererForTest(recordingRenderer(log, { fail: "chrome died between frames" }));
    fixtureTemplates();
    healthyDoctorBinary();

    const notes: string[] = [];
    const assets = await resolveSegmentTemplateAssets(
      templateInput({
        params: renderParams({ template_id: "fixture", template_parts: ["card", "bed"] }),
        note: (message) => void notes.push(message),
      }),
    );

    // Both parts were attempted and both were dropped; nothing threw.
    expect(log).toHaveLength(2);
    expect(Object.keys(assets)).toEqual([]);
    expect(notes.some((note) => note.includes("chrome died between frames"))).toBe(true);
  });

  test("rethrows a cancellation rather than spending an hour of ffmpeg on it", async () => {
    const log: RecordedRender[] = [];
    __setCompositionRendererForTest(recordingRenderer(log, { fail: "composition render was cancelled" }));
    fixtureTemplates();
    healthyDoctorBinary();

    const controller = new AbortController();
    controller.abort();

    await expect(
      resolveSegmentTemplateAssets(
        templateInput({
          params: renderParams({ template_id: "fixture", template_parts: ["bed"] }),
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow("cancelled");
  });
});

// ---------------------------------------------------------------------------
// The rendering path
// ---------------------------------------------------------------------------

describe("resolving a card and a bed", () => {
  test("threads the template's frame rate and quality profile into the encode", async () => {
    const log: RecordedRender[] = [];
    __setCompositionRendererForTest(recordingRenderer(log));
    fixtureTemplates();
    healthyDoctorBinary();

    const assets = await resolveSegmentTemplateAssets(
      templateInput({
        params: renderParams({ template_id: "fixture", template_parts: ["card", "bed"] }),
      }),
    );

    // Without this the bed is resampled to STILL_FRAMERATE with no error at all.
    expect(assets.fps).toBe(15);
    expect(assets.fps).not.toBe(STILL_FRAMERATE);
    expect(assets.bedEncode).toEqual({ fps: 15, crf: 26, preset: "veryfast" });
    expect(assets.cardDuration).toBe(8);
    // Both compositions are rendered at the rate the body is encoded at, so
    // neither is resampled when ffmpeg puts them together.
    expect(log.map((entry) => entry.fps)).toEqual([15, 15]);
  });

  test("prints the book and chapter on the card and nothing but the accent on the bed", async () => {
    const log: RecordedRender[] = [];
    __setCompositionRendererForTest(recordingRenderer(log));
    fixtureTemplates();
    healthyDoctorBinary();

    await resolveSegmentTemplateAssets(
      templateInput({
        chapterTitle: "Chapter 4: The Long Way Home",
        params: renderParams({
          template_id: "fixture",
          template_parts: ["card", "bed"],
          template_accent: "#B08D57",
        }),
      }),
    );

    const bed = log.find((entry) => entry.templateDir.endsWith("/bed"))!;
    const card = log.find((entry) => entry.templateDir.endsWith("/card"))!;

    // T0 took the cover out of the bed, which is what collapses its key to the
    // accent alone. A bed that read anything per-book would be a bed per book.
    expect(bed.variables).toEqual({ accent: "#b08d57" });
    expect(card.variables).toEqual({
      bookTitle: "Me Before You",
      bookAuthor: "Jojo Moyes",
      chapterTitle: "Chapter 4: The Long Way Home",
      accent: "#b08d57",
    });
  });

  test("reuses one bed across chapters and renders a card for each", async () => {
    const log: RecordedRender[] = [];
    __setCompositionRendererForTest(recordingRenderer(log));
    fixtureTemplates();
    healthyDoctorBinary();

    const bookId = scratchBookId();
    const params = renderParams({ template_id: "fixture", template_parts: ["card", "bed"] });

    const first = await resolveSegmentTemplateAssets(
      templateInput({ bookId, chapterTitle: "Chapter 1", params }),
    );
    const second = await resolveSegmentTemplateAssets(
      templateInput({ bookId, chapterTitle: "Chapter 2", params }),
    );

    // One bed per accent: the second segment asked for the same path, found it
    // and spawned nothing. Four calls, three of them real renders.
    expect(log).toHaveLength(4);
    expect(spawnCount(log)).toBe(3);
    expect(second.bedPath).toBe(first.bedPath!);
    expect(log.filter((entry) => entry.templateDir.endsWith("/bed") && !entry.cached)).toHaveLength(1);

    // The card is the part that is genuinely per chapter.
    expect(second.cardPath).not.toBe(first.cardPath!);
    expect(spawnCount(log.filter((entry) => entry.templateDir.endsWith("/card")))).toBe(2);
  });

  test("re-renders the bed when the accent or the frame size changes", async () => {
    const log: RecordedRender[] = [];
    __setCompositionRendererForTest(recordingRenderer(log));
    fixtureTemplates();
    healthyDoctorBinary();

    const bookId = scratchBookId();
    const base = { template_id: "fixture", template_parts: ["bed"] as ("card" | "bed")[] };

    const blue = await resolveSegmentTemplateAssets(
      templateInput({ bookId, params: renderParams({ ...base, template_accent: "#7aa2f7" }) }),
    );
    const gold = await resolveSegmentTemplateAssets(
      templateInput({ bookId, params: renderParams({ ...base, template_accent: "#b08d57" }) }),
    );
    const portrait = await resolveSegmentTemplateAssets(
      templateInput({
        bookId,
        width: 1080,
        height: 1920,
        params: renderParams({ ...base, template_accent: "#7aa2f7" }),
      }),
    );

    // A 16:9 bed stretched into a 9:16 frame is a different picture, so the
    // frame size is in the key alongside the accent.
    expect(new Set([blue.bedPath, gold.bedPath, portrait.bedPath]).size).toBe(3);
    expect(spawnCount(log)).toBe(3);
  });

  test("caches under the book, so deleting a book reclaims its renders", async () => {
    const log: RecordedRender[] = [];
    __setCompositionRendererForTest(recordingRenderer(log));
    fixtureTemplates();
    healthyDoctorBinary();

    const bookId = scratchBookId();
    const assets = await resolveSegmentTemplateAssets(
      templateInput({ bookId, params: renderParams({ template_id: "fixture", template_parts: ["bed"] }) }),
    );

    expect(dirname(assets.bedPath!)).toBe(join(booksDir(bookId), "hyperframes"));
    expect(basename(assets.bedPath!)).toMatch(/^bed-[0-9a-f]{16}\.mp4$/);
    expect(existsSync(assets.bedPath!)).toBe(true);
  });

  test("reports composition progress across the parts it renders", async () => {
    const log: RecordedRender[] = [];
    __setCompositionRendererForTest(recordingRenderer(log));
    fixtureTemplates();
    healthyDoctorBinary();

    const fractions: number[] = [];
    await resolveSegmentTemplateAssets(
      templateInput({
        params: renderParams({ template_id: "fixture", template_parts: ["card", "bed"] }),
        onProgress: (fraction) => void fractions.push(fraction),
      }),
    );

    // Two parts share the band rather than each driving it to the top.
    expect(fractions).toEqual([0.5, 1]);
  });
});

// ---------------------------------------------------------------------------
// Keys and colours
// ---------------------------------------------------------------------------

describe("resolveTemplateAccent", () => {
  const template = () => {
    fixtureTemplates();
    return getTemplate("fixture")!;
  };

  test("defers to the template's own colour when none was asked for", () => {
    expect(resolveTemplateAccent(template(), "")).toBe("#7aa2f7");
    expect(resolveTemplateAccent(template(), undefined)).toBe("#7aa2f7");
    expect(resolveTemplateAccent(template(), "   ")).toBe("#7aa2f7");
  });

  test("lowercases, so one accent is one cached bed", () => {
    expect(resolveTemplateAccent(template(), "#B08D57")).toBe("#b08d57");
  });

  test("refuses anything that is not a #rrggbb colour", () => {
    // These reach a composition's CSS and this module's cache key; a typo that
    // got that far would render a colour nobody chose and then cache it.
    expect(resolveTemplateAccent(template(), "red")).toBe("#7aa2f7");
    expect(resolveTemplateAccent(template(), "#fff")).toBe("#7aa2f7");
    expect(resolveTemplateAccent(template(), "#12345g")).toBe("#7aa2f7");
    expect(resolveTemplateAccent(template(), "../../etc")).toBe("#7aa2f7");
  });
});

describe("compositionCacheName", () => {
  test("is stable for the same key and different for any change to it", () => {
    const key = { template: "fixture", accent: "#7aa2f7", width: 1920, height: 1080, fps: 15 };

    expect(compositionCacheName("bed", key)).toBe(compositionCacheName("bed", key));
    expect(compositionCacheName("bed", key)).not.toBe(compositionCacheName("card", key));
    expect(compositionCacheName("bed", key)).not.toBe(
      compositionCacheName("bed", { ...key, accent: "#b08d57" }),
    );
    expect(compositionCacheName("bed", key)).not.toBe(compositionCacheName("bed", { ...key, fps: 30 }));
  });

  test("survives a chapter title that has no business being a filename", () => {
    const name = compositionCacheName("card", {
      chapterTitle: "Chapter 4/5: «Дом» — a very, very long subtitle 🌊 ".repeat(6),
    });

    expect(name).toMatch(/^card-[0-9a-f]{16}\.mp4$/);
  });
});
