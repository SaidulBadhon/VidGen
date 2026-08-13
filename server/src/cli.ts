#!/usr/bin/env bun
/**
 * Command-line interface.
 * Ported from python-version/cli.py.
 *
 * Runs the pipeline in-process rather than through the HTTP API, so a single
 * `bun run cli` produces a video with no server running.
 */

import { parseArgs } from "node:util";
import { connect, disconnect } from "./db/client.ts";
import { initSettings } from "./config/settings.ts";
import { STOP_AT_STAGES, TASK_STATE_FAILED, type StopAt } from "./models/const.ts";
import { videoParamsSchema } from "./models/schema.ts";
import { runPipeline } from "./tasks/pipeline.ts";
import { createTask } from "./tasks/state.ts";
import { logger, errorMessage } from "./utils/logger.ts";
import { getUuid } from "./utils/misc.ts";
import { taskDir } from "./utils/paths.ts";
import { APP_VERSION, PROJECT_NAME } from "./version.ts";

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },

  "task-id": { type: "string" },
  "stop-at": { type: "string" },

  "video-subject": { type: "string" },
  "video-script": { type: "string" },
  "video-terms": { type: "string" },
  "video-language": { type: "string" },
  "video-source": { type: "string" },
  "video-materials": { type: "string", multiple: true },
  "video-aspect": { type: "string" },
  "video-concat-mode": { type: "string" },
  "video-transition-mode": { type: "string" },
  "video-clip-duration": { type: "string" },
  "video-clip-speed": { type: "string" },
  "video-count": { type: "string" },
  "match-materials-to-script": { type: "boolean" },

  "voice-name": { type: "string" },
  "voice-volume": { type: "string" },
  "voice-rate": { type: "string" },
  "custom-audio-file": { type: "string" },

  "bgm-type": { type: "string" },
  "bgm-file": { type: "string" },
  "bgm-volume": { type: "string" },
  "video-music-prompt": { type: "string" },
  "sonilo-bgm-prompt": { type: "string" },

  "subtitle-enabled": { type: "boolean" },
  "no-subtitle-enabled": { type: "boolean" },
  "subtitle-position": { type: "string" },
  "custom-position": { type: "string" },
  "font-name": { type: "string" },
  "font-size": { type: "string" },
  "text-fore-color": { type: "string" },
  "subtitle-background-enabled": { type: "boolean" },
  "no-subtitle-background-enabled": { type: "boolean" },
  "subtitle-background-color": { type: "string" },
  "rounded-subtitle-background": { type: "boolean" },
  "stroke-color": { type: "string" },
  "stroke-width": { type: "string" },

  "paragraph-number": { type: "string" },
  "video-script-prompt": { type: "string" },
  "custom-system-prompt": { type: "string" },
  "n-threads": { type: "string" },
} as const;

