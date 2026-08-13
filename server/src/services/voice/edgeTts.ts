/**
 * Edge (consumer) text-to-speech over the Microsoft Read Aloud WebSocket.
 *
 * The Python version delegated this to the `edge-tts` package. There is no
 * equivalent we want to depend on here, so the protocol is implemented
 * directly — it is small, and owning it means the word-boundary events the
 * subtitle pipeline depends on are guaranteed to be available.
 */

import { ticksToSeconds, type TtsCue } from "./types.ts";
import { logger } from "../../utils/logger.ts";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const BASE_URL = "speech.platform.bing.com/consumer/speech/synthesize/readaloud";
const WSS_URL = `wss://${BASE_URL}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
export const VOICE_LIST_URL = `https://${BASE_URL}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;

/**
 * Edge build this client claims to be.
 *
 * The service validates `Sec-MS-GEC-Version` and rejects the handshake with a
 * bare 403 once the value drifts too far behind the shipping Edge release, so
 * this needs bumping periodically. `EDGE_CHROMIUM_VERSION` overrides it without
 * a code change if the endpoint starts refusing connections.
 */
const CHROMIUM_FULL_VERSION = process.env.EDGE_CHROMIUM_VERSION ?? "143.0.3650.75";
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0]!;
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;

/** Seconds between the Windows FILETIME epoch (1601) and the Unix epoch. */
const WIN_EPOCH = 11_644_473_600;

const USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`;

const REQUEST_HEADERS: Record<string, string> = {
  Pragma: "no-cache",
  "Cache-Control": "no-cache",
  Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent": USER_AGENT,
};

/**
 * Builds the anti-abuse token the endpoint requires.
 *
 * It is a SHA-256 of the current Windows tick count — rounded down to a
 * five-minute window so client and server agree — concatenated with the public
 * client token.
 */
export function generateSecMsGec(nowSeconds: number = Date.now() / 1000): string {
  let ticks = Math.floor(nowSeconds) + WIN_EPOCH;
  ticks -= ticks % 300;
  // Convert seconds to 100-nanosecond intervals. The product exceeds the safe
  // integer range, so it is formatted from the double exactly as the reference
  // implementation does rather than via BigInt.
  const ticksIn100Ns = ticks * 1e7;
  return new Bun.CryptoHasher("sha256")
    .update(`${ticksIn100Ns.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`, "ascii")
    .digest("hex")
    .toUpperCase();
}

function connectionUrl(): string {
  return (
    `${WSS_URL}&Sec-MS-GEC=${generateSecMsGec()}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
    `&ConnectionId=${crypto.randomUUID().replace(/-/g, "")}`
  );
}

function escapeSsml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Formats a speed multiplier as the signed percentage the service expects.
 *
 * Rounding can turn a rate near 1.0 into 0, which must still be "+0%" — the
 * unsigned "0%" is rejected. Zero, negative and unparseable values fall back to
 * normal speed rather than producing an unusably slow narration.
 */
export function convertRateToPercent(rate: unknown): string {
  let value = typeof rate === "number" ? rate : Number(rate);
  if (!Number.isFinite(value) || value <= 0) value = 1.0;

  const percent = Math.round((value - 1.0) * 100);
  return percent >= 0 ? `+${percent}%` : `${percent}%`;
}

