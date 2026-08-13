/**
 * Persistent files inside a task directory.
 * Ported from python-version/app/services/task_artifacts.py.
 *
 * `script.json` records what a task was generated from — the script, the search
 * terms, the parameters and the material provenance — so a finished video can
 * be traced or its settings restored later.
 */

import { existsSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { logger, errorMessage } from "../utils/logger.ts";
import { taskDir } from "../utils/paths.ts";

function scriptFile(taskId: string): string {
  return join(taskDir(taskId), "script.json");
}

/**
 * Writes JSON atomically inside the task directory.
 *
 * The temporary file must sit in the same directory for the rename to be atomic
 * on ordinary filesystems and Docker mounts. The existing file is untouched
 * until the write succeeds.
 */
async function writeJsonAtomic(target: string, payload: unknown): Promise<void> {
  const tempPath = `${target}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    await Bun.write(tempPath, JSON.stringify(payload, null, 2));
    await rename(tempPath, target);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

export interface ScriptData {
  script?: string;
  search_terms?: string[];
  params?: unknown;
  material_sources?: unknown[];
  [key: string]: unknown;
}

/**
 * Writes the task manifest.
 *
 * Failures are logged and swallowed: the manifest is a convenience for the task
 * browser, and losing it must never fail a video that rendered successfully.
 */
export async function writeScriptData(taskId: string, data: ScriptData): Promise<boolean> {
  try {
    await writeJsonAtomic(scriptFile(taskId), data);
    return true;
  } catch (error) {
    logger.warning(`failed to write task script data: task_id=${taskId}, error: ${errorMessage(error)}`);
    return false;
  }
}

export async function readScriptData(taskId: string): Promise<ScriptData | null> {
  const target = scriptFile(taskId);
  if (!existsSync(target)) return null;

  try {
    return (await Bun.file(target).json()) as ScriptData;
  } catch (error) {
    logger.warning(`failed to read task script data: task_id=${taskId}, error: ${errorMessage(error)}`);
    return null;
  }
}

/** Merges fields into an existing manifest, creating it when absent. */
export async function patchScriptData(taskId: string, patch: ScriptData): Promise<boolean> {
  const existing = (await readScriptData(taskId)) ?? {};
  return writeScriptData(taskId, { ...existing, ...patch });
}