const HELP = `${PROJECT_NAME} v${APP_VERSION}

Usage:
  bun run cli --video-subject "How AI is changing everyday life"
  bun run cli --video-script "..." --video-source local --video-materials clip.mp4

Script
  --video-subject TEXT           Topic the AI writes the script from
  --video-script TEXT            Use this script verbatim instead of generating one
  --video-terms TEXT             Comma-separated stock search terms
  --video-language CODE          Script language; empty auto-detects
  --paragraph-number N           Paragraphs to generate (1-10)
  --video-script-prompt TEXT     Extra requirements for the script
  --custom-system-prompt TEXT    Replace the default system prompt

Video
  --video-source NAME            pexels | pixabay | coverr | local
  --video-materials PATH         Local material (repeatable, implies --video-source local)
  --video-aspect RATIO           9:16 | 16:9 | 1:1
  --video-concat-mode MODE       random | sequential
  --video-transition-mode MODE   Shuffle|FadeIn|FadeOut|SlideIn|SlideOut|ZoomIn|ZoomOut
  --video-clip-duration SECONDS  Max seconds per clip
  --video-clip-speed FACTOR      Playback speed, 0.5-2.0
  --video-count N                Number of videos to render
  --match-materials-to-script    Order materials to follow the narration
  --n-threads N                  ffmpeg threads

Audio
  --voice-name NAME              TTS voice, or "no-voice" for silence
  --voice-volume FLOAT           Narration volume
  --voice-rate FLOAT             Narration speed
  --custom-audio-file PATH       Use this audio instead of TTS
  --bgm-type TYPE                "" | random | custom | sonilo | elevenlabs
  --bgm-file NAME                Track name when --bgm-type custom
  --bgm-volume FLOAT             Music volume
  --video-music-prompt TEXT      Prompt for AI-generated music

Subtitles
  --subtitle-enabled / --no-subtitle-enabled
  --subtitle-position POS        top | center | bottom | custom
  --custom-position PERCENT      Vertical position when POS is custom
  --font-name FILE               Font from resource/fonts
  --font-size N
  --text-fore-color HEX
  --subtitle-background-enabled / --no-subtitle-background-enabled
  --subtitle-background-color HEX
  --rounded-subtitle-background
  --stroke-color HEX
  --stroke-width FLOAT

Other
  --task-id ID                   Reuse a specific task id
  --stop-at STAGE                ${STOP_AT_STAGES.join(" | ")}
  -h, --help                     Show this help
  -v, --version                  Show the version
`;

