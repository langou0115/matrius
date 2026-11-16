import { parseHTML } from 'linkedom';

import type { Settings } from '../config';
import type { MemoryCache } from './cache';
import { decodeBody, type HttpClient } from './http';
import type { SearchResult } from './search';

/**
 * Discover a product's own news/changelog pages from search results.
 *
 * A search engine page is capped at roughly ten results and often ranks brand
 * homepages above news. When the question is specifically about an update or an
 * announcement, the product's own news index and sitemap are a better source
 * than one more search query. The search results already reveal the official
 * domain (or a docs/API sibling), so this module only probes that site and its
 * own subdomains — it never guesses an unrelated host. The homepage navigation,
 * `/sitemap.xml` and the news index linked from the homepage are read with a
 * shared deadline; a blocked or missing site simply contributes no extra results.
 */

const CACHE_TTL_SECONDS = 600;
const EMPTY_CACHE_TTL_SECONDS = 120;
// Per official site: keep the discovery result set focused on recent articles.
// This is not a cap on the search tool's own result count.
const MAX_RESULTS = 10;
const MAX_INDEX_PAGES = 2;
const MIN_REQUEST_MS = 300;
const REQUEST_TIMEOUT_MS = 2_500;

const UPDATE_INTENT = /(?:更新|发布|公告|版本|上线|推出|新功能|升级|最新|动态|新闻|release|releases|changelog|announcement|announce|update|updates|latest|version|launch|roadmap|what'?s new|news)/iu;
const NEWS_PATH = /\/(?:news|blog|changelog|changes|updates?|releases?|announcements?|press|whats-new|release-notes)(?:\/|$)/iu;
const DATE_PATH = /(?:^|\/)(?:19|20)\d{2}[-/]\d{1,2}(?:[-/]\d{1,2})?(?:\/|$)/u;
const DATE_FILE = /news\d{4,}/iu;
const NEWS_ANCHOR = /(?:news|blog|changelog|release|update|公告|动态|更新|发布|新闻|更多|more)/iu;
const NEWS_INDEX = /\/(?:news|blog|changelog|updates?|press)\/?$/iu;
const GENERIC_TITLE = /^(?:news|blog|changelog|updates?|release notes?|press|更多|more|详情|read more|this documentation|documentation|click here|here|link)$/iu;
const SIBLING_HOST = /^(?:api|api-docs|docs|developer|developers|news|blog|changelog|updates?)\./u;

/** Hosts that are platforms, media or aggregators rather than a product's own site. */
const THIRD_PARTY_HOSTS = new Set([
  'github.com',
  'gist.github.com',
  'apps.apple.com',
  'play.google.com',
  'baike.baidu.com',
  'zhidao.baidu.com',
  'tieba.baidu.com',
  'wenku.baidu.com',
  'huggingface.co',
  'openrouter.ai',
  'build.nvidia.com',
  'opencode.ai',
  'ithome.com',
  'zhihu.com',
  'csdn.net',
  'juejin.cn',
  'medium.com',
  'youtube.com',
  'x.com',
  'twitter.com',
  'reddit.com',
  'news.ycombinator.com',
  'wikipedia.org',
  'weibo.com',
  '36kr.com',
  'sina.com.cn',
  'qq.com',
  '163.com',
  'sohu.com',
  'theverge.com',
  'techcrunch.com',
  'reuters.com',
  'bloomberg.com',
  'nytimes.com',
  'bbc.com',
  'bbc.co.uk',
  'apnews.com',
  'cnbc.com',
  'forbes.com',
  'wired.com',
  'arstechnica.com',
  'engadget.com',
  'cnbeta.com',
  'oschina.net',
  'infoq.cn',
  '51cto.com',
]);

const SUBDOMAIN_PREFIXES = new Set([
  'www', 'api', 'api-docs', 'docs', 'download', 'chat', 'blog', 'en', 'm', 'mobile',
  'news', 'platform', 'status', 'help', 'support', 'community', 'developer', 'developers',
]);

export type OfficialDiscoveryOptions = {
  cache: MemoryCache;
  settings: Settings;
  http: HttpClient;
  results: SearchResult[];
  /** Absolute timestamp shared with the search call. */
  deadline: number;
  signal?: AbortSignal;
  normalizeUrl: (raw: string) => string | null;
};

type Anchor = {
  getAttribute(name: string): string | null;
  textContent: string | null;
};

type Discovered = {
  url: string;
  title: string;
  date?: string;
  order: number;
};

export function isUpdateIntent(query: string): boolean {
  return UPDATE_INTENT.test(query.normalize('NFKC'));
}

function isThirdParty(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^www\./u, '');
  for (const blocked of THIRD_PARTY_HOSTS) {
    if (normalized === blocked || normalized.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

/** `api-docs.example.com` and `download.example.com` belong to `example.com`. */
function rootHost(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./u, '').split('.').filter(Boolean);
  while (labels.length > 2 && SUBDOMAIN_PREFIXES.has(labels[0] ?? '')) labels.shift();
  return labels.join('.');
}

function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./u, '');
}

