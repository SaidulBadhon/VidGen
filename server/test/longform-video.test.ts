/**
 * Long-form rendering logic that can be verified without spawning ffmpeg.
 *
 * Covers the single-pass replacements for the PNG overlay path: ASS document
 * generation, still-segment and soft-subtitle argument building, the capability
 * probe's parser, and the strategy that chooses between them.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  assFontFromNames,
  buildAssDocument,
  buildAssDialogueLine,
  buildAssStyleLine,
  buildPositionTag,
  escapeAssText,
  estimateCueHeight,
  formatAssTime,
  hexToAssColor,
  parseNameTable,
  resolveAssAlignment,
  resolveAssFont,
  type AssRenderOptions,
} from "../src/services/subtitle/ass.ts";
import { parseFilterNames } from "../src/services/video/capabilities.ts";
import {
  MAX_OVERLAY_INPUTS,
  resolveSubtitleStrategy,
  resolveSubtitleY,
  subtitleStrategyWarningCode,
  SUBTITLE_BURN_UNAVAILABLE_WARNING,
} from "../src/services/video/generate.ts";
import {
  buildStillArgs,
  buildStillAudioChains,
  buildStillFilterGraph,
  buildSubtitlesFilter,
} from "../src/services/video/still.ts";
import {
  buildSoftSubtitleArgs,
  sidecarSubtitlePath,
  toIso639_2,
} from "../src/services/video/softSubs.ts";
import type { SubtitleCue } from "../src/services/subtitle/srt.ts";
import { fontDir } from "../src/utils/paths.ts";

const baseOptions: AssRenderOptions = {
  width: 1080,
  height: 1920,
  fontPath: join(fontDir(), "MicrosoftYaHeiBold.ttc"),
  fontSize: 60,
  textForeColor: "#FFFFFF",
  strokeColor: "#000000",
  strokeWidth: 2,
  textBackgroundColor: false,
  roundedSubtitleBackground: false,
  subtitlePosition: "bottom",
  customPosition: 70,
};

function cue(start: number, end: number, text: string, index = 1): SubtitleCue {
  return { index, start, end, text };
}

describe("hexToAssColor", () => {
  test("reverses the channel order into BGR", () => {
    expect(hexToAssColor("#FF0000")).toBe("&H000000FF");
    expect(hexToAssColor("#00FF00")).toBe("&H0000FF00");
    expect(hexToAssColor("#0000FF")).toBe("&H00FF0000");
  });

  test("keeps greys and white symmetric", () => {
    expect(hexToAssColor("#FFFFFF")).toBe("&H00FFFFFF");
    expect(hexToAssColor("#000000")).toBe("&H00000000");
  });

  test("upper-cases mixed-case input", () => {
    expect(hexToAssColor("#1a2b3c")).toBe("&H003C2B1A");
  });

  test("writes transparency, not opacity, in the leading pair", () => {
    // 140/255 opacity for the rounded plate is 115 transparency.
    expect(hexToAssColor("#101010", 115)).toBe("&H73101010");
    expect(hexToAssColor("#101010", 255)).toBe("&HFF101010");
  });

  test("clamps an out-of-range alpha", () => {
    expect(hexToAssColor("#FFFFFF", -20)).toBe("&H00FFFFFF");
    expect(hexToAssColor("#FFFFFF", 900)).toBe("&HFFFFFFFF");
    expect(hexToAssColor("#FFFFFF", Number.NaN)).toBe("&H00FFFFFF");
  });

  test("falls back to black for anything malformed", () => {
    expect(hexToAssColor("nope")).toBe("&H00000000");
    expect(hexToAssColor("#FFF")).toBe("&H00000000");
    expect(hexToAssColor(true)).toBe("&H00000000");
    expect(hexToAssColor(undefined)).toBe("&H00000000");
  });
});

describe("formatAssTime", () => {
  test("formats zero with a single-digit hour", () => {
    expect(formatAssTime(0)).toBe("0:00:00.00");
  });

  test("keeps sub-second precision as centiseconds", () => {
    expect(formatAssTime(0.5)).toBe("0:00:00.50");
    expect(formatAssTime(1.07)).toBe("0:00:01.07");
  });

  test("rounds at the centisecond rather than truncating", () => {
    expect(formatAssTime(0.004)).toBe("0:00:00.00");
    expect(formatAssTime(0.005)).toBe("0:00:00.01");
    // Rounding must carry into the seconds field, not print ".100".
    expect(formatAssTime(59.999)).toBe("0:01:00.00");
  });

  test("carries past an hour", () => {
    expect(formatAssTime(3600)).toBe("1:00:00.00");
    expect(formatAssTime(3661.239)).toBe("1:01:01.24");
    expect(formatAssTime(36000)).toBe("10:00:00.00");
  });

  test("clamps nonsense to zero", () => {
    expect(formatAssTime(-5)).toBe("0:00:00.00");
    expect(formatAssTime(Number.NaN)).toBe("0:00:00.00");
  });
});

describe("escapeAssText", () => {
  test("neutralises override braces", () => {
    expect(escapeAssText("a {b} c")).toBe("a \\{b\\} c");
  });

  test("doubles backslashes so they cannot become line breaks", () => {
    expect(escapeAssText("back\\slash")).toBe("back\\\\slash");
    expect(escapeAssText("literal \\N here")).toBe("literal \\\\N here");
  });

  test("turns every newline flavour into \\N", () => {
    expect(escapeAssText("one\ntwo")).toBe("one\\Ntwo");
    expect(escapeAssText("one\r\ntwo")).toBe("one\\Ntwo");
    expect(escapeAssText("one\rtwo")).toBe("one\\Ntwo");
  });

  test("trims surrounding whitespace and survives empty input", () => {
    expect(escapeAssText("  padded  ")).toBe("padded");
    expect(escapeAssText("")).toBe("");
  });
});

describe("resolveAssAlignment", () => {
  test("maps the app's positions onto ASS numpad alignments", () => {
    expect(resolveAssAlignment("bottom")).toBe(2);
    expect(resolveAssAlignment("top")).toBe(8);
    expect(resolveAssAlignment("center")).toBe(5);
  });

  test("uses middle-centre for custom, since MarginV is ignored there", () => {
    expect(resolveAssAlignment("custom")).toBe(5);
    expect(resolveAssAlignment("anything-else")).toBe(5);
  });
});

describe("buildPositionTag", () => {
  test("emits nothing for margin-driven positions", () => {
    for (const subtitlePosition of ["bottom", "top", "center"]) {
      expect(buildPositionTag({ ...baseOptions, subtitlePosition }, 1)).toBe("");
    }
  });

  test("agrees with resolveSubtitleY for a custom position", () => {
    const options = { ...baseOptions, subtitlePosition: "custom", customPosition: 70 };
    const cueHeight = estimateCueHeight(options.fontSize, 2);
    const top = resolveSubtitleY("custom", 70, options.height, cueHeight);

    // \pos anchors the block's centre because the style aligns middle-centre.
    expect(buildPositionTag(options, 2)).toBe(
      `{\\pos(${Math.round(options.width / 2)},${Math.round(top + cueHeight / 2)})}`,
    );
  });

  test("inherits resolveSubtitleY's on-screen clamping at both extremes", () => {
    const options = { ...baseOptions, subtitlePosition: "custom" };
    const cueHeight = estimateCueHeight(options.fontSize, 1);

    const low = buildPositionTag({ ...options, customPosition: 0 }, 1);
    const high = buildPositionTag({ ...options, customPosition: 100 }, 1);

    expect(low).toBe(`{\\pos(540,${Math.round(10 + cueHeight / 2)})}`);
    expect(high).toBe(`{\\pos(540,${Math.round(1920 - cueHeight - 10 + cueHeight / 2)})}`);
  });

  test("moves a taller block up, matching the overlay geometry", () => {
    const options = { ...baseOptions, subtitlePosition: "custom", customPosition: 50 };
    const one = estimateCueHeight(options.fontSize, 1);
    const three = estimateCueHeight(options.fontSize, 3);
    expect(three).toBeGreaterThan(one);

    // Centring on the block means the centre is the same regardless of height.
    expect(buildPositionTag(options, 1)).toBe(buildPositionTag(options, 3));
  });
});

describe("buildAssStyleLine", () => {
  test("uses the stroke colour as the outline without a plate", () => {
    const line = buildAssStyleLine({ ...baseOptions, strokeColor: "#123456", strokeWidth: 3 });
    const fields = line.replace("Style: ", "").split(",");
    expect(fields[15]).toBe("1"); // BorderStyle
    expect(fields[5]).toBe("&H00563412"); // OutlineColour
    expect(fields[16]).toBe("3"); // Outline width
  });

  test("puts the plate colour on OutlineColour for an opaque box", () => {
    // BorderStyle=3 fills with OutlineColour; BackColour is only the shadow.
    const line = buildAssStyleLine({ ...baseOptions, textBackgroundColor: "#101020" });
    const fields = line.replace("Style: ", "").split(",");
    expect(fields[15]).toBe("3");
    expect(fields[5]).toBe("&H00201010");
    expect(fields[6]).toBe("&H00000000");
  });

  test("keeps the rounded plate's translucency even without rounded corners", () => {
    const line = buildAssStyleLine({
      ...baseOptions,
      textBackgroundColor: "#101020",
      roundedSubtitleBackground: true,
    });
    expect(line).toContain("&H73201010");
  });

  test("accepts the legacy boolean background", () => {
    const line = buildAssStyleLine({ ...baseOptions, textBackgroundColor: true });
    const fields = line.replace("Style: ", "").split(",");
    expect(fields[15]).toBe("3");
    expect(fields[5]).toBe("&H00000000");
  });

  test("derives margins from the frame size", () => {
    const fields = buildAssStyleLine(baseOptions).replace("Style: ", "").split(",");
    expect(fields[18]).toBe("2"); // Alignment: bottom-centre
    expect(fields[19]).toBe("54"); // MarginL: 5% of 1080
    expect(fields[20]).toBe("54");
    expect(fields[21]).toBe("96"); // MarginV: 5% of 1920, as in resolveSubtitleY
  });

  test("names the font family, not the file, and carries its weight", () => {
    const fields = buildAssStyleLine(baseOptions).replace("Style: ", "").split(",");
    expect(fields[1]).toBe("Microsoft YaHei");
    expect(fields[7]).toBe("-1"); // Bold, from the file's subfamily
  });
});

describe("buildAssDialogueLine", () => {
  test("writes one escaped, timed dialogue per cue", () => {
    expect(buildAssDialogueLine(cue(0, 2.5, "Hello"), baseOptions)).toBe(
      "Dialogue: 0,0:00:00.00,0:00:02.50,VidGen,,0,0,0,,Hello",
    );
  });

  test("drops a cue with no visible text", () => {
    expect(buildAssDialogueLine(cue(0, 1, "   "), baseOptions)).toBeNull();
  });

  test("counts wrapped lines when positioning a custom cue", () => {
    const options = { ...baseOptions, subtitlePosition: "custom", customPosition: 20 };
    const line = buildAssDialogueLine(cue(0, 1, "one\ntwo"), options)!;
    expect(line).toContain(buildPositionTag(options, 2));
    expect(line).toEndWith("one\\Ntwo");
  });
});

describe("buildAssDocument", () => {
  const cues = [cue(0, 2, "First", 1), cue(2, 4, "Second", 2), cue(4, 6, "  ", 3)];

  test("emits the three required sections in order", () => {
    const document = buildAssDocument(cues, baseOptions);
    expect(document.indexOf("[Script Info]")).toBe(0);
    expect(document.indexOf("[V4+ Styles]")).toBeGreaterThan(document.indexOf("[Script Info]"));
    expect(document.indexOf("[Events]")).toBeGreaterThan(document.indexOf("[V4+ Styles]"));
    expect(document).toContain("ScriptType: v4.00+");
  });

  test("declares the real frame size, or every size and margin is wrong", () => {
    const document = buildAssDocument(cues, { ...baseOptions, width: 1920, height: 1080 });
    expect(document).toContain("PlayResX: 1920");
    expect(document).toContain("PlayResY: 1080");
  });

  test("carries the format lines each section needs", () => {
    const document = buildAssDocument(cues, baseOptions);
    expect(document).toContain("Format: Name, Fontname, Fontsize, PrimaryColour");
    expect(document).toContain("Format: Layer, Start, End, Style, Name");
    expect(document).toContain("Style: VidGen,");
  });

  test("writes one Dialogue per non-empty cue", () => {
    const document = buildAssDocument(cues, baseOptions);
    const dialogues = document.split("\n").filter((line) => line.startsWith("Dialogue:"));
    expect(dialogues).toHaveLength(2);
    expect(dialogues[0]).toEndWith("First");
    expect(dialogues[1]).toEndWith("Second");
  });

  test("scales to a whole chapter without repeating the style", () => {
    const many = Array.from({ length: 400 }, (_, index) =>
      cue(index * 2, index * 2 + 2, `line ${index}`, index + 1),
    );
    const document = buildAssDocument(many, baseOptions);
    expect(document.split("\n").filter((line) => line.startsWith("Dialogue:"))).toHaveLength(400);
    expect(document.split("\n").filter((line) => line.startsWith("Style:"))).toHaveLength(1);
  });

  test("handles no cues at all", () => {
    const document = buildAssDocument([], baseOptions);
    expect(document).toContain("[Events]");
    expect(document).not.toContain("Dialogue:");
  });

  test("names a Bangla-capable family when the chosen font cannot draw the cues", () => {
    // libass would otherwise draw every cue as blank boxes: the default font is
    // CJK-only, so a Bangla narration burns in with no readable subtitles.
    const document = buildAssDocument([cue(0, 2, "আজকের ভিডিওতে আমরা শিখব")], baseOptions);
    expect(document).toContain("Noto Sans Bengali");
    expect(document).not.toContain("Microsoft YaHei");
  });

  test("leaves the chosen family alone when it covers the cues", () => {
    const document = buildAssDocument([cue(0, 2, "春天的花海")], baseOptions);
    expect(document).toContain("Microsoft YaHei");
  });
});

describe("font family resolution", () => {
  /** Minimal sfnt `name` table: family and subfamily as Windows UTF-16BE. */
  function nameTable(entries: { nameId: number; value: string }[]): Uint8Array {
    const encoded = entries.map(({ nameId, value }) => {
      const bytes = new Uint8Array(value.length * 2);
      for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        bytes[index * 2] = code >> 8;
        bytes[index * 2 + 1] = code & 0xff;
      }
      return { nameId, bytes };
    });

    const stringOffset = 6 + encoded.length * 12;
    const strings = encoded.reduce((total, entry) => total + entry.bytes.byteLength, 0);
    const table = new Uint8Array(stringOffset + strings);
    const view = new DataView(table.buffer);

    view.setUint16(0, 0);
    view.setUint16(2, encoded.length);
    view.setUint16(4, stringOffset);

    let cursor = 0;
    encoded.forEach((entry, index) => {
      const record = 6 + index * 12;
      view.setUint16(record, 3); // Windows
      view.setUint16(record + 2, 1); // UCS-2
      view.setUint16(record + 4, 0x409); // en-US
      view.setUint16(record + 6, entry.nameId);
      view.setUint16(record + 8, entry.bytes.byteLength);
      view.setUint16(record + 10, cursor);
      table.set(entry.bytes, stringOffset + cursor);
      cursor += entry.bytes.byteLength;
    });

    return table;
  }

  test("parses family and subfamily out of a name table", () => {
    const names = parseNameTable(
      nameTable([
        { nameId: 1, value: "Test Family" },
        { nameId: 2, value: "Bold Italic" },
      ]),
    );
    expect(names.get(1)).toBe("Test Family");
    expect(names.get(2)).toBe("Bold Italic");
  });

  test("survives a truncated table instead of throwing", () => {
    expect(parseNameTable(new Uint8Array(0)).size).toBe(0);
    expect(parseNameTable(new Uint8Array([0, 0, 0, 5, 0, 30])).size).toBe(0);
  });

  test("reads the weight from the subfamily", () => {
    const names = new Map([
      [1, "Test Family"],
      [2, "Bold Italic"],
    ]);
    expect(assFontFromNames(names, "fallback")).toEqual({
      family: "Test Family",
      bold: true,
      italic: true,
    });
  });

  test("falls back to the filename stem when the table is unreadable", () => {
    expect(assFontFromNames(null, "SomeFont")).toEqual({
      family: "SomeFont",
      bold: false,
      italic: false,
    });
  });

  test("resolves a bundled font to its family, not its filename", () => {
    // font_name is a filename; ASS needs the family, and the two differ for
    // every font this app ships.
    expect(resolveAssFont(join(fontDir(), "MicrosoftYaHeiBold.ttc"))).toEqual({
      family: "Microsoft YaHei",
      bold: true,
      italic: false,
    });
    expect(resolveAssFont(join(fontDir(), "BeVietnamPro-Bold.ttf"))).toEqual({
      family: "Be Vietnam Pro",
      bold: true,
      italic: false,
    });
  });

  test("degrades to the stem for a missing file", () => {
    expect(resolveAssFont(join(fontDir(), "does-not-exist.ttf")).family).toBe("does-not-exist");
  });
});

