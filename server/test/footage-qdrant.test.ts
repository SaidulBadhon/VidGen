/**
 * Collection naming.
 *
 * The only part of the Qdrant wrapper that is pure: every other export makes a
 * request. It is worth pinning because the alias/version scheme is what makes a
 * model change a create-backfill-repoint migration rather than an in-place one,
 * and because a name that silently drifts splits one library into two.
 *
 * No client is constructed here — `qdrant.ts` builds one lazily, on first call.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { defaultSettings } from "../src/config/schema.ts";
import { __setSettingsForTest } from "../src/config/settings.ts";
import { VECTOR_SIZE, searchCollection, targetCollection } from "../src/services/footage/qdrant.ts";
import { EMBED_DIMENSIONS } from "../src/services/footage/embed.ts";
import { EMBED_VERSION } from "../src/services/footage/types.ts";

/** Settings with `qdrant.collection` set to `collection`. */
function withCollection(collection: string): void {
  const settings = defaultSettings();
  settings.qdrant.collection = collection;
  __setSettingsForTest(settings);
}

afterEach(() => {
  __setSettingsForTest(defaultSettings());
});

// ---------------------------------------------------------------------------

describe("collection naming", () => {
  test("searches through the configured alias", () => {
    withCollection("shared");
    expect(searchCollection()).toBe("shared");
  });

  test("falls back to 'footage' for a blank alias", () => {
    withCollection("   ");
    expect(searchCollection()).toBe("footage");
    __setSettingsForTest(defaultSettings());
    expect(searchCollection()).toBe("footage");
  });

  test("trims a stray space typed into the settings field", () => {
    withCollection("  shared  ");
    expect(searchCollection()).toBe("shared");
  });

  test("owns <alias>_v<EMBED_VERSION>, derived rather than hardcoded", () => {
    // A second deployment against the same Qdrant keeps its own namespace by
    // changing this one setting.
    withCollection("shared");
    expect(targetCollection()).toBe(`shared_v${EMBED_VERSION}`);
    __setSettingsForTest(defaultSettings());
    expect(targetCollection()).toBe(`footage_v${EMBED_VERSION}`);
  });

  test("the alias is never the collection itself", () => {
    // Writers address the versioned collection, readers address the alias; the
    // two must not collapse or the alias swap has nothing to swap.
    expect(targetCollection()).not.toBe(searchCollection());
  });

  test("the collection's vector width is the width embed.ts enforces", () => {
    // Set at creation and immutable afterwards, so a drift between these two is
    // a rebuild, not a config change.
    expect(VECTOR_SIZE).toBe(EMBED_DIMENSIONS);
    expect(VECTOR_SIZE).toBe(3072);
  });
});
