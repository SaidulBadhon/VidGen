#!/bin/bash
#
# Periodic footage indexing.
#
# Clips downloaded during a render get a provenance row but no description and
# no vector — the download hook records where a clip came from, it does not
# describe it. Until an index pass runs, a fallback clip is saved but NOT
# searchable, so "the next render can reuse it" is only true if something runs
# this. Nothing in the app does: `indexAll` deliberately does not take its own
# writer lock, and only the CLI wraps it.
#
# Safe to fire while a run is already in progress: the CLI takes the footage
# index lock and exits 3 without doing anything, so overlapping cron ticks
# coalesce instead of racing.
#
# Install:   crontab -l 2>/dev/null | { cat; echo "0 * * * * /Users/saidulbadhon/Documents/GitHub/VidGen/scripts/footage-index-cron.sh"; } | crontab -
# Remove:    crontab -e   (delete the line)
# Watch:     tail -f storage/logs/footage-index.log

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$REPO/storage/logs"
LOG="$LOG_DIR/footage-index.log"
MAX_LOG_BYTES=$((5 * 1024 * 1024))

# cron runs with a minimal PATH that will not contain bun.
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

mkdir -p "$LOG_DIR"

# Keep one previous log rather than growing without bound.
if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt "$MAX_LOG_BYTES" ]; then
  mv -f "$LOG" "$LOG.1"
fi

stamp() { date "+%Y-%m-%d %H:%M:%S"; }

if ! command -v bun >/dev/null 2>&1; then
  echo "$(stamp) ERROR bun not found on PATH; cannot index" >> "$LOG"
  exit 1
fi

cd "$REPO" || { echo "$(stamp) ERROR cannot cd to $REPO" >> "$LOG"; exit 1; }

output="$(bun run --cwd server footage index --json 2>&1)"
status=$?

# `--json` prints a run result object. Summarised with shell rather than a
# parser: the fields are flat integers, and a log line must never be the thing
# that fails.
field() { printf '%s' "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*[0-9]*" | head -1 | grep -o '[0-9]*$'; }

summarise() {
  local j="$1" scanned indexed refreshed skipped failed described ms
  scanned=$(field "$j" scanned);     indexed=$(field "$j" indexed)
  refreshed=$(field "$j" refreshed); skipped=$(field "$j" skipped)
  failed=$(field "$j" failed);       described=$(field "$j" described)
  ms=$(field "$j" elapsed_ms)
  if [ -z "$scanned" ]; then echo "completed"; return; fi
  echo "scanned=$scanned indexed=${indexed:-0} refreshed=${refreshed:-0} skipped=${skipped:-0} failed=${failed:-0} describes=${described:-0} ${ms:-0}ms"
}

case "$status" in
  0) echo "$(stamp) ok $(summarise "$output")" >> "$LOG" ;;
  3) echo "$(stamp) skipped: an index run is already in progress" >> "$LOG" ;;
  *) echo "$(stamp) FAILED (exit $status)" >> "$LOG"
     echo "$output" | tail -20 >> "$LOG" ;;
esac

exit 0
