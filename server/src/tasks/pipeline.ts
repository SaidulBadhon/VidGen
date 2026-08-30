/**
 * The generation pipeline: script → terms → audio → subtitles → materials → video.
 * Ported from python-version/app/services/task.py.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { appConfig, resolveContentLanguage, resolveVoiceName } from "../config/settings.ts";
import {
  CROSS_POST_STATE_FAILED,
  CROSS_POST_STATE_PENDING,
  TASK_STATE_COMPLETE,
  TASK_STATE_FAILED,
  TASK_STATE_PROCESSING,
  type StopAt,
} from "../models/const.ts";
import {
  VideoConcatMode,
  normalizeVideoTerms,
  type VideoAspectValue,
  type VideoParams,
} from "../models/schema.ts";
import { logger, errorMessage } from "../utils/logger.ts";
import { resolvePathWithinDirectory } from "../utils/fileSecurity.ts";
import { rootDir, taskDir } from "../utils/paths.ts";
import * as llm from "../services/llm/index.ts";
import * as twelvelabs from "../services/twelvelabs.ts";
import * as voice from "../services/voice/index.ts";
import * as uploadPost from "../services/uploadPost.ts";
import * as sonilo from "../services/music/sonilo.ts";
import * as elevenlabsMusic from "../services/music/elevenlabsMusic.ts";
import { getBgmFile, shouldUseBgm } from "../services/bgm.ts";
import { generateSubtitle } from "../services/subtitle/index.ts";
import { matchScenes, sceneFootageOptions, isCancellation, type SceneCue } from "../services/footage/sceneMatch.ts";
import { resolveSceneFallback } from "../services/footage/sceneFallback.ts";
import { downloadVideos } from "../services/material/download.ts";
import { preprocessVideos } from "../services/video/preprocess.ts";
import { combineVideos } from "../services/video/combine.ts";
import { generateVideo } from "../services/video/generate.ts";
import { writeScriptData } from "../services/taskArtifacts.ts";
import { BOOK_SHORT_REQUEST_PREFIX } from "../services/book/shorts.ts";
import { scheduleCrossPost } from "./crossPost.ts";
import { scheduleAutoYoutubeUpload } from "./youtubeUpload.ts";
import { PROCESS_OWNER_ID } from "./owner.ts";
import { appendTaskLog, getTask, updateTask } from "./state.ts";
import type { TaskWarning } from "../db/types.ts";

/**
 * AI music providers.
 *
 * Each only needs `isEnabled` and `generateBgm`; the differences are the file
 * extension, the error type and the warning code. Keeping orchestration,
 * zero-volume short-circuiting and failure degradation in one path avoids
 * duplicating that logic for every new provider.
 */
const VIDEO_MUSIC_PROVIDERS = {
  sonilo: {
    service: sonilo,
    suffix: ".m4a",
    warningCode: "sonilo_bgm_failed",
    displayName: "Sonilo",
    maxPromptLength: sonilo.MAX_PROMPT_LENGTH,
  },
  elevenlabs: {
    service: elevenlabsMusic,
    suffix: ".mp3",
    warningCode: "elevenlabs_bgm_failed",
    displayName: "ElevenLabs",
    maxPromptLength: elevenlabsMusic.MAX_PROMPT_LENGTH,
  },
} as const;

type MusicProviderKey = keyof typeof VIDEO_MUSIC_PROVIDERS;

function getMusicProvider(bgmType: string): (typeof VIDEO_MUSIC_PROVIDERS)[MusicProviderKey] | undefined {
  return VIDEO_MUSIC_PROVIDERS[bgmType as MusicProviderKey];
}

/**
 * Reads the prompt for the active music provider.
 *
 * New tasks use the provider-agnostic field; legacy Sonilo CLI flags and older
 * task records may only carry `sonilo_bgm_prompt`.
 */
function getVideoMusicPrompt(params: VideoParams): string {
  const prompt = String(params.video_music_prompt ?? "").trim();
  if (params.bgm_type === "sonilo" && !prompt) return String(params.sonilo_bgm_prompt ?? "").trim();
  return prompt;
}

