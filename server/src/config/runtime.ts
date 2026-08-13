/**
 * Runtime-environment probes used to pick sensible defaults.
 * Ported from python-version/app/config/config.py.
 */

import { readFileSync, existsSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { logger } from "../utils/logger.ts";

const CONTAINER_CGROUP_MARKERS = ["docker", "containerd", "kubepods", "libpod", "podman"];
const DOCKER_HOST_GATEWAY_NAME = "host.docker.internal";

/**
 * True when this process runs inside a container.
 *
 * This drives the Ollama default address: on a normal host `localhost` is the
 * user's machine, but inside a container it is the container itself, so
 * reaching a host-side Ollama needs `host.docker.internal`.
 *
 * `/proc/1/cgroup` alone is not evidence — plain Linux has it too — so only an
 * explicit container marker counts. Paths are injectable for tests.
 */
export function isRunningInContainer(
  dockerenvPath = "/.dockerenv",
  containerenvPath = "/run/.containerenv",
  cgroupPath = "/proc/1/cgroup",
): boolean {
  if (existsSync(dockerenvPath) || existsSync(containerenvPath)) return true;

  try {
    const content = readFileSync(cgroupPath, "utf8").toLowerCase();
    return CONTAINER_CGROUP_MARKERS.some((marker) => content.includes(marker));
  } catch {
    return false;
  }
}

async function canResolveHostname(hostname: string): Promise<boolean> {
  try {
    await lookup(hostname);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decodes a `/proc/net/route` gateway field.
 *
 * The value is little-endian hex — `010011AC` means 172.17.0.1. Parsing it
 * gives native Linux Docker, which has no `host.docker.internal` DNS record, a
 * way to reach host services.
 */
export function decodeLinuxRouteGateway(hexGateway: string): string {
  if (hexGateway.length !== 8) {
    throw new Error("invalid gateway length");
  }
  const octets: string[] = [];
  for (let index = 6; index >= 0; index -= 2) {
    octets.push(String(parseInt(hexGateway.slice(index, index + 2), 16)));
  }
  return octets.join(".");
}

/**
 * Reads the container's default gateway IP.
 *
 * Docker Desktop usually provides `host.docker.internal`, native Linux Docker
 * often does not. The default gateway is a reasonable fallback for reaching
 * host services — though an Ollama bound only to 127.0.0.1 still requires the
 * user to widen its listen address or set the base URL explicitly.
 */
export function getContainerDefaultGatewayIp(routePath = "/proc/net/route"): string {
  let lines: string[];
  try {
    lines = readFileSync(routePath, "utf8").split("\n");
  } catch {
    return "";
  }

  for (const line of lines.slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;

    const [, destination, gateway] = fields as [string, string, string];
    if (destination !== "00000000" || gateway === "00000000") continue;

    try {
      return decodeLinuxRouteGateway(gateway);
    } catch {
      logger.warning(`invalid container gateway route entry: ${line.trim()}`);
      return "";
    }
  }

  return "";
}

let cachedOllamaBaseUrl: string | undefined;

/**
 * Best default Ollama OpenAI-compatible base URL when none is configured.
 * Inside a container this points at the host; otherwise at localhost.
 */
export async function getDefaultOllamaBaseUrl(): Promise<string> {
  if (cachedOllamaBaseUrl) return cachedOllamaBaseUrl;

  if (!isRunningInContainer()) {
    cachedOllamaBaseUrl = "http://localhost:11434/v1";
    return cachedOllamaBaseUrl;
  }

  if (await canResolveHostname(DOCKER_HOST_GATEWAY_NAME)) {
    cachedOllamaBaseUrl = `http://${DOCKER_HOST_GATEWAY_NAME}:11434/v1`;
    return cachedOllamaBaseUrl;
  }

  const gatewayIp = getContainerDefaultGatewayIp();
  if (gatewayIp) {
    logger.info(
      "host.docker.internal is not resolvable, fallback to container " +
        `default gateway for Ollama: ${gatewayIp}`,
    );
    cachedOllamaBaseUrl = `http://${gatewayIp}:11434/v1`;
    return cachedOllamaBaseUrl;
  }

  logger.warning(
    "failed to resolve host.docker.internal and container default gateway; " +
      "fallback to host.docker.internal for Ollama",
  );
  cachedOllamaBaseUrl = `http://${DOCKER_HOST_GATEWAY_NAME}:11434/v1`;
  return cachedOllamaBaseUrl;
}
