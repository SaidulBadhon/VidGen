/**
 * Stock footage under book narration: term derivation and pool identity.
 *
 * The download and montage halves are not exercised here — they hit Pexels and
 * ffmpeg, cost gigabytes, and are covered by the material/combine suites. What
 * matters at this level is that a host with no model still gets usable search
 * terms, and that a pool is re-downloaded exactly when its inputs change and
 * never otherwise.
 */

import { describe, expect, test } from "bun:test";
import { footageKeywords, footagePoolKey, POOL_TARGET_SECONDS } from "../src/services/book/footage.ts";

/** A paragraph in the register a book actually supplies: prose, not keywords. */
const CHAPTER_TEXT = `
  It was the Dover road that lay, on a Friday night late in November, before the
  first of the persons with whom this history has business. The Dover road lay,
  as to him, beyond the Dover mail, as it lumbered up Shooter's Hill. He walked
  up hill in the mire by the side of the mail, as the rest of the passengers did;
  not because they had the least relish for walking exercise, under the
  circumstances, but because the hill, and the harness, and the mud, and the
  mail, were all so heavy, that the horses had three times already come to a
  stop. The coachman and the guard watched the road together.
`;

describe("footageKeywords", () => {
  const base = {
    bookTitle: "A Tale Of Two Cities",
    chapterTitle: "Book The First — Recalled To Life",
    text: CHAPTER_TEXT,
  };

  test("leads with the titles, which are the most searchable thing a book has", () => {
    const terms = footageKeywords(base);
    expect(terms[0]).toBe("A Tale Of Two Cities");
    expect(terms[1]).toBe("Book The First — Recalled To Life");
  });

  test("pulls visual nouns out of the prose", () => {
    const terms = footageKeywords(base).join(" ").toLowerCase();
    // The scene is a mail coach climbing a hill; at least some of that must survive.
    const found = ["dover", "hill", "coach", "mail", "passengers", "road", "horses"].filter((w) =>
      terms.includes(w),
    );
    expect(found.length).toBeGreaterThanOrEqual(3);
  });

  test("drops the filler words that would return nothing visual", () => {
    const terms = footageKeywords(base).slice(2).join(" ").toLowerCase().split(/\s+/);
    for (const stop of ["the", "and", "with", "because", "that", "were"]) {
      expect(terms).not.toContain(stop);
    }
  });

  test("does not repeat the book title as a bare keyword", () => {
    const terms = footageKeywords({ ...base, chapterTitle: "A Tale Of Two Cities" });
    // Chapter equal to the book title must not be listed twice.
    expect(terms.filter((t) => t === "A Tale Of Two Cities")).toHaveLength(1);
  });

  test("honours the requested count and survives text with nothing usable in it", () => {
    expect(footageKeywords({ ...base, amount: 3 })).toHaveLength(3);
    const bare = footageKeywords({ bookTitle: "Untitled", chapterTitle: "", text: "the and of to a" });
    expect(bare).toEqual(["Untitled"]);
  });

  test("is deterministic, so a retried segment searches for the same things", () => {
    expect(footageKeywords(base)).toEqual(footageKeywords(base));
  });
});

describe("footagePoolKey", () => {
  const base = { terms: ["dover road", "mail coach"], source: "pexels", aspect: "16:9" };

  test("is stable, and independent of the order terms arrive in", () => {
    expect(footagePoolKey(base)).toBe(footagePoolKey(base));
    expect(footagePoolKey(base)).toBe(
      footagePoolKey({ ...base, terms: ["mail coach", "dover road"] }),
    );
  });

  test("changes when the terms, the provider or the aspect change", () => {
    expect(footagePoolKey(base)).not.toBe(footagePoolKey({ ...base, terms: ["stormy sky"] }));
    expect(footagePoolKey(base)).not.toBe(footagePoolKey({ ...base, source: "pixabay" }));
    // A 9:16 pool cropped from 16:9 clips is not the same pool.
    expect(footagePoolKey(base)).not.toBe(footagePoolKey({ ...base, aspect: "9:16" }));
  });
});

describe("pool sizing", () => {
  test("targets more footage than one chapter needs, so a segment does not repeat itself", () => {
    // Measured average chapter on the reference book is ~816s.
    expect(POOL_TARGET_SECONDS).toBeGreaterThan(816);
  });
});
