/**
 * `footage compare` — measurement, not selection.
 *
 * The open question in `docs/plans/semantic-material-selection.md` §6.1 is what
 * `min_score` should be, and §6.3 asks whether the measurement should ship
 * before the render-path surgery. This module is that answer: it runs the two
 * candidate sources side by side for one video subject and reports the numbers,
 * and it **writes nothing and downloads nothing**. No module under
 * `services/material/` or `tasks/` is modified by its existence; it only calls
 * their read paths.
 *
 * Three things make the comparison faithful rather than merely plausible:
 *
 *   1. **Terms come from the pipeline's own call.** `llm.generateTerms` with the
 *      same `amount`/`matchScriptOrder` the pipeline passes (`pipeline.ts:255`).
 *      Comparing the library against terms invented here would measure the
 *      terms, not the library.
 *   2. **The provider side is the real provider path** — `getProviderSearch` +
 *      `searchWithCache`, with `minimumDuration = maxClipDuration` exactly as
 *      `downloadVideos` sets it (`download.ts:268`). Not a fresh HTTP call
 *      written for this tool.
 *   3. **The library filter maps the aspect.** The Qdrant payload stores
 *      `landscape`/`portrait`/`square` (`index.ts:503,528`); a request carries
 *      `16:9`/`9:16`/`1:1` (`schema.ts:40`). Passing the request value matches
 *      **zero** points, which would render the library as empty and make every
 *      number below a lie in the library's disfavour. `libraryFilter` is the
 *      one place that mapping happens, and it is the function the tests pin.
 *
 * Duration accounting mirrors the download loop — `min(clipDuration,
 * maxClipDuration)` (`download.ts:314`) — not the informational `foundDuration`
 * sum, because the question is how much *rendered timeline* the library covers.
 */

import { getSettings } from "../../config/settings.ts";
import {
  VideoAspect,
  aspectOrientation,
  type MaterialInfo,
  type VideoAspectValue,
} from "../../models/schema.ts";
import { errorMessage, logger } from "../../utils/logger.ts";
import { searchWithCache } from "../material/cache.ts";
import { getProviderSearch, type SearchParams } from "../material/search.ts";
import * as llm from "../llm/index.ts";
import { searchFootage } from "./index.ts";
import { isAvailable, type FootageFilter, type FootageMatch } from "./qdrant.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The sweep the plan asks for (§6.1), ordered low to high.
 *
 * The measured bands it straddles: unrelated clips land near 0.51, plausible
 * ones 0.60-0.65, strong ones 0.72-0.83. 0.55 therefore sits just above noise
 * and 0.75 inside the strong band, so a row that collapses between two
 * neighbours is the signal — it names where the library stops having answers.
 */
export const SWEEP_THRESHOLDS = [0.55, 0.6, 0.62, 0.65, 0.7, 0.75] as const;

/** Term counts the pipeline uses, keyed by `match_materials_to_script`. */
export const TERMS_DEFAULT = 5;
export const TERMS_SCRIPT_ORDER = 8;

/**
 * Library results requested per term.
 *
 * Higher than `searchFootage`'s own default of 10 because the sweep counts
 * survivors: a limit that truncates at the low thresholds would report the
 * limit rather than the library. `searchFootage` caps at 100.
 */
export const DEFAULT_LIBRARY_LIMIT = 20;

/** `video_clip_duration`'s default (`schema.ts:118`). */
export const DEFAULT_CLIP_DURATION = 5;

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** One provider candidate, reduced to what a comparison needs to show. */
export interface ProviderCandidate {
  provider: string;
  asset_id: string | null;
  width: number | null;
  height: number | null;
  duration: number;
}

/** One library candidate. `local_file` is the render-side identity (§3.2). */
export interface LibraryCandidate {
  local_file: string;
  score: number;
  duration: number;
  aspect: string | null;
  summary: string;
  provider: string;
  asset_id: string | null;
}

