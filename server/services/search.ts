import { createHash } from 'node:crypto';

import { parseHTML } from 'linkedom';

import type { Settings } from '../config';
import { AppError } from '../errors';
import type { MemoryCache } from './cache';
import { decodeBody, type HttpClient } from './http';

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  engine: string;
  rank: number;
};

export type SearchOptions = { signal?: AbortSignal };

export type SearchService = {
  searchMany(queries: string[], limit: number, options?: SearchOptions): Promise<SearchResult[]>;
};

const CANDIDATE_LIMIT = 20;
const MAX_PER_DOMAIN = 2;
const MAX_TITLE_CHARS = 280;
const MAX_SNIPPET_CHARS = 640;
const CACHE_TTL_SECONDS = 300;

type RawResult = { url: string; title: string; snippet: string; engine: string; rank: number };
type ProviderOutcome = {
  name: 'duckduckgo' | 'bing';
  status: 'ok' | 'empty' | 'blocked' | 'timeout' | 'error' | 'skipped';
  results: RawResult[];
  attempts: number;
  error?: string;
};

const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'igshid', 'mc_cid', 'mc_eid', 'ref_src', 'msclkid']);

function isTracking(name: string): boolean {
  const lowered = name.toLowerCase();
  return lowered.startsWith('utm_') || TRACKING_PARAMS.has(lowered);
}

export function normalizeSearchUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null;
  if (url.username || url.password) return null;
  const search = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (!isTracking(key)) search.append(key, value);
  }
  const query = search.toString();
  return `${url.protocol}//${url.host.toLowerCase()}${url.pathname || '/'}${query ? `?${query}` : ''}`;
}

export function canonicalResultKey(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/^www\./u, '');
  const path = parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/+$/u, '');
  const query = [...parsed.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const suffix = query.length ? `?${new URLSearchParams(query).toString()}` : '';
  return `${host}${path}${suffix}`;
}

function decodeEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1')
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/giu, (_, name: string) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    }[name.toLowerCase()] ?? ''));
}

function stripTags(value: string): string {
  return ` ${decodeEntities(value.replace(/<[^>]*>/gu, ' '))} `.replace(/\s+/gu, ' ').trim();
}

function unwrapDdgUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return value;
  const absolute = value.startsWith('//') ? `https:${value}` : value;
  try {
    const url = new URL(absolute);
    const host = url.hostname.toLowerCase();
    if ((host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) && url.pathname.startsWith('/l/')) {
      return url.searchParams.get('uddg') ?? absolute;
    }
    return absolute;
  } catch {
    return value;
  }
}

type DomLink = { getAttribute(name: string): string | null; textContent: string | null };

function parseDuckDuckGo(html: string): RawResult[] {
  const { document } = parseHTML(html);
  const links = Array.from(document.querySelectorAll('.result__a')) as DomLink[];
  const snippets = Array.from(document.querySelectorAll('.result__snippet')) as DomLink[];
  return links.map((link, index) => ({
    url: unwrapDdgUrl(link.getAttribute('href') ?? ''),
    title: link.textContent ?? '',
    snippet: snippets[index]?.textContent ?? '',
    engine: 'duckduckgo',
    rank: index + 1,
  }));
}

function parseBingRss(xml: string): RawResult[] {
  const results: RawResult[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/giu)) {
    const item = match[1];
    const field = (name: string): string =>
      stripTags(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'iu').exec(item)?.[1] ?? '');
    const url = field('link');
    if (!url) continue;
    results.push({
      url,
      title: field('title'),
      snippet: field('description'),
      engine: 'bing',
      rank: results.length + 1,
    });
  }
  return results;
}

