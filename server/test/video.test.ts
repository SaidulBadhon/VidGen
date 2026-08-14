/**
 * Video engine logic that can be verified without spawning ffmpeg.
 * Cases ported from python-version/test/services/test_video.py,
 * test_clip_speed.py and test_video_effects.py.
 */

import { describe, expect, test } from "bun:test";
import {
  getRequiredVideoDuration,
  isMaterialResolutionAcceptable,
  prioritizeUniqueSourceClips,
  shuffleInPlace,
  type SubClippedItem,
} from "../src/services/video/combine.ts";
import { buildClipFilterGraph, buildFitFilter } from "../src/services/video/clip.ts";
import { buildTransitionGraph, pickSlideSide, resolveTransition } from "../src/services/video/transitions.ts";
import { formatConcatPath } from "../src/services/video/concat.ts";
import { buildOverlayChain, resolveSubtitleY } from "../src/services/video/generate.ts";
import {
  fontSupportsText,
  hexToRgb,
  registerSubtitleFont,
  resolveBackgroundColor,
  resolveSubtitleFontPath,
  wrapText,
} from "../src/services/video/textRender.ts";
import { aspectToResolution } from "../src/models/schema.ts";
import { fontDir } from "../src/utils/paths.ts";
import { join } from "node:path";

/** Deterministic stand-in for Math.random so ordering tests are stable. */
function sequenceRandom(values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length]!;
}

describe("aspectToResolution", () => {
  test("maps every supported ratio", () => {
    expect(aspectToResolution("16:9")).toEqual([1920, 1080]);
    expect(aspectToResolution("9:16")).toEqual([1080, 1920]);
    expect(aspectToResolution("1:1")).toEqual([1080, 1080]);
  });
});

describe("isMaterialResolutionAcceptable", () => {
  test("accepts material at or above the minimum", () => {
    expect(isMaterialResolutionAcceptable(1080, 1920)).toBe(true);
    expect(isMaterialResolutionAcceptable(480, 480)).toBe(true);
  });

  test("tolerates encoder rounding just below the minimum", () => {
    // WhatsApp emits 478x850 for 9:16; rejecting it failed whole tasks.
    expect(isMaterialResolutionAcceptable(478, 850)).toBe(true);
    expect(isMaterialResolutionAcceptable(470, 850)).toBe(true);
  });

  test("still rejects genuinely low-resolution material", () => {
    expect(isMaterialResolutionAcceptable(320, 240)).toBe(false);
    expect(isMaterialResolutionAcceptable(469, 850)).toBe(false);
  });
});

describe("getRequiredVideoDuration", () => {
  test("adds the frame-rounding safety margin", () => {
    expect(getRequiredVideoDuration(10)).toBeCloseTo(10.1, 5);
    expect(getRequiredVideoDuration(0)).toBeCloseTo(0.1, 5);
  });
});

describe("prioritizeUniqueSourceClips", () => {
  const items: SubClippedItem[] = [
    { filePath: "a.mp4", startTime: 0, endTime: 5, width: 1080, height: 1920, duration: 5, sourceFilePath: "a.mp4" },
    { filePath: "a.mp4", startTime: 5, endTime: 7, width: 1080, height: 1920, duration: 2, sourceFilePath: "a.mp4" },
    { filePath: "b.mp4", startTime: 0, endTime: 3, width: 1080, height: 1920, duration: 3, sourceFilePath: "b.mp4" },
  ];

  test("puts each source's longest clip before any repeat", () => {
    const ordered = prioritizeUniqueSourceClips(items, "random", sequenceRandom([0]));
    expect(ordered).toHaveLength(3);

    const primaries = ordered.slice(0, 2).map((item) => item.sourceFilePath).sort();
    expect(primaries).toEqual(["a.mp4", "b.mp4"]);
    // The 5s clip from a.mp4 wins over its 2s tail fragment.
    expect(ordered.find((item) => item.sourceFilePath === "a.mp4")!.duration).toBe(5);
    expect(ordered[2]!.duration).toBe(2);
  });

  test("leaves sequential order untouched", () => {
    expect(prioritizeUniqueSourceClips(items, "sequential")).toEqual(items);
  });

  test("handles an empty list", () => {
    expect(prioritizeUniqueSourceClips([], "random")).toEqual([]);
  });
});

describe("shuffleInPlace", () => {
  test("preserves every element", () => {
    const input = [1, 2, 3, 4, 5];
    const output = shuffleInPlace([...input], sequenceRandom([0.1, 0.9, 0.4, 0.6]));
    expect([...output].sort((a, b) => a - b)).toEqual(input);
  });
});

describe("buildFitFilter", () => {
  test("scales to fit and pads on black", () => {
    // decrease + centred pad covers both the exact-ratio and letterbox cases.
    expect(buildFitFilter(1080, 1920)).toBe(
      "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1",
    );
  });
});

