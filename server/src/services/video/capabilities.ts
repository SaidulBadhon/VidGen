/**
 * Runtime feature detection for the ffmpeg binary in use.
 *
 * Which optional libraries an ffmpeg carries is decided by whoever compiled it,
 * not by this app: the Docker image installs Debian's package, which links
 * libass, while a Homebrew build routinely does not ship the `subtitles`/`ass`
 * filters at all. Burning captions therefore cannot be assumed to work, so the
 * pipeline asks the binary and falls back to a soft subtitle track when the
 * answer is no.
 *
 * The probe runs at most once per process; a render must never pay for it more
 * than once, and a probe failure must never fail the render.
 */

import { runFfmpegRaw } from "./ffmpeg.ts";
import { logger, errorMessage } from "../../utils/logger.ts";

/**
 * Extracts filter names from `ffmpeg -filters`.
 *
 * The table is fixed-width — flags, name, `V->V`, description — and is preceded
 * by a legend whose rows share the flags column. The `->` in the third column is
 * what separates a real filter row from the legend, and the flags column has
 * been both two and three characters wide across ffmpeg releases.
 */
export function parseFilterNames(output: string): Set<string> {
  const names = new Set<string>();

  for (const line of String(output ?? "").split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 3) continue;
    if (!/^[TSC.]{2,3}$/.test(columns[0]!)) continue;
    if (!columns[2]!.includes("->")) continue;
    if (!/^[A-Za-z0-9_]+$/.test(columns[1]!)) continue;
    names.add(columns[1]!);
  }

  return names;
}

/** Cached as a promise so concurrent renders share a single spawn. */
let filterProbe: Promise<Set<string>> | undefined;

async function probeFilters(): Promise<Set<string>> {
  try {
    const { stdout } = await runFfmpegRaw(["-filters"], { timeoutMs: 10_000 });
    return parseFilterNames(stdout);
  } catch (error) {
    // An empty set degrades every optional path to its portable alternative,
    // which is always preferable to failing a render over a capability question.
    logger.warning(`failed to inspect ffmpeg filters: ${errorMessage(error)}`);
    return new Set<string>();
  }
}

export async function hasFilter(name: string): Promise<boolean> {
  filterProbe ??= probeFilters();
  return (await filterProbe).has(name);
}

/**
 * Whether captions can be burned in with libass.
 *
 * The `subtitles` filter is the one that reads SRT/ASS files directly; `ass`
 * exists only when libass does, but the reverse is not guaranteed across
 * builds, so the filter the pipeline actually uses is the one probed.
 */
export function supportsAssBurn(): Promise<boolean> {
  return hasFilter("subtitles");
}

/** Test seam. */
export function __resetCapabilityCacheForTest(): void {
  filterProbe = undefined;
}