describe("parseFilterNames", () => {
  // Real output shape: legend rows share the flags column but have no "->".
  const header = [
    "Filters:",
    "  T.. = Timeline support",
    "  .S. = Slice threading",
    "  A = Audio input/output",
    "  ------",
  ].join("\n");

  test("finds the subtitles filter in a libass build", () => {
    const output = [
      header,
      " ... subtitles        V->V       Render text subtitles onto input video using the libass library.",
      " ... ass              V->V       Render ASS subtitles onto input video using the libass library.",
      " TS overlay           VV->V      Overlay a video source on top of the input.",
    ].join("\n");

    const names = parseFilterNames(output);
    expect(names.has("subtitles")).toBe(true);
    expect(names.has("ass")).toBe(true);
    expect(names.has("overlay")).toBe(true);
  });

  test("reports no subtitles filter for a build without libass", () => {
    const output = [
      header,
      " TS overlay           VV->V      Overlay a video source on top of the input.",
      " .. scale             V->V       Scale the input video size.",
    ].join("\n");

    const names = parseFilterNames(output);
    expect(names.has("subtitles")).toBe(false);
    expect(names.has("overlay")).toBe(true);
  });

  test("ignores the legend rows that share the flags column", () => {
    const names = parseFilterNames(header);
    expect(names.size).toBe(0);
  });

  test("reads source and sink filters, whose io column is one-sided", () => {
    const names = parseFilterNames(" ..C color            |->V       Provide an uniformly coloured input.");
    expect(names.has("color")).toBe(true);
  });

  test("returns nothing for empty or garbage output", () => {
    expect(parseFilterNames("").size).toBe(0);
    expect(parseFilterNames("command not found").size).toBe(0);
  });
});

