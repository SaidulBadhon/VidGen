/**
 * Media inspection via ffprobe.
 *
 * The Python version read these values by opening a MoviePy clip, which meant
 * spawning a decoder just to learn a duration. ffprobe answers from the
 * container metadata instead, which is both faster and does not leak readers.
 */

import { runFfprobe } from "./ffmpeg.ts";
import { logger } from "../../utils/logger.ts";
import { errorMessage } from "../../utils/logger.ts";

export interface MediaInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** Sample rate of the first audio stream, 0 when there is none. */
  audioSampleRate: number;
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  sample_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

function parseFrameRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [numerator, denominator] = rate.split("/");
  const n = Number(numerator);
  const d = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  return n / d;
}

/**
 * How long ffprobe may run before it is killed.
 *
 * `runFfprobe` only arms its kill timer when a timeout is supplied
 * (`ffmpeg.ts`), so without this a probe of a corrupt or truncated file could
 * block forever — and because probes run inside the render's bounded worker
 * pool, one stuck process holds its slot for the life of the server. Reading
 * container metadata is a sub-second operation even for a long audiobook
 * master, so a minute is far past "slow" and safely inside "hung".
 */
const PROBE_TIMEOUT_MS = 60_000;

export async function probe(filePath: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<MediaInfo> {
  const { stdout } = await runFfprobe(
    ["-print_format", "json", "-show_format", "-show_streams", filePath],
    { timeoutMs },
  );

  const parsed = JSON.parse(stdout) as FfprobeOutput;
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");

  // Container duration is the reliable value; a stream duration is a fallback
  // for formats that omit it at the container level.
  const duration =
    Number(parsed.format?.duration) || Number(video?.duration) || Number(audio?.duration) || 0;

  return {
    duration: Number.isFinite(duration) ? duration : 0,
    width: Number(video?.width) || 0,
    height: Number(video?.height) || 0,
    fps: parseFrameRate(video?.r_frame_rate) || parseFrameRate(video?.avg_frame_rate) || 0,
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
    audioSampleRate: Number(audio?.sample_rate) || 0,
  };
}

/** Duration in seconds, or 0 when the file cannot be read. */
export async function getDuration(filePath: string): Promise<number> {
  try {
    const info = await probe(filePath);
    return info.duration;
  } catch (error) {
    logger.warning(`failed to probe duration: ${filePath}, error: ${errorMessage(error)}`);
    return 0;
  }
}

/**
 * Confirms a downloaded material is actually playable.
 *
 * Providers occasionally return truncated files or an HTML error page with a
 * .mp4 name; both decode to nothing and would fail much later during render.
 */
export async function isValidVideo(filePath: string): Promise<boolean> {
  try {
    const info = await probe(filePath);
    return info.hasVideo && info.duration > 0 && info.fps > 0;
  } catch {
    return false;
  }
}
