/**
 * Structural filtering: every drop rule in isolation, and the fail-open default.
 *
 * The negative case matters more than the positive one throughout. A rule that fails
 * to fire costs a listener a boring paragraph; a rule that fires wrongly deletes a
 * chapter, which is the outcome this whole module exists to prevent.
 */

import { describe, expect, test } from "bun:test";

import { classifyBlocks } from "../src/services/book/filter/structural.ts";
import { decisionSummary, keptBlocks, mergeDecisions } from "../src/services/book/filter/decisions.ts";
import { DEFAULT_KEEP_RULE } from "../src/services/book/types.ts";
import type {
  Block,
  BlockKind,
  BookStructure,
  Chapter,
  ChapterLandmark,
  FilterDecision,
} from "../src/services/book/types.ts";

interface BlockSpec {
  text: string;
  kind?: BlockKind;
  level?: number;
}

interface ChapterSpec {
  title?: string;
  landmark?: ChapterLandmark;
  blocks: BlockSpec[];
}

function buildStructure(specs: ChapterSpec[]): BookStructure {
  const chapters: Chapter[] = [];
  const blocks: Block[] = [];
  let order = 0;

  specs.forEach((spec, chapterIndex) => {
    const chapterId = `ch-${chapterIndex}`;
    const blockIds = spec.blocks.map((blockSpec, blockIndex) => {
      const id = `${chapterIndex}:${blockIndex}`;
      blocks.push({
        id,
        kind: blockSpec.kind ?? "paragraph",
        text: blockSpec.text,
        level: blockSpec.level,
        chapterId,
        order: (order += 1),
      });
      return id;
    });

    chapters.push({
      id: chapterId,
      title: spec.title ?? `Chapter ${chapterIndex + 1}`,
      level: 1,
      order: chapterIndex,
      blockIds,
      landmark: spec.landmark,
    });
  });

  return { title: "Test Book", author: "A Tester", language: "en", chapters, blocks };
}

/** Decisions keyed by block id, which is how every assertion below reads them. */
function classify(structure: BookStructure): Map<string, FilterDecision> {
  return new Map(classifyBlocks(structure).map((decision) => [decision.blockId, decision]));
}

const PROSE =
  "The rain had stopped by the time she reached the harbour, and the boats were " +
  "already moving out past the breakwater in a long untidy line.";

const MORE_PROSE =
  "He counted the change twice, put it back in his pocket, and decided that the " +
  "walk home would do him more good than the bus.";

function prose(count: number): BlockSpec[] {
  return Array.from({ length: count }, (_, index) => ({ text: `${PROSE} Paragraph ${index}.` }));
}

// ---------------------------------------------------------------------------