describe("resolveSubtitleStrategy", () => {
  const short = 25;
  const long = MAX_OVERLAY_INPUTS + 1;

  test("leaves short renders on the existing overlay path", () => {
    expect(resolveSubtitleStrategy({ cueCount: short, assAvailable: true })).toBe("overlay");
    expect(resolveSubtitleStrategy({ cueCount: short, requested: null, assAvailable: false })).toBe(
      "overlay",
    );
    expect(resolveSubtitleStrategy({ cueCount: MAX_OVERLAY_INPUTS, assAvailable: false })).toBe(
      "overlay",
    );
  });

  test("routes long renders to a soft track rather than multi-pass compositing", () => {
    expect(resolveSubtitleStrategy({ cueCount: long, assAvailable: false })).toBe("soft");
    expect(resolveSubtitleStrategy({ cueCount: long, assAvailable: true })).toBe("soft");
  });

  test("honours an explicit request over the cue count", () => {
    expect(resolveSubtitleStrategy({ cueCount: long, requested: "none", assAvailable: true })).toBe(
      "none",
    );
    expect(resolveSubtitleStrategy({ cueCount: short, requested: "soft", assAvailable: true })).toBe(
      "soft",
    );
    expect(resolveSubtitleStrategy({ cueCount: short, requested: "burn", assAvailable: true })).toBe(
      "ass",
    );
  });

  test("falls back to soft when burn-in is asked for and libass is missing", () => {
    // The whole point of the fallback: a long render must never be composited
    // in six full re-encodes just because this ffmpeg lacks libass.
    expect(resolveSubtitleStrategy({ cueCount: long, requested: "burn", assAvailable: false })).toBe(
      "soft",
    );
  });

  test("still burns short content with overlays when libass is missing", () => {
    expect(resolveSubtitleStrategy({ cueCount: short, requested: "burn", assAvailable: false })).toBe(
      "overlay",
    );
    expect(resolveSubtitleStrategy({ cueCount: 0, requested: "burn", assAvailable: false })).toBe(
      "overlay",
    );
  });
});

