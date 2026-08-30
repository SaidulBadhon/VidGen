/**
 * Read-only browser for the semantic footage library.
 *
 * Three things drive the page and they are deliberately separate:
 *   - the URL owns the filters, so any view is a shareable link;
 *   - `useInfiniteQuery` owns paging, so the 1,512-clip library arrives a
 *     screenful at a time and never in one request;
 *   - `/footage/stats` owns availability, so a dead Qdrant is reported as
 *     "the index is unreachable" instead of an empty grid that looks like a
 *     library with nothing in it.
 *
 * Typing is debounced before it reaches the query. Each keystroke would
 * otherwise be an embedding call on the server, and semantic search is the
 * expensive path.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Loader2, Search, X } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { ApiError, api, type FootageItem } from "@/api/client.ts";
import { PageHeader } from "@/components/page-header.tsx";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, Button, Card, Field, Select, TextInput } from "@/components/ui.tsx";
import { useI18n } from "@/i18n/index.tsx";
import { FootageCard } from "./FootageCard.tsx";
import { FootageDetail } from "./FootageDetail.tsx";
import {
  ASPECTS,
  EMPTY_FILTERS,
  MIN_DURATIONS,
  isUnfiltered,
  readFilters,
  toListQuery,
  writeFilters,
  type GalleryFilters,
} from "./query.ts";

/** One screenful and change. Large enough that scrolling is not a request per row. */
const PAGE_SIZE = 60;
const SEARCH_DEBOUNCE_MS = 350;

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * Turns a failure into something a reader can act on.
 *
 * A 404 here means the route is not served — the library is not broken, the
 * endpoint is missing — and that is a different message from a 500.
 */
function errorText(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiError && error.status === 404) return t("Gallery Endpoint Missing");
  return error instanceof Error ? error.message : String(error);
}

