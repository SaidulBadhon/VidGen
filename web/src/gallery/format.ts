/**
 * Value formatters for the footage gallery.
 *
 * Kept out of the components so the grid tile and the detail panel render a
 * duration or a file size the same way, and so none of it needs a translation
 * key: these produce digits and international unit symbols, never sentences.
 */

/** `0:21`, `1:05`. Clip durations are seconds with a fractional tail. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

/** `4.0 MB`, `1.2 GB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const megabytes = bytes / 1024 / 1024;
  if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(2)} GB`;
  return `${megabytes.toFixed(1)} MB`;
}

/** `1920 × 1080`. */
export function formatDimensions(width: number, height: number): string {
  if (!width || !height) return "—";
  return `${width} × ${height}`;
}

/**
 * Relevance as two decimals.
 *
 * Deliberately not a percentage: these are cosine similarities from the
 * embedding model, and dressing 0.83 up as "83%" implies a confidence scale
 * the number does not carry.
 */
export function formatScore(score: number): string {
  return score.toFixed(2);
}

/** Local date and time, or an em dash when the timestamp is missing or unparseable. */
export function formatTimestamp(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