describe("subtitleStrategyWarningCode", () => {
  const long = MAX_OVERLAY_INPUTS + 1;

  test("warns only when a burn request had to degrade to a soft track", () => {
    expect(subtitleStrategyWarningCode({ cueCount: long, requested: "burn", assAvailable: false })).toBe(
      SUBTITLE_BURN_UNAVAILABLE_WARNING,
    );
  });

  test("stays silent when nothing was degraded", () => {
    expect(subtitleStrategyWarningCode({ cueCount: long, requested: "burn", assAvailable: true })).toBeNull();
    expect(subtitleStrategyWarningCode({ cueCount: 25, requested: "burn", assAvailable: false })).toBeNull();
    expect(subtitleStrategyWarningCode({ cueCount: long, requested: "soft", assAvailable: false })).toBeNull();
    expect(subtitleStrategyWarningCode({ cueCount: long, assAvailable: false })).toBeNull();
  });
});

describe("buildSubtitlesFilter", () => {
  test("escapes the option separator inside a path", () => {
    // A bare colon would be read as the start of the next filter option.
    expect(buildSubtitlesFilter("/tmp/a:b/subs.ass")).toBe("subtitles=filename=/tmp/a\\:b/subs.ass");
  });

  test("escapes backslashes, quotes and commas", () => {
    expect(buildSubtitlesFilter("C:\\media\\it's, here.ass")).toBe(
      "subtitles=filename=C\\:\\\\media\\\\it\\'s\\, here.ass",
    );
  });

  test("adds fontsdir so libass can find a bundled font file", () => {
    expect(buildSubtitlesFilter("/tmp/subs.ass", "/app/resource/fonts")).toBe(
      "subtitles=filename=/tmp/subs.ass:fontsdir=/app/resource/fonts",
    );
  });
});

