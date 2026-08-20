/**
 * Registry for the HyperFrames book-video templates in `resource/hyperframes`.
 *
 * A template is a directory of checked-in HyperFrames projects — `card/`,
 * `bed/`, `short/` — plus a `template.json` describing which of them it ships.
 * Nothing here renders; this is the layer that answers "which templates exist,
 * what does each one promise, and where does its part live on disk" so the
 * renderer and the pipeline never have to guess at either.
 *
 * The manifest is a contract with a template author, not with a user, so a
 * template that lies about itself — declares a part it does not ship, or names
 * itself something other than its own directory — is rejected rather than
 * half-loaded. A broken template is dropped from the list and logged; it must
 * never take the other templates, or the settings endpoint, down with it.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { UnsafePathError, resolvePathWithinDirectory } from "../../utils/fileSecurity.ts";
import { resourceDir } from "../../utils/paths.ts";
import { logger } from "../../utils/logger.ts";

/** The parts a template may ship. Each is its own HyperFrames project directory. */
export const TEMPLATE_PARTS = ["card", "bed", "short"] as const;
export type TemplatePart = (typeof TEMPLATE_PARTS)[number];

/** Every part is a directory holding exactly this file; its absence is the defect we check for. */
const PART_ENTRY_FILE = "index.html";

const MANIFEST_FILE = "template.json";

export interface TemplateEncodeProfile {
  fps: number;
  crf: number;
  preset: string;
}

export interface TemplateManifest {
  id: string;
  label: string;
  description: string;
  parts: TemplatePart[];
  defaultAccent: string;
  /** Seconds the card stays on screen, including its own alpha fade-out. */
  cardDuration: number;
  cardFadeOutSeconds: number;
  /** Length of one bed loop. The body is built by looping it, so this is not the segment length. */
  bedDuration: number;
  bedEncode: TemplateEncodeProfile;
}

/**
 * A template directory that exists but cannot be trusted.
 *
 * Carries the directory because the message alone rarely says which of several
 * templates is at fault once it reaches a log line.
 */
export class TemplateManifestError extends Error {
  readonly templateDir: string;

  constructor(message: string, templateDir: string) {
    super(message);
    this.name = "TemplateManifestError";
    this.templateDir = templateDir;
  }
}

/**
 * Encode profile applied to the body when a bed is used, for a template that
 * does not state its own. These are the T0 measurements — a moving bed is not a
 * held still, so `codecQualityArgs()`'s defaults are the wrong trade here.
 */
const DEFAULT_BED_ENCODE: TemplateEncodeProfile = { fps: 15, crf: 26, preset: "veryfast" };

/**
 * `template.json`'s shape.
 *
 * Deliberately not `.strict()`. Real manifests carry `"//"` keys — legal JSON
 * string keys used as comments, since JSON has none — and a `measured` block
 * that documents the spike's timings. Both are for humans, and zod's default
 * strip is exactly the "tolerate and ignore" this needs. Adding `.strict()`
 * would turn a template author's note into a load failure.
 *
 * `card` / `bed` are optional here and required in `assertPartsAreShipped` only
 * when `parts` claims them, so a short-only template does not have to invent
 * durations for parts it does not have.
 */
const manifestSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  description: z.string().trim().default(""),
  parts: z.array(z.enum(TEMPLATE_PARTS)).min(1),
  // The accent is interpolated into a composition's CSS and cache key; anything
  // that is not a plain 6-digit hex is a typo, not a colour we should pass on.
  defaultAccent: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "must be a #rrggbb colour"),
  card: z
    .object({
      duration: z.number().positive(),
      fadeOutSeconds: z.number().min(0).default(0),
    })
    .optional(),
  bed: z.object({ duration: z.number().positive() }).optional(),
  bedEncode: z
    .object({
      fps: z.number().positive().max(120),
      crf: z.number().int().min(0).max(63),
      preset: z.string().trim().min(1),
    })
    .default(DEFAULT_BED_ENCODE),
});

