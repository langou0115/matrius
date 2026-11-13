import type { WebActivity, WebSearchResult } from '../../../contract/agent-protocol';

export const WEB_SEARCH_TOOL_NAME = 'web_search';
export const WEB_FETCH_TOOL_NAME = 'web_fetch';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseHttpUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function getQueries(record: Record<string, unknown> | null): string[] {
  if (!record) return [];
  const raw = Array.isArray(record.queries) ? record.queries : [];
  const values = raw.filter((value): value is string => typeof value === 'string');
  const single = getString(record.query);
  const source = values.length ? values : single ? [single] : [];
  return [...new Set(source.map((query) => query.trim()).filter(Boolean))].slice(0, 4);
}

function truncate(value: string, limit: number): string {
  const normalized = value.trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit).trimEnd()}…`;
}

function normalizeSearchResult(value: unknown): WebSearchResult | null {
  if (!isRecord(value)) return null;
  const url = getString(value.url);
  const title = getString(value.title);
  if (!url || !title || !parseHttpUrl(url)) return null;
  return {
    title: truncate(title, 280),
    url,
    snippet: typeof value.snippet === 'string' ? truncate(value.snippet, 640) : '',
    domain: getString(value.domain) ?? '',
    engine: getString(value.engine) ?? '',
    rank: typeof value.rank === 'number' && Number.isFinite(value.rank) ? value.rank : 0,
  };
}

function normalizeSearchResults(value: unknown): WebSearchResult[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeSearchResult).filter((result): result is WebSearchResult => result !== null);
}

export function getWebActivityStart(
  toolName: string,
  toolCallId: string,
  args: unknown,
): WebActivity | null {
  const record = isRecord(args) ? args : {};
  if (toolName === WEB_SEARCH_TOOL_NAME) {
    const queries = getQueries(record);
    return queries.length
      ? { id: toolCallId, kind: 'search', status: 'running', query: queries[0], queries, results: [] }
      : null;
  }
  if (toolName === WEB_FETCH_TOOL_NAME) {
    const rawUrls = Array.isArray(record.urls)
      ? record.urls.filter((value): value is string => typeof value === 'string')
      : [];
    const single = getString(record.url);
    const urls = (rawUrls.length ? rawUrls : single ? [single] : [])
      .map(parseHttpUrl)
      .filter((url): url is string => url !== null);
    if (!urls.length) return null;
    return { id: toolCallId, kind: 'fetch', status: 'running', url: urls[0], urls: [...new Set(urls)] };
  }
  return null;
}

function getResultDetails(result: unknown): Record<string, unknown> | null {
  return isRecord(result) && isRecord(result.details) ? result.details : null;
}

function getToolResultText(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
  for (const item of result.content) {
    if (!isRecord(item) || item.type !== 'text') continue;
    const text = getString(item.text);
    if (text) return text;
  }
  return undefined;
}

export function getWebActivityEnd(
  toolName: string,
  toolCallId: string,
  result: unknown,
  isError: boolean,
  previous?: WebActivity,
): WebActivity | null {
  const details = getResultDetails(result);
  const error = isError ? getToolResultText(result) || '联网工具执行失败。' : getString(details?.warning);
  const tookMs = typeof details?.tookMs === 'number' && Number.isFinite(details.tookMs)
    ? details.tookMs
    : undefined;
  const base = {
    id: toolCallId,
    status: isError ? 'error' as const : 'complete' as const,
    ...(error ? { error } : {}),
    ...(tookMs !== undefined ? { tookMs } : {}),
  };

  if (toolName === WEB_SEARCH_TOOL_NAME) {
    const previousSearch = previous?.kind === 'search' ? previous : undefined;
    const returnedQueries = getQueries(details);
    const queries = returnedQueries.length
      ? returnedQueries
      : previousSearch?.queries ?? (previousSearch?.query ? [previousSearch.query] : []);
    const query = getString(details?.query) ?? queries[0];
    if (!query) return null;
    const results = normalizeSearchResults(details?.results);
    return {
      ...base,
      kind: 'search',
      query,
      queries: queries.length ? queries : [query],
      results: results.length ? results : previousSearch?.results ?? [],
    };
  }

  if (toolName === WEB_FETCH_TOOL_NAME) {
    const previousFetch = previous?.kind === 'fetch' ? previous : undefined;
    const returnedUrl = getString(details?.url);
    const url = returnedUrl ? parseHttpUrl(returnedUrl) : previousFetch?.url;
    if (!url) return null;
    const title = getString(details?.title) ?? previousFetch?.title;
    const urls = Array.isArray(details?.urls)
      ? details.urls
        .map((item) => (typeof item === 'string' ? parseHttpUrl(item) : null))
        .filter((item): item is string => item !== null)
      : previousFetch?.urls ?? [url];
    return {
      ...base,
      kind: 'fetch',
      url,
      urls,
      ...(title ? { title } : {}),
    };
  }

  return null;
}
