/**
 * Template registry: what `resource/hyperframes` is allowed to contain, and
 * what a template that lies about itself is not allowed to do.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TemplateManifestError,
  __setTemplatesRootForTest,
  getTemplate,
  listTemplates,
  loadTemplateManifest,
  templatePartDir,
  templatesRoot,
} from "../src/services/video/templates.ts";
import { UnsafePathError } from "../src/utils/fileSecurity.ts";

/** Writes a template directory, creating an `index.html` for each named part. */
function writeTemplate(root: string, id: string, manifest: unknown, parts: string[]): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "template.json"), JSON.stringify(manifest));
  for (const part of parts) {
    mkdirSync(join(dir, part), { recursive: true });
    writeFileSync(join(dir, part, "index.html"), "<div></div>");
  }
  return dir;
}

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "vidgen-templates-"));
}

// Every test that swaps the root puts it back, so the "classic" assertions
// below always read the real resource/hyperframes tree.
afterEach(() => __setTemplatesRootForTest());

// ---------------------------------------------------------------------------

describe("the shipped classic template", () => {
  test("parses, and reports the three parts it ships", () => {
    const classic = getTemplate("classic");

    expect(classic).not.toBeNull();
    expect(classic!.id).toBe("classic");
    expect(classic!.label).toBe("Classic");
    expect(classic!.parts).toEqual(["card", "bed", "short"]);
    expect(classic!.description.length).toBeGreaterThan(0);
    expect(classic!.defaultAccent).toBe("#7aa2f7");
  });

  test("carries the card and bed timings the ffmpeg graph needs", () => {
    const classic = getTemplate("classic")!;

    expect(classic.cardDuration).toBe(8);
    expect(classic.cardFadeOutSeconds).toBe(1.4);
    expect(classic.bedDuration).toBe(20);
    expect(classic.bedEncode).toEqual({ fps: 15, crf: 26, preset: "veryfast" });
  });

  test("drops the manifest's human-only keys", () => {
    // `"//"` comments and the `measured` block are notes to a template author;
    // nothing downstream should be able to read them off a manifest.
    const classic = getTemplate("classic") as unknown as Record<string, unknown>;

    expect(classic).not.toHaveProperty("//");
    expect(classic).not.toHaveProperty("measured");
    expect(classic).not.toHaveProperty("card");
    expect(classic).not.toHaveProperty("bed");
  });

  test("is listed, sorted by id", () => {
    const ids = listTemplates().map((template) => template.id);

    expect(ids).toContain("classic");
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });
});

// ---------------------------------------------------------------------------

describe("manifest validation", () => {
  const wellFormed = {
    id: "fixture",
    label: "Fixture",
    description: "A fixture.",
    parts: ["card", "bed"],
    defaultAccent: "#112233",
    card: { duration: 6, fadeOutSeconds: 1 },
    bed: { duration: 12 },
    bedEncode: { fps: 15, crf: 26, preset: "veryfast" },
  };

  test("accepts a well-formed manifest, including comment keys", () => {
    const root = fixtureRoot();
    const dir = writeTemplate(
      root,
      "fixture",
      { ...wellFormed, "//": "a note", measured: { anything: 1 } },
      ["card", "bed"],
    );

    const manifest = loadTemplateManifest(dir);
    expect(manifest.id).toBe("fixture");
    expect(manifest.parts).toEqual(["card", "bed"]);
    expect(manifest.cardFadeOutSeconds).toBe(1);
    expect(manifest.bedDuration).toBe(12);
  });

  test("rejects a declared part whose index.html is missing, naming the part", () => {
    const root = fixtureRoot();
    // Declares card and bed; only card is on disk.
    const dir = writeTemplate(root, "fixture", wellFormed, ["card"]);

    expect(() => loadTemplateManifest(dir)).toThrow(TemplateManifestError);
    expect(() => loadTemplateManifest(dir)).toThrow(/"bed"/);
    expect(() => loadTemplateManifest(dir)).toThrow(/index\.html/);
  });

  test("drops the broken template from the list instead of failing the whole scan", () => {
    const root = fixtureRoot();
    // Broken the same way as the test above: declares bed, ships only card.
    writeTemplate(root, "broken", { ...wellFormed, id: "broken" }, ["card"]);
    writeTemplate(root, "intact", { ...wellFormed, id: "intact" }, ["card", "bed"]);
    __setTemplatesRootForTest(root);

    expect(listTemplates().map((template) => template.id)).toEqual(["intact"]);
    expect(getTemplate("broken")).toBeNull();
  });

  test("rejects a manifest whose id does not name its own directory", () => {
    const root = fixtureRoot();
    const dir = writeTemplate(root, "fixture", { ...wellFormed, id: "somethingelse" }, ["card", "bed"]);

    expect(() => loadTemplateManifest(dir)).toThrow(/does not match its directory/);
  });

  test("rejects a declared card or bed with no duration", () => {
    const root = fixtureRoot();
    const { card, ...noCard } = wellFormed;
    const dir = writeTemplate(root, "fixture", noCard, ["card", "bed"]);

    expect(() => loadTemplateManifest(dir)).toThrow(/card\.duration/);
  });

  test("rejects an unusable accent and a malformed file", () => {
    const root = fixtureRoot();
    const badAccent = writeTemplate(root, "accent", { ...wellFormed, id: "accent", defaultAccent: "blue" }, [
      "card",
      "bed",
    ]);
    expect(() => loadTemplateManifest(badAccent)).toThrow(/defaultAccent/);

    const brokenJson = join(root, "syntax");
    mkdirSync(brokenJson, { recursive: true });
    writeFileSync(join(brokenJson, "template.json"), "{ nope");
    expect(() => loadTemplateManifest(brokenJson)).toThrow(/not valid JSON/);

    expect(() => loadTemplateManifest(join(root, "absent"))).toThrow(/missing or unreadable/);
  });

  test("a short-only template needs no card or bed block", () => {
    const root = fixtureRoot();
    const dir = writeTemplate(
      root,
      "shortonly",
      { id: "shortonly", label: "Short only", parts: ["short"], defaultAccent: "#aabbcc" },
      ["short"],
    );

    const manifest = loadTemplateManifest(dir);
    expect(manifest.parts).toEqual(["short"]);
    expect(manifest.cardDuration).toBe(0);
    expect(manifest.bedDuration).toBe(0);
    // Falls back to the profile the T0 measurements settled on.
    expect(manifest.bedEncode).toEqual({ fps: 15, crf: 26, preset: "veryfast" });
    expect(manifest.description).toBe("");
  });
});