/**
 * A template id or part name, as it appears in a path segment.
 *
 * Anchored, and narrower than "no separators" on purpose: these two values are
 * joined into a directory that becomes an argv entry for the HyperFrames CLI,
 * so a leading `-` would be read as a flag. Requiring both ends to be
 * alphanumeric rules that out along with `.`, `..`, `/`, `\`, drive letters and
 * NUL, none of which can survive this character class.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

interface TemplateCache {
  root: string;
  stamp: string;
  templates: TemplateManifest[];
}

let rootOverride: string | undefined;
let cache: TemplateCache | undefined;

/** Root of the template tree. Not created on demand — templates ship with the repo. */
export function templatesRoot(): string {
  return rootOverride ?? resourceDir("hyperframes");
}

/**
 * Every template on disk, sorted by id.
 *
 * Sorting the directory names is sorting by id, because `loadTemplateManifest`
 * refuses a manifest whose `id` disagrees with its directory.
 *
 * Never throws: a missing root, an unreadable entry and a malformed manifest
 * all reduce to "fewer templates", because the callers are a settings endpoint
 * and a render that must degrade to the plain still rather than fail a chapter.
 */
export function listTemplates(): TemplateManifest[] {
  const root = templatesRoot();
  const names = templateDirNames(root);
  const stamp = directoryStamp(root, names);

  if (cache && cache.root === root && cache.stamp === stamp) return cache.templates.slice();

  const templates: TemplateManifest[] = [];
  for (const name of names) {
    try {
      templates.push(loadTemplateManifest(join(root, name)));
    } catch (error) {
      // Loud, but not fatal — see the class comment.
      logger.warning(`ignoring template "${name}": ${(error as Error).message}`);
    }
  }

  cache = { root, stamp, templates };
  return templates.slice();
}

/**
 * One template by id, or `null` when there is no such template.
 *
 * Total by construction: an unknown id, a blank one and a traversal attempt all
 * simply fail to match a discovered id. Callers reach this from a persisted
 * `render_params.template_id` that can outlive the template it names, so a
 * throw here would turn a deleted template into a failed re-render.
 */
export function getTemplate(id: string): TemplateManifest | null {
  const wanted = String(id ?? "").trim();
  if (!wanted) return null;
  return listTemplates().find((template) => template.id === wanted) ?? null;
}

/**
 * Directory of one template part, proven to sit inside the template root.
 *
 * Two independent checks, because this path ends up as a spawn argument: the
 * character class rejects anything that is not a bare name, and
 * `resolvePathWithinDirectory` then proves the resolved result — symlinks
 * followed — is still under the root. Neither argument is trusted to be a
 * known id or a known part; that is `getTemplate`'s job, and this stays usable
 * for a part directory that has not been created yet.
 */
export function templatePartDir(id: string, part: string): string {
  const safeId = assertSafeSegment(id, "id");
  const safePart = assertSafeSegment(part, "part");
  return resolvePathWithinDirectory(templatesRoot(), join(safeId, safePart), { requireFile: false });
}

/**
 * Reads and validates one template directory, or throws `TemplateManifestError`.
 *
 * Exported so the failure is inspectable: `listTemplates` deliberately swallows
 * it into a log line, which is right for a settings response and useless when
 * you are trying to find out why your new template did not appear.
 */
export function loadTemplateManifest(templateDir: string): TemplateManifest {
  const dir = resolve(templateDir);
  const dirName = basename(dir);
  const manifestPath = join(dir, MANIFEST_FILE);

  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    throw new TemplateManifestError(`${MANIFEST_FILE} is missing or unreadable`, dir);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new TemplateManifestError(`${MANIFEST_FILE} is not valid JSON: ${(error as Error).message}`, dir);
  }

  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new TemplateManifestError(`${MANIFEST_FILE} is invalid — ${describeIssues(parsed.error)}`, dir);
  }
  const manifest = parsed.data;

  // The id is what every caller passes to templatePartDir, so an id that does
  // not name its own directory resolves to a path that does not exist.
  if (manifest.id !== dirName) {
    throw new TemplateManifestError(`id "${manifest.id}" does not match its directory "${dirName}"`, dir);
  }

  const duplicate = manifest.parts.find((part, index) => manifest.parts.indexOf(part) !== index);
  if (duplicate) {
    throw new TemplateManifestError(`part "${duplicate}" is declared twice`, dir);
  }

  assertPartsAreShipped(manifest.id, manifest.parts, dir);
  assertPartTimingsExist(manifest, dir);

  // Frozen because the cache hands the same objects to every caller, and a
  // pipeline that scaled `bedEncode.fps` in place would poison every later read.
  return Object.freeze({
    id: manifest.id,
    label: manifest.label,
    description: manifest.description,
    parts: Object.freeze([...manifest.parts]) as TemplatePart[],
    defaultAccent: manifest.defaultAccent.toLowerCase(),
    cardDuration: manifest.card?.duration ?? 0,
    cardFadeOutSeconds: manifest.card?.fadeOutSeconds ?? 0,
    bedDuration: manifest.bed?.duration ?? 0,
    bedEncode: Object.freeze({ ...manifest.bedEncode }),
  }) as TemplateManifest;
}