function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function main(): Promise<number> {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({ args: Bun.argv.slice(2), options: OPTIONS, allowPositionals: false }));
  } catch (error) {
    console.error(`error: ${errorMessage(error)}\n`);
    console.error(HELP);
    return 2;
  }

  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(`${PROJECT_NAME} v${APP_VERSION}`);
    return 0;
  }

  const subject = values["video-subject"] as string | undefined;
  const script = values["video-script"] as string | undefined;
  if (!subject && !script) {
    console.error("error: one of --video-subject or --video-script is required\n");
    console.error(HELP);
    return 2;
  }

  const stopAt = (values["stop-at"] as string | undefined) ?? "video";
  if (!(STOP_AT_STAGES as readonly string[]).includes(stopAt)) {
    console.error(`error: --stop-at must be one of ${STOP_AT_STAGES.join(", ")}`);
    return 2;
  }

  const materials = (values["video-materials"] as string[] | undefined) ?? [];

  // Subtitle background is expressed as two flags in the CLI but as a single
  // overloaded field in the schema, so it is resolved here.
  const backgroundEnabled = values["subtitle-background-enabled"]
    ? true
    : values["no-subtitle-background-enabled"]
      ? false
      : undefined;
  const backgroundColor = values["subtitle-background-color"] as string | undefined;

  const params = videoParamsSchema.parse({
    video_subject: subject ?? "",
    video_script: script ?? "",
    ...(values["video-terms"] ? { video_terms: values["video-terms"] } : {}),
    ...(values["video-language"] ? { video_language: values["video-language"] } : {}),
    // Passing materials only makes sense with the local source, so it is implied.
    video_source: materials.length > 0 ? "local" : ((values["video-source"] as string) ?? "pexels"),
    ...(materials.length > 0 ? { video_materials: materials.map((url) => ({ url })) } : {}),
    ...(values["video-aspect"] ? { video_aspect: values["video-aspect"] } : {}),
    ...(values["video-concat-mode"] ? { video_concat_mode: values["video-concat-mode"] } : {}),
    ...(values["video-transition-mode"] ? { video_transition_mode: values["video-transition-mode"] } : {}),
    ...(num(values["video-clip-duration"] as string) !== undefined
      ? { video_clip_duration: num(values["video-clip-duration"] as string) }
      : {}),
    ...(num(values["video-clip-speed"] as string) !== undefined
      ? { video_clip_speed: num(values["video-clip-speed"] as string) }
      : {}),
    ...(num(values["video-count"] as string) !== undefined ? { video_count: num(values["video-count"] as string) } : {}),
    ...(values["match-materials-to-script"] ? { match_materials_to_script: true } : {}),

    ...(values["voice-name"] ? { voice_name: values["voice-name"] } : {}),
    ...(num(values["voice-volume"] as string) !== undefined ? { voice_volume: num(values["voice-volume"] as string) } : {}),
    ...(num(values["voice-rate"] as string) !== undefined ? { voice_rate: num(values["voice-rate"] as string) } : {}),
    ...(values["custom-audio-file"] ? { custom_audio_file: values["custom-audio-file"] } : {}),

    ...(values["bgm-type"] !== undefined ? { bgm_type: values["bgm-type"] } : {}),
    ...(values["bgm-file"] ? { bgm_file: values["bgm-file"] } : {}),
    ...(num(values["bgm-volume"] as string) !== undefined ? { bgm_volume: num(values["bgm-volume"] as string) } : {}),
    ...(values["video-music-prompt"] ? { video_music_prompt: values["video-music-prompt"] } : {}),
    ...(values["sonilo-bgm-prompt"] ? { sonilo_bgm_prompt: values["sonilo-bgm-prompt"] } : {}),

    ...(values["no-subtitle-enabled"] ? { subtitle_enabled: false } : {}),
    ...(values["subtitle-enabled"] ? { subtitle_enabled: true } : {}),
    ...(values["subtitle-position"] ? { subtitle_position: values["subtitle-position"] } : {}),
    ...(num(values["custom-position"] as string) !== undefined
      ? { custom_position: num(values["custom-position"] as string) }
      : {}),
    ...(values["font-name"] ? { font_name: values["font-name"] } : {}),
    ...(num(values["font-size"] as string) !== undefined ? { font_size: num(values["font-size"] as string) } : {}),
    ...(values["text-fore-color"] ? { text_fore_color: values["text-fore-color"] } : {}),
    ...(backgroundEnabled === false
      ? { text_background_color: false }
      : backgroundEnabled === true || backgroundColor
        ? { text_background_color: backgroundColor ?? "#000000" }
        : {}),
    ...(values["rounded-subtitle-background"] ? { rounded_subtitle_background: true } : {}),
    ...(values["stroke-color"] ? { stroke_color: values["stroke-color"] } : {}),
    ...(num(values["stroke-width"] as string) !== undefined
      ? { stroke_width: num(values["stroke-width"] as string) }
      : {}),

    ...(num(values["paragraph-number"] as string) !== undefined
      ? { paragraph_number: num(values["paragraph-number"] as string) }
      : {}),
    ...(values["video-script-prompt"] ? { video_script_prompt: values["video-script-prompt"] } : {}),
    ...(values["custom-system-prompt"] ? { custom_system_prompt: values["custom-system-prompt"] } : {}),
    ...(num(values["n-threads"] as string) !== undefined ? { n_threads: num(values["n-threads"] as string) } : {}),
  });

  await connect();
  await initSettings();

  const taskId = (values["task-id"] as string | undefined) ?? getUuid();
  await createTask(taskId, { params, stop_at: stopAt as StopAt });

  logger.info(`task ${taskId} starting (stop_at: ${stopAt})`);
  const result = await runPipeline({ taskId, params, stopAt: stopAt as StopAt });

  if (result.state === TASK_STATE_FAILED) {
    logger.error(`task failed at ${result.failed_stage}: ${result.error}`);
    return 1;
  }

  logger.success(`task ${taskId} complete`);
  console.log(`\nOutput directory: ${taskDir(taskId)}`);
  for (const video of result.videos ?? []) console.log(`  video:    ${video}`);
  if (result.subtitle_path) console.log(`  subtitle: ${result.subtitle_path}`);
  if (result.audio_file) console.log(`  audio:    ${result.audio_file}`);

  return 0;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  logger.exception("cli failed", error);
} finally {
  await disconnect().catch(() => {});
}
process.exit(exitCode);
