import { useCallback, useEffect, useRef, useState } from 'react';

import { bulkDeleteFiles, listFiles, renameFile, type LibraryFile } from './files-api.web';
import type { LibraryKind, LibraryOrder, LibrarySort } from './types';

type ApiRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;
const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();

function readError(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  return '暂时无法加载资料库，请稍后重试。';
}

/**
 * Library browsing state: debounced search, kind/sort filters and cursor pagination.
 *
 * The list carries the filter key it belongs to, so a filter change is visible immediately.
 * The previous page stays on screen while the next one loads (`refreshing`) instead of being
 * swapped for the skeleton on every tab switch. Every request also checks a generation
 * counter, which keeps a slow response from an earlier search from overwriting the current
 * list.
 */
export function useFileLibrary({ request, enabled, initialKind = 'all' }: {
  request: ApiRequest;
  enabled: boolean;
  initialKind?: LibraryKind;
}) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [kind, setKind] = useState<LibraryKind>(initialKind);
  const [sort, setSort] = useState<LibrarySort>('created');
  const [order, setOrder] = useState<LibraryOrder>('desc');
  const [reloadKey, setReloadKey] = useState(0);
  const [list, setList] = useState<{ key: string; items: LibraryFile[]; nextCursor: string | null; error: string | null }>(
    { key: '', items: [], nextCursor: null, error: null },
  );
  const [more, setMore] = useState<{ key: string; loading: boolean } | null>(null);
  const [selection, setSelection] = useState<{ key: string; ids: ReadonlySet<string> }>({ key: '', ids: EMPTY_SELECTION });
  const generation = useRef(0);

  const filterKey = JSON.stringify([enabled, debouncedQuery, kind, sort, order, reloadKey]);
  const current = list.key === filterKey;
  // Keep the last completed page visible while the new filter loads. Only a first load
  // (or a filter with no previous rows) falls back to the skeleton.
  const refreshing = enabled && !current && list.items.length > 0 && !list.error;
  const items = current || refreshing ? list.items : [];
  const nextCursor = current ? list.nextCursor : null;
  const error = current ? list.error : null;
  const loading = enabled && !current;
  const loadingMore = more !== null && more.key === filterKey && more.loading;
  const selected = selection.key === filterKey ? selection.ids : EMPTY_SELECTION;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!enabled) return;
    const key = filterKey;
    const requestGeneration = ++generation.current;
    const controller = new AbortController();

    listFiles(request, { query: debouncedQuery, kind, sort, order, limit: PAGE_SIZE }, controller.signal)
      .then((page) => {
        if (requestGeneration !== generation.current) return;
        setList({ key, items: page.items, nextCursor: page.nextCursor, error: null });
      })
      .catch((reason: unknown) => {
        if (requestGeneration !== generation.current || controller.signal.aborted) return;
        setList({ key, items: [], nextCursor: null, error: readError(reason) });
      });

    return () => controller.abort();
  }, [enabled, filterKey, debouncedQuery, kind, sort, order, request]);

  const loadMore = useCallback(() => {
    if (!enabled || !nextCursor || loadingMore) return;
    const key = filterKey;
    const requestGeneration = generation.current;
    setMore({ key, loading: true });
    listFiles(request, { query: debouncedQuery, kind, sort, order, cursor: nextCursor, limit: PAGE_SIZE })
      .then((page) => {
        if (requestGeneration !== generation.current) return;
        setList((previous) => {
          if (previous.key !== key) return previous;
          const seen = new Set(previous.items.map((item) => item.id));
          return { ...previous, items: [...previous.items, ...page.items.filter((item) => !seen.has(item.id))], nextCursor: page.nextCursor };
        });
      })
      .catch((reason: unknown) => {
        if (requestGeneration !== generation.current) return;
        setList((previous) => previous.key === key ? { ...previous, error: readError(reason) } : previous);
      })
      .finally(() => {
        if (requestGeneration === generation.current) setMore({ key, loading: false });
      });
  }, [enabled, nextCursor, loadingMore, filterKey, debouncedQuery, kind, sort, order, request]);

  const refresh = useCallback(() => setReloadKey((value) => value + 1), []);

  const rename = useCallback(async (id: string, filename: string) => {
    const updated = await renameFile(request, id, filename);
    setList((previous) => ({
      ...previous,
      items: previous.items.map((item) => item.id === id ? { ...item, ...updated } : item),
    }));
    return updated;
  }, [request]);

  const remove = useCallback(async (ids: string[]) => {
    const target = new Set(ids);
    const result = await bulkDeleteFiles(request, ids);
    setList((previous) => ({ ...previous, items: previous.items.filter((item) => !target.has(item.id)) }));
    setSelection((previous) => {
      const next = new Set(previous.ids);
      for (const id of ids) next.delete(id);
      return { key: previous.key, ids: next };
    });
    return result.deleted;
  }, [request]);

  const toggleSelected = useCallback((id: string) => {
    setSelection((previous) => {
      const ids = new Set(previous.key === filterKey ? previous.ids : EMPTY_SELECTION);
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      return { key: filterKey, ids };
    });
  }, [filterKey]);

  const selectMany = useCallback((ids: string[]) => setSelection({ key: filterKey, ids: new Set(ids) }), [filterKey]);
  const clearSelection = useCallback(() => setSelection({ key: filterKey, ids: EMPTY_SELECTION }), [filterKey]);
  const toggleOrder = useCallback(() => setOrder((value) => value === 'desc' ? 'asc' : 'desc'), []);

  return {
    query, setQuery,
    kind, setKind,
    sort, setSort,
    order, setOrder, toggleOrder,
    items, nextCursor, loading, loadingMore, refreshing, error,
    selected, toggleSelected, selectMany, clearSelection,
    loadMore, refresh, rename, remove,
  };
}

export type FileLibrary = ReturnType<typeof useFileLibrary>;