export interface PipelineResult {
  script?: string;
  terms?: string[];
  audio_file?: string;
  audio_duration?: number;
  subtitle_path?: string;
  materials?: string[];
  videos?: string[];
  combined_videos?: string[];
  state?: number;
  failed_stage?: string;
  error?: string;
}

async function log(taskId: string, message: string): Promise<void> {
  logger.info(message);
  await appendTaskLog(taskId, message);
}

/**
 * Records a structured failure, preserving the progress reached beforehand.
 *
 * A service usually knows the real cause better than the orchestrator does, so
 * a specific error already stored is never overwritten by a generic one.
 */
async function markTaskFailed(taskId: string, stage: string, error: string): Promise<PipelineResult> {
  const existing = await getTask(taskId).catch(() => null);
  if (existing?.state === TASK_STATE_FAILED && existing.error) {
    return { state: TASK_STATE_FAILED, failed_stage: existing.failed_stage ?? stage, error: existing.error };
  }

  const message = String(error || "unknown task error").trim();
  logger.error(`task failed, task_id: ${taskId}, stage: ${stage}, error: ${message}`);
  await appendTaskLog(taskId, `ERROR [${stage}] ${message}`);
  await updateTask(taskId, {
    state: TASK_STATE_FAILED,
    progress: existing?.progress ?? 0,
    failed_stage: stage,
    error: message,
    owner_id: null,
  });

  return { state: TASK_STATE_FAILED, failed_stage: stage, error: message };
}

/**
 * Resolves a caller-supplied audio path.
 *
 * Task-local files are preferred; otherwise a server-side file is allowed but
 * relative paths must stay inside the project directory, so an API caller
 * cannot point the mixer at arbitrary files on the host.
 */
export function resolveCustomAudioFile(taskId: string, customAudioFile: string | null | undefined): string {
  const requested = String(customAudioFile ?? "").trim();
  if (!requested) return "";

  try {
    return resolvePathWithinDirectory(taskDir(taskId), requested);
  } catch {
    // Not task-local; fall through to the server-side file check.
  }

  const serverAudioFile = resolve(isAbsolute(requested) ? requested : join(rootDir(), requested));

  if (!isAbsolute(requested)) {
    const projectRoot = resolve(rootDir());
    if (!serverAudioFile.startsWith(projectRoot)) {
      throw new Error("relative custom audio paths must stay within the project directory");
    }
  }

  if (!existsSync(serverAudioFile) || !statSync(serverAudioFile).isFile()) {
    throw new Error("custom audio file does not exist or is not a file");
  }
  return serverAudioFile;
}

// ---------------------------------------------------------------------------
// Scene-matched materials
// ---------------------------------------------------------------------------

/**
 * What a scene-matched run needs from whichever orchestrator is asking.
 *
 * Deliberately not `VideoParams`: a book render has no `video_clip_duration`
 * and no `video_clip_speed` — its unit is `FOOTAGE_CLIP_SECONDS` at 1x — so
 * asking for the two numbers that actually matter is what lets both callers
 * share one implementation instead of one each.
 */
export interface SceneMatchedMaterialsOptions {
  taskId: string;
  /** `ttsCues` for a short, `narration.cues` for a book. Never the SRT — §3.1. */
  cues: readonly SceneCue[] | undefined;
  /** `video_source` for a short, `footage_source` for a book. */
  source: string;
  videoAspect: VideoAspectValue;
  /** `video_clip_duration` for a short, `FOOTAGE_CLIP_SECONDS` for a book. */
  slotSeconds: number;
  /** Raw request value; normalized once inside the matcher. Books render at 1x. */
  clipSpeed?: unknown;
  signal?: AbortSignal;
  note?: (message: string) => void | Promise<void>;
}

/**
 * The ordered, scene-matched clip list — or `null` for "this did not happen".
 *
 * `null` is the load-bearing half of the contract. Every caller answers it by
 * running exactly the path it ran before this feature existed, which is what
 * makes `scene_footage.enabled = false` byte-identical to today: the flag is
 * read first, and nothing else in here executes when it is off.
 *
 * Three other reasons produce the same `null`:
 *
 *  - **No cues.** A custom audio file yields none, and there is nothing to cut
 *    into scenes (§3.1). Note this reads the cues held in memory and never the
 *    SRT, which is `""` with captions off and is corrected back to the script.
 *  - **`source === "local"`.** The user's own files are not in the gallery,
 *    which indexes only `cache_videos`, and `"local"` would silently resolve to
 *    Pexels in provider fallback (`search.ts:447`).
 *  - **Nothing matched.** `matchScenes` already swallows its own failures into
 *    `skipped`; an empty list after fallback means the term-based path is the
 *    only one left that can put a picture on screen.
 *
 * Cancellation is the single thing that propagates, because an aborted task
 * carrying on into a provider fetch is a bug, not a degradation.
 */
