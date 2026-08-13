/**
 * SRT reading and writing.
 * Ported from `file_to_subtitles` / `text_to_srt` in the Python version.
 */

import { existsSync } from "node:fs";
import { parseSrtTimestamp, timeConvertSecondsToHmsm } from "../../utils/text.ts";

export interface SubtitleCue {
  index: number;
  /** Seconds from the start of the video. */
  start: number;
  end: number;
  text: string;
}

const TIME_LINE = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;

/**
 * Parses an SRT file into cues.
 *
 * Blocks are separated by blank lines, but a file whose last cue has no
 * trailing blank line is common in the wild — the final block is flushed
 * explicitly so it is never silently dropped.
 */
export function parseSrtContent(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let currentTimes: RegExpExecArray | null = null;
  let currentText = "";

  const flush = () => {
    if (!currentTimes) return;
    const text = currentText.trim();
    cues.push({
      index: cues.length + 1,
      start: parseSrtTimestamp(currentTimes[1]!),
      end: parseSrtTimestamp(currentTimes[2]!),
      text,
    });
    currentTimes = null;
    currentText = "";
  };

  for (const line of content.split(/\r?\n/)) {
    const times = TIME_LINE.exec(line);
    if (times) {
      // A new timing line without an intervening blank line still starts a cue.
      if (currentTimes) flush();
      currentTimes = times;
    } else if (line.trim() === "" && currentTimes) {
      flush();
    } else if (currentTimes) {
      currentText += (currentText ? "\n" : "") + line;
    }
  }
  flush();

  return cues.filter((cue) => cue.text.length > 0);
}

export async function readSrtFile(filePath: string): Promise<SubtitleCue[]> {
  if (!filePath || !existsSync(filePath)) return [];
  const content = await Bun.file(filePath).text();
  return parseSrtContent(content);
}

export function formatSrt(cues: SubtitleCue[]): string {
  return (
    cues
      .map(
        (cue, position) =>
          `${position + 1}\n` +
          `${timeConvertSecondsToHmsm(cue.start)} --> ${timeConvertSecondsToHmsm(cue.end)}\n` +
          `${cue.text}\n`,
      )
      .join("\n") + "\n"
  );
}

export async function writeSrtFile(filePath: string, cues: SubtitleCue[]): Promise<void> {
  await Bun.write(filePath, formatSrt(cues));
}
