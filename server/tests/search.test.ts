import assert from 'node:assert/strict';
import test from 'node:test';

import { loadSettings } from '../config';
import { AppError } from '../errors';
import { MemoryCache } from '../services/cache';
import type { HttpClient, HttpResponse } from '../services/http';
import {
  canonicalResultKey,
  createSearchService,
  normalizeSearchUrl,
} from '../services/search';

function response(status: number, body: string, contentType = 'text/html; charset=utf-8'): HttpResponse {
  return {
    status,
    headers: { 'content-type': contentType },
    body: Buffer.from(body),
    truncated: false,
  };
}

function fakeHttp(handler: (url: string) => HttpResponse): HttpClient {
  return { get: async (url) => handler(url) };
}

const DDG_HTML = `
  <a class="result__a" href="https://example.com/a">Example A</a>
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb">Example B</a>
  <a class="result__snippet">Snippet for A</a>
  <a class="result__snippet">Snippet for B</a>
`;

const BING_RSS = `<?xml version="1.0"?><rss><channel><item>
  <title>Bing result</title>
  <link>https://bing.example/page</link>
  <description>Bing snippet</description>
</item></channel></rss>`;

function settings() {
  return loadSettings({ APP_ENV: 'test', LOG_LEVEL: 'silent' });
}

test('search normalizes URLs, unwraps DuckDuckGo links and caches results', async () => {
  let calls = 0;
  const service = createSearchService({
    cache: new MemoryCache(),
    settings: settings(),
    http: fakeHttp((url) => {
      calls += 1;
      assert.match(url, /duckduckgo/u);
      return response(200, DDG_HTML);
    }),
  });

  const first = await service.searchMany(['typescript'], 5);
  assert.equal(first.length, 2);
  assert.equal(first[0].url, 'https://example.com/a');
  assert.equal(first[1].url, 'https://example.org/b');
  assert.equal(first[0].snippet, 'Snippet for A');
  assert.equal(first[0].engine, 'duckduckgo');
  assert.equal(calls, 1);

  const second = await service.searchMany(['typescript'], 5);
  assert.deepEqual(second, first);
  assert.equal(calls, 1, 'the second search should be served from cache');
});

test('a failed DuckDuckGo search falls back to Bing RSS', async () => {
  const service = createSearchService({
    cache: new MemoryCache(),
    settings: settings(),
    http: fakeHttp((url) => {
      if (url.includes('duckduckgo')) return response(500, 'blocked');
      return response(200, BING_RSS, 'application/rss+xml');
    }),
  });

  const results = await service.searchMany(['fallback query'], 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].engine, 'bing');
  assert.equal(results[0].title, 'Bing result');
  assert.equal(results[0].url, 'https://bing.example/page');
});

test('all failed providers surface a stable upstream error', async () => {
  const service = createSearchService({
    cache: new MemoryCache(),
    settings: settings(),
    http: fakeHttp(() => response(502, 'bad gateway')),
  });

  await assert.rejects(
    () => service.searchMany(['nothing works'], 5),
    (error: unknown) => error instanceof AppError && error.statusCode === 502,
  );
});

test('search URL helpers remove tracking and normalize canonical keys', () => {
  assert.equal(
    normalizeSearchUrl('HTTPS://Example.com/a/?utm_source=x&q=1#frag'),
    'https://example.com/a/?q=1',
  );
  assert.equal(normalizeSearchUrl('javascript:alert(1)'), null);
  assert.equal(canonicalResultKey('https://www.example.com/a/?b=2&a=1'), 'example.com/a?a=1&b=2');
  assert.equal(canonicalResultKey('https://example.com/a?a=1&b=2'), 'example.com/a?a=1&b=2');
});

test('a CAPTCHA response immediately skips DuckDuckGo for subsequent queries', async () => {
  let ddgCalls = 0;
  const service = createSearchService({
    cache: new MemoryCache(), settings: settings(),
    http: fakeHttp((url) => {
      if (url.includes('duckduckgo')) { ddgCalls++; return response(202, 'captcha'); }
      return response(200, BING_RSS, 'application/rss+xml');
    }),
  });
  await service.searchMany(['first topic'], 5);
  await service.searchMany(['another topic'], 5);
  assert.equal(ddgCalls, 1);
});

test('an update query adds the official news page revealed by the results', async () => {
  const officialHome = `
    <html><head><title>DeepSeek</title></head><body>
      <a href="/news/">更多</a>
      <a href="/news/deepseek-v4-1-flash/">DeepSeek V4.1 Flash 发布</a>
      <a href="https://api-docs.deepseek.com/">API</a>
    </body></html>`;
  const officialSitemap = `<?xml version="1.0"?><urlset>
    <url><loc>https://www.deepseek.com/news/deepseek-v4-1-flash/</loc><lastmod>2026-10-17</lastmod></url>
  </urlset>`;
  const officialNews = `
    <html><body>
      <a href="/news/deepseek-v4-1-flash/">DeepSeek V4.1 Flash 发布</a>
    </body></html>`;
  const docsHome = `<html><body><a href="/news/news261113/">News</a></body></html>`;
  const docsSitemap = `<?xml version="1.0"?><urlset>
    <url><loc>https://api-docs.deepseek.com/news/news261113/</loc><lastmod>2026-11-13</lastmod></url>
  </urlset>`;
  const service = createSearchService({
    cache: new MemoryCache(),
    settings: settings(),
    http: fakeHttp((url) => {
      if (url.includes('duckduckgo')) {
        return response(200, `
          <a class="result__a" href="https://www.deepseek.com/en/platform/">DeepSeek | API Platform</a>
          <a class="result__a" href="https://download.deepseek.com/">DeepSeek App</a>
          <a class="result__a" href="https://baike.baidu.com/item/DeepSeek">DeepSeek 百科</a>
        `);
      }
      if (url === 'https://deepseek.com/') return response(200, officialHome);
      if (url === 'https://deepseek.com/sitemap.xml') return response(200, officialSitemap, 'application/xml');
      if (url === 'https://deepseek.com/news/') return response(200, officialNews);
      if (url === 'https://api-docs.deepseek.com/') return response(200, docsHome);
      if (url === 'https://api-docs.deepseek.com/sitemap.xml') return response(200, docsSitemap, 'application/xml');
      return response(404, 'not found');
    }),
  });

  const results = await service.searchMany(['DeepSeek 官网更新'], 10);
  const official = results.filter((result) => result.engine === 'official');
  assert.ok(official.length > 0, 'expected official news candidates');
  assert.equal(results[0].engine, 'official');
  assert.ok(
    official.some((result) => result.url.includes('news261113')),
    'expected the docs subdomain sitemap to be discovered from the homepage',
  );
  assert.ok(
    results.some((result) => result.url === 'https://www.deepseek.com/en/platform/'),
    'the original search results should be preserved',
  );
});