describe("buildClipFilterGraph", () => {
  const base = { width: 1080, height: 1920, duration: 4, fps: 30, slideSide: "left" as const };

  test("omits setpts at normal speed", () => {
    const { filterComplex } = buildClipFilterGraph({ ...base, speed: 1, transition: null });
    expect(filterComplex).not.toContain("setpts");
    expect(filterComplex).toContain("[0:v]");
    expect(filterComplex).toContain("[out]");
  });

  test("applies setpts for a speed change", () => {
    const { filterComplex } = buildClipFilterGraph({ ...base, speed: 1.5, transition: null });
    expect(filterComplex).toContain("setpts=PTS/1.5");
  });

  test("fades in from the start", () => {
    const { filterComplex } = buildClipFilterGraph({ ...base, speed: 1, transition: "FadeIn" });
    expect(filterComplex).toContain("fade=t=in:st=0:d=1");
  });

  test("fades out over the final second", () => {
    const { filterComplex } = buildClipFilterGraph({ ...base, speed: 1, transition: "FadeOut" });
    expect(filterComplex).toContain("fade=t=out:st=3:d=1");
  });

  test("composites a slide onto a black background", () => {
    const { filterComplex } = buildClipFilterGraph({ ...base, speed: 1, transition: "SlideIn" });
    expect(filterComplex).toContain("color=c=black:s=1080x1920");
    expect(filterComplex).toContain("overlay=");
    expect(filterComplex).toContain("-1080+1080*");
  });

  test("pre-upscales before zooming", () => {
    // zoompan truncates its crop origin, so the 2x pass is what keeps a slow
    // centre zoom from visibly stepping.
    const { filterComplex } = buildClipFilterGraph({ ...base, speed: 1, transition: "ZoomIn" });
    expect(filterComplex).toContain("scale=2160:3840");
    expect(filterComplex).toContain("zoompan=");
    expect(filterComplex).toContain("s=1080x1920");
  });
});

describe("resolveTransition", () => {
  test("passes concrete modes through", () => {
    expect(resolveTransition("FadeIn")).toBe("FadeIn");
    expect(resolveTransition(null)).toBeNull();
    expect(resolveTransition(undefined)).toBeNull();
  });

  test("resolves Shuffle to a concrete effect", () => {
    expect(resolveTransition("Shuffle", () => 0)).toBe("FadeIn");
    expect(resolveTransition("Shuffle", () => 0.99)).toBe("ZoomOut");
  });
});

describe("buildTransitionGraph", () => {
  test("returns an empty graph without a transition", () => {
    const graph = buildTransitionGraph(null, {
      width: 1080,
      height: 1920,
      duration: 4,
      fps: 30,
      side: "left",
    });
    expect(graph.extraChains).toEqual([]);
    expect(graph.chainSuffix).toEqual([]);
  });

  test("slides out only in the final second", () => {
    const graph = buildTransitionGraph("SlideOut", {
      width: 1080,
      height: 1920,
      duration: 4,
      fps: 30,
      side: "right",
    });
    expect(graph.overlay?.x).toContain("t-3");
  });
});

describe("pickSlideSide", () => {
  test("returns a valid side", () => {
    expect(pickSlideSide(() => 0)).toBe("left");
    expect(["left", "right", "top", "bottom"]).toContain(pickSlideSide());
  });
});

describe("formatConcatPath", () => {
  test("normalises separators and escapes quotes", () => {
    expect(formatConcatPath("/tmp/a b/clip.mp4")).toBe("/tmp/a b/clip.mp4");
    expect(formatConcatPath("/tmp/it's/clip.mp4")).toBe("/tmp/it'\\''s/clip.mp4");
  });
});

describe("resolveSubtitleY", () => {
  const height = 1920;
  const cueHeight = 200;

  test("places bottom captions above the safe margin", () => {
    expect(resolveSubtitleY("bottom", 70, height, cueHeight)).toBeCloseTo(1920 * 0.95 - 200, 5);
  });

  test("places top captions below the safe margin", () => {
    expect(resolveSubtitleY("top", 70, height, cueHeight)).toBeCloseTo(96, 5);
  });

  test("centres by default", () => {
    expect(resolveSubtitleY("center", 70, height, cueHeight)).toBe(860);
  });

  test("clamps a custom position on screen", () => {
    expect(resolveSubtitleY("custom", 0, height, cueHeight)).toBe(10);
    expect(resolveSubtitleY("custom", 100, height, cueHeight)).toBe(1710);
    expect(resolveSubtitleY("custom", 50, height, cueHeight)).toBe(860);
  });
});

describe("buildOverlayChain", () => {
  test("chains one overlay per cue with a time gate", () => {
    const { chains, outputLabel } = buildOverlayChain(
      [
        { imagePath: "a.png", width: 900, height: 200, x: 90, y: 1600, start: 0, end: 2 },
        { imagePath: "b.png", width: 900, height: 200, x: 90, y: 1600, start: 2, end: 4 },
      ],
      1,
    );
    expect(chains).toHaveLength(2);
    expect(chains[0]).toContain("[0:v][1:v]overlay=x=90:y=1600:enable='between(t,0,2)'[sub0]");
    expect(chains[1]).toContain("[sub0][2:v]overlay=");
    expect(outputLabel).toBe("sub1");
  });

  test("produces nothing without cues", () => {
    const { chains, outputLabel } = buildOverlayChain([], 1);
    expect(chains).toEqual([]);
    expect(outputLabel).toBe("0:v");
  });
});