function officialRoot(results: SearchResult[]): string | null {
  const scores = new Map<string, { count: number; best: number }>();
  for (const result of results.slice(0, 20)) {
    let host: string;
    try {
      host = new URL(result.url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (isThirdParty(host)) continue;
    const root = rootHost(host);
    if (!root || isThirdParty(root)) continue;
    const entry = scores.get(root) ?? { count: 0, best: Number.POSITIVE_INFINITY };
    entry.count += 1;
    entry.best = Math.min(entry.best, Number.isFinite(result.rank) && result.rank > 0 ? result.rank : 100);
    scores.set(root, entry);
  }
  const best = [...scores.entries()].sort((left, right) =>
    right[1].count - left[1].count || left[1].best - right[1].best)[0];
  return best?.[0] ?? null;
}

/**
 * Official hosts worth probing: the site itself plus sibling subdomains that
 * appeared in the results (docs, API, developer, news). A result URL that is
 * already news-like is the strongest signal because that subdomain often carries
 * the newest changelog.
 */
function officialHosts(results: SearchResult[], root: string): string[] {
  const hosts = new Map<string, { count: number; best: number; news: boolean }>();
  for (const result of results.slice(0, 20)) {
    let host: string;
    let news = false;
    try {
      host = new URL(result.url).hostname.toLowerCase().replace(/^www\./u, '');
      news = isNewsUrl(result.url);
    } catch {
      continue;
    }
    if (isThirdParty(host) || !isOfficialHostname(host, root)) continue;
    const entry = hosts.get(host) ?? { count: 0, best: Number.POSITIVE_INFINITY, news: false };
    entry.count += 1;
    entry.best = Math.min(entry.best, Number.isFinite(result.rank) && result.rank > 0 ? result.rank : 100);
    entry.news = entry.news || news;
    hosts.set(host, entry);
  }
  if (!hosts.has(root)) hosts.set(root, { count: 1, best: 100, news: false });

  const score = (host: string, entry: { count: number; best: number; news: boolean }): number =>
    (entry.news ? 2 : 0)
    + (host === root ? 1 : 0)
    + (/^(?:api|api-docs|docs|developer|developers|news|blog)\./u.test(host) ? 1 : 0);

  return [...hosts.entries()]
    .filter(([host, entry]) => host === root
      || entry.news
      || /^(?:api|api-docs|docs|developer|developers|news|blog)\./u.test(host))
    .sort((left, right) => score(right[0], right[1]) - score(left[0], left[1])
      || right[1].count - left[1].count
      || left[1].best - right[1].best)
    .slice(0, 3)
    .map(([host]) => host);
}

function resolveHttpUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href.trim(), base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function isOfficialHostname(host: string, root: string): boolean {
  return host === root || host.endsWith(`.${root}`);
}

function isOfficialHost(url: string, root: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./u, '');
    return isOfficialHostname(host, root);
  } catch {
    return false;
  }
}

function isNewsUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    return NEWS_PATH.test(path) || DATE_PATH.test(path) || DATE_FILE.test(path);
  } catch {
    return false;
  }
}

function isNewsIndex(url: string): boolean {
  try {
    return NEWS_INDEX.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).at(-1) ?? parsed.hostname;
    const dated = /^news(\d{2})(\d{2})(\d{2})$/iu.exec(last);
    if (dated) return `News 20${dated[1]}-${dated[2]}-${dated[3]}`;
    return decodeURIComponent(last).replace(/[-_]+/gu, ' ').trim() || url;
  } catch {
    return url;
  }
}