/**
 * Every declared part must have an `index.html` behind it.
 *
 * This is the failure the registry exists to catch. A declared-but-absent part
 * would otherwise surface as a renderer error deep inside a chapter render, or
 * — worse — as a silently skipped card that nobody notices until the video is
 * watched, so it is caught at load and names the part.
 */
function assertPartsAreShipped(id: string, parts: TemplatePart[], dir: string): void {
  for (const part of parts) {
    const entry = join(dir, part, PART_ENTRY_FILE);
    let isFile = false;
    try {
      isFile = statSync(entry).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      throw new TemplateManifestError(
        `template "${id}" declares part "${part}" but ${join(part, PART_ENTRY_FILE)} does not exist`,
        dir,
      );
    }
  }
}

/**
 * A declared card or bed must state its length.
 *
 * The card's duration becomes the `enable='between(t,0,D)'` window of the
 * overlay filter and the bed's is the loop length; defaulting either to zero
 * would produce an encode that runs, costs full price, and shows nothing.
 * `short` is exempt — its length is the narration's, resolved at render time.
 */
function assertPartTimingsExist(
  manifest: z.infer<typeof manifestSchema>,
  dir: string,
): void {
  if (manifest.parts.includes("card") && !manifest.card) {
    throw new TemplateManifestError(`template "${manifest.id}" declares part "card" but has no card.duration`, dir);
  }
  if (manifest.parts.includes("bed") && !manifest.bed) {
    throw new TemplateManifestError(`template "${manifest.id}" declares part "bed" but has no bed.duration`, dir);
  }
}

/** Candidate template directories: real directories, safely nameable, sorted. */
function templateDirNames(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  return entries
    .filter((name) => SAFE_SEGMENT.test(name) && isDirectory(join(root, name)))
    .sort((a, b) => a.localeCompare(b));
}

function isDirectory(path: string): boolean {
  try {
    // statSync rather than a Dirent, so a template symlinked in from elsewhere
    // still counts as a directory.
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Cheap fingerprint of the tree's shape, used to expire the parsed cache.
 *
 * Covers what a template author actually does between restarts: adding,
 * removing or renaming a template, and adding or removing a part inside one —
 * all of which move a directory's mtime. The entry names are folded in as well
 * because filesystem timestamps are not always fine-grained enough to separate
 * two changes in the same millisecond.
 *
 * What it does not catch is editing a `template.json` in place, which touches
 * no directory. That is a restart, and is the deliberate trade for not re-reading
 * and re-parsing every manifest on every settings request.
 */
function directoryStamp(root: string, names: string[]): string {
  const parts = [mtimeOf(root)];
  for (const name of names) parts.push(`${name}:${mtimeOf(join(root, name))}`);
  return parts.join("|");
}

function mtimeOf(path: string): string {
  try {
    return String(statSync(path).mtimeMs);
  } catch {
    return "-";
  }
}

function assertSafeSegment(value: string, label: string): string {
  const segment = String(value ?? "");
  if (!SAFE_SEGMENT.test(segment)) {
    throw new UnsafePathError(`unsafe template ${label}: ${JSON.stringify(segment)}`);
  }
  return segment;
}

/** zod's own `.message` is a JSON blob; a log line wants `path: reason`. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

/**
 * Test seam: point discovery at a fixture tree, or restore `resource/hyperframes`
 * by passing nothing. Drops the cache either way, since the root changed.
 */
export function __setTemplatesRootForTest(dir?: string): void {
  rootOverride = dir;
  cache = undefined;
}