describe("classifyBlocks output shape", () => {
  test("emits exactly one decision per block, in block order", () => {
    const structure = buildStructure([{ blocks: prose(3) }, { blocks: prose(2) }]);
    const decisions = classifyBlocks(structure);

    expect(decisions).toHaveLength(5);
    expect(decisions.map((decision) => decision.blockId)).toEqual(structure.blocks.map((block) => block.id));
  });

  test("every decision carries a reason, a rule and a usable confidence", () => {
    const structure = buildStructure([
      { landmark: "copyright", blocks: [{ text: "All rights reserved." }] },
      { blocks: prose(2) },
    ]);

    for (const decision of classifyBlocks(structure)) {
      expect(decision.reason.length).toBeGreaterThan(0);
      expect(decision.rule.length).toBeGreaterThan(0);
      expect(decision.source).toBe("structural");
      expect(decision.confidence).toBeGreaterThan(0);
      expect(decision.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe("fail-open default", () => {
  test("keeps anything no rule matched, at full confidence", () => {
    const decisions = classifyBlocks(buildStructure([{ blocks: [{ text: PROSE }] }]));

    expect(decisions[0]).toMatchObject({ keep: true, rule: DEFAULT_KEEP_RULE, confidence: 1 });
  });

  test("never drops ordinary prose, whatever else is around it", () => {
    // The one assertion that must never regress: a realistic body chapter comes
    // through untouched even when the book is full of furniture elsewhere.
    const structure = buildStructure([
      { landmark: "copyright", blocks: [{ text: "Copyright (c) 2019 by A Tester. All rights reserved." }] },
      {
        title: "Chapter One",
        blocks: [
          { text: "Chapter One", kind: "heading", level: 1 },
          { text: PROSE },
          { text: MORE_PROSE },
          { text: "He was born in 1987" },
          { text: "I" },
          { text: "42 people were waiting on the platform." },
          { text: "She paused... then went on without him." },
          { text: "Vivid" },
          { text: "The copyright question came up again at dinner." },
        ],
      },
    ]);

    const decisions = classify(structure);
    for (const block of structure.blocks.filter((candidate) => candidate.chapterId === "ch-1")) {
      expect(decisions.get(block.id)).toMatchObject({ keep: true, rule: DEFAULT_KEEP_RULE });
    }
  });
});

// ---------------------------------------------------------------------------

describe("landmark rules", () => {
  test("drops cover, title page and copyright chapters", () => {
    for (const landmark of ["cover", "titlepage", "copyright"] as const) {
      const decisions = classifyBlocks(buildStructure([{ landmark, blocks: [{ text: PROSE }] }]));
      expect(decisions[0]).toMatchObject({ keep: false, rule: "landmark_front_matter" });
      expect(decisions[0]!.confidence).toBeGreaterThanOrEqual(0.95);
    }
  });

  test("drops back matter, index, bibliography, glossary and acknowledgements chapters", () => {
    for (const landmark of ["backmatter", "index", "bibliography", "glossary", "acknowledgements"] as const) {
      const decisions = classifyBlocks(buildStructure([{ landmark, blocks: [{ text: PROSE }] }]));
      expect(decisions[0]).toMatchObject({ keep: false, rule: "landmark_back_matter" });
      expect(decisions[0]!.confidence).toBeGreaterThanOrEqual(0.95);
    }
  });

  test("drops a generic front-matter chapter, but with visibly lower confidence", () => {
    const generic = classifyBlocks(buildStructure([{ landmark: "frontmatter", blocks: [{ text: PROSE }] }]));
    expect(generic[0]).toMatchObject({ keep: false, rule: "landmark_front_matter" });

    // `frontmatter` can wrap a preface, so it must not be trusted as much as the
    // labels that name a title or copyright page outright — the review UI sorts
    // on this, and a reviewer should see it above the near-certain drops.
    const specific = classifyBlocks(buildStructure([{ landmark: "copyright", blocks: [{ text: PROSE }] }]));
    expect(generic[0]!.confidence).toBeLessThan(specific[0]!.confidence);
    expect(generic[0]!.reason).toMatch(/preface|review/i);
  });

  test("drops a table-of-contents chapter", () => {
    const decisions = classifyBlocks(buildStructure([{ landmark: "toc", blocks: [{ text: "Contents" }] }]));
    expect(decisions[0]).toMatchObject({ keep: false, rule: "landmark_toc" });
  });

  test("keeps a body-matter chapter", () => {
    const decisions = classifyBlocks(buildStructure([{ landmark: "bodymatter", blocks: [{ text: PROSE }] }]));
    expect(decisions[0]).toMatchObject({ keep: true, rule: DEFAULT_KEEP_RULE });
  });

  test("names the landmark in the reason the UI shows", () => {
    const decisions = classifyBlocks(buildStructure([{ landmark: "bibliography", blocks: [{ text: PROSE }] }]));
    expect(decisions[0]!.reason).toContain("bibliography");
  });
});

describe("toc_entry_shape", () => {
  test("drops a line with dot leaders and a page number", () => {
    const decisions = classifyBlocks(
      buildStructure([{ blocks: [{ text: "Chapter One: The Harbour . . . . . . . . 12" }] }]),
    );
    expect(decisions[0]).toMatchObject({ keep: false, rule: "toc_entry_shape" });
  });

  test("drops a line with unspaced dot leaders", () => {
    const decisions = classifyBlocks(buildStructure([{ blocks: [{ text: "Preface.............vii" }] }]));
    expect(decisions[0]).toMatchObject({ keep: false, rule: "toc_entry_shape" });
  });

  test("drops a title separated from its page number by a typographic gap", () => {
    const decisions = classifyBlocks(buildStructure([{ blocks: [{ text: "The Harbour     12" }] }]));
    expect(decisions[0]).toMatchObject({ keep: false, rule: "toc_entry_shape" });
  });

  test("keeps a sentence that merely ends in a number", () => {
    // One space, not a leader run: "he was born in 1987" is prose.
    const decisions = classifyBlocks(buildStructure([{ blocks: [{ text: "He was born in 1987" }] }]));
    expect(decisions[0]!.keep).toBe(true);
  });

  test("keeps prose containing an ellipsis", () => {
    const decisions = classifyBlocks(
      buildStructure([{ blocks: [{ text: "She waited... and then the lights went out." }] }]),
    );
    expect(decisions[0]!.keep).toBe(true);
  });

  test("drops a block the extractor already labelled a toc entry", () => {
    const decisions = classifyBlocks(buildStructure([{ blocks: [{ text: "Preface", kind: "toc_entry" }] }]));
    expect(decisions[0]).toMatchObject({ keep: false, rule: "toc_entry_shape" });
  });
});

describe("toc_chapter_shape", () => {
  test("drops an unlabelled chapter that is mostly entries", () => {
    const structure = buildStructure([
      {
        blocks: [
          { text: "Contents", kind: "heading", level: 1 },
          { text: "Chapter One . . . . . 1" },
          { text: "Chapter Two . . . . . 24" },
          { text: "Chapter Three . . . . . 51" },
          { text: "Chapter Four . . . . . 78" },
        ],
      },
    ]);

    const decisions = classifyBlocks(structure);
    expect(decisions.every((decision) => !decision.keep)).toBe(true);
    // The heading itself has no entry shape, so only the chapter-level rule reaches it.
    expect(decisions[0]).toMatchObject({ rule: "toc_chapter_shape" });
  });

  test("keeps a prose chapter that contains one stray entry-shaped line", () => {
    const structure = buildStructure([
      { blocks: [...prose(5), { text: "Appendix A     201" }] },
    ]);

    const decisions = classifyBlocks(structure);
    expect(decisions.slice(0, 5).every((decision) => decision.keep)).toBe(true);
    expect(decisions[5]).toMatchObject({ keep: false, rule: "toc_entry_shape" });
  });
});

describe("page_number", () => {
  test("drops a block that is only digits", () => {
    const decisions = classifyBlocks(buildStructure([{ blocks: [{ text: PROSE }, { text: "137" }] }]));
    expect(decisions[1]).toMatchObject({ keep: false, rule: "page_number" });
  });

  test("keeps a heading that happens to be a bare number", () => {
    // Numeric chapter titles are common; losing one would corrupt the segment plan.
    const decisions = classifyBlocks(
      buildStructure([{ blocks: [{ text: "7", kind: "heading", level: 1 }, { text: PROSE }] }]),
    );
    expect(decisions[0]!.keep).toBe(true);
  });

  test("drops a roman numeral corroborated by other page numbers in the section", () => {
    const structure = buildStructure([
      { blocks: [{ text: "iv" }, { text: "v" }, { text: PROSE }] },
    ]);
    const decisions = classifyBlocks(structure);

    expect(decisions[0]).toMatchObject({ keep: false, rule: "page_number" });
    expect(decisions[1]).toMatchObject({ keep: false, rule: "page_number" });
    expect(decisions[0]!.confidence).toBeLessThan(0.8);
    expect(decisions[2]!.keep).toBe(true);
  });

  test("keeps a lone I in dialogue with nothing to corroborate it", () => {
    const structure = buildStructure([{ blocks: [{ text: PROSE }, { text: "I" }, { text: MORE_PROSE }] }]);
    expect(classifyBlocks(structure)[1]!.keep).toBe(true);
  });

  test("keeps English words made of roman letters", () => {
    // "vivid" and "civil" are all-roman-letters but not valid numerals, so they must
    // neither be dropped nor corroborate each other.
    const structure = buildStructure([{ blocks: [{ text: "Vivid" }, { text: "Civil" }, { text: "Did" }] }]);
    expect(classifyBlocks(structure).every((decision) => decision.keep)).toBe(true);
  });

  test("drops a block the extractor already labelled a page number", () => {
    const decisions = classifyBlocks(buildStructure([{ blocks: [{ text: "ix", kind: "page_number" }] }]));
    expect(decisions[0]).toMatchObject({ keep: false, rule: "page_number" });
  });
});

describe("repeated_running_head", () => {
  /** The body text differs per chapter so only the repeated head can be dropped. */
  function bookWithRepeatedLine(chapterCount: number, head: (index: number) => string): BookStructure {
    return buildStructure(
      Array.from({ length: chapterCount }, (_, index) => ({
        blocks: [{ text: head(index) }, ...prose(1).map((spec) => ({ text: `${spec.text} ${index}.` }))],
      })),
    );
  }

  test("drops a short line repeating across five chapters", () => {
    const decisions = classifyBlocks(bookWithRepeatedLine(5, () => "The Harbour"));
    const heads = decisions.filter((decision) => decision.rule === "repeated_running_head");

    expect(heads).toHaveLength(5);
    expect(heads.every((decision) => !decision.keep)).toBe(true);
    expect(heads[0]!.reason).toContain("5");
  });

  test("keeps the same line when it only reaches four chapters", () => {
    // "the harbour" also sits under the boilerplate length floor, so with the
    // running-head rule silent nothing else reaches it either.
    const decisions = classifyBlocks(bookWithRepeatedLine(4, () => "The Harbour"));

    expect(decisions.every((decision) => decision.rule !== "repeated_running_head")).toBe(true);
    expect(decisions.every((decision) => decision.keep)).toBe(true);
  });

  test("collapses trailing page numbers so a running head is recognised", () => {
    // "The Harbour   47" and "The Harbour   48" are the same running head, and the
    // repetition is also what distinguishes it from a table-of-contents entry.
    const structure = bookWithRepeatedLine(5, (index) => `The Harbour   ${index + 47}`);
    const dropped = classifyBlocks(structure).filter((decision) => !decision.keep);

    expect(dropped).toHaveLength(5);
    expect(dropped.every((decision) => decision.rule === "repeated_running_head")).toBe(true);
  });

  test("keeps a long line even when it repeats across many chapters", () => {
    const structure = buildStructure(
      Array.from({ length: 6 }, () => ({ blocks: [{ text: PROSE }] })),
    );
    // PROSE is well over the running-head length limit, so only the weaker
    // boilerplate rule can reach it.
    expect(classifyBlocks(structure).every((decision) => decision.rule !== "repeated_running_head")).toBe(true);
  });

  test("drops a block the extractor already labelled a running head", () => {
    const decisions = classifyBlocks(buildStructure([{ blocks: [{ text: "THE HARBOUR", kind: "running_head" }] }]));
    expect(decisions[0]).toMatchObject({ keep: false, rule: "repeated_running_head" });
  });
});

describe("boilerplate_repeat", () => {
  const NOTICE = "Visit our website for more titles from this publisher.";

  test("drops identical text appearing three times", () => {
    const structure = buildStructure([{ blocks: [{ text: NOTICE }, { text: PROSE }, { text: NOTICE }, { text: NOTICE }] }]);
    const decisions = classifyBlocks(structure);

    expect(decisions.filter((decision) => decision.rule === "boilerplate_repeat")).toHaveLength(3);
    expect(decisions[1]!.keep).toBe(true);
  });

  test("keeps text appearing only twice", () => {
    const structure = buildStructure([{ blocks: [{ text: NOTICE }, { text: PROSE }, { text: NOTICE }] }]);
    expect(classifyBlocks(structure).every((decision) => decision.keep)).toBe(true);
  });

  test("keeps short repeated dialogue", () => {
    // Novels repeat short lines constantly; dropping them would be a silent deletion.
    const structure = buildStructure([
      { blocks: [{ text: "Yes." }, { text: PROSE }, { text: "Yes." }, { text: MORE_PROSE }, { text: "Yes." }] },
    ]);
    expect(classifyBlocks(structure).every((decision) => decision.keep)).toBe(true);
  });

  test("keeps a repeated heading so its body is not stranded", () => {
    const structure = buildStructure(
      Array.from({ length: 3 }, (_, index) => ({
        blocks: [
          { text: "Notes on the Translation", kind: "heading" as BlockKind, level: 2 },
          { text: `${PROSE} Paragraph ${index}.` },
        ],
      })),
    );
    expect(classifyBlocks(structure).every((decision) => decision.keep)).toBe(true);
  });
});

describe("copyright_notice", () => {
  test("drops an ISBN line", () => {
    const decisions = classifyBlocks(buildStructure([{ blocks: [{ text: "ISBN 978-0-14-303943-3" }] }]));
    expect(decisions[0]).toMatchObject({ keep: false, rule: "copyright_notice" });
  });

  test("drops a rights statement", () => {
    const decisions = classifyBlocks(buildStructure([{ blocks: [{ text: "All rights reserved." }] }]));
    expect(decisions[0]).toMatchObject({ keep: false, rule: "copyright_notice" });
  });

  test("drops a copyright line with a year", () => {
    const decisions = classifyBlocks(buildStructure([{ blocks: [{ text: "© 2019 A Tester" }] }]));
    expect(decisions[0]).toMatchObject({ keep: false, rule: "copyright_notice" });
  });

  test("drops publisher boilerplate", () => {
    const decisions = classifyBlocks(
      buildStructure([
        { blocks: [{ text: "No part of this book may be reproduced without written permission." }] },
      ]),
    );
    expect(decisions[0]).toMatchObject({ keep: false, rule: "copyright_notice" });
  });

  test("keeps prose that merely mentions rights or publishing", () => {
    const structure = buildStructure([
      { blocks: [{ text: "She had reserved every right to walk away, and she took it." }, { text: MORE_PROSE }] },
    ]);
    expect(classifyBlocks(structure).every((decision) => decision.keep)).toBe(true);
  });
});

describe("footnote_block", () => {
  test("drops a footnote", () => {
    const decisions = classifyBlocks(
      buildStructure([{ blocks: [{ text: "1. See Alvarez, op. cit., p. 214.", kind: "footnote" }] }]),
    );
    expect(decisions[0]).toMatchObject({ keep: false, rule: "footnote_block" });
  });

  test("keeps a paragraph that reads like a citation but is not marked as one", () => {
    const decisions = classifyBlocks(buildStructure([{ blocks: [{ text: "He quoted Alvarez at length." }] }]));
    expect(decisions[0]!.keep).toBe(true);
  });
});

describe("about_the_author", () => {
  test("drops the heading and its body up to the next heading of equal depth", () => {
    const structure = buildStructure([
      {
        blocks: [
          { text: "About the Author", kind: "heading", level: 2 },
          { text: "A Tester lives in Lisbon with two cats." },
          { text: "Their previous novel won nothing at all." },
          { text: "Also by This Author", kind: "heading", level: 2 },
          { text: MORE_PROSE },
        ],
      },
    ]);

    const decisions = classifyBlocks(structure);
    expect(decisions.slice(0, 3).every((decision) => decision.rule === "about_the_author")).toBe(true);
    expect(decisions.slice(0, 3).every((decision) => !decision.keep)).toBe(true);
    expect(decisions[3]!.keep).toBe(true);
    expect(decisions[4]!.keep).toBe(true);
  });

  test("keeps a deeper heading inside the section as part of the section", () => {
    const structure = buildStructure([
      {
        blocks: [
          { text: "About the Translator", kind: "heading", level: 2 },
          { text: "A note on the text", kind: "heading", level: 3 },
          { text: "The translation follows the 1954 edition." },
          { text: "Chapter One", kind: "heading", level: 1 },
          { text: PROSE },
        ],
      },
    ]);

    const decisions = classifyBlocks(structure);
    expect(decisions.slice(0, 3).every((decision) => decision.rule === "about_the_author")).toBe(true);
    expect(decisions[3]!.keep).toBe(true);
  });

  test("stops at a chapter boundary", () => {
    const structure = buildStructure([
      { blocks: [{ text: "About the Author", kind: "heading", level: 3 }, { text: "A Tester lives in Lisbon." }] },
      { blocks: [{ text: PROSE }] },
    ]);

    const decisions = classifyBlocks(structure);
    expect(decisions[1]!.keep).toBe(false);
    expect(decisions[2]!.keep).toBe(true);
  });

  test("drops a whole chapter titled About the Author", () => {
    const structure = buildStructure([
      { title: "About the Author", blocks: [{ text: "A Tester lives in Lisbon." }, { text: MORE_PROSE }] },
    ]);
    expect(classifyBlocks(structure).every((decision) => decision.rule === "about_the_author")).toBe(true);
  });

  test("keeps prose that mentions the phrase mid-sentence", () => {
    const structure = buildStructure([
      { blocks: [{ text: "She read the note about the author on the back flap and laughed." }] },
    ]);
    expect(classifyBlocks(structure)[0]!.keep).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("mergeDecisions", () => {
  const structural: FilterDecision[] = [
    { blockId: "a", keep: false, reason: "page number", rule: "page_number", confidence: 0.85, source: "structural" },
    { blockId: "b", keep: true, reason: "kept", rule: DEFAULT_KEEP_RULE, confidence: 1, source: "structural" },
  ];

  test("lets a user override win despite lower confidence", () => {
    const merged = mergeDecisions(structural, [
      { blockId: "a", keep: true, reason: "I want this read", rule: "user_override", confidence: 0.1, source: "user" },
    ]);

    expect(merged[0]).toMatchObject({ blockId: "a", keep: true, source: "user" });
  });

  test("lets a user override drop something structural kept", () => {
    const merged = mergeDecisions(structural, [
      { blockId: "b", keep: false, reason: "skip this", rule: "user_override", confidence: 1, source: "user" },
    ]);

    expect(merged[1]).toMatchObject({ blockId: "b", keep: false, source: "user" });
  });

  test("refuses to let a later LLM pass overwrite a user decision", () => {
    const withUser = mergeDecisions(structural, [
      { blockId: "a", keep: true, reason: "I want this read", rule: "user_override", confidence: 0.1, source: "user" },
    ]);
    const merged = mergeDecisions(withUser, [
      { blockId: "a", keep: false, reason: "model says apparatus", rule: "llm_apparatus", confidence: 0.99, source: "llm" },
    ]);

    expect(merged[0]).toMatchObject({ keep: true, source: "user" });
  });

  test("lets an LLM decision refine a structural one", () => {
    const merged = mergeDecisions(structural, [
      { blockId: "b", keep: false, reason: "model says apparatus", rule: "llm_apparatus", confidence: 0.9, source: "llm" },
    ]);

    expect(merged[1]).toMatchObject({ keep: false, source: "llm" });
  });

  test("keeps structural ordering and appends decisions for unseen blocks", () => {
    const merged = mergeDecisions(structural, [
      { blockId: "c", keep: false, reason: "skip", rule: "user_override", confidence: 1, source: "user" },
    ]);

    expect(merged.map((decision) => decision.blockId)).toEqual(["a", "b", "c"]);
  });

  test("takes the last of several overrides for one block", () => {
    const merged = mergeDecisions(structural, [
      { blockId: "a", keep: true, reason: "first", rule: "user_override", confidence: 1, source: "user" },
      { blockId: "a", keep: false, reason: "second", rule: "user_override", confidence: 1, source: "user" },
    ]);

    expect(merged[0]).toMatchObject({ keep: false, reason: "second" });
  });
});

describe("keptBlocks", () => {
  test("returns survivors in reading order regardless of array order", () => {
    const structure = buildStructure([{ blocks: [{ text: "one" }, { text: "two" }, { text: "three" }] }]);
    structure.blocks.reverse();

    const kept = keptBlocks(structure, [
      { blockId: "0:1", keep: false, reason: "dropped", rule: "page_number", confidence: 0.85, source: "structural" },
    ]);

    expect(kept.map((block) => block.text)).toEqual(["one", "three"]);
  });

  test("keeps a block that has no decision at all", () => {
    // Absence of a verdict is not a verdict.
    const structure = buildStructure([{ blocks: [{ text: "one" }, { text: "two" }] }]);
    expect(keptBlocks(structure, []).map((block) => block.id)).toEqual(["0:0", "0:1"]);
  });

  test("honours a user override that reinstates a dropped block", () => {
    const structure = buildStructure([{ blocks: [{ text: "137" }, { text: PROSE }] }]);
    const merged = mergeDecisions(classifyBlocks(structure), [
      { blockId: "0:0", keep: true, reason: "read it anyway", rule: "user_override", confidence: 1, source: "user" },
    ]);

    expect(keptBlocks(structure, merged)).toHaveLength(2);
  });
});

describe("decisionSummary", () => {
  test("counts totals and groups by rule, biggest cut first", () => {
    const structure = buildStructure([
      { landmark: "toc", blocks: [{ text: "Contents" }] },
      { blocks: [{ text: PROSE }, { text: "137" }, { text: "138" }, { text: MORE_PROSE }] },
    ]);

    const summary = decisionSummary(classifyBlocks(structure));

    expect(summary.total).toBe(5);
    expect(summary.kept).toBe(2);
    expect(summary.dropped).toBe(3);
    expect(summary.rules[0]).toMatchObject({ rule: "page_number", dropped: 2, kept: 0 });
    expect(summary.rules.find((rule) => rule.rule === "landmark_toc")).toMatchObject({ dropped: 1 });
    expect(summary.rules.find((rule) => rule.rule === DEFAULT_KEEP_RULE)).toMatchObject({ kept: 2, dropped: 0 });
  });

  test("carries a reason string for each rule row", () => {
    const summary = decisionSummary(classifyBlocks(buildStructure([{ blocks: [{ text: "137" }] }])));
    expect(summary.rules[0]!.reason.length).toBeGreaterThan(0);
  });

  test("handles an empty decision list", () => {
    expect(decisionSummary([])).toEqual({ total: 0, kept: 0, dropped: 0, rules: [] });
  });
});