function dateFromUrl(url: string): string | undefined {
  try {
    const match = /news(\d{2})(\d{2})(\d{2})(?:\/|$)/u.exec(new URL(url).pathname);
    return match ? `20${match[1]}-${match[2]}-${match[3]}` : undefined;
  } catch {
    return undefined;
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'");
}

function parseIndexPage(
  html: string,
  pageUrl: string,
  root: string,
  add: (url: string, title: string, date?: string) => void,
): void {
  const { document } = parseHTML(html);
  const anchors = Array.from(document.querySelectorAll('a[href]')) as Anchor[];
  for (const anchor of anchors) {
    const url = resolveHttpUrl(anchor.getAttribute('href') ?? '', pageUrl);
    if (!url || !isOfficialHost(url, root) || !isNewsUrl(url) || isNewsIndex(url)) continue;
    const text = (anchor.textContent ?? '').replace(/\s+/gu, ' ').trim();
    add(url, text || titleFromUrl(url), dateFromUrl(url));
  }
}

function findNewsIndexes(html: string, pageUrl: string, root: string): string[] {
  const { document } = parseHTML(html);
  const anchors = Array.from(document.querySelectorAll('a[href]')) as Anchor[];
  const found = new Set<string>();
  for (const anchor of anchors) {
    const url = resolveHttpUrl(anchor.getAttribute('href') ?? '', pageUrl);
    if (!url || !isOfficialHost(url, root) || url === pageUrl) continue;
    const path = new URL(url).pathname;
    if (!/\/(?:news|blog|changelog|updates?|press)\/?$/iu.test(path)) continue;
    const text = (anchor.textContent ?? '').replace(/\s+/gu, ' ').trim();
    if (!NEWS_ANCHOR.test(`${text} ${url}`)) continue;
    found.add(url);
  }
  return [...found].slice(0, MAX_INDEX_PAGES);
}

/**
 * The official homepage usually links to its docs/API subdomain. Reading those
 * links lets us probe a sibling sitemap that the search results did not reveal,
 * without guessing a host name.
 */
function findSiblingHosts(html: string, pageUrl: string, root: string): string[] {
  const { document } = parseHTML(html);
  const anchors = Array.from(document.querySelectorAll('a[href]')) as Anchor[];
  const found = new Set<string>();
  for (const anchor of anchors) {
    const url = resolveHttpUrl(anchor.getAttribute('href') ?? '', pageUrl);
    if (!url || !isOfficialHost(url, root)) continue;
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./u, '');
    if (host !== root && SIBLING_HOST.test(host) && !isThirdParty(host)) found.add(host);
  }
  return [...found].slice(0, 3);
}

function parseSitemap(
  xml: string,
  root: string,
  add: (url: string, title: string, date?: string) => void,
): void {
  for (const match of xml.matchAll(/<url>([\s\S]*?)<\/url>/giu)) {
    const block = match[1] ?? '';
    const loc = decodeXml(/<loc>([\s\S]*?)<\/loc>/iu.exec(block)?.[1]?.trim() ?? '');
    if (!loc) continue;
    const url = resolveHttpUrl(loc, `https://${root}/`);
    if (!url || !isOfficialHost(url, root) || !isNewsUrl(url) || isNewsIndex(url)) continue;
    const lastmod = /<lastmod>([\s\S]*?)<\/lastmod>/iu.exec(block)?.[1]?.trim();
    add(url, titleFromUrl(url), lastmod ?? dateFromUrl(url));
  }
}