function truncate(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit).trimEnd()}…`;
}

function rankOf(result: RawResult, fallback: number): number {
  return Number.isFinite(result.rank) ? Math.max(1, Math.trunc(result.rank)) : fallback;
}

function normalizeResult(result: RawResult, index: number): SearchResult | null {
  const url = normalizeSearchUrl(result.url);
  if (!url) return null;
  const domain = (new URL(url).hostname || '').replace(/^www\./u, '');
  return {
    title: truncate(result.title || result.url, MAX_TITLE_CHARS),
    url,
    snippet: truncate(result.snippet, MAX_SNIPPET_CHARS),
    domain,
    engine: result.engine,
    rank: rankOf(result, index + 1),
  };
}

export function dedupeResults(results: SearchResult[]): SearchResult[] {
  const merged = new Map<string, SearchResult>();
  for (const result of results) {
    const key = canonicalResultKey(result.url);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...result });
      continue;
    }
    const engines = new Set(`${existing.engine},${result.engine}`.split(',').filter(Boolean));
    existing.engine = [...engines].sort().join(',');
    existing.rank = Math.min(existing.rank, result.rank);
    if (result.snippet.length > existing.snippet.length) existing.snippet = result.snippet;
    if (result.title.length > existing.title.length) existing.title = result.title;
    if (result.url.startsWith('https://') && !existing.url.startsWith('https://')) existing.url = result.url;
  }
  return [...merged.values()].sort((left, right) => left.rank - right.rank || left.title.localeCompare(right.title));
}

export function selectDiverse(results: SearchResult[], limit: number): SearchResult[] {
  const selected: SearchResult[] = [];
  const deferred: SearchResult[] = [];
  const counts = new Map<string, number>();
  for (const result of results) {
    const domain = result.domain.toLowerCase();
    if ((counts.get(domain) ?? 0) >= MAX_PER_DOMAIN) {
      deferred.push(result);
      continue;
    }
    selected.push(result);
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
    if (selected.length >= limit) return selected;
  }
  return [...selected, ...deferred].slice(0, limit);
}

export function queryTerms(query: string): string[] {
  const normalized = query.normalize('NFKC').toLowerCase()
    .replace(/(?:^|\s)(?:site|filetype|inurl|intitle):\S+/gu, ' ');
  const stop = new Set(['the', 'what', 'how', 'when', 'where', 'which', 'who', 'about', 'latest']);
  const terms: string[] = [];
  for (const word of normalized.match(/[a-z0-9][a-z0-9_.+-]*|[\u3400-\u9fff]+/gu) ?? []) {
    if (word.length < 2 || stop.has(word)) continue;
    if (/^[a-z0-9]+$/u.test(word) || word.length <= 2) terms.push(word);
    else for (let index = 0; index < word.length - 1; index += 1) terms.push(word.slice(index, index + 2));
  }
  return [...new Set(terms)].slice(0, 32);
}

export function rankRelevant(query: string, results: SearchResult[]): SearchResult[] {
  const terms = queryTerms(query);
  if (!terms.length) return results;
  const score = (result: SearchResult): number => {
    const title = result.title.normalize('NFKC').toLowerCase();
    const domain = result.domain.normalize('NFKC').toLowerCase();
    const snippet = result.snippet.normalize('NFKC').toLowerCase();
    return terms.reduce((sum, term) => sum
      + (title.includes(term) ? 3 : domain.includes(term) ? 2 : snippet.includes(term) ? 1 : 0), 0);
  };
  return [...results].sort((left, right) => score(right) - score(left));
}

function prepare(query: string, raw: RawResult[], limit: number): SearchResult[] {
  const normalized = raw.slice(0, CANDIDATE_LIMIT)
    .map((result, index) => normalizeResult(result, index))
    .filter((result): result is SearchResult => result !== null);
  return selectDiverse(rankRelevant(query, dedupeResults(normalized)), limit);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error
    && (error.name === 'TimeoutError' || error.name === 'AbortError' || /timed out|timeout/iu.test(error.message));
}

function classify(error: unknown): ProviderOutcome['status'] {
  if (isTimeout(error)) return 'timeout';
  return 'error';
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function createSearchService(options: {
  cache: MemoryCache;
  settings: Settings;
  http: HttpClient;
}): SearchService {
  const { cache, settings, http } = options;
  const flights = new Map<string, Promise<SearchResult[]>>();
  const breaker = { failures: 0, openUntil: 0 };

  async function duckDuckGo(query: string, deadline: number, signal?: AbortSignal): Promise<ProviderOutcome> {
    const started = Date.now();
    if (settings.SEARCH_BREAKER_FAILURES > 0 && breaker.openUntil > started) {
      return { name: 'duckduckgo', status: 'skipped', results: [], attempts: 0 };
    }
    let attempts = 0;
    let status: ProviderOutcome['status'] = 'timeout';
    let error = '';
    while (attempts < settings.SEARCH_MAX_ATTEMPTS) {
      const remaining = (deadline - Date.now()) / 1000;
      const reserve = settings.SEARCH_FALLBACK ? 2 : 0;
      const cap = Math.min(settings.SEARCH_DDGS_TIMEOUT_SECONDS, remaining - reserve);
      if (cap < 1) {
        error = 'no time left for DuckDuckGo';
        break;
      }
      attempts += 1;
      const attemptStarted = Date.now();
      try {
        const response = await http.get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
          timeoutMs: Math.max(500, Math.min((cap + 0.5) * 1000, remaining * 1000)),
          maxBytes: settings.SEARCH_MAX_BYTES,
          headers: {
            'User-Agent': settings.SEARCH_USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
          ...(signal ? { signal } : {}),
        });
        if (response.status === 200) {
          const results = parseDuckDuckGo(decodeBody(response.body, response.headers['content-type']));
          breaker.failures = 0;
          breaker.openUntil = 0;
          return {
            name: 'duckduckgo',
            status: results.length ? 'ok' : 'empty',
            results,
            attempts,
          };
        }
        if ([202, 403, 429].includes(response.status)) {
          status = 'blocked';
          error = `DuckDuckGo returned HTTP ${response.status}`;
          break;
        }
        status = 'error';
        error = `DuckDuckGo returned HTTP ${response.status}`;
      } catch (caught) {
        status = classify(caught);
        error = errorText(caught);
        if (status === 'blocked' || attempts >= settings.SEARCH_MAX_ATTEMPTS) break;
        if (Date.now() - attemptStarted >= 2000 || (deadline - Date.now()) < 4000) break;
        continue;
      }
      if (attempts >= settings.SEARCH_MAX_ATTEMPTS) break;
    }
    if (settings.SEARCH_BREAKER_FAILURES > 0) {
      breaker.failures += 1;
      if (breaker.failures >= settings.SEARCH_BREAKER_FAILURES) {
        breaker.openUntil = Date.now() + settings.SEARCH_BREAKER_COOLDOWN_SECONDS * 1000;
      }
    }
    return { name: 'duckduckgo', status, results: [], attempts, error };
  }

  async function bing(query: string, deadline: number, signal?: AbortSignal): Promise<ProviderOutcome> {
    let attempts = 0;
    let status: ProviderOutcome['status'] = 'timeout';
    let error = '';
    while (attempts < settings.SEARCH_MAX_ATTEMPTS) {
      const remaining = (deadline - Date.now()) / 1000;
      if (remaining < 0.5) {
        error = error || 'no time left for Bing';
        break;
      }
      attempts += 1;
      try {
        const url = new URL('https://www.bing.com/search');
        url.searchParams.set('format', 'rss');
        url.searchParams.set('count', String(CANDIDATE_LIMIT));
        url.searchParams.set('q', query);
        const response = await http.get(url.toString(), {
          timeoutMs: Math.max(500, remaining * 1000),
          maxBytes: settings.SEARCH_MAX_BYTES,
          maxRedirects: 5,
          headers: {
            'User-Agent': settings.SEARCH_USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
          ...(signal ? { signal } : {}),
        });
        if (response.status === 200) {
          const results = parseBingRss(decodeBody(response.body, response.headers['content-type']));
          return { name: 'bing', status: results.length ? 'ok' : 'empty', results, attempts };
        }
        status = response.status === 429 ? 'blocked' : 'error';
        error = `Bing returned HTTP ${response.status}`;
        if (response.status < 500) break;
      } catch (caught) {
        status = isTimeout(caught) ? 'timeout' : 'error';
        error = errorText(caught);
        if (attempts >= settings.SEARCH_MAX_ATTEMPTS || (deadline - Date.now()) < 1000) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(500, 250 * attempts)));
        continue;
      }
      if (attempts >= settings.SEARCH_MAX_ATTEMPTS) break;
    }
    return { name: 'bing', status, results: [], attempts, error };
  }

  async function uncached(query: string, limit: number, cacheKey: string | null, signal?: AbortSignal): Promise<SearchResult[]> {
    const deadline = Date.now() + settings.SEARCH_TIMEOUT_SECONDS * 1000;
    const outcomes: ProviderOutcome[] = [];
    let results: SearchResult[] = [];
    const primary = await duckDuckGo(query, deadline, signal);
    outcomes.push(primary);
    if (primary.status === 'ok') results = prepare(query, primary.results, limit);
    if (!results.length && settings.SEARCH_FALLBACK && Date.now() < deadline - 500) {
      const fallback = await bing(query, deadline, signal);
      outcomes.push(fallback);
      if (fallback.status === 'ok') results = prepare(query, fallback.results, limit);
    }
    if (!results.length) {
      if (outcomes.some((outcome) => outcome.status === 'ok' || outcome.status === 'empty')) return [];
      throw new AppError(502, 'upstream_error', '联网服务暂时不可用，请稍后重试。');
    }
    if (cacheKey) cache.set(cacheKey, JSON.stringify(results), CACHE_TTL_SECONDS);
    return results;
  }

  async function search(query: string, limit: number, options: SearchOptions = {}): Promise<SearchResult[]> {
    const cacheKey = `matrius:search:v2:${createHash('sha256').update(`${query}|${limit}`).digest('hex')}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as SearchResult[];
      } catch {
        // Ignore a corrupted entry and search again.
      }
    }
    const flight = flights.get(cacheKey);
    if (flight) return flight;
    const task = uncached(query, limit, cacheKey, options.signal)
      .finally(() => flights.delete(cacheKey));
    flights.set(cacheKey, task);
    return task;
  }

  return {
    async searchMany(queries, limit, options = {}) {
      const normalized = [...new Set(queries.map((query) => query.trim()).filter(Boolean))];
      if (!normalized.length) return [];
      if (normalized.length === 1) return search(normalized[0], limit, options);
      const perQueryLimit = Math.max(10, Math.min(CANDIDATE_LIMIT, limit));
      const settled = await Promise.allSettled(
        normalized.map((query) => search(query, perQueryLimit, options)),
      );
      const merged: SearchResult[] = [];
      const failures: unknown[] = [];
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') merged.push(...outcome.value);
        else failures.push(outcome.reason);
      }
      if (!merged.length && failures.length === normalized.length) throw failures[0];
      return selectDiverse(rankRelevant(normalized.join(' '), dedupeResults(merged)), limit);
    },
  };
}