describe("buildStillFilterGraph", () => {
  test("fits and pads to the target frame with a square pixel ratio", () => {
    expect(buildStillFilterGraph(1920, 1080)).toBe(
      "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1",
    );
  });

  test("burns captions in the same chain, so they cost no extra pass", () => {
    const graph = buildStillFilterGraph(1920, 1080, "/tmp/subs.ass", "/fonts");
    expect(graph).toStartWith("scale=1920:1080");
    // libass must draw after the fit, against the final frame size the ASS
    // PlayRes describes.
    expect(graph.indexOf("subtitles=")).toBeGreaterThan(graph.indexOf("setsar=1"));
  });
});

describe("buildStillArgs", () => {
  const input = {
    imagePath: "/tmp/cover.png",
    audioPath: "/tmp/chapter.mp3",
    outputFile: "/tmp/segment.mp4",
    width: 1920,
    height: 1080,
    duration: 903.25,
    audioSampleRate: 24000,
    fps: 5,
    threads: 4,
  };

  test("loops the still at an explicit input frame rate", () => {
    const args = buildStillArgs(input, "libx264");
    expect(args.slice(0, 6)).toEqual(["-y", "-loop", "1", "-framerate", "5", "-i"]);
  });

  test("maps both streams explicitly", () => {
    const args = buildStillArgs(input, "libx264").join(" ");
    expect(args).toContain("-map 0:v:0");
    expect(args).toContain("-map 1:a:0");
  });

  test("bounds the segment by the probed narration length", () => {
    const args = buildStillArgs(input, "libx264");
    expect(args[args.indexOf("-t") + 1]).toBe("903.25");
    expect(args).toContain("-shortest");
  });

  test("leaves the cut to -shortest when the duration is unknown", () => {
    const args = buildStillArgs({ ...input, duration: 0 }, "libx264");
    expect(args).not.toContain("-t");
    expect(args).toContain("-shortest");
  });

  test("writes a widely playable file", () => {
    const args = buildStillArgs(input, "libx264").join(" ");
    expect(args).toContain("-pix_fmt yuv420p");
    expect(args).toContain("-movflags +faststart");
    expect(args).toContain("setsar=1");
  });

  test("reuses the pipeline's audio settings", () => {
    const args = buildStillArgs(input, "libx264").join(" ");
    expect(args).toContain("-c:a aac");
    expect(args).toContain("-b:a 192k");
    expect(args).toContain("-ar 24000");
  });

  test("tunes for a still only on libx264", () => {
    // -tune is an x264 option; the hardware encoders reject or ignore it.
    expect(buildStillArgs(input, "libx264")).toContain("stillimage");
    for (const codec of ["h264_videotoolbox", "h264_nvenc", "h264_qsv", "h264_amf"]) {
      expect(buildStillArgs(input, codec)).not.toContain("stillimage");
    }
  });

  test("carries the codec's own quality flags", () => {
    expect(buildStillArgs(input, "libx264").join(" ")).toContain("-crf 23");
    expect(buildStillArgs(input, "h264_videotoolbox").join(" ")).toContain("-b:v 6M");
  });

  test("ends with the output path", () => {
    const args = buildStillArgs(input, "libx264");
    expect(args[args.length - 1]).toBe("/tmp/segment.mp4");
  });

  describe("with background music", () => {
    const scored = { ...input, bgmPath: "/tmp/calm.mp3", bgmVolume: 0.2 };

    test("loops the track, because a chapter outlasts any library file", () => {
      const args = buildStillArgs(scored, "libx264");
      // -stream_loop applies to the input that follows it, so it must sit
      // between the narration and the music, never before the image.
      expect(args.slice(args.indexOf("-stream_loop"), args.indexOf("-stream_loop") + 4)).toEqual([
        "-stream_loop",
        "-1",
        "-i",
        "/tmp/calm.mp3",
      ]);
      expect(args.indexOf("-stream_loop")).toBeGreaterThan(args.indexOf("/tmp/chapter.mp3"));
    });

    test("moves the picture into the complex graph, since -vf cannot coexist with it", () => {
      const args = buildStillArgs(scored, "libx264");
      expect(args).not.toContain("-vf");
      const graph = args[args.indexOf("-filter_complex") + 1]!;
      expect(graph).toContain("[0:v]scale=1920:1080");
      expect(graph).toContain("[v]");
      expect(args).toContain("[v]");
      expect(args).toContain("[aout]");
    });

    test("mixes at the requested gain and sums rather than averages", () => {
      const graph = buildStillAudioChains(0.2, 903.25).join(";");
      expect(graph).toContain("[2:a]volume=0.2");
      // normalize=0 keeps the narration at full level once music is added.
      expect(graph).toContain("[1:a][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]");
    });

    test("fades the music out over the last seconds of the narration", () => {
      expect(buildStillAudioChains(0.2, 903.25).join(";")).toContain("afade=t=out:st=900.25:d=3");
    });

    test("skips the fade when there is no length to fade from", () => {
      // An unknown duration and a segment shorter than the fade would both
      // start the music already quiet.
      expect(buildStillAudioChains(0.2, 0).join(";")).not.toContain("afade");
      expect(buildStillAudioChains(0.2, 2).join(";")).not.toContain("afade");
    });

    test("still bounds the output by the narration", () => {
      const args = buildStillArgs(scored, "libx264");
      expect(args[args.indexOf("-t") + 1]).toBe("903.25");
      expect(args).toContain("-shortest");
    });

    test("leaves the single-input form alone when there is no music", () => {
      const args = buildStillArgs(input, "libx264");
      expect(args).not.toContain("-stream_loop");
      expect(args).not.toContain("-filter_complex");
      expect(args).toContain("-vf");
    });
  });
});