async function readText(
  url: string,
  options: Pick<OfficialDiscoveryOptions, 'settings' | 'http' | 'deadline' | 'signal'>,
): Promise<string> {
  const remaining = options.deadline - Date.now();
  if (remaining < MIN_REQUEST_MS) throw new Error('no time left for the official source');
  const response = await options.http.get(url, {
    timeoutMs: Math.min(REQUEST_TIMEOUT_MS, Math.max(MIN_REQUEST_MS, remaining)),
    maxBytes: Math.min(options.settings.SEARCH_MAX_BYTES, 2 * 1024 * 1024),
    maxRedirects: 3,
    headers: {
      'User-Agent': options.settings.SEARCH_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (response.status !== 200) throw new Error(`official source returned HTTP ${response.status}`);
  return decodeBody(response.body, response.headers['content-type'] ?? '');
}

async function probe(
  host: string,
  root: string,
  options: OfficialDiscoveryOptions,
): Promise<{ results: SearchResult[]; siblings: string[] }> {
  const homepage = `https://${host}/`;
  const [home, sitemap] = await Promise.all([
    readText(homepage, options).catch(() => null),
    readText(`https://${host}/sitemap.xml`, options).catch(() => null),
  ]);
  if (!home && !sitemap) return { results: [], siblings: [] };

  const discovered = new Map<string, Discovered>();
  let order = 0;
  const add = (url: string, title: string, date?: string): void => {
    const normalized = options.normalizeUrl(url);
    if (!normalized) return;
    const fallback = titleFromUrl(normalized);
    const cleaned = title && !GENERIC_TITLE.test(title) ? title : fallback;
    const existing = discovered.get(normalized);
    if (existing) {
      if (GENERIC_TITLE.test(existing.title) && cleaned) existing.title = cleaned;
      if (date && !existing.date) existing.date = date;
      return;
    }
    discovered.set(normalized, {
      url: normalized,
      title: cleaned,
      ...(date ? { date } : {}),
      order: order++,
    });
  };

  if (home) {
    parseIndexPage(home, homepage, root, add);
    for (const index of findNewsIndexes(home, homepage, root)) {
      if (Date.now() >= options.deadline - MIN_REQUEST_MS) break;
      const html = await readText(index, options).catch(() => null);
      if (html) parseIndexPage(html, index, root, add);
    }
  }
  if (sitemap) parseSitemap(sitemap, root, add);

  const results = [...discovered.values()]
    .sort((left, right) => (right.date ?? '').localeCompare(left.date ?? '') || left.order - right.order)
    .slice(0, MAX_RESULTS)
    .map((entry) => {
      const title = entry.date && !entry.title.includes(entry.date)
        ? `${entry.title} (${entry.date})`
        : entry.title;
      return {
        title: title.slice(0, 280),
        url: entry.url,
        snippet: entry.date ? `Official page, last updated ${entry.date}.` : `Official news or changelog page from ${root}.`,
        domain: hostOf(entry.url),
        engine: 'official',
        rank: 0,
      };
    });
  return {
    results,
    siblings: home ? findSiblingHosts(home, homepage, root) : [],
  };
}

/**
 * Return official news/changelog candidates for an update-like query. Empty when
 * the results do not reveal an official domain, the site is unreachable, or the
 * search deadline has almost expired. Never throws into the caller.
 */
export async function discoverOfficialNews(options: OfficialDiscoveryOptions): Promise<SearchResult[]> {
  if (Date.now() >= options.deadline - MIN_REQUEST_MS) return [];
  const root = officialRoot(options.results);
  if (!root) return [];

  const discovered: SearchResult[] = [];
  const probedHosts = new Set<string>();
  const siblings = new Set<string>();

  const load = async (host: string): Promise<void> => {
    if (probedHosts.has(host)) return;
    probedHosts.add(host);
    const cacheKey = `matrius:official:v2:${host}`;
    const cached = options.cache.get(cacheKey);
    if (cached) {
      try {
        discovered.push(...(JSON.parse(cached) as SearchResult[]));
        return;
      } catch {
        // Ignore a corrupted entry and probe again.
      }
    }
    let results: SearchResult[] = [];
    try {
      const probed = await probe(host, root, options);
      results = probed.results;
      for (const sibling of probed.siblings) siblings.add(sibling);
    } catch {
      results = [];
    }
    options.cache.set(
      cacheKey,
      JSON.stringify(results),
      results.length ? CACHE_TTL_SECONDS : EMPTY_CACHE_TTL_SECONDS,
    );
    discovered.push(...results);
  };

  await Promise.all(officialHosts(options.results, root).map(load));

  // The homepage's own navigation can reveal a docs/API subdomain carrying the
  // newest changelog even when no search result pointed at it.
  if (Date.now() < options.deadline - MIN_REQUEST_MS) {
    const extra = [...siblings].filter((host) => !probedHosts.has(host)).slice(0, 2);
    await Promise.all(extra.map(load));
  }

  const dateOf = (result: SearchResult): string => /last updated ([^.]+)\./u.exec(result.snippet)?.[1] ?? '';
  const seen = new Set<string>();
  return discovered
    .sort((left, right) => dateOf(right).localeCompare(dateOf(left)))
    .filter((result) => {
      if (seen.has(result.url)) return false;
      seen.add(result.url);
      return true;
    })
    .slice(0, MAX_RESULTS);
}
