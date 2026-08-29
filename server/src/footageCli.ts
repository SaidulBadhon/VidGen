#!/usr/bin/env bun
/**
 * Command-line interface for the semantic footage library.
 *
 * A second entry point rather than a subcommand of `cli.ts`, because that file
 * parses with `allowPositionals: false` and rejects any invocation without
 * `--video-subject` or `--video-script`. Bending it around a positional
 * subcommand would put the working video CLI at risk for no gain, so the two
 * share the bootstrap sequence and nothing else.
 *
 *   bun run --cwd server footage status
 *   bun run --cwd server footage pull --per-term 4
 *   bun run --cwd server footage index --concurrency 4
 *   bun run --cwd server footage search "empty hospital corridor"
 *   bun run --cwd server footage reconcile
 */

// Must come first: it populates process.env from the root .env, and the
// modules below read it while they are being evaluated.
import "./config/dotenv.ts";

import { connect, disconnect, footageIndexCollection, footageRunsCollection } from "./db/client.ts";
import { getSettings, initSettings } from "./config/settings.ts";
import {
  indexAll,
  indexOne,
  listCacheClips,
  reconcile,
  searchFootage,
  stats,
  type IndexAllOptions,
  type IndexRunResult,
} from "./services/footage/index.ts";
import {
  FootageLockedError,
  forceReleaseLock,
  isLocked,
  withLock,
  type FootageLockStatus,
} from "./services/footage/lock.ts";
import { formatDryRun, parsePullArgs, pullFootage } from "./services/footage/pull.ts";
import type { FootageIndexDocument, FootageRunDocument } from "./db/types.ts";
import { errorMessage, logger, setLogLevel } from "./utils/logger.ts";
import { APP_VERSION, PROJECT_NAME } from "./version.ts";

const HELP = `${PROJECT_NAME} footage library v${APP_VERSION}

Usage:
  bun run --cwd server footage <command> [options]

Commands
  status                    What the library holds: counts, drift, failures, recent runs
  pull                      Download clips from the provider into the cache
  index                     Describe, embed and index every clip on disk
  reconcile                 Make Qdrant and the cache directory agree, then index the rest
  search QUERY              Semantic query against the index

status
  --json                    Machine-readable, instead of the operator report
  --failures N              Failed clips to list with their error text (default 10)
  --runs N                  Recent pull runs to list (default 5)

pull                        (every flag below is parsed by services/footage/pull.ts)
  --dry-run                 List what would be fetched; write nothing
  --per-term N              Clips per term per orientation
  --term TEXT               One search term (repeatable)
  --terms A,B,C             Comma-separated search terms
  --aspect NAME             portrait | landscape | square | both
  --concurrency N           Simultaneous downloads
  --page-cap N              Provider pages per term/orientation
  --max-bytes SIZE          Ceiling on bytes written this run, e.g. 20GB
  --min-free-bytes SIZE     Refuse to start a download below this free space
  --max-clip-bytes SIZE     Largest single clip to keep

index
  --file NAME               Index one clip (vid-<hash>.mp4), repeatable
  --concurrency N           Clips in flight at once
  --limit N                 Stop after this many clips that need work
  --force                   Re-index rows that are already current
  --redescribe              Ignore the cached description and pay the describer again
  --retry-failed            Try rows that have used up their attempts
  --json                    Machine-readable run result

reconcile                   Accepts every \`index\` flag except --file

search QUERY
  --limit N                 Results to return (default 10)
  --aspect NAME             Restrict to portrait | landscape | square
  --json                    Machine-readable matches

Global
  --wait MS                 Wait this long for the index lock instead of failing (default 0)
  --force-unlock            Drop a stale lock document, then exit
  -h, --help                Show this help
  -v, --version             Show the version

Exit codes
  0  success
  1  the run hit a fatal condition, or a clip failed
  2  bad usage
  3  the footage lock is held by another run
`;

/** Both mutating run types report the same way, so they format the same way. */
type RunLike = IndexRunResult & { points_deleted?: number; rows_unlinked?: number };