// ---------------------------------------------------------------------------

describe("getTemplate", () => {
  test("returns null for an unknown id rather than throwing", () => {
    expect(getTemplate("nope")).toBeNull();
  });

  test("returns null, not an error, for blank and hostile ids", () => {
    // A persisted template_id can outlive its template, so nothing here may throw.
    expect(getTemplate("")).toBeNull();
    expect(getTemplate("   ")).toBeNull();
    expect(getTemplate("../classic")).toBeNull();
    expect(getTemplate("/etc/passwd")).toBeNull();
  });

  test("survives a template root that does not exist", () => {
    __setTemplatesRootForTest(join(fixtureRoot(), "gone"));

    expect(listTemplates()).toEqual([]);
    expect(getTemplate("classic")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("the cache", () => {
  const manifest = {
    id: "one",
    label: "One",
    parts: ["card"],
    defaultAccent: "#010203",
    card: { duration: 4 },
  };

  test("picks up a template added after the first scan", () => {
    const root = fixtureRoot();
    writeTemplate(root, "one", manifest, ["card"]);
    __setTemplatesRootForTest(root);

    expect(listTemplates().map((template) => template.id)).toEqual(["one"]);

    writeTemplate(root, "two", { ...manifest, id: "two", label: "Two" }, ["card"]);

    // No restart, no explicit invalidation — the directory changed shape.
    expect(listTemplates().map((template) => template.id)).toEqual(["one", "two"]);
    expect(getTemplate("two")).not.toBeNull();
  });

  test("hands out a list callers cannot corrupt", () => {
    const root = fixtureRoot();
    writeTemplate(root, "one", manifest, ["card"]);
    __setTemplatesRootForTest(root);

    listTemplates().pop();
    expect(listTemplates()).toHaveLength(1);

    expect(() => {
      (getTemplate("one") as unknown as { id: string }).id = "hijacked";
    }).toThrow();
    expect(getTemplate("one")!.id).toBe("one");
  });
});

// ---------------------------------------------------------------------------

describe("templatePartDir", () => {
  let root: string;

  beforeAll(() => {
    root = realpathSync(templatesRoot());
  });

  test("resolves a part inside the template root", () => {
    expect(templatePartDir("classic", "card")).toBe(join(root, "classic", "card"));
  });

  test("resolves a part directory that does not exist yet", () => {
    expect(templatePartDir("classic", "outro")).toBe(join(root, "classic", "outro"));
  });

  test("refuses traversal in either argument", () => {
    // This path becomes a spawn argument, so containment is checked, not assumed.
    expect(() => templatePartDir("../etc", "card")).toThrow(UnsafePathError);
    expect(() => templatePartDir("classic", "../../etc")).toThrow(UnsafePathError);
    expect(() => templatePartDir("..", "card")).toThrow(UnsafePathError);
    expect(() => templatePartDir("classic", "..")).toThrow(UnsafePathError);
  });

  test("refuses absolute paths in either argument", () => {
    expect(() => templatePartDir("/etc/passwd", "card")).toThrow(UnsafePathError);
    expect(() => templatePartDir("classic", "/etc/passwd")).toThrow(UnsafePathError);
  });

  test("refuses separators in either argument", () => {
    expect(() => templatePartDir("classic/card", "card")).toThrow(UnsafePathError);
    expect(() => templatePartDir("classic", "card/index.html")).toThrow(UnsafePathError);
    expect(() => templatePartDir("classic\\card", "card")).toThrow(UnsafePathError);
    expect(() => templatePartDir("classic", "card\\nested")).toThrow(UnsafePathError);
  });

  test("refuses empty segments and argv-shaped names", () => {
    expect(() => templatePartDir("", "card")).toThrow(UnsafePathError);
    expect(() => templatePartDir("classic", "")).toThrow(UnsafePathError);
    // A leading dash would read as a flag once it reaches the renderer's argv.
    expect(() => templatePartDir("--help", "card")).toThrow(UnsafePathError);
    expect(() => templatePartDir("classic", "-rf")).toThrow(UnsafePathError);
  });
});
