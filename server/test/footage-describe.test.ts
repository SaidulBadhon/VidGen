/**
 * The describer's pure surface, plus `describeClip` driven through its seams.
 *
 * Nothing here spawns ffmpeg or reaches a model: `buildProxyArgs` is the argv
 * `runFfmpeg` would be handed, and `describeClip` takes its proxy builder,
 * reader, remover and generator as injected functions, so the retry and cleanup
 * behaviour can be exercised with plain callbacks.
 *
 * Two assertions in `buildProxyArgs` are measurements rather than preferences,
 * and are the reason that function is exported at all — see the cases.
 */

import { beforeAll, describe, expect, test } from "bun:test";

import { defaultSettings } from "../src/config/schema.ts";
import { __setSettingsForTest } from "../src/config/settings.ts";
import {
  ClipDescribeError,
  DESCRIBE_SYSTEM_PROMPT,
  buildDescribeMessages,
  buildProxyArgs,
  describeClip,
  describeInstruction,
  isSchemaViolation,
  proxyFileName,
  proxyTimeoutMs,
  type DescribeDeps,
  type ProxyRecipe,
} from "../src/services/footage/describe.ts";
import { DESCRIBE_VERSION, type ClipDescription } from "../src/services/footage/types.ts";

beforeAll(() => {
  __setSettingsForTest(defaultSettings());
});

const RECIPE: ProxyRecipe = { height: 360, fps: 2, maxSeconds: 60 };

const DESCRIPTION: ClipDescription = {
  summary: "A woman walks along a wet street.",
  detailed_description: "Medium shot, neon reflections.",
  use_cases: ["a segment on urban loneliness"],
  mood: ["melancholy"],
  tags: ["rain", "city"],
  setting: "outdoor",
  time_of_day: "night",
  has_people: true,
  has_on_screen_text: false,
  camera_motion: "handheld",
  quality_flags: [],
};

// ---------------------------------------------------------------------------