export async function resolveSceneMatchedMaterials(
  options: SceneMatchedMaterialsOptions,
): Promise<string[] | null> {
  const settings = sceneFootageOptions();
  if (!settings.enabled) return null;

  const cues = options.cues;
  if (!cues || cues.length === 0) return null;

  if (options.source === "local") {
    await options.note?.("scene-matched footage does not apply to local materials; using them as given");
    return null;
  }

  const match = await matchScenes({
    cues,
    slotSeconds: options.slotSeconds,
    speed: options.clipSpeed,
    videoAspect: options.videoAspect,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (match.skipped) {
    await options.note?.(match.skipped);
    return null;
  }

  // Fallback fills the scenes the gallery could not answer. It is judged too
  // (§3.5), so a scene whose provider candidates are all rejected simply stays
  // empty rather than being handed a clip nothing looked at.
  let fallback = new Map<string, string>();
  if (settings.fallback_enabled && match.unmatched.length > 0) {
    try {
      fallback = await resolveSceneFallback({
        scenes: match.scenes,
        unmatched: match.unmatched,
        source: options.source,
        videoAspect: options.videoAspect,
        slotSeconds: options.slotSeconds,
        clipSpeed: options.clipSpeed,
        taskId: options.taskId,
        // What this render has already placed. Without it a download can
        // resolve onto a gallery clip assigned earlier in the same run and be
        // shown twice; only a caller holding `ordered` can see that collision.
        assigned: match.ordered,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (isCancellation(error, options.signal)) throw error;
      logger.warning(`scene footage: provider fallback failed: ${errorMessage(error)}`);
      await options.note?.(`scene footage fallback unavailable (${errorMessage(error)})`);
    }
  }

  // Rebuilt from `scenes` rather than from `match.ordered`, because a fallback
  // clip belongs at *its scene's* position — appending it would put a scene-20
  // rescue between scenes 3 and 4.
  const matched = new Map(match.assignments.map((assignment) => [assignment.scene_id, assignment.file]));
  const ordered: string[] = [];
  let fetched = 0;
  for (const scene of match.scenes) {
    const gallery = matched.get(scene.id);
    if (typeof gallery === "string" && gallery.length > 0) {
      ordered.push(gallery);
      continue;
    }
    const rescued = fallback.get(scene.id);
    if (typeof rescued === "string" && rescued.length > 0) {
      ordered.push(rescued);
      fetched++;
    }
  }

  if (ordered.length === 0) {
    await options.note?.("scene matching produced no clips; falling back to search terms");
    return null;
  }

  await options.note?.(
    `scene-matched footage: ${ordered.length} clip(s) for ${match.scenes.length} scene(s)` +
      (fetched > 0 ? ` (${ordered.length - fetched} from the gallery, ${fetched} fetched)` : ""),
  );
  for (const assignment of match.assignments) {
    if (!assignment.local_file) continue;
    logger.info(
      `scene footage: ${assignment.scene_id} -> ${assignment.local_file}` +
        `${assignment.substituted ? " (substituted)" : ""} — ${assignment.reason}`,
    );
  }

  return ordered;
}

export interface RunPipelineOptions {
  taskId: string;
  params: VideoParams;
  stopAt?: StopAt;
  signal?: AbortSignal;
}

export async function runPipeline(options: RunPipelineOptions): Promise<PipelineResult> {
  const { taskId, params, stopAt = "video", signal } = options;

  try {
    return await executePipeline(taskId, params, stopAt, signal);
  } catch (error) {
    logger.exception(`unexpected task pipeline failure, task_id: ${taskId}`, error);
    return markTaskFailed(taskId, "pipeline", `${error instanceof Error ? error.name : "Error"}: ${errorMessage(error)}`);
  }
}

async function executePipeline(
  taskId: string,
  params: VideoParams,
  stopAt: StopAt,
  signal?: AbortSignal,
): Promise<PipelineResult> {
  await log(taskId, `start task: ${taskId}, stop_at: ${stopAt}`);
  await updateTask(taskId, { state: TASK_STATE_PROCESSING, progress: 5, owner_id: PROCESS_OWNER_ID });

  // --- Preflight -----------------------------------------------------------
  // Only a full render needs an AI music provider. Failing here avoids burning
  // LLM, TTS and stock-material quota on a task that cannot finish.
  const musicProvider = getMusicProvider(params.bgm_type);
  const musicEnabled =
    stopAt === "video" && musicProvider !== undefined && shouldUseBgm(params.bgm_type, params.bgm_volume);

  if (musicEnabled && musicProvider) {
    if (!musicProvider.service.isEnabled()) {
      return markTaskFailed(taskId, "preflight", `${musicProvider.displayName} background music requires an API key`);
    }

    // The UI limits prompt length, but the API, CLI and older tasks bypass it.
    const musicPrompt = getVideoMusicPrompt(params);
    if (musicProvider.maxPromptLength && musicPrompt.length > musicProvider.maxPromptLength) {
      return markTaskFailed(
        taskId,
        "preflight",
        `${musicProvider.displayName} music prompt exceeds ${musicProvider.maxPromptLength} characters`,
      );
    }

    try {
      await musicProvider.service.validateGenerationAccess();
    } catch (error) {
      return markTaskFailed(taskId, "preflight", errorMessage(error));
    }
  }

  // --- 1. Script -----------------------------------------------------------
  await log(taskId, "generating video script");
  let videoScript = params.video_script.trim();
  if (!videoScript) {
    try {
      videoScript = await llm.generateScript({
        videoSubject: params.video_subject,
        language: resolveContentLanguage(params.video_language),
        paragraphNumber: params.paragraph_number,
        videoScriptPrompt: params.video_script_prompt,
        customSystemPrompt: params.custom_system_prompt,
      });
    } catch (error) {
      return markTaskFailed(taskId, "script", errorMessage(error));
    }
  }
  if (!videoScript) return markTaskFailed(taskId, "script", "failed to generate video script");

  await updateTask(taskId, { state: TASK_STATE_PROCESSING, progress: 10 });
  if (stopAt === "script") {
    await updateTask(taskId, { state: TASK_STATE_COMPLETE, progress: 100, script: videoScript, owner_id: null });
    return { script: videoScript };
  }

  // --- 2. Search terms -----------------------------------------------------
  let videoTerms: string[] = [];
  if (params.video_source !== "local") {
    await log(taskId, "generating video terms");
    videoTerms = normalizeVideoTerms(params.video_terms);

    if (videoTerms.length === 0) {
      // With script-order matching on, term order is itself the narrative
      // order, so more terms are requested and their order is preserved.
      videoTerms = await llm.generateTerms({
        videoSubject: params.video_subject,
        videoScript,
        amount: params.match_materials_to_script ? 8 : 5,
        matchScriptOrder: params.match_materials_to_script,
      });
    }

    if (videoTerms.length === 0) {
      return markTaskFailed(taskId, "terms", "failed to generate video search terms");
    }

    // Optional semantic rerank. Skipped in script-order mode, where the order
    // already carries meaning.
    if (!params.match_materials_to_script) {
      videoTerms = await twelvelabs.rerankTermsBySubject(params.video_subject, videoTerms);
    }
  }

  await writeScriptData(taskId, { script: videoScript, search_terms: videoTerms, params });

  if (stopAt === "terms") {
    await updateTask(taskId, { state: TASK_STATE_COMPLETE, progress: 100, terms: videoTerms, owner_id: null });
    return { script: videoScript, terms: videoTerms };
  }

  await updateTask(taskId, { state: TASK_STATE_PROCESSING, progress: 20 });

  // --- 3. Audio ------------------------------------------------------------
  await log(taskId, "generating audio");
  let audioFile: string;
  let audioDuration: number;
  let ttsCues: voice.TtsCue[] | undefined;

  let customAudioFile = "";
  try {
    customAudioFile = resolveCustomAudioFile(taskId, params.custom_audio_file);
  } catch (error) {
    return markTaskFailed(taskId, "audio", `invalid custom audio file: ${errorMessage(error)}`);
  }

  if (customAudioFile) {
    await log(taskId, `using custom audio file: ${customAudioFile}`);
    audioFile = customAudioFile;
    audioDuration = await voice.getAudioDuration(customAudioFile);
    if (audioDuration === 0) return markTaskFailed(taskId, "audio", "custom audio duration is zero");
  } else {
    await log(taskId, "no custom audio file provided, using TTS to generate audio.");
    audioFile = join(taskDir(taskId), "audio.mp3");
    const result = await voice.tts({
      text: videoScript,
      voiceName: voice.parseVoiceName(resolveVoiceName(params.voice_name)),
      voiceRate: params.voice_rate,
      voiceFile: audioFile,
      voiceVolume: params.voice_volume,
      signal,
    });

    if (!result) {
      return markTaskFailed(
        taskId,
        "audio",
        "failed to synthesize audio; verify the selected voice and TTS connectivity",
      );
    }

    audioDuration = Math.ceil(result.duration ?? (await voice.getAudioDuration(audioFile)));
    if (audioDuration === 0) return markTaskFailed(taskId, "audio", "generated audio duration is zero");
    ttsCues = result.cues;
  }

  await updateTask(taskId, { state: TASK_STATE_PROCESSING, progress: 30 });
  if (stopAt === "audio") {
    await updateTask(taskId, {
      state: TASK_STATE_COMPLETE,
      progress: 100,
      audio_file: audioFile,
      audio_duration: audioDuration,
      owner_id: null,
    });
    return { audio_file: audioFile, audio_duration: audioDuration };
  }

  // --- 4. Subtitles --------------------------------------------------------
  await log(taskId, "generating subtitle");
  const subtitlePath = await generateSubtitle({
    subtitlePath: join(taskDir(taskId), "subtitle.srt"),
    videoScript,
    ttsCues,
    audioFile,
    subtitleEnabled: params.subtitle_enabled,
  });

  if (stopAt === "subtitle") {
    await updateTask(taskId, {
      state: TASK_STATE_COMPLETE,
      progress: 100,
      subtitle_path: subtitlePath,
      owner_id: null,
    });
    return { subtitle_path: subtitlePath };
  }

  await updateTask(taskId, { state: TASK_STATE_PROCESSING, progress: 40 });

  // --- 5. Materials --------------------------------------------------------
  let downloadedVideos: string[];
  // True only when the list below is a scene-matched one, whose order is the
  // narration's. It is threaded to the combiner explicitly rather than by
  // flipping `match_materials_to_script`, which is a different feature and is
  // also what the download and term stages above read.
  let sceneMatched = false;
  if (params.video_source === "local") {
    await log(taskId, "preprocess local materials");
    const materials = await preprocessVideos(params.video_materials, params.video_clip_duration);
    if (materials.length === 0) {
      return markTaskFailed(taskId, "materials", "no valid local video materials were found");
    }
    downloadedVideos = materials.map((material) => material.url);
  } else {
    // Returns null with the flag off, with no cues, or when nothing matched —
    // and then the term-based download below runs exactly as it always has.
    const sceneClips = await resolveSceneMatchedMaterials({
      taskId,
      cues: ttsCues,
      source: params.video_source,
      videoAspect: params.video_aspect,
      slotSeconds: params.video_clip_duration,
      clipSpeed: params.video_clip_speed,
      signal,
      note: (message) => log(taskId, message),
    });

    if (sceneClips) {
      downloadedVideos = sceneClips;
      sceneMatched = true;
    } else {
      await log(taskId, `downloading videos from ${params.video_source}`);
      downloadedVideos = await downloadVideos({
        taskId,
        searchTerms: videoTerms,
        source: params.video_source,
        videoAspect: params.video_aspect,
        // Script-order matching forces sequential download so an early term
        // cannot monopolise the timeline and push later topics off the end.
        videoConcatMode: params.match_materials_to_script ? VideoConcatMode.sequential : params.video_concat_mode,
        audioDuration: audioDuration * params.video_count,
        maxClipDuration: params.video_clip_duration,
        matchScriptOrder: params.match_materials_to_script,
        signal,
      });

      if (downloadedVideos.length === 0) {
        return markTaskFailed(taskId, "materials", `failed to download video materials from ${params.video_source}`);
      }
    }
  }

  if (stopAt === "materials") {
    await updateTask(taskId, {
      state: TASK_STATE_COMPLETE,
      progress: 100,
      materials: downloadedVideos,
      owner_id: null,
    });
    return { materials: downloadedVideos };
  }

  await updateTask(taskId, { state: TASK_STATE_PROCESSING, progress: 50 });

  // --- 6. Final videos -----------------------------------------------------
  const { finalVideoPaths, combinedVideoPaths, warnings } = await generateFinalVideos({
    taskId,
    params,
    downloadedVideos,
    sceneMatched,
    audioFile,
    subtitlePath,
    audioDuration,
    signal,
  });

  if (finalVideoPaths.length === 0) {
    return markTaskFailed(taskId, "video", "failed to generate final video");
  }

  logger.success(`task ${taskId} finished, generated ${finalVideoPaths.length} videos.`);

  // --- 7. Cross-posting ----------------------------------------------------
  const crossPostEnabled = uploadPost.isAutoUploadEnabled();
  const platforms = crossPostEnabled ? uploadPost.getPlatforms() : [];
  const shouldCrossPost = crossPostEnabled && platforms.length > 0;

  if (crossPostEnabled && platforms.length === 0) {
    logger.warning(`skip cross-post because no platforms are configured, task_id: ${taskId}`);
  }

  await updateTask(taskId, {
    state: TASK_STATE_COMPLETE,
    progress: 100,
    videos: finalVideoPaths,
    combined_videos: combinedVideoPaths,
    script: videoScript,
    terms: videoTerms,
    audio_file: audioFile,
    audio_duration: audioDuration,
    subtitle_path: subtitlePath,
    materials: downloadedVideos,
    warnings: warnings.length > 0 ? warnings : null,
    cross_post_state: shouldCrossPost ? CROSS_POST_STATE_PENDING : null,
    cross_post_results: null,
    cross_post_error: null,
    cross_post_owner: shouldCrossPost ? PROCESS_OWNER_ID : null,
    owner_id: null,
  });

  if (shouldCrossPost) {
    const schedulingError = scheduleCrossPost({
      taskId,
      videoPaths: finalVideoPaths,
      videoSubject: params.video_subject || "",
      videoScript,
      videoLanguage: resolveContentLanguage(params.video_language),
      platforms,
      youtubePrivacyStatus: uploadPost.getYoutubePrivacyStatus(),
    });
    if (schedulingError) {
      await updateTask(taskId, {
        cross_post_state: CROSS_POST_STATE_FAILED,
        cross_post_error: schedulingError,
        cross_post_owner: null,
      });
    }
  }

  const isBookShort = String((await getTask(taskId))?.request_id ?? "").startsWith(BOOK_SHORT_REQUEST_PREFIX);
  if (!isBookShort) {
    const youtubeError = await scheduleAutoYoutubeUpload({
      taskId,
      videoPaths: finalVideoPaths,
      videoSubject: params.video_subject || "",
      videoScript,
      videoLanguage: params.video_language || "",
    });
    if (youtubeError) {
      await updateTask(taskId, {
        youtube_upload_state: CROSS_POST_STATE_FAILED,
        youtube_upload_error: youtubeError,
        youtube_upload_owner: null,
      });
    }
  }

  return {
    script: videoScript,
    terms: videoTerms,
    audio_file: audioFile,
    audio_duration: audioDuration,
    subtitle_path: subtitlePath,
    materials: downloadedVideos,
    videos: finalVideoPaths,
    combined_videos: combinedVideoPaths,
  };
}

async function generateFinalVideos(options: {
  taskId: string;
  params: VideoParams;
  downloadedVideos: string[];
  /** True when `downloadedVideos` is a scene-matched list already in narration order. */
  sceneMatched?: boolean;
  audioFile: string;
  subtitlePath: string;
  audioDuration: number;
  signal?: AbortSignal;
}): Promise<{ finalVideoPaths: string[]; combinedVideoPaths: string[]; warnings: TaskWarning[] }> {
  const { taskId, params, downloadedVideos, sceneMatched, audioFile, subtitlePath, audioDuration, signal } = options;

  const finalVideoPaths: string[] = [];
  const combinedVideoPaths: string[] = [];
  const warnings: TaskWarning[] = [];

  const musicProvider = getMusicProvider(params.bgm_type);
  const musicRequested = musicProvider !== undefined && shouldUseBgm(params.bgm_type, params.bgm_volume);

  // Multiple outputs are normally shuffled for variety, but script-order
  // matching is about a stable, explicable timeline, so it stays sequential.
  // A scene-matched list is ordered for the same reason and by a different
  // feature, so it forces sequential here without touching that flag —
  // re-randomising it would throw away the entire point of matching.
  const concatMode =
    sceneMatched || params.match_materials_to_script
      ? VideoConcatMode.sequential
      : params.video_count === 1
        ? params.video_concat_mode
        : VideoConcatMode.random;

  let progress = 50;

  for (let index = 1; index <= params.video_count; index++) {
    const combinedVideoPath = join(taskDir(taskId), `combined-${index}.mp4`);
    await log(taskId, `combining video: ${index} => ${combinedVideoPath}`);

    await combineVideos({
      combinedVideoPath,
      videoPaths: downloadedVideos,
      audioFile,
      videoAspect: params.video_aspect,
      videoConcatMode: concatMode,
      videoTransitionMode: params.video_transition_mode ?? null,
      maxClipDuration: params.video_clip_duration,
      threads: params.n_threads,
      clipSpeed: params.video_clip_speed,
      signal,
    });

    progress += 50 / params.video_count / 2;
    await updateTask(taskId, { progress });

    const finalVideoPath = join(taskDir(taskId), `final-${index}.mp4`);

    // With an AI provider selected, the ordinary random/custom lookup is
    // disabled outright so a stale bgm_file from an old task cannot leak in.
    let bgmFileOverride: string | undefined = musicProvider ? "" : undefined;

    if (musicRequested && musicProvider) {
      const generatedBgmPath = join(taskDir(taskId), `${params.bgm_type}-bgm-${index}${musicProvider.suffix}`);
      try {
        await musicProvider.service.generateBgm({
          videoPath: combinedVideoPath,
          outputPath: generatedBgmPath,
          videoDuration: audioDuration,
          prompt: getVideoMusicPrompt(params),
          signal,
        });
        bgmFileOverride = generatedBgmPath;
      } catch (error) {
        // Video, narration and subtitles are already done; a transient music
        // failure should not waste the whole task.
        logger.warning(
          `${musicProvider.displayName} BGM generation failed: task_id=${taskId}, ` +
            `video_index=${index}, error=${errorMessage(error)}`,
        );
        bgmFileOverride = "";
        warnings.push({ code: musicProvider.warningCode, video_index: index });
      }
    }

    await log(taskId, `generating video: ${index} => ${finalVideoPath}`);
    const { bgmMixSucceeded } = await generateVideo({
      videoPath: combinedVideoPath,
      audioPath: audioFile,
      subtitlePath,
      outputFile: finalVideoPath,
      params,
      bgmFileOverride,
      bgmFile: bgmFileOverride === undefined ? getBgmFile(params.bgm_type, params.bgm_file) : undefined,
      signal,
    });

    // The provider succeeded but the local mix still failed; the video is kept
    // without music, so surface the degradation exactly once.
    if (musicProvider && bgmFileOverride && !bgmMixSucceeded) {
      warnings.push({ code: musicProvider.warningCode, video_index: index });
    }

    progress += 50 / params.video_count / 2;
    await updateTask(taskId, { progress });

    finalVideoPaths.push(finalVideoPath);
    combinedVideoPaths.push(combinedVideoPath);
  }

  return { finalVideoPaths, combinedVideoPaths, warnings };
}

/** True while generation or publishing may still touch the task directory. */
export function isTaskBusy(
  task: { state?: number; cross_post_state?: string | null; youtube_upload_state?: string | null } | null,
): boolean {
  if (!task) return false;
  return (
    task.state === TASK_STATE_PROCESSING ||
    task.cross_post_state === "pending" ||
    task.cross_post_state === "processing" ||
    task.youtube_upload_state === "pending" ||
    task.youtube_upload_state === "processing"
  );
}

export { appConfig };