/** Both sides for one search term, plus whatever went wrong on either. */
export interface TermComparison {
  term: string;
  provider: ProviderCandidate[];
  /** Set when the provider side was skipped or failed; `provider` is then empty. */
  provider_note: string | null;
  library: LibraryCandidate[];
  /** Set when the library side could not be consulted at all. */
  library_note: string | null;
  /** Highest library score for this term; null when the library returned nothing. */
  best_score: number | null;
}

/** One row of the threshold sweep — the deliverable. */
export interface SweepRow {
  threshold: number;
  /** Terms with at least one library match at or above the threshold. */
  terms_covered: number;
  terms_total: number;
  /** Surviving matches, counted per term (a clip winning two terms counts twice). */
  matches: number;
  /** Distinct `local_file`s among those matches — what a render could actually use. */
  unique_clips: number;
  /** `sum(min(duration, maxClipDuration))` over the distinct clips. */
  duration: number;
  /** `duration / audioDuration`, or null when no target was given. */
  coverage: number | null;
}

export interface CompareReport {
  video_subject: string;
  video_script: string;
  terms: string[];
  terms_source: "llm" | "given";
  match_script_order: boolean;
  source: string;
  video_aspect: VideoAspectValue;
  /** What the aspect was mapped to for the Qdrant filter; null for square. */
  orientation_filter: string | null;
  max_clip_duration: number;
  library_limit: number;
  audio_duration: number | null;
  qdrant_available: boolean;
  provider_consulted: boolean;
  per_term: TermComparison[];
  sweep: SweepRow[];
  totals: {
    provider_candidates: number;
    library_matches: number;
    library_unique_clips: number;
    terms_with_no_library_match: string[];
  };
  elapsed_ms: number;
}

// ---------------------------------------------------------------------------
// The aspect mapping — the part that is easy to get silently wrong
// ---------------------------------------------------------------------------

/** A single Qdrant filter clause, derived from the client's own filter type. */
type FilterCondition = Extract<NonNullable<FootageFilter["must"]>, readonly unknown[]>[number];

/**
 * The Qdrant filter for one library query.
 *
 * **The aspect clause must carry `aspectOrientation(videoAspect)`, never the
 * request value.** Verified against the live collection: `aspect = "9:16"`
 * counts 0 points, `aspect = "portrait"` counts 756 of 1,512.
 *
 * Square is deliberately unfiltered, mirroring the provider path, which accepts
 * every orientation for 1:1 and crops at render time (`search.ts:80`).
 * Filtering to `square` here would compare a 1:1 render against a handful of
 * genuinely square clips and report the library as useless for a reason that
 * has nothing to do with the library.
 *
 * The duration clause mirrors the provider search's `minimumDuration`
 * (`download.ts:268`), so neither side is credited with clips too short to use.
 */
export function libraryFilter(
  videoAspect: VideoAspectValue,
  minimumDuration: number,
): FootageFilter | undefined {
  const must: FilterCondition[] = [];

  const orientation = orientationFilterValue(videoAspect);
  if (orientation) must.push({ key: "aspect", match: { value: orientation } });

  if (Number.isFinite(minimumDuration) && minimumDuration > 0) {
    must.push({ key: "duration", range: { gte: minimumDuration } });
  }

  return must.length > 0 ? { must } : undefined;
}

/** The orientation word a request aspect filters on, or null when it does not filter. */
export function orientationFilterValue(videoAspect: VideoAspectValue): string | null {
  if (videoAspect === VideoAspect.square) return null;
  return aspectOrientation(videoAspect);
}

/**
 * Accepts a request aspect (`9:16`) or an orientation word (`portrait`).
 *
 * The existing `footage search --aspect` takes the orientation word while a
 * render takes the ratio, and this command sits between the two. Rejecting one
 * spelling would hand the operator the exact footgun this module exists to
 * document, so both are understood and normalised to the request form.
 */