/**
 * A malformed invocation, as opposed to a run that went wrong.
 *
 * Separated so a mistyped flag exits 2 like every other usage error rather
 * than 1, which a caller would read as "the index run failed" and might retry.
 */
class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

/** Reads `--flag value`, removing both from `argv`. Undefined when absent. */
function takeValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
  argv.splice(index, 2);
  return value;
}

/** Reads every `--flag value` occurrence, removing them all. */
function takeValues(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (;;) {
    const value = takeValue(argv, flag);
    if (value === undefined) return values;
    values.push(value);
  }
}

/** Reads a boolean `--flag`, removing it. */
function takeFlag(argv: string[], flag: string): boolean {
  const index = argv.indexOf(flag);
  if (index === -1) return false;
  argv.splice(index, 1);
  return true;
}

function positiveInt(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} needs a positive integer`);
  }
  return parsed;
}

/**
 * The flags `index` and `reconcile` share.
 *
 * Consumed off `argv` so whatever is left over is an unknown flag — a mistyped
 * `--redescibe` that silently did nothing would be indistinguishable from a
 * run that decided there was no work to do.
 */
function takeIndexOptions(argv: string[]): IndexAllOptions {
  const options: IndexAllOptions = {};
  const concurrency = positiveInt(takeValue(argv, "--concurrency"), "--concurrency");
  if (concurrency !== undefined) options.concurrency = concurrency;
  const limit = positiveInt(takeValue(argv, "--limit"), "--limit");
  if (limit !== undefined) options.limit = limit;
  if (takeFlag(argv, "--force")) options.force = true;
  if (takeFlag(argv, "--redescribe")) options.redescribe = true;
  if (takeFlag(argv, "--retry-failed")) options.retryFailed = true;
  return options;
}

function rejectLeftovers(argv: string[]): void {
  if (argv.length > 0) throw new UsageError(`unknown option: ${argv[0]}`);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatLock(lock: FootageLockStatus | null): string {
  if (!lock) return "free";
  return (
    `held by ${lock.label} (pid ${lock.pid} on ${lock.hostname}), ` +
    `since ${lock.acquired_at.toISOString()}, expires ${lock.expires_at.toISOString()}`
  );
}

/** The one-line verdict a `status` reader is actually looking for. */
function verdictFor(report: Awaited<ReturnType<typeof stats>>): string {
  if (!report.qdrant.ok) return "DEGRADED — qdrant did not answer; counts below are partial";
  if (!report.drift) return "DEGRADED — drift could not be measured";
  if (report.drift.orphan_points > 0 || report.drift.missing_points > 0) {
    return `DRIFTED — run \`footage reconcile\` (${report.drift.orphan_points} orphan point(s), ` +
      `${report.drift.missing_points} file(s) with no point)`;
  }
  if (report.rows.failed > 0) {
    return `OK, with ${report.rows.failed} failed clip(s) — see below`;
  }
  if (report.files.count > report.rows.current) {
    return `INCOMPLETE — ${report.files.count - report.rows.current} file(s) not indexed at the current versions; run \`footage index\``;
  }
  return "OK — every clip on disk is indexed at the current versions";
}

function printRun(label: string, result: RunLike): void {
  const parts = [
    `scanned=${result.scanned}`,
    `attempted=${result.attempted}`,
    `indexed=${result.indexed}`,
    `refreshed=${result.refreshed}`,
    `skipped=${result.skipped}`,
    `missing=${result.missing}`,
    `failed=${result.failed}`,
    `describe_calls=${result.described}`,
  ];
  if (result.points_deleted !== undefined) parts.push(`points_deleted=${result.points_deleted}`);
  if (result.rows_unlinked !== undefined) parts.push(`rows_unlinked=${result.rows_unlinked}`);
  parts.push(`elapsed=${(result.elapsed_ms / 1000).toFixed(1)}s`);

  console.log(`\n${label}: ${parts.join(", ")}`);
  if (result.aborted) console.log("  run stopped early (abort, lost lock, or fatal error)");
  if (result.fatal) console.log(`  FATAL: ${result.fatal}`);

  // Per-clip failures are the actionable half; a count alone sends the reader
  // to Mongo to find out which file and why.
  for (const error of result.errors.slice(0, 20)) {
    console.log(`  failed  ${error.local_file}  ${error.message}`);
  }
  if (result.errors.length > 20) {
    console.log(`  ... and ${result.errors.length - 20} more failure(s); see \`footage status\``);
  }
}

