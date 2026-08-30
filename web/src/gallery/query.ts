/**
 * The gallery's filter state, and its round trip through the URL.
 *
 * The query string is the single source of truth for what is on screen, so a
 * filtered or searched view is linkable and survives a reload. Param names
 * mirror the `/footage/list` contract exactly (`q`, `aspect`, `has_people`,
 * `min_duration`, …) rather than inventing short aliases — the address bar
 * then reads as the request it produces.
 *
 * Everything here is pure so the screen can call it during render without an
 * effect: parse the params it was handed, or serialise the ones it is about
 * to push.
 */

import type { FootageListQuery } from "@/api/client.ts";

/** The three values `/footage/list` accepts for `aspect`. */
export const ASPECTS = ["landscape", "portrait", "square"] as const;
export type Aspect = (typeof ASPECTS)[number];

/**
 * Tri-state, because `has_people` has three meanings and a boolean has two:
 * "" is "do not filter", which is not the same request as `has_people=false`.
 */
export type PeopleFilter = "" | "yes" | "no";

/** Minimum-duration steps, in seconds. 0 means unfiltered. */
export const MIN_DURATIONS = [0, 5, 10, 15, 30] as const;

export interface GalleryFilters {
  /** Semantic search text. Non-empty switches the endpoint into search mode. */
  q: string;
  aspect: Aspect | "";
  provider: string;
  hasPeople: PeopleFilter;
  /** Seconds. 0 when unset. */
  minDuration: number;
  /** Passed through untouched; the server owns this vocabulary. */
  sort: string;
}

export const EMPTY_FILTERS: GalleryFilters = {
  q: "",
  aspect: "",
  provider: "",
  hasPeople: "",
  minDuration: 0,
  sort: "",
};

/**
 * Whether a value is one of the three aspects the UI has a translation for.
 *
 * Worth a guard rather than a cast: `aspect` arrives from the index, and a
 * blind `t("Gallery Aspect " + aspect)` on an unexpected value would print the
 * lookup key on screen instead of falling back to the raw word.
 */
export function isAspect(value: string): value is Aspect {
  return (ASPECTS as readonly string[]).includes(value);
}

/** Reads filters out of a URL. Anything unrecognised falls back to unset. */
export function readFilters(params: URLSearchParams): GalleryFilters {
  const aspect = (params.get("aspect") ?? "").trim();
  const people = (params.get("has_people") ?? "").trim();
  const minDuration = Number(params.get("min_duration") ?? "");

  return {
    q: params.get("q") ?? "",
    aspect: isAspect(aspect) ? aspect : "",
    provider: (params.get("provider") ?? "").trim(),
    hasPeople: people === "true" || people === "yes" ? "yes" : people === "false" || people === "no" ? "no" : "",
    minDuration: Number.isFinite(minDuration) && minDuration > 0 ? minDuration : 0,
    sort: (params.get("sort") ?? "").trim(),
  };
}

/**
 * Serialises filters back to a URL.
 *
 * Unset values are omitted rather than written empty, so a cleared filter
 * leaves no `aspect=` behind and the default view has a bare `/gallery` URL.
 */
export function writeFilters(filters: GalleryFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.aspect) params.set("aspect", filters.aspect);
  if (filters.provider) params.set("provider", filters.provider);
  if (filters.hasPeople) params.set("has_people", filters.hasPeople === "yes" ? "true" : "false");
  if (filters.minDuration > 0) params.set("min_duration", String(filters.minDuration));
  if (filters.sort) params.set("sort", filters.sort);
  return params;
}

/** Builds the request for one page. `offset` walks the list; `limit` is the page size. */
export function toListQuery(filters: GalleryFilters, offset: number, limit: number): FootageListQuery {
  const query: FootageListQuery = { limit, offset };
  const q = filters.q.trim();
  if (q) query.q = q;
  if (filters.aspect) query.aspect = filters.aspect;
  if (filters.provider) query.provider = filters.provider;
  if (filters.hasPeople) query.has_people = filters.hasPeople === "yes";
  if (filters.minDuration > 0) query.min_duration = filters.minDuration;
  if (filters.sort) query.sort = filters.sort;
  return query;
}

/** True when nothing is narrowing the library — used to pick the empty-state copy. */
export function isUnfiltered(filters: GalleryFilters): boolean {
  return (
    !filters.q.trim() &&
    !filters.aspect &&
    !filters.provider &&
    !filters.hasPeople &&
    filters.minDuration === 0
  );
}
