/**
 * Process identity for in-flight work.
 *
 * Generation and cross-posting run in this process, not in a durable queue, so
 * a restart cannot resume them. Stamping the owner lets startup recovery tell
 * "another live process owns this" apart from "the owner died mid-run", instead
 * of leaving tasks stuck in `processing` forever.
 */

import { hostname } from "node:os";

export const PROCESS_HOSTNAME = hostname();

export const PROCESS_OWNER_ID = `${PROCESS_HOSTNAME}:${process.pid}:${crypto.randomUUID().replace(/-/g, "")}`;

export interface ParsedOwner {
  hostname: string;
  pid: number;
}

export function parseOwner(owner: string | null | undefined): ParsedOwner | null {
  if (!owner) return null;
  const parts = String(owner).split(":");
  if (parts.length < 3) return null;

  const pid = Number(parts[1]);
  if (!Number.isInteger(pid) || pid <= 0) return null;

  return { hostname: parts[0]!, pid };
}

/**
 * Whether the process that claimed a task still exists.
 *
 * Another host cannot be probed, so a foreign hostname is conservatively
 * treated as alive — deleting files another node is still reading is the worse
 * failure. A record stamped with *this* pid is treated as dead, because live
 * work is tracked in memory and would never need this check.
 */
export function isOwnerAlive(owner: string | null | undefined): boolean {
  const parsed = parseOwner(owner);
  if (!parsed) return false;

  if (parsed.hostname !== PROCESS_HOSTNAME) return true;
  if (parsed.pid === process.pid) return false;

  try {
    // Signal 0 performs the permission and existence check without delivering.
    process.kill(parsed.pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM means the process exists but belongs to another user.
    return true;
  }
}