export function parseAspect(raw: string): VideoAspectValue {
  const value = raw.trim().toLowerCase();
  switch (value) {
    case "16:9":
    case "landscape":
      return VideoAspect.landscape;
    case "9:16":
    case "portrait":
      return VideoAspect.portrait;
    case "1:1":
    case "square":
      return VideoAspect.square;
    default:
      throw new Error(`unknown aspect ${JSON.stringify(raw)}; use 16:9, 9:16 or 1:1`);
  }
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * Builds the threshold sweep from already-collected per-term matches.
 *
 * Pure, so the arithmetic that the `min_score` decision rests on is testable
 * without Qdrant, an LLM or a provider key.
 *
 * `matches` counts per term and `unique_clips` deduplicates on `local_file`
 * across every term, because both readings are needed and they answer different
 * questions: the first is how much the retrieval returns, the second is how
 * many clips a render could actually place given the per-render reuse ban
 * (§3.3). Duration follows the distinct clips for the same reason — counting a
 * clip once per term it wins would inflate coverage to whatever the term count
 * happens to be.
 */
export function buildSweep(
  perTerm: readonly Pick<TermComparison, "term" | "library">[],
  options: {
    thresholds?: readonly number[];
    maxClipDuration?: number;
    audioDuration?: number | null;
  } = {},
): SweepRow[] {
  const thresholds = options.thresholds ?? SWEEP_THRESHOLDS;
  const maxClipDuration = options.maxClipDuration ?? DEFAULT_CLIP_DURATION;
  const audioDuration = options.audioDuration ?? null;

  return thresholds.map((threshold) => {
    let termsCovered = 0;
    let matches = 0;
    let duration = 0;
    const seen = new Set<string>();

    for (const entry of perTerm) {
      const surviving = entry.library.filter((match) => match.score >= threshold);
      if (surviving.length > 0) termsCovered++;
      matches += surviving.length;

      for (const match of surviving) {
        if (seen.has(match.local_file)) continue;
        seen.add(match.local_file);
        duration += Math.min(maxClipDuration, match.duration);
      }
    }

    return {
      threshold,
      terms_covered: termsCovered,
      terms_total: perTerm.length,
      matches,
      unique_clips: seen.size,
      duration: round(duration, 1),
      coverage: audioDuration && audioDuration > 0 ? round(duration / audioDuration, 4) : null,
    };
  });
}

/**
 * The highest sweep threshold a term still clears, or null when it clears none.
 *
 * "A term the library cannot serve is the interesting case" — this is the
 * column that names it. A term whose best score falls below the lowest
 * threshold is one the library has no answer for at any setting worth using,
 * and no amount of lowering `min_score` fixes it without admitting noise.
 */
export function coveredTo(
  bestScore: number | null,
  thresholds: readonly number[] = SWEEP_THRESHOLDS,
): number | null {
  if (bestScore === null) return null;
  let highest: number | null = null;
  for (const threshold of thresholds) {
    if (bestScore >= threshold && (highest === null || threshold > highest)) highest = threshold;
  }
  return highest;
}

// ---------------------------------------------------------------------------
// Running the comparison
// ---------------------------------------------------------------------------

export interface CompareOptions {
  videoSubject: string;
  videoScript?: string;
  /** Explicit terms, skipping the LLM entirely. */
  terms?: string[];
  matchScriptOrder?: boolean;
  /** Overrides the pipeline's 5 / 8 default. */
  amount?: number;
  source?: string;
  videoAspect?: VideoAspectValue;
  maxClipDuration?: number;
  libraryLimit?: number;
  audioDuration?: number | null;
  /** False spends no provider quota and reports the library alone. */
  useProvider?: boolean;
  thresholds?: readonly number[];
  signal?: AbortSignal;
}

/** Every outbound call, injectable so the orchestration is testable offline. */
export interface CompareDeps {
  generateTerms?: typeof llm.generateTerms;
  searchFootage?: typeof searchFootage;
  getProviderSearch?: typeof getProviderSearch;
  searchWithCache?: typeof searchWithCache;
  qdrantAvailable?: () => Promise<boolean>;
}

export async function runCompare(
  options: CompareOptions,
  deps: CompareDeps = {},
): Promise<CompareReport> {
  const started = Date.now();

  const generateTerms = deps.generateTerms ?? llm.generateTerms;
  const searchLibrary = deps.searchFootage ?? searchFootage;
  const resolveProvider = deps.getProviderSearch ?? getProviderSearch;
  const providerSearch = deps.searchWithCache ?? searchWithCache;
  const qdrantAvailable = deps.qdrantAvailable ?? isAvailable;

  const videoSubject = options.videoSubject.trim();
  if (!videoSubject) throw new Error("compare needs a video subject");

  const videoScript = options.videoScript ?? "";
  const matchScriptOrder = Boolean(options.matchScriptOrder);
  const source = options.source ?? "pexels";
  const videoAspect = options.videoAspect ?? VideoAspect.portrait;
  const maxClipDuration = options.maxClipDuration ?? DEFAULT_CLIP_DURATION;
  const libraryLimit = options.libraryLimit ?? DEFAULT_LIBRARY_LIMIT;
  const audioDuration = options.audioDuration ?? null;
  const useProvider = options.useProvider !== false;
  const thresholds = options.thresholds ?? SWEEP_THRESHOLDS;

  // --- terms ---------------------------------------------------------------
  // Identical to `pipeline.ts:255-260`. The pipeline's optional
  // `rerankTermsBySubject` pass is *not* run: it is a TwelveLabs call that only
  // reorders an already-generated list, and reordering cannot change any number
  // this tool reports — every term is searched, and the sweep is order-blind.
  let terms: string[];
  let termsSource: "llm" | "given";
  if (options.terms && options.terms.length > 0) {
    terms = options.terms.map((term) => term.trim()).filter(Boolean);
    termsSource = "given";
  } else {
    const amount = options.amount ?? (matchScriptOrder ? TERMS_SCRIPT_ORDER : TERMS_DEFAULT);
    terms = await generateTerms({ videoSubject, videoScript, amount, matchScriptOrder });
    termsSource = "llm";
  }
  if (terms.length === 0) throw new Error("no search terms to compare");

  // --- library availability, probed once ------------------------------------
  // §3.3: one cached probe before the loop. A hung Qdrant otherwise costs the
  // 30-second query timeout and a warning per term, turning a five-term
  // comparison into a two-and-a-half-minute hang that still reports nothing.
  const available = await qdrantAvailable();
  if (!available) {
    logger.warning("qdrant is not reachable; the library side of this comparison will be empty");
  }

  const filter = libraryFilter(videoAspect, maxClipDuration);
  const provider = useProvider ? resolveProvider(source) : null;

  const perTerm: TermComparison[] = [];
  for (const term of terms) {
    options.signal?.throwIfAborted();

    // --- provider side -----------------------------------------------------
    let providerCandidates: ProviderCandidate[] = [];
    let providerNote: string | null = null;
    if (provider) {
      try {
        const items = await providerSearch({
          provider: provider.provider,
          search: provider.search,
          searchTerm: term,
          minimumDuration: maxClipDuration,
          videoAspect,
          signal: options.signal,
        } satisfies SearchParams & {
          provider: ReturnType<typeof getProviderSearch>["provider"];
          search: ReturnType<typeof getProviderSearch>["search"];
        });
        providerCandidates = items.map(toProviderCandidate);
      } catch (error) {
        providerNote = errorMessage(error);
        logger.warning(`provider search failed for ${JSON.stringify(term)}: ${providerNote}`);
      }
    } else {
      providerNote = "skipped (--no-provider)";
    }

    // --- library side ------------------------------------------------------
    let libraryCandidates: LibraryCandidate[] = [];
    let libraryNote: string | null = null;
    if (!available) {
      libraryNote = "qdrant unreachable";
    } else {
      try {
        // The term goes in bare. `embedSearchQuery` uses RETRIEVAL_QUERY and
        // the documents used RETRIEVAL_DOCUMENT; that asymmetry is exactly what
        // those task types absorb (`types.ts:174`). Padding the query with
        // "footage for a video about" would dilute the subject and invalidate
        // every threshold measured here.
        const matches = await searchLibrary(term, libraryLimit, filter);
        libraryCandidates = matches.map(toLibraryCandidate);
      } catch (error) {
        libraryNote = errorMessage(error);
        logger.warning(`library search failed for ${JSON.stringify(term)}: ${libraryNote}`);
      }
    }

    perTerm.push({
      term,
      provider: providerCandidates,
      provider_note: providerNote,
      library: libraryCandidates,
      library_note: libraryNote,
      best_score: libraryCandidates.length > 0 ? libraryCandidates[0]!.score : null,
    });
  }

  const uniqueClips = new Set<string>();
  for (const entry of perTerm) for (const match of entry.library) uniqueClips.add(match.local_file);

  return {
    video_subject: videoSubject,
    video_script: videoScript,
    terms,
    terms_source: termsSource,
    match_script_order: matchScriptOrder,
    source,
    video_aspect: videoAspect,
    orientation_filter: orientationFilterValue(videoAspect),
    max_clip_duration: maxClipDuration,
    library_limit: libraryLimit,
    audio_duration: audioDuration,
    qdrant_available: available,
    provider_consulted: useProvider,
    per_term: perTerm,
    sweep: buildSweep(perTerm, { thresholds, maxClipDuration, audioDuration }),
    totals: {
      provider_candidates: perTerm.reduce((sum, entry) => sum + entry.provider.length, 0),
      library_matches: perTerm.reduce((sum, entry) => sum + entry.library.length, 0),
      library_unique_clips: uniqueClips.size,
      terms_with_no_library_match: perTerm
        .filter((entry) => entry.library.length === 0)
        .map((entry) => entry.term),
    },
    elapsed_ms: Date.now() - started,
  };
}

/**
 * `MaterialInfo` reduced to the comparable facts.
 *
 * The download URL is deliberately dropped: it is a provider address that
 * routinely carries a key or a signature, and nothing in a comparison needs it.
 */
function toProviderCandidate(item: MaterialInfo): ProviderCandidate {
  const rendition = item.source_info?.rendition;
  return {
    provider: item.provider,
    asset_id: item.source_info?.asset_id ?? null,
    width: rendition?.width ?? null,
    height: rendition?.height ?? null,
    duration: round(item.duration, 1),
  };
}

function toLibraryCandidate(match: FootageMatch): LibraryCandidate {
  const payload = match.payload;
  return {
    local_file: payload?.local_file ?? match.id,
    score: round(match.score, 4),
    duration: round(payload?.duration ?? 0, 1),
    aspect: payload?.aspect ?? null,
    summary: payload?.summary ?? "",
    provider: payload?.provider ?? "unknown",
    asset_id: payload?.asset_id ?? null,
  };
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Terminal rendering
// ---------------------------------------------------------------------------

const PROVIDER_COLUMN = 40;
/** `vid-` + 32 hex + `.mp4` is exactly 40 characters; +2 keeps a gap. */
const LOCAL_FILE_COLUMN = 42;

/**
 * The whole report as text.
 *
 * Returned rather than printed so the formatting is testable — the sweep table
 * is the deliverable, and a table that silently loses a column is the kind of
 * defect that only shows up in a screenshot.
 */
export function formatReport(report: CompareReport): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(`footage compare — ${JSON.stringify(report.video_subject)}`);
  lines.push(
    `  terms          ${report.terms.length} (${report.terms_source}` +
      `${report.match_script_order ? ", script-order" : ""}): ${report.terms.join(" | ")}`,
  );
  lines.push(
    `  aspect         ${report.video_aspect} → qdrant filter ` +
      `${report.orientation_filter ? `aspect="${report.orientation_filter}"` : "none (square accepts every orientation, mirroring the provider path)"}`,
  );
  lines.push(
    `  clip cap       ${report.max_clip_duration}s (also the minimum duration both sides filter on)`,
  );
  lines.push(
    `  provider       ${report.provider_consulted ? report.source : "skipped (--no-provider)"}` +
      `    library limit ${report.library_limit}/term    qdrant ${report.qdrant_available ? "ok" : "UNREACHABLE"}`,
  );
  if (report.audio_duration !== null) lines.push(`  audio target   ${report.audio_duration}s`);
  lines.push("");

  for (const [position, entry] of report.per_term.entries()) {
    lines.push(...formatTerm(entry, position + 1, report.per_term.length));
  }

  lines.push(...formatPerTermTable(report));
  lines.push(...formatSweep(report));

  return lines.join("\n");
}

/** One term, provider and library aligned rank-for-rank. */
function formatTerm(entry: TermComparison, position: number, total: number): string[] {
  const lines: string[] = [];
  const header = `[${position}/${total}] ${JSON.stringify(entry.term)}`;
  lines.push(header);
  lines.push("─".repeat(Math.min(header.length + 2, 100)));

  const providerLabel = entry.provider_note
    ? `PROVIDER — ${entry.provider_note}`
    : `PROVIDER (${entry.provider.length})`;
  const libraryLabel = entry.library_note
    ? `LIBRARY — ${entry.library_note}`
    : `LIBRARY (${entry.library.length}${entry.best_score !== null ? `, best ${entry.best_score.toFixed(4)}` : ""})`;
  lines.push(`  ${"".padEnd(3)}${providerLabel.padEnd(PROVIDER_COLUMN)}${libraryLabel}`);

  const rows = Math.max(entry.provider.length, entry.library.length);
  if (rows === 0) {
    lines.push(`  ${"".padEnd(3)}${"(none)".padEnd(PROVIDER_COLUMN)}(none)`);
  }
  for (let index = 0; index < rows; index++) {
    const left = entry.provider[index];
    const right = entry.library[index];
    const leftText = left
      ? `${(left.asset_id ?? "?").padEnd(12)}${dimensions(left).padEnd(12)}${left.duration}s`
      : "—";
    const rightText = right
      ? `${right.score.toFixed(4)}  ${right.local_file.padEnd(LOCAL_FILE_COLUMN)}` +
        `${`${right.duration.toFixed(1)}s`.padStart(7)}${right.aspect ? `  [${right.aspect}]` : ""}`
      : "—";
    lines.push(`  ${String(index + 1).padStart(2)}. ${leftText.padEnd(PROVIDER_COLUMN)}${rightText}`);
  }

  // Summaries are the reason to trust or distrust a score, but they are far too
  // long for the right-hand column, so they follow the table instead of
  // wrapping it into unreadability.
  if (entry.library.length > 0) {
    lines.push("      library summaries:");
    for (const match of entry.library) {
      lines.push(`        ${match.score.toFixed(4)}  ${truncate(match.summary, 96)}`);
    }
  }
  lines.push("");
  return lines;
}

function dimensions(candidate: ProviderCandidate): string {
  if (!candidate.width || !candidate.height) return "?x?";
  return `${candidate.width}x${candidate.height}`;
}

/** Per-term verdict: can the library serve this term, and how strongly. */
function formatPerTermTable(report: CompareReport): string[] {
  const lines: string[] = [];
  lines.push("per-term library coverage");
  lines.push(
    `  ${"term".padEnd(34)}${"provider".padStart(8)}${"matches".padStart(9)}` +
      `${"best".padStart(9)}   covered to`,
  );
  lines.push(`  ${"─".repeat(78)}`);

  for (const entry of report.per_term) {
    const highest = coveredTo(entry.best_score, report.sweep.map((row) => row.threshold));
    const verdict =
      entry.best_score === null
        ? "NO MATCH"
        : highest === null
          ? `NOT SERVED (best ${entry.best_score.toFixed(3)} below every threshold)`
          : highest.toFixed(2);
    lines.push(
      `  ${truncate(entry.term, 33).padEnd(34)}` +
        `${String(entry.provider.length).padStart(8)}` +
        `${String(entry.library.length).padStart(9)}` +
        `${(entry.best_score === null ? "—" : entry.best_score.toFixed(4)).padStart(9)}   ${verdict}`,
    );
  }
  lines.push("");
  return lines;
}

/** The deliverable. */
function formatSweep(report: CompareReport): string[] {
  const lines: string[] = [];
  lines.push(
    `min_score sweep — ${report.per_term.length} term(s), clip cap ${report.max_clip_duration}s` +
      `${report.audio_duration !== null ? `, audio target ${report.audio_duration}s` : ", no audio target given"}`,
  );
  lines.push(
    `  ${"min_score".padStart(9)}${"terms covered".padStart(16)}${"matches".padStart(10)}` +
      `${"unique clips".padStart(14)}${"duration".padStart(11)}${"vs target".padStart(11)}`,
  );
  lines.push(`  ${"─".repeat(69)}`);

  for (const row of report.sweep) {
    lines.push(
      `  ${row.threshold.toFixed(2).padStart(9)}` +
        `${`${row.terms_covered}/${row.terms_total}`.padStart(16)}` +
        `${String(row.matches).padStart(10)}` +
        `${String(row.unique_clips).padStart(14)}` +
        `${`${row.duration.toFixed(1)}s`.padStart(11)}` +
        `${(row.coverage === null ? "—" : `${(row.coverage * 100).toFixed(0)}%`).padStart(11)}`,
    );
  }

  // The sweep's low rows are only meaningful when `--limit` is not what stopped
  // the results. A term that returned a full page with every match above the
  // lowest threshold has been truncated, and those rows understate the library
  // by an unknown amount — which is exactly the wrong direction for a decision
  // about how *low* `min_score` can go. Naming it is cheaper than a reader
  // silently drawing the wrong conclusion from a saturated table.
  const lowest = report.sweep[0]?.threshold ?? 0;
  const truncated = report.per_term.filter(
    (entry) =>
      entry.library.length >= report.library_limit &&
      entry.library.every((candidate) => candidate.score >= lowest),
  );
  if (truncated.length > 0) {
    lines.push(
      `NOTE: ${truncated.length} of ${report.per_term.length} term(s) returned a full page of ` +
        `${report.library_limit} matches with every score above ${lowest.toFixed(2)}. The rows at and ` +
        "below that score are capped by --limit, not by the library; re-run with a higher --limit " +
        "before reading them.",
    );
    lines.push("");
  }

  if (report.totals.terms_with_no_library_match.length > 0) {
    lines.push(
      `terms the library returned nothing for (${report.totals.terms_with_no_library_match.length}): ` +
        report.totals.terms_with_no_library_match.map((term) => JSON.stringify(term)).join(", "),
    );
  }
  lines.push(
    `totals: ${report.totals.provider_candidates} provider candidate(s), ` +
      `${report.totals.library_matches} library match(es) over ` +
      `${report.totals.library_unique_clips} distinct clip(s), ` +
      `${(report.elapsed_ms / 1000).toFixed(1)}s`,
  );
  lines.push("");
  return lines;
}

function truncate(text: string, width: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}

/**
 * Whether the settings even allow a library to exist.
 *
 * Read-only and advisory: the comparison still runs with indexing switched off
 * — the points are already there — but "the library looks empty" and "indexing
 * was never turned on" are different findings and the report should not let a
 * reader confuse them.
 */
export function footageIndexEnabled(): boolean {
  try {
    return Boolean(getSettings().footage_index.enabled);
  } catch {
    return false;
  }
}