/** Non-zero when the library is broken, or when any individual clip failed. */
function exitCodeFor(result: IndexRunResult): number {
  return result.fatal || result.failed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function commandStatus(argv: string[]): Promise<number> {
  const json = takeFlag(argv, "--json");
  const failureLimit = positiveInt(takeValue(argv, "--failures"), "--failures") ?? 10;
  const runLimit = positiveInt(takeValue(argv, "--runs"), "--runs") ?? 5;
  rejectLeftovers(argv);

  const report = await stats();

  // Read straight from Mongo: `stats()` deliberately reports counts, and the
  // error text is the thing an operator needs to decide whether a re-run is
  // worth anything.
  const failures = await footageIndexCollection()
    .find({ state: "failed" })
    .sort({ updated_at: -1 })
    .limit(failureLimit)
    .toArray()
    .catch((error: unknown) => {
      logger.warning(`could not read failed rows: ${errorMessage(error)}`);
      return [] as FootageIndexDocument[];
    });

  const runs = await footageRunsCollection()
    .find({})
    .sort({ started_at: -1 })
    .limit(runLimit)
    .toArray()
    .catch((error: unknown) => {
      logger.warning(`could not read footage runs: ${errorMessage(error)}`);
      return [] as FootageRunDocument[];
    });

  if (json) {
    console.log(
      JSON.stringify(
        {
          ...report,
          settings: {
            enabled: getSettings().footage_index.enabled,
            auto_index: getSettings().footage_index.auto_index,
            describe_model: getSettings().footage_index.describe_model,
            embed_model: getSettings().footage_index.embed_model,
          },
          failures: failures.map((row) => ({
            local_file: row.local_file,
            attempts: row.attempts,
            last_attempt_at: row.last_attempt_at,
            errors: row.errors ?? [],
          })),
          runs,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const settings = getSettings().footage_index;

  console.log(`\nfootage library — ${verdictFor(report)}\n`);
  console.log(`  cache files      ${report.files.count} (${formatBytes(report.files.bytes)})`);
  console.log(
    `  mongo rows       ${report.rows.total} total: ${report.rows.current} current, ` +
      `${report.rows.indexed} indexed, ${report.rows.stale} stale, ${report.rows.failed} failed`,
  );
  console.log(
    `  qdrant           ${report.qdrant.ok ? "ok" : "UNREACHABLE"} at ${report.qdrant.url}` +
      `${report.qdrant.version ? ` (v${report.qdrant.version})` : ""}` +
      `${report.qdrant.detail ? ` — ${report.qdrant.detail}` : ""}`,
  );
  console.log(`  collection       ${report.qdrant.collection} (alias ${report.qdrant.alias})`);
  console.log(`  points           ${report.qdrant.points ?? "unknown"}`);
  if (report.drift) {
    console.log(
      `  drift            ${report.drift.orphan_points} orphan point(s), ` +
        `${report.drift.missing_points} file(s) with no point`,
    );
  } else {
    console.log("  drift            unknown (qdrant did not answer)");
  }
  console.log(`  lock             ${formatLock(report.lock)}`);
  console.log(
    `  config           enabled=${settings.enabled}, auto_index=${settings.auto_index}, ` +
      `describe=${settings.describe_model}, embed=${settings.embed_model}`,
  );

  if (failures.length > 0) {
    console.log(`\nfailed clips (most recent ${failures.length}):`);
    for (const row of failures) {
      const last = row.errors?.[row.errors.length - 1];
      console.log(
        `  ${row.local_file}  attempts=${row.attempts}` +
          `${row.last_attempt_at ? `  last=${new Date(row.last_attempt_at).toISOString()}` : ""}`,
      );
      if (last) console.log(`      ${last.at ? `${new Date(last.at).toISOString()}  ` : ""}${last.message}`);
    }
  }

  if (runs.length > 0) {
    console.log(`\nrecent pull runs (${runs.length}):`);
    for (const run of runs) {
      console.log(
        `  ${run.started_at.toISOString()}  ${run.finished_at ? run.stop_reason ?? "finished" : "IN FLIGHT / KILLED"}  ` +
          `added=${run.clips_added}, failed=${run.clips_failed}, ` +
          `bytes=${formatBytes(run.bytes_written)}, terms=${run.per_term.length}`,
      );
      // A term that was throttled explains a thin library far better than the
      // clip count does, so it is surfaced rather than left in the document.
      const throttled = run.per_term.filter((term) => term.last_status === 429);
      if (throttled.length > 0) {
        console.log(`      ${throttled.length} term/aspect pair(s) rate-limited (429)`);
      }
    }
  }

  console.log();
  return 0;
}

async function commandPull(argv: string[], waitMs: number): Promise<number> {
  // `parsePullArgs` owns every pull flag and throws on an unknown one, so the
  // flag names live in exactly one place. It throws plain `Error`s, which are
  // usage errors here and are re-labelled so they exit 2 with everything else.
  let options;
  try {
    options = parsePullArgs(argv);
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }

  const result = await withLock(
    async (lock) => pullFootage({ ...options, signal: lock.signal }),
    { label: "footage pull", waitMs },
  );

  if (result.dryRun) {
    console.log(formatDryRun(result));
    return 0;
  }

  console.log(
    `\nfootage pull: stop_reason=${result.stopReason}, added=${result.clipsAdded}, ` +
      `failed=${result.clipsFailed}, already_cached=${result.clipsSkippedExisting}, ` +
      `written=${formatBytes(result.bytesWritten)}, run=${result.runId ?? "(none)"}`,
  );
  console.log("Next: `bun run --cwd server footage index`\n");

  // A pull that stopped on the budget or the disk floor did what it was asked
  // within its limits; only a genuine error is a failed command.
  return result.stopReason === "error" ? 1 : 0;
}

async function commandIndex(argv: string[], waitMs: number): Promise<number> {
  const json = takeFlag(argv, "--json");
  const files = takeValues(argv, "--file");
  const options = takeIndexOptions(argv);
  rejectLeftovers(argv);

  // --- one or more named clips ---------------------------------------------
  if (files.length > 0) {
    const results = await withLock(
      async (lock) => {
        const collected = [];
        for (const file of files) {
          collected.push(await indexOne(file, { ...options, signal: lock.signal }));
        }
        return collected;
      },
      { label: "footage index", waitMs },
    );

    if (json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      for (const result of results) {
        console.log(
          `${result.outcome.padEnd(9)} ${result.local_file}  ` +
            `described=${result.described}, embedded=${result.embedded}, ` +
            `${(result.elapsed_ms / 1000).toFixed(1)}s` +
            `${result.reason ? `  (${result.reason})` : ""}`,
        );
      }
    }
    return results.some((result) => result.outcome === "failed") ? 1 : 0;
  }

  // --- the whole cache directory -------------------------------------------
  const result = await withLock(
    async (lock) => indexAll({ ...options, signal: lock.signal }),
    { label: "footage index", waitMs },
  );

  if (json) console.log(JSON.stringify(result, null, 2));
  else printRun("footage index", result);

  return exitCodeFor(result);
}

async function commandReconcile(argv: string[], waitMs: number): Promise<number> {
  const json = takeFlag(argv, "--json");
  const options = takeIndexOptions(argv);
  rejectLeftovers(argv);

  const result = await withLock(
    async (lock) => reconcile({ ...options, signal: lock.signal }),
    { label: "footage reconcile", waitMs },
  );

  if (json) console.log(JSON.stringify(result, null, 2));
  else printRun("footage reconcile", result);

  return exitCodeFor(result);
}

/**
 * Read-only, so it deliberately does not take the lock: refusing to answer a
 * question because an unrelated indexing run is in flight would make the one
 * command that proves the index works unusable exactly when it matters.
 */
async function commandSearch(argv: string[]): Promise<number> {
  const json = takeFlag(argv, "--json");
  const limit = positiveInt(takeValue(argv, "--limit"), "--limit") ?? 10;
  const aspect = takeValue(argv, "--aspect");

  const query = argv.filter((arg) => !arg.startsWith("--")).join(" ").trim();
  const leftovers = argv.filter((arg) => arg.startsWith("--"));
  rejectLeftovers(leftovers);

  if (!query) {
    console.error("error: search needs a query\n");
    return 2;
  }

  const filter = aspect ? { must: [{ key: "aspect", match: { value: aspect } }] } : undefined;
  const matches = await searchFootage(query, limit, filter);

  if (json) {
    console.log(JSON.stringify(matches, null, 2));
    return 0;
  }

  if (matches.length === 0) {
    console.log(`no matches for ${JSON.stringify(query)}`);
    return 0;
  }

  console.log(`\n${matches.length} match(es) for ${JSON.stringify(query)}:\n`);
  for (const [position, match] of matches.entries()) {
    const payload = match.payload;
    console.log(
      `${String(position + 1).padStart(2)}. ${match.score.toFixed(4)}  ${payload?.local_file ?? match.id}` +
        `${payload?.aspect ? `  [${payload.aspect}]` : ""}` +
        `${payload?.duration ? ` ${payload.duration}s` : ""}`,
    );
    if (payload?.summary) console.log(`     ${payload.summary}`);
    if (payload?.tags?.length) console.log(`     tags: ${payload.tags.slice(0, 8).join(", ")}`);
  }
  console.log();
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const argv = Bun.argv.slice(2);

  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return argv.length === 0 ? 2 : 0;
  }
  if (argv.includes("-v") || argv.includes("--version")) {
    console.log(`${PROJECT_NAME} v${APP_VERSION}`);
    return 0;
  }

  const command = argv[0]!;
  const rest = argv.slice(1);

  if (command.startsWith("-")) {
    console.error(`error: expected a command, got ${JSON.stringify(command)}\n`);
    console.error(HELP);
    return 2;
  }

  const waitMs = positiveInt(takeValue(rest, "--wait"), "--wait") ?? 0;
  const forceUnlock = takeFlag(rest, "--force-unlock");

  // `logger` writes INFO and SUCCESS to stdout, which would sit in the middle
  // of the document `--json` exists to make pipeable. Warnings and errors are
  // already on stderr, so they survive. Detected without consuming the flag —
  // the command handlers still read it.
  if (rest.includes("--json")) setLogLevel("WARNING");

  // Every command below needs settings out of Mongo, so the connection is
  // opened before the switch rather than per-branch.
  await connect();
  await initSettings();

  if (forceUnlock) {
    const before = await isLocked();
    const released = await forceReleaseLock();
    console.log(
      released
        ? `released the footage lock (${formatLock(before)})`
        : "the footage lock was already free",
    );
    return 0;
  }

  switch (command) {
    case "status":
      return await commandStatus(rest);
    case "pull":
      return await commandPull(rest, waitMs);
    case "index":
      return await commandIndex(rest, waitMs);
    case "reconcile":
      return await commandReconcile(rest, waitMs);
    case "search":
      return await commandSearch(rest);
    default:
      console.error(`error: unknown command ${JSON.stringify(command)}\n`);
      console.error(HELP);
      return 2;
  }
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`error: ${error.message}\n`);
    console.error(HELP);
    exitCode = 2;
  } else if (error instanceof FootageLockedError) {
    // Its own exit code: "someone else is indexing" is a retry-later, not the
    // same class of event as a clip that will not describe.
    console.error(`error: ${error.message}`);
    exitCode = 3;
  } else {
    console.error(`error: ${errorMessage(error)}`);
    logger.debug(`footage cli failed: ${errorMessage(error)}`);
    exitCode = 1;
  }
} finally {
  await disconnect().catch(() => {});
}
process.exit(exitCode);