function buildSsml(text: string, voiceName: string, rate: string, volume: string, pitch: string): string {
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voiceName}'>` +
    `<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
    `${escapeSsml(text)}` +
    `</prosody></voice></speak>`
  );
}

function timestamp(): string {
  // The service expects the JavaScript Date.toString() form, not ISO 8601.
  return new Date().toString().replace(/\s\(.*\)$/, " (Coordinated Universal Time)");
}

function speechConfigMessage(): string {
  return (
    `X-Timestamp:${timestamp()}\r\n` +
    `Content-Type:application/json; charset=utf-8\r\n` +
    `Path:speech.config\r\n\r\n` +
    `{"context":{"synthesis":{"audio":{"metadataoptions":{` +
    `"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},` +
    `"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`
  );
}

function ssmlMessage(requestId: string, ssml: string): string {
  return (
    `X-RequestId:${requestId}\r\n` +
    `Content-Type:application/ssml+xml\r\n` +
    `X-Timestamp:${timestamp()}Z\r\n` +
    `Path:ssml\r\n\r\n` +
    `${ssml}`
  );
}

/** Splits a text frame into its headers and body. */
function parseTextFrame(data: string): { headers: Record<string, string>; body: string } {
  const separator = data.indexOf("\r\n\r\n");
  const headerBlock = separator >= 0 ? data.slice(0, separator) : data;
  const body = separator >= 0 ? data.slice(separator + 4) : "";

  const headers: Record<string, string> = {};
  for (const line of headerBlock.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon)] = line.slice(colon + 1);
  }
  return { headers, body };
}

interface AudioMetadata {
  Metadata?: {
    Type?: string;
    Data?: {
      Offset?: number;
      Duration?: number;
      text?: { Text?: string; Length?: number; BoundaryType?: string };
    };
  }[];
}

export interface EdgeTtsOptions {
  text: string;
  voiceName: string;
  /** Signed percentage, e.g. "+0%". */
  rate?: string;
  volume?: string;
  pitch?: string;
  /** Total time budget for the stream; 0 or undefined disables it. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface EdgeTtsStreamResult {
  audio: Uint8Array;
  cues: TtsCue[];
}

/**
 * Synthesises text and collects both the audio and its word boundaries.
 *
 * A total timeout is enforced because the endpoint can stall indefinitely when
 * the network is blocked, the service throttles, or the voice does not match
 * the text's language — leaving a generation task with no feedback at all.
 */
export function synthesizeEdgeTts(options: EdgeTtsOptions): Promise<EdgeTtsStreamResult> {
  const {
    text,
    voiceName,
    rate = "+0%",
    volume = "+0%",
    pitch = "+0Hz",
    timeoutMs,
    signal,
  } = options;

  return new Promise<EdgeTtsStreamResult>((resolve, reject) => {
    const requestId = crypto.randomUUID().replace(/-/g, "");
    const audioChunks: Uint8Array[] = [];
    const cues: TtsCue[] = [];

    let settled = false;
    let socket: WebSocket;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        socket?.close();
      } catch {
        // Already closing; nothing useful to do.
      }
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();

      const total = audioChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const audio = new Uint8Array(total);
      let offset = 0;
      for (const chunk of audioChunks) {
        audio.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve({ audio, cues });
    };

    const onAbort = () => fail(new Error("edge tts request was cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(
        () => fail(new Error(`edge tts stream timed out after ${(timeoutMs / 1000).toFixed(0)}s`)),
        timeoutMs,
      );
    }

    try {
      socket = new WebSocket(connectionUrl(), { headers: REQUEST_HEADERS } as unknown as string[]);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      socket.send(speechConfigMessage());
      socket.send(ssmlMessage(requestId, buildSsml(text, voiceName, rate, volume, pitch)));
    };

    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        const { headers, body } = parseTextFrame(event.data);
        const path = headers.Path;

        if (path === "audio.metadata") {
          try {
            const metadata = JSON.parse(body) as AudioMetadata;
            for (const entry of metadata.Metadata ?? []) {
              if (entry.Type !== "WordBoundary" && entry.Type !== "SentenceBoundary") continue;
              const data = entry.Data;
              const content = data?.text?.Text;
              if (!data || typeof data.Offset !== "number" || content === undefined) continue;

              cues.push({
                start: ticksToSeconds(data.Offset),
                end: ticksToSeconds(data.Offset + (data.Duration ?? 0)),
                content,
              });
            }
          } catch (error) {
            logger.debug(`failed to parse edge tts metadata frame: ${String(error)}`);
          }
        } else if (path === "turn.end") {
          succeed();
        }
        return;
      }

      // Binary frames carry a two-byte big-endian header length, the header
      // block, and then the raw audio bytes.
      const buffer = new Uint8Array(event.data as ArrayBuffer);
      if (buffer.byteLength < 2) return;

      const headerLength = (buffer[0]! << 8) | buffer[1]!;
      const headerEnd = 2 + headerLength;
      if (headerEnd > buffer.byteLength) return;

      const header = new TextDecoder().decode(buffer.subarray(2, headerEnd));
      if (header.includes("Path:audio")) {
        audioChunks.push(buffer.subarray(headerEnd));
      }
    };

    socket.onerror = () => {
      fail(new Error("edge tts websocket error; check network access to speech.platform.bing.com"));
    };

    socket.onclose = (event: CloseEvent) => {
      if (settled) return;
      if (audioChunks.length > 0) {
        // Some closes arrive before turn.end but after all audio; keep it.
        succeed();
        return;
      }
      fail(
        new Error(
          `edge tts connection closed before any audio was received ` +
            `(code ${event.code}${event.reason ? `: ${event.reason}` : ""})`,
        ),
      );
    };
  });
}

export interface EdgeVoice {
  Name: string;
  ShortName: string;
  Gender: string;
  Locale: string;
  FriendlyName?: string;
}

/** Fetches the live voice catalogue, used to refresh the bundled list. */
export async function listEdgeVoices(): Promise<EdgeVoice[]> {
  const url = `${VOICE_LIST_URL}&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
  const response = await fetch(url, { headers: REQUEST_HEADERS });
  if (!response.ok) {
    throw new Error(`failed to list edge voices: HTTP ${response.status}`);
  }
  return (await response.json()) as EdgeVoice[];
}