describe("buildSoftSubtitleArgs", () => {
  const input = {
    videoPath: "/tmp/final.mp4",
    subtitlePath: "/tmp/final.srt",
    outputFile: "/tmp/final-subbed.mp4",
    language: "eng",
    title: "Subtitles",
  };

  test("takes the SRT as a second input with explicit maps", () => {
    const args = buildSoftSubtitleArgs(input);
    expect(args.slice(0, 5)).toEqual(["-y", "-i", "/tmp/final.mp4", "-i", "/tmp/final.srt"]);
    const joined = args.join(" ");
    expect(joined).toContain("-map 0:v:0");
    // Optional audio, so a silent render still muxes.
    expect(joined).toContain("-map 0:a?");
    expect(joined).toContain("-map 1:0");
  });

  test("copies the picture and converts only the subtitle stream", () => {
    const joined = buildSoftSubtitleArgs(input).join(" ");
    expect(joined).toContain("-c copy");
    expect(joined).toContain("-c:s mov_text");
  });

  test("labels the track and marks it default", () => {
    const joined = buildSoftSubtitleArgs(input).join(" ");
    expect(joined).toContain("-metadata:s:s:0 language=eng");
    expect(joined).toContain("-metadata:s:s:0 title=Subtitles");
    expect(joined).toContain("-disposition:s:0 default");
  });

  test("never passes -shortest on a remux", () => {
    // On a stream copy it would truncate the video at whichever stream ends
    // first, which for captions is arbitrary.
    expect(buildSoftSubtitleArgs(input)).not.toContain("-shortest");
  });

  test("keeps the output streamable", () => {
    expect(buildSoftSubtitleArgs(input).join(" ")).toContain("-movflags +faststart");
  });
});

describe("toIso639_2", () => {
  test("widens a two-letter or BCP-47 tag", () => {
    expect(toIso639_2("en")).toBe("eng");
    expect(toIso639_2("en-US")).toBe("eng");
    expect(toIso639_2("zh-CN")).toBe("zho");
    expect(toIso639_2("pt_BR")).toBe("por");
  });

  test("passes an existing three-letter code through", () => {
    expect(toIso639_2("jpn")).toBe("jpn");
  });

  test("marks anything unknown as undetermined rather than guessing", () => {
    expect(toIso639_2("")).toBe("und");
    expect(toIso639_2(null)).toBe("und");
    expect(toIso639_2("klingon-1")).toBe("und");
  });
});

describe("sidecarSubtitlePath", () => {
  test("sits next to the video with an .srt extension", () => {
    expect(sidecarSubtitlePath("/tmp/tasks/abc/final-1.mp4")).toBe("/tmp/tasks/abc/final-1.srt");
  });

  test("handles a name with dots and no extension", () => {
    expect(sidecarSubtitlePath("/tmp/chapter.01.mkv")).toBe("/tmp/chapter.01.srt");
    expect(sidecarSubtitlePath("/tmp/plain")).toBe("/tmp/plain.srt");
  });
});