describe("buildProxyArgs", () => {
  const args = buildProxyArgs({ ...RECIPE, src: "/cache/vid-a.mp4", dest: "/tmp/vid-a-abcd.mp4" });

  test("puts -t before -i, making it an input option", () => {
    // As an input option ffmpeg stops demuxing after `maxSeconds`; after -i it
    // would read a 200 MB file to the end and discard the tail. Measured: ~2 s
    // versus ~20 s. This ordering is the whole reason the argv is built here.
    expect(args.indexOf("-t")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-t") + 1]).toBe("60");
    expect(args[args.indexOf("-i") + 1]).toBe("/cache/vid-a.mp4");
  });

  test("normalises the pixel format in the filter chain", () => {
    // Without `format=yuv420p`, a 10-bit or 4:2:2 source makes libx264 emit a
    // High10/422 stream the model may refuse to decode — a steady trickle of
    // unexplained describe failures across a thousand-clip run.
    const filter = args[args.indexOf("-vf") + 1]!;
    expect(filter).toContain("format=yuv420p");
    expect(filter).toBe("scale=-2:360,fps=2,format=yuv420p");
  });

  test("scales with -2, so the width stays even for chroma subsampling", () => {
    const filter = buildProxyArgs({ ...RECIPE, height: 481, src: "a", dest: "b" })[
      buildProxyArgs({ ...RECIPE, height: 481, src: "a", dest: "b" }).indexOf("-vf") + 1
    ]!;
    expect(filter.startsWith("scale=-2:481,")).toBe(true);
    expect(filter).not.toContain("scale=-1:");
  });

  test("rounds a fractional height and formats a fractional rate", () => {
    const built = buildProxyArgs({ height: 359.6, fps: 0.5, maxSeconds: 30, src: "a", dest: "b" });
    expect(built[built.indexOf("-vf") + 1]).toBe("scale=-2:360,fps=0.5,format=yuv420p");
    expect(built[built.indexOf("-t") + 1]).toBe("30");
  });

  test("overwrites, drops audio, and encodes small and fast", () => {
    expect(args[0]).toBe("-y");
    expect(args).toContain("-an");
    expect(args[args.indexOf("-c:v") + 1]).toBe("libx264");
    expect(args[args.indexOf("-crf") + 1]).toBe("32");
    expect(args[args.indexOf("-preset") + 1]).toBe("veryfast");
  });

  test("ends with the destination, and every argument is a string", () => {
    expect(args.at(-1)).toBe("/tmp/vid-a-abcd.mp4");
    for (const arg of args) expect(typeof arg).toBe("string");
  });
});

// ---------------------------------------------------------------------------

describe("proxyTimeoutMs", () => {
  test("budgets two seconds of wall clock per second of footage", () => {
    expect(proxyTimeoutMs(60)).toBe(120_000);
    expect(proxyTimeoutMs(90)).toBe(180_000);
  });

  test("never drops below thirty seconds", () => {
    expect(proxyTimeoutMs(1)).toBe(30_000);
    expect(proxyTimeoutMs(14)).toBe(30_000);
    expect(proxyTimeoutMs(15)).toBe(30_000);
    expect(proxyTimeoutMs(16)).toBe(32_000);
  });

  test("never rises above five minutes, so one bad file cannot hold a worker", () => {
    expect(proxyTimeoutMs(150)).toBe(300_000);
    expect(proxyTimeoutMs(10_000)).toBe(300_000);
  });

  test("rounds a fractional budget up", () => {
    expect(proxyTimeoutMs(60.1)).toBe(122_000);
  });
});

// ---------------------------------------------------------------------------

describe("proxyFileName", () => {
  test("keeps the source stem so a leftover file is traceable", () => {
    expect(proxyFileName("/cache/vid-abc.mp4", "deadbeef")).toBe("vid-abc-deadbeef.mp4");
  });

  test("uses the basename only", () => {
    expect(proxyFileName("/a/b/c/vid-abc.mp4", "tok")).toBe("vid-abc-tok.mp4");
  });

  test("replaces anything outside a conservative character set", () => {
    // The stem reaches the filesystem and the source name is not this module's
    // to trust.
    expect(proxyFileName("/cache/a b;rm -rf.mp4", "tok")).toBe("a_b_rm_-rf-tok.mp4");
    expect(proxyFileName("/cache/../../etc/passwd.mp4", "tok")).toBe("passwd-tok.mp4");
  });

  test("caps the stem so the name cannot outgrow the filesystem's limit", () => {
    const name = proxyFileName(`${"x".repeat(300)}.mp4`, "tok");
    expect(name).toBe(`${"x".repeat(80)}-tok.mp4`);
  });

  test("falls back to 'clip' when there is no stem at all", () => {
    expect(proxyFileName("", "tok")).toBe("clip-tok.mp4");
  });

  test("is unique per token, so two workers cannot overwrite each other", () => {
    expect(proxyFileName("/cache/vid-a.mp4", "aaaa")).not.toBe(proxyFileName("/cache/vid-a.mp4", "bbbb"));
  });
});

// ---------------------------------------------------------------------------

describe("isSchemaViolation", () => {
  test("recognises the AI SDK's parse and validation failures by name", () => {
    for (const name of [
      "AI_NoObjectGeneratedError",
      "AI_TypeValidationError",
      "AI_JSONParseError",
      "NoObjectGeneratedError",
      "TypeValidationError",
      "JSONParseError",
    ]) {
      const error = new Error("bad shape");
      error.name = name;
      expect(isSchemaViolation(error)).toBe(true);
    }
  });

  test("walks the cause chain, because the SDK wraps validation failures", () => {
    const inner = new Error("not an object");
    inner.name = "AI_TypeValidationError";
    const wrapped = new Error("outer", { cause: new Error("middle", { cause: inner }) });
    expect(isSchemaViolation(wrapped)).toBe(true);
  });

  test("stops at the depth limit rather than following an unbounded chain", () => {
    const deep = new Error("l0");
    deep.name = "AI_JSONParseError";
    let current: Error = deep;
    for (let level = 0; level < 4; level++) current = new Error(`l${level + 1}`, { cause: current });

    expect(isSchemaViolation(current)).toBe(true);
    expect(isSchemaViolation(current, 2)).toBe(false);
  });

  test("terminates on a self-referential cause chain", () => {
    const cyclic: { name: string; cause?: unknown } = { name: "APICallError" };
    cyclic.cause = cyclic;
    expect(isSchemaViolation(cyclic)).toBe(false);
  });

  test("does not classify a transport failure as a schema violation", () => {
    // A 429 or a 500 must not be retried here; retrying only makes it worse.
    const rateLimited = new Error("Too Many Requests");
    rateLimited.name = "AI_APICallError";
    expect(isSchemaViolation(rateLimited)).toBe(false);
    expect(isSchemaViolation(new TypeError("fetch failed"))).toBe(false);
  });

  test("is false for anything that is not an object", () => {
    for (const value of [null, undefined, "AI_JSONParseError", 42, true]) {
      expect(isSchemaViolation(value)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------

describe("the prompt", () => {
  test("tells the model the proxy's own limits are not defects of the footage", () => {
    // Without this, `quality_flags` comes back "low resolution" on every clip
    // and the field stops distinguishing the genuinely unusable masters.
    expect(DESCRIBE_SYSTEM_PROMPT).toContain("PROXY");
    expect(DESCRIBE_SYSTEM_PROMPT).toContain("never report the proxy's own");
  });

  test("states the recipe's actual numbers rather than hardcoded ones", () => {
    // A model told a clip was truncated at 60 s when the setting is 20 would
    // describe an ending it never saw.
    const instruction = describeInstruction({ height: 240, fps: 0.5, maxSeconds: 20 });
    expect(instruction).toContain("240p");
    expect(instruction).toContain("0.5 frames per second");
    expect(instruction).toContain("first 20 seconds");
  });

  test("puts the media before the text, as Google documents", () => {
    const [message] = buildDescribeMessages(new Uint8Array([1, 2, 3]), RECIPE);
    const content = message!.content as Array<{ type: string; mediaType?: string; text?: string }>;
    expect(message!.role).toBe("user");
    expect(content[0]!.type).toBe("file");
    expect(content[0]!.mediaType).toBe("video/mp4");
    expect(content[1]!.type).toBe("text");
    expect(content[1]!.text).toBe(describeInstruction(RECIPE));
  });

  test("appends the schema reminder only on a retry", () => {
    const first = buildDescribeMessages(new Uint8Array(), RECIPE, false);
    const retry = buildDescribeMessages(new Uint8Array(), RECIPE, true);
    const textOf = (messages: typeof first): string =>
      (messages[0]!.content as Array<{ type: string; text?: string }>).find((part) => part.type === "text")!.text!;

    expect(textOf(first)).not.toContain("could not be parsed");
    expect(textOf(retry)).toContain("could not be parsed against the required schema");
    expect(textOf(retry).startsWith(textOf(first))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

/**
 * `describeClip` with every side effect replaced by a callback: no ffmpeg, no
 * filesystem, no model. `removed` records the cleanup so the `finally` can be
 * asserted on every path.
 */
function stubDeps(
  generate: DescribeDeps["generate"],
  removed: string[] = [],
  overrides: Partial<DescribeDeps> = {},
): DescribeDeps {
  return {
    model: "stub-model",
    modelName: "stub-model",
    proxy: RECIPE,
    buildProxy: async () => "/tmp/proxies/vid-a-tok.mp4",
    readProxy: async () => new Uint8Array([1, 2, 3, 4]),
    removeProxy: async (path: string) => {
      removed.push(path);
    },
    generate,
    ...overrides,
  };
}

describe("describeClip", () => {
  test("returns the description with the stamps the row and payload need", async () => {
    const removed: string[] = [];
    const result = await describeClip(
      "/cache/vid-a.mp4",
      stubDeps(async () => ({ object: DESCRIPTION, totalTokens: 1234 }), removed),
    );

    expect(result.description).toEqual(DESCRIPTION);
    expect(result.describe_model).toBe("stub-model");
    expect(result.describe_version).toBe(DESCRIBE_VERSION);
    expect(result.proxy_bytes).toBe(4);
    expect(result.attempts).toBe(1);
    expect(result.total_tokens).toBe(1234);
    expect(removed).toEqual(["/tmp/proxies/vid-a-tok.mp4"]);
  });

  test("passes the resolved recipe to the proxy builder and the prompt", async () => {
    let builderOptions: Record<string, unknown> = {};
    await describeClip(
      "/cache/vid-a.mp4",
      stubDeps(async () => ({ object: DESCRIPTION }), [], {
        buildProxy: async (_src, options) => {
          builderOptions = options as Record<string, unknown>;
          return "/tmp/p.mp4";
        },
      }),
    );

    // Resolved once, so the encoder and the prompt cannot describe different
    // proxies.
    expect(builderOptions.height).toBe(360);
    expect(builderOptions.fps).toBe(2);
    expect(builderOptions.maxSeconds).toBe(60);
  });

  test("retries once on a schema violation and reports two attempts", async () => {
    const removed: string[] = [];
    const seen: boolean[] = [];
    const result = await describeClip(
      "/cache/vid-a.mp4",
      stubDeps(async (request) => {
        const text = (request.messages[0]!.content as Array<{ type: string; text?: string }>).find(
          (part) => part.type === "text",
        )!.text!;
        seen.push(text.includes("could not be parsed"));
        if (seen.length === 1) {
          const error = new Error("no object generated");
          error.name = "AI_NoObjectGeneratedError";
          throw error;
        }
        return { object: DESCRIPTION };
      }, removed),
    );

    expect(result.attempts).toBe(2);
    // The second request carries the retry instruction; the first must not.
    expect(seen).toEqual([false, true]);
    expect(removed.length).toBe(1);
  });

  test("gives up after the second schema violation, at stage 'schema'", async () => {
    const removed: string[] = [];
    let calls = 0;
    const error = (await describeClip(
      "/cache/vid-a.mp4",
      stubDeps(async () => {
        calls++;
        const violation = new Error("still not an object");
        violation.name = "AI_TypeValidationError";
        throw violation;
      }, removed),
    ).catch((caught: unknown) => caught)) as ClipDescribeError;

    expect(error).toBeInstanceOf(ClipDescribeError);
    expect(calls).toBe(2);
    expect(error.stage).toBe("schema");
    expect(error.attempts).toBe(2);
    expect(error.clip).toBe("vid-a.mp4");
    // Cleaned up on the failure path too: one proxy in, one proxy removed.
    expect(removed).toEqual(["/tmp/proxies/vid-a-tok.mp4"]);
  });

  test("does not retry a transport failure", async () => {
    let calls = 0;
    const error = (await describeClip(
      "/cache/vid-a.mp4",
      stubDeps(async () => {
        calls++;
        throw new Error("429 Too Many Requests");
      }),
    ).catch((caught: unknown) => caught)) as ClipDescribeError;

    expect(calls).toBe(1);
    expect(error.stage).toBe("model");
    expect(error.attempts).toBe(1);
  });

  test("attributes a proxy read failure to the read stage", async () => {
    const removed: string[] = [];
    const error = (await describeClip(
      "/cache/vid-a.mp4",
      stubDeps(async () => ({ object: DESCRIPTION }), removed, {
        readProxy: async () => {
          throw new Error("ENOENT: no such file");
        },
      }),
    ).catch((caught: unknown) => caught)) as ClipDescribeError;

    expect(error.stage).toBe("read");
    expect(error.detail).toContain("ENOENT");
    // Still cleaned up: the proxy existed as far as this function knows.
    expect(removed.length).toBe(1);
  });

  test("rethrows the original error untouched when the run was cancelled", async () => {
    const controller = new AbortController();
    const aborted = new Error("The operation was aborted");
    const caught = await describeClip(
      "/cache/vid-a.mp4",
      stubDeps(async () => {
        controller.abort();
        throw aborted;
      }, [], { signal: controller.signal }),
    ).catch((error: unknown) => error);

    // A cancelled run is not a property of the clip: wrapping it would write a
    // failure into `errors[]` for a row that never actually failed.
    expect(caught).toBe(aborted);
    expect(caught).not.toBeInstanceOf(ClipDescribeError);
  });

  test("does not wrap a ClipDescribeError the proxy builder already raised", async () => {
    const raised = new ClipDescribeError({ clip: "vid-a.mp4", stage: "proxy", attempts: 1, detail: "ffmpeg died" });
    const caught = await describeClip(
      "/cache/vid-a.mp4",
      stubDeps(async () => ({ object: DESCRIPTION }), [], {
        buildProxy: async () => {
          throw raised;
        },
      }),
    ).catch((error: unknown) => error);

    expect(caught).toBe(raised);
    expect((caught as ClipDescribeError).stage).toBe("proxy");
  });
});