describe("hexToRgb", () => {
  test("parses valid colours", () => {
    expect(hexToRgb("#FFFFFF")).toEqual([255, 255, 255]);
    expect(hexToRgb("#1a1a2e")).toEqual([26, 26, 46]);
  });

  test("falls back to black for anything malformed", () => {
    expect(hexToRgb("nope")).toEqual([0, 0, 0]);
    expect(hexToRgb(true)).toEqual([0, 0, 0]);
    expect(hexToRgb(undefined)).toEqual([0, 0, 0]);
  });
});

describe("resolveBackgroundColor", () => {
  test("normalises the historically overloaded field", () => {
    expect(resolveBackgroundColor(false)).toBeNull();
    expect(resolveBackgroundColor(true)).toBe("#000000");
    expect(resolveBackgroundColor("#123456")).toBe("#123456");
    expect(resolveBackgroundColor("")).toBeNull();
  });
});

describe("wrapText", () => {
  const family = registerSubtitleFont(join(fontDir(), "MicrosoftYaHeiBold.ttc"));

  test("leaves short text on one line", () => {
    const result = wrapText("Hello", 900, family, 60);
    expect(result.lines).toEqual(["Hello"]);
  });

  test("wraps English on word boundaries", () => {
    const result = wrapText("Artificial intelligence is reshaping how ordinary people work", 900, family, 60);
    expect(result.lines.length).toBeGreaterThan(1);
    // No word may be split when spaces are available.
    expect(result.lines.join(" ").replace(/\s+/g, " ")).toBe(
      "Artificial intelligence is reshaping how ordinary people work",
    );
  });

  test("splits CJK by character since it has no spaces", () => {
    const result = wrapText("春天的花海如诗如画般展现在眼前万物复苏的季节里", 600, family, 60);
    expect(result.lines.length).toBeGreaterThan(1);
    expect(result.lines.join("")).toBe("春天的花海如诗如画般展现在眼前万物复苏的季节里");
  });

  test("never starts a line with closing punctuation when it can be avoided", () => {
    const result = wrapText("这是一个较长的测试句子，用来验证标点符号处理。", 900, family, 60);
    for (const line of result.lines.slice(1)) {
      expect("，。！？；：、".includes(line[0]!)).toBe(false);
    }
  });

  test("wraps Bangla on word boundaries, keeping conjuncts intact", () => {
    const result = wrapText("আজকের ভিডিওতে আমরা শিখব কীভাবে বিজ্ঞান কাজ করে", 600, family, 60);
    expect(result.lines.length).toBeGreaterThan(1);
    expect(result.lines.join(" ").replace(/\s+/g, " ")).toBe(
      "আজকের ভিডিওতে আমরা শিখব কীভাবে বিজ্ঞান কাজ করে",
    );
  });
});

describe("fontSupportsText", () => {
  const bangla = join(fontDir(), "NotoSansBengali-Bold.ttf");
  const cjk = join(fontDir(), "MicrosoftYaHeiBold.ttc");

  test("accepts a font that covers the script", () => {
    expect(fontSupportsText(bangla, "শিক্ষা ও বিজ্ঞান")).toBe(true);
  });

  test("rejects a font missing the script, which would draw blank boxes", () => {
    expect(fontSupportsText(cjk, "শিক্ষা ও বিজ্ঞান")).toBe(false);
  });

  test("requires Latin and digits too, since Bangla scripts mix them in", () => {
    expect(fontSupportsText(bangla, "VidGen 2026")).toBe(true);
  });

  test("ignores text with nothing to draw", () => {
    expect(fontSupportsText(cjk, "  —  ")).toBe(true);
  });
});

describe("resolveSubtitleFontPath", () => {
  const bangla = join(fontDir(), "NotoSansBengali-Bold.ttf");
  const cjk = join(fontDir(), "MicrosoftYaHeiBold.ttc");

  test("keeps the requested font when it can draw the text", () => {
    expect(resolveSubtitleFontPath(cjk, "春天的花海")).toBe(cjk);
    expect(resolveSubtitleFontPath(bangla, "শিক্ষা")).toBe(bangla);
  });

  test("substitutes a Bangla-capable font rather than rendering empty boxes", () => {
    const resolved = resolveSubtitleFontPath(cjk, "আজকের ভিডিওতে আমরা শিখব");
    expect(resolved).not.toBe(cjk);
    expect(fontSupportsText(resolved, "আজকের ভিডিওতে আমরা শিখব")).toBe(true);
  });

  test("keeps the requested weight when substituting", () => {
    expect(resolveSubtitleFontPath(cjk, "বিজ্ঞান")).toContain("Bold");
  });
});
