/**
 * Small leveled logger standing in for loguru.
 *
 * Kept dependency-free on purpose: the server writes to stdout only, and the
 * WebUI reads per-task logs from the task record rather than from this stream.
 */

const LEVELS = ["DEBUG", "INFO", "SUCCESS", "WARNING", "ERROR"] as const;
export type LogLevel = (typeof LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  SUCCESS: 25,
  WARNING: 30,
  ERROR: 40,
};

const COLORS: Record<LogLevel, string> = {
  DEBUG: "\x1b[36m",
  INFO: "\x1b[34m",
  SUCCESS: "\x1b[32m",
  WARNING: "\x1b[33m",
  ERROR: "\x1b[31m",
};
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function resolveThreshold(): number {
  const configured = String(process.env.LOG_LEVEL ?? "INFO").toUpperCase();
  // Accept loguru's WARN alias so an existing config.toml log_level keeps working.
  const normalized = configured === "WARN" ? "WARNING" : configured;
  return LEVEL_RANK[normalized as LogLevel] ?? LEVEL_RANK.INFO;
}

let threshold = resolveThreshold();
const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

export function setLogLevel(level: string): void {
  const normalized = String(level).toUpperCase();
  threshold = LEVEL_RANK[normalized as LogLevel] ?? threshold;
}

function timestamp(): string {
  const now = new Date();
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.` +
    `${pad(now.getMilliseconds(), 3)}`
  );
}

function emit(level: LogLevel, args: unknown[]): void {
  if (LEVEL_RANK[level] < threshold) return;

  const parts = args.map((arg) => {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ""}`;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  });

  const label = level.padEnd(7);
  const line = useColor
    ? `${DIM}${timestamp()}${RESET} ${COLORS[level]}${label}${RESET} ${parts.join(" ")}`
    : `${timestamp()} ${label} ${parts.join(" ")}`;

  if (level === "ERROR" || level === "WARNING") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (...args: unknown[]) => emit("DEBUG", args),
  info: (...args: unknown[]) => emit("INFO", args),
  success: (...args: unknown[]) => emit("SUCCESS", args),
  warning: (...args: unknown[]) => emit("WARNING", args),
  warn: (...args: unknown[]) => emit("WARNING", args),
  error: (...args: unknown[]) => emit("ERROR", args),
  /** Logs an error together with its stack, mirroring `logger.exception`. */
  exception: (message: string, error: unknown) => {
    const detail =
      error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
    emit("ERROR", [`${message}\n${detail}`]);
  },
};

/** Reduces an unknown thrown value to a readable message. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Reduces an unknown thrown value to its type name, for structured log fields. */
export function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}