export function GalleryScreen() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readFilters(params), [params]);

  const [selected, setSelected] = useState<FootageItem | null>(null);
  const [searchText, setSearchText] = useState(filters.q);
  const debouncedSearch = useDebouncedValue(searchText, SEARCH_DEBOUNCE_MS);
  const lastPushedQuery = useRef(filters.q);

  /**
   * The filters the query actually runs with.
   *
   * Search text comes from the debounced input rather than the URL so results
   * do not wait on a navigation round trip; the URL catches up in the effect
   * below and stays the thing that is shareable.
   */
  const activeFilters = useMemo<GalleryFilters>(
    () => ({ ...filters, q: debouncedSearch }),
    [filters, debouncedSearch],
  );

  const applyFilters = useCallback(
    (next: GalleryFilters) => {
      lastPushedQuery.current = next.q;
      setParams(writeFilters(next), { replace: true });
    },
    [setParams],
  );

  const setFilter = useCallback(
    <K extends keyof GalleryFilters>(key: K, value: GalleryFilters[K]) => {
      applyFilters({ ...filters, [key]: value });
    },
    [applyFilters, filters],
  );

  // Settled search text becomes part of the URL. Replaced rather than pushed:
  // a word typed one letter at a time should not be nine back-button steps.
  useEffect(() => {
    if (debouncedSearch === filters.q) return;
    lastPushedQuery.current = debouncedSearch;
    setParams(writeFilters({ ...filters, q: debouncedSearch }), { replace: true });
  }, [debouncedSearch, filters, setParams]);

  // A `q` this component did not write — the back button, or a pasted link —
  // has to be adopted by the input, or the box and the results disagree.
  useEffect(() => {
    if (filters.q === lastPushedQuery.current) return;
    lastPushedQuery.current = filters.q;
    setSearchText(filters.q);
  }, [filters.q]);

  const statsQuery = useQuery({ queryKey: ["footage-stats"], queryFn: api.footageStats });

  const listQuery = useInfiniteQuery({
    queryKey: ["footage-list", activeFilters],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.listFootage(toListQuery(activeFilters, pageParam, PAGE_SIZE)),
    // A short page is the end of the list even when `total` says otherwise —
    // trusting `total` alone would loop forever against a filtered count.
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.items.length < PAGE_SIZE) return undefined;
      const loaded = allPages.reduce((sum, page) => sum + page.items.length, 0);
      return loaded >= lastPage.total ? undefined : loaded;
    },
    // Keeps the previous grid on screen while a new filter loads, instead of
    // blanking the page on every keystroke that settles.
    placeholderData: keepPreviousData,
  });

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = listQuery;
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasNextPage || isFetchingNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void fetchNextPage();
      },
      // Start the next page before the reader reaches the bottom.
      { rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const items = useMemo(
    () => listQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [listQuery.data],
  );
  const total = listQuery.data?.pages[0]?.total ?? 0;

  /**
   * Provider options, learned from what has loaded.
   *
   * There is no endpoint that lists providers, and hardcoding one would drift
   * from whatever the library was actually pulled from. The value currently in
   * the URL is always included so a shared link never silently loses its
   * filter.
   */
  const providerOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const item of items) if (item.provider) seen.add(item.provider);
    if (filters.provider) seen.add(filters.provider);
    return [
      { value: "", label: t("Gallery All Providers") },
      ...[...seen].sort().map((provider) => ({ value: provider, label: provider })),
    ];
  }, [items, filters.provider, t]);

  const qdrantDown = statsQuery.data ? !statsQuery.data.qdrant.ok : false;
  const searching = listQuery.isFetching && !isFetchingNextPage;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("Footage Gallery")}
        description={t("Gallery Intro")}
        actions={
          statsQuery.data && (
            <span className="text-sm text-muted-foreground tabular-nums">
              {t("Gallery Library Size", {
                count: statsQuery.data.qdrant.points ?? statsQuery.data.rows.indexed,
              })}
            </span>
          )
        }
      />

      {qdrantDown && (
        <Alert tone="danger">
          <span className="font-medium">{t("Gallery Qdrant Down")}</span>{" "}
          <span className="text-xs opacity-90">
            {statsQuery.data?.qdrant.detail || statsQuery.data?.qdrant.url}
          </span>
        </Alert>
      )}
      {statsQuery.isError && <Alert tone="warning">{t("Gallery Stats Unavailable")}</Alert>}

      <Card>
        <div className="space-y-4">
          <Field label={t("Gallery Search Label")} hint={t("Gallery Search Hint")}>
            <div className="relative">
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <TextInput
                value={searchText}
                placeholder={t("Gallery Search Placeholder")}
                onChange={(event) => setSearchText(event.target.value)}
                className="pl-9 pr-9"
              />
              {searching ? (
                <Loader2
                  size={14}
                  className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground"
                />
              ) : (
                searchText && (
                  <button
                    type="button"
                    onClick={() => setSearchText("")}
                    aria-label={t("Gallery Clear Search")}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <X size={14} />
                  </button>
                )
              )}
            </div>
          </Field>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t("Gallery Aspect")}>
              <Select
                value={filters.aspect}
                onValueChange={(value) => setFilter("aspect", value as GalleryFilters["aspect"])}
                options={[
                  { value: "", label: t("Gallery All Aspects") },
                  ...ASPECTS.map((aspect) => ({ value: aspect, label: t(`Gallery Aspect ${aspect}`) })),
                ]}
              />
            </Field>
            <Field label={t("Gallery Provider")}>
              <Select
                value={filters.provider}
                onValueChange={(value) => setFilter("provider", value)}
                options={providerOptions}
              />
            </Field>
            <Field label={t("Gallery People")}>
              <Select
                value={filters.hasPeople}
                onValueChange={(value) => setFilter("hasPeople", value as GalleryFilters["hasPeople"])}
                options={[
                  { value: "", label: t("Gallery People Any") },
                  { value: "yes", label: t("Gallery People With") },
                  { value: "no", label: t("Gallery People Without") },
                ]}
              />
            </Field>
            <Field label={t("Gallery Min Duration")}>
              <Select
                value={String(filters.minDuration)}
                onValueChange={(value) => setFilter("minDuration", Number(value))}
                options={MIN_DURATIONS.map((seconds) => ({
                  value: String(seconds),
                  label:
                    seconds === 0
                      ? t("Gallery Any Duration")
                      : t("Gallery Seconds Or More", { seconds }),
                }))}
              />
            </Field>
          </div>

          {!isUnfiltered(filters) && (
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSearchText("");
                  applyFilters(EMPTY_FILTERS);
                }}
              >
                <X size={14} />
                {t("Gallery Clear Filters")}
              </Button>
            </div>
          )}
        </div>
      </Card>

      {listQuery.isError ? (
        <Alert tone="danger">{errorText(listQuery.error, t)}</Alert>
      ) : listQuery.isPending ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 15 }, (_, index) => (
            <div key={index} className="overflow-hidden rounded-xl border bg-card">
              <Skeleton className="aspect-video w-full rounded-none" />
              <div className="space-y-1.5 p-2.5">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {isUnfiltered(activeFilters) ? t("Gallery Empty Library") : t("Gallery No Matches")}
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground tabular-nums">
            {t("Gallery Showing", { shown: items.length, total })}
          </p>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {items.map((item) => (
              <FootageCard key={item.local_file} item={item} onSelect={setSelected} />
            ))}
          </div>

          <div ref={sentinelRef} aria-hidden className="h-px" />

          <div className="flex justify-center py-4">
            {isFetchingNextPage ? (
              <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="animate-spin" size={16} /> {t("Loading")}
              </span>
            ) : hasNextPage ? (
              <Button size="sm" onClick={() => void fetchNextPage()}>
                {t("Gallery Load More")}
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">{t("Gallery End Of Results")}</span>
            )}
          </div>
        </>
      )}

      {selected && <FootageDetail item={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
