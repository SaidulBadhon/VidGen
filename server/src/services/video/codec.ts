/**
 * Video encoder selection with automatic fallback.
 * Ported from python-version/app/services/video.py.
 *
 * Hardware encoders depend on the GPU, the driver and the ffmpeg build, none of
 * which can be settled from configuration alone. A generation must never fail
 * because an optional encoder is unavailable, so every failure degrades to
 * libx264 and the bad encoder is remembered for the rest of the process.
 */

import { appConfig } from "../../config/settings.ts";
import { logger } from "../../utils/logger.ts";
import { errorMessage } from "../../utils/logger.ts";
import { runFfmpegRaw } from "./ffmpeg.ts";

export const DEFAULT_VIDEO_CODEC = "libx264";

export const SUPPORTED_VIDEO_CODECS = [
  "libx264",
  "h264_nvenc",
  "h264_amf",
  "h264_qsv",
  "h264_mf",
  "h264_videotoolbox",
] as const;

export type VideoCodec = (typeof SUPPORTED_VIDEO_CODECS)[number];

const runtimeDisabledCodecs = new Set<string>();
const encoderProbeCache = new Map<string, boolean>();

/**
 * Reads the configured encoder.
 *
 * Deliberately a fixed whitelist rather than free-form ffmpeg arguments: an
 * arbitrary value would make the output format unpredictable and could fail
 * only at the very last stage of a long render.
 */
export function getConfiguredVideoCodec(): string {
  const configured = String(appConfig().video_codec ?? "").trim();
  if (!configured) return DEFAULT_VIDEO_CODEC;

  if (!(SUPPORTED_VIDEO_CODECS as readonly string[]).includes(configured)) {
    logger.warning(`unsupported video codec configured: ${configured}, fallback to ${DEFAULT_VIDEO_CODEC}`);
    return DEFAULT_VIDEO_CODEC;
  }
  return configured;
}

/**
 * Whether this ffmpeg build declares the encoder.
 *
 * Proves only that ffmpeg was compiled with it, never that the local hardware
 * and driver will accept it — which is why encode failures still fall back.
 */
async function ffmpegEncoderExists(codec: string): Promise<boolean> {
  const cached = encoderProbeCache.get(codec);
  if (cached !== undefined) return cached;

  let available = false;
  try {
    const { stdout } = await runFfmpegRaw(["-encoders"], { timeoutMs: 10_000 });
    available = stdout.includes(codec);
  } catch (error) {
    logger.warning(
      `failed to inspect ffmpeg encoders, fallback to ${DEFAULT_VIDEO_CODEC}: ${errorMessage(error)}`,
    );
    available = false;
  }

  encoderProbeCache.set(codec, available);
  return available;
}

/** Resolves the encoder to use for this run, after availability checks. */
export async function getEffectiveVideoCodec(preferredCodec?: string): Promise<string> {
  const selected = preferredCodec || getConfiguredVideoCodec();
  if (selected === DEFAULT_VIDEO_CODEC) return DEFAULT_VIDEO_CODEC;

  if (runtimeDisabledCodecs.has(selected)) {
    logger.warning(
      `video codec ${selected} was disabled after a runtime failure, fallback to ${DEFAULT_VIDEO_CODEC}`,
    );
    return DEFAULT_VIDEO_CODEC;
  }

  if (!(await ffmpegEncoderExists(selected))) {
    logger.warning(`ffmpeg encoder ${selected} is not available, fallback to ${DEFAULT_VIDEO_CODEC}`);
    return DEFAULT_VIDEO_CODEC;
  }

  return selected;
}

export function disableRuntimeVideoCodec(codec: string, reason: string): void {
  if (codec === DEFAULT_VIDEO_CODEC) return;
  runtimeDisabledCodecs.add(codec);
  logger.warning(`video codec ${codec} failed, fallback to ${DEFAULT_VIDEO_CODEC}. reason: ${reason}`);
}

/**
 * Runs an encode with the preferred codec and retries once with libx264.
 *
 * The retry is what decides whether the encoder was really at fault: a failure
 * from a locked output file or a permissions problem fails on libx264 too, and
 * in that case the codec stays enabled so later tasks are not penalised.
 */
export async function encodeWithCodecFallback(
  build: (codec: string) => string[],
  runner: (args: string[]) => Promise<unknown>,
  preferredCodec?: string,
): Promise<string> {
  const effective = await getEffectiveVideoCodec(preferredCodec);

  try {
    await runner(build(effective));
    return effective;
  } catch (error) {
    if (effective === DEFAULT_VIDEO_CODEC) throw error;

    const reason = errorMessage(error);
    await runner(build(DEFAULT_VIDEO_CODEC));
    disableRuntimeVideoCodec(effective, reason);
    return DEFAULT_VIDEO_CODEC;
  }
}

/** Encoder-specific quality flags, since the hardware ones reject `-crf`. */
export function codecQualityArgs(codec: string): string[] {
  if (codec === "libx264") return ["-preset", "medium", "-crf", "23"];
  if (codec === "h264_videotoolbox") return ["-b:v", "6M"];
  if (codec === "h264_nvenc") return ["-preset", "p4", "-cq", "23"];
  if (codec === "h264_qsv") return ["-global_quality", "23"];
  if (codec === "h264_amf") return ["-quality", "balanced", "-rc", "cqp", "-qp_i", "23", "-qp_p", "23"];
  return [];
}

/** Test seam. */
export function __resetCodecStateForTest(): void {
  runtimeDisabledCodecs.clear();
  encoderProbeCache.clear();
}
