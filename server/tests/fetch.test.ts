import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { loadSettings } from '../config';
import { AppError } from '../errors';
import { MemoryCache } from '../services/cache';
import type { HttpClient, HttpResponse } from '../services/http';
import { decodeBody } from '../services/http';
import { extractContent, resolveMime } from '../services/fetch/extract';
import { createFetchService } from '../services/fetch/index';
import { validateFetchUrl } from '../services/fetch/url';

function response(status: number, body: string, contentType = 'text/html; charset=utf-8', headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { 'content-type': contentType, ...headers },
    body: Buffer.from(body),
    truncated: false,
  };
}

function fakeHttp(handler: (url: string) => HttpResponse | Promise<HttpResponse>): HttpClient {
  return { get: async (url) => handler(url) };
}

function settings(overrides: Record<string, string> = {}) {
  return loadSettings({ APP_ENV: 'test', LOG_LEVEL: 'silent', ...overrides });
}

const PAGE = `<!doctype html><html><head><title>Example page</title></head><body>
  <article>
    <h1>Heading</h1>
    <p>Hello <a href="https://example.com/more">world</a>.</p>
    <pre><code>const value = 1;</code></pre>
    <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
  </article>
</body></html>`;

test('fetch URL validation blocks local, private and metadata targets', async () => {
  for (const url of [
    'http://localhost/',
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://[::1]/',
    'http://metadata.google.internal/',
    'file:///etc/passwd',
    'https://user:pass@example.com/',
  ]) {
    await assert.rejects(
      () => validateFetchUrl(url),
      (error: unknown) => error instanceof AppError && error.statusCode === 422,
      url,
    );
  }
  assert.equal(await validateFetchUrl('https://8.8.8.8/'), 'https://8.8.8.8/');
});

test('MIME resolution rejects obvious binaries and sniffs HTML', () => {
  assert.equal(resolveMime('text/html; charset=utf-8', Buffer.from('<html></html>')), 'text/html');
  assert.throws(
    () => resolveMime('image/png', Buffer.from('x')),
    (error: unknown) => error instanceof AppError && error.code === 'unsupported_content',
  );
  assert.throws(
    () => resolveMime('application/octet-stream', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    (error: unknown) => error instanceof AppError && error.code === 'unsupported_content',
  );
  assert.equal(resolveMime('application/octet-stream', Buffer.from('<html><body>x</body></html>')), 'text/html');
});

test('HTML extraction keeps headings, links, code and tables as Markdown', () => {
  const extracted = extractContent(PAGE, 'https://example.com/', 'fast');
  assert.equal(extracted.title, 'Example page');
  assert.match(extracted.text, /# Heading/u);
  assert.match(extracted.text, /\[world\]\(https:\/\/example\.com\/more\)/u);
  assert.match(extracted.text, /```/u);
  assert.match(extracted.text, /\| A \| B \|/u);
});

/** A page whose article is long enough for Readability but wrapped in every kind of chrome. */
const ARTICLE = `<!doctype html><html><head><title>Long article - Example Site</title></head><body>
<header class="site-header"><nav><a href="/">Home</a> NavigationOnlyMarker</nav></header>
<div class="cookie-banner">CookieOnlyMarker</div>
<main><article>
<h1>Long article</h1>
<p>${'This paragraph explains the subject in enough detail for a reader. '.repeat(10)}</p>
<h2>Details</h2>
<p><strong>BoldMarker</strong> and <em>ItalicMarker</em> and <del>StrikeMarker</del>.</p>
<ul><li>ParentItem<ul><li>NestedItem</li></ul></li><li>SiblingItem</li></ul>
<pre><code class="language-ts">const value = 1;</code></pre>
<table><tr><th>HeaderA</th><th>HeaderB</th></tr><tr><td>CellA</td><td>CellB</td></tr></table>
</article></main>
<aside>SidebarOnlyMarker</aside>
<footer>FooterOnlyMarker</footer>
</body></html>`;

test('Readability keeps the article body and drops navigation, banners and footers', () => {
  const extracted = extractContent(ARTICLE, 'https://example.com/article', 'fast');
  assert.equal(extracted.extractor, 'readability');
  assert.equal(extracted.title, 'Long article - Example Site');
  assert.match(extracted.text, /subject in enough detail/u);
  for (const marker of ['NavigationOnlyMarker', 'CookieOnlyMarker', 'SidebarOnlyMarker', 'FooterOnlyMarker']) {
    assert.doesNotMatch(extracted.text, new RegExp(marker, 'u'));
  }
  // Formatting survives the HTML -> Markdown pass instead of flattening to plain text.
  assert.match(extracted.text, /\*\*BoldMarker\*\*/u);
  assert.match(extracted.text, /\*ItalicMarker\*/u);
  assert.match(extracted.text, /~~StrikeMarker~~/u);
  assert.match(extracted.text, /- ParentItem\n  - NestedItem\n- SiblingItem/u);
  assert.match(extracted.text, /```\nconst value = 1;\n```/u);
  assert.match(extracted.text, /\| HeaderA \| HeaderB \|/u);
  assert.match(extracted.text, /\| CellA \| CellB \|/u);
});

test('decodeBody detects GB18030 when a Chinese page is mislabelled as UTF-8', () => {
  const bytes = readFileSync(new URL('./fixtures/gbk-mislabeled.html', import.meta.url));
  const decoded = decodeBody(bytes, 'text/html');
  assert.match(decoded, /中文网页编码测试/u);
  assert.doesNotMatch(decoded, /\uFFFD/u);

  // A usable declaration still decodes a short page that no detector could classify alone.
  const gbk = Buffer.concat([
    Buffer.from('<html><head><title>'),
    Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
    Buffer.from('</title></head><body>'),
    Buffer.from([0xce, 0xc4, 0xd7, 0xd6]),
    Buffer.from('</body></html>'),
  ]);
  assert.match(decodeBody(gbk, 'text/html; charset=gbk'), /中文/u);
  assert.match(decodeBody(gbk, 'text/html; charset=gbk'), /文字/u);

  // Clean UTF-8 wins over a stale legacy declaration from the server.
  const utf8 = Buffer.from('<html><body>中文网页</body></html>');
  assert.match(decodeBody(utf8, 'text/html; charset=gbk'), /中文网页/u);
});

test('anti-bot and JavaScript shells are rejected with distinct codes', () => {
  assert.throws(
    () => extractContent('<html><head><title>Just a moment...</title></head><body>cf-chl-</body></html>', 'https://example.com/', 'fast'),
    (error: unknown) => error instanceof AppError && error.code === 'fetch_blocked',
  );
  assert.throws(
    () => extractContent('<html><head><title>App</title></head><body><noscript>Please enable JavaScript to continue</noscript></body></html>', 'https://example.com/', 'fast'),
    (error: unknown) => error instanceof AppError && error.code === 'fetch_requires_browser',
  );
});

test('the fetch service downloads, follows redirects and caches the result', async () => {
  let calls = 0;
  const service = createFetchService({
    cache: new MemoryCache(),
    settings: settings(),
    http: fakeHttp((url) => {
      calls += 1;
      if (url === 'https://8.8.8.8/') {
        return response(302, '', 'text/html', { location: '/next' });
      }
      assert.equal(url, 'https://8.8.8.8/next');
      return response(200, PAGE);
    }),
  });

  const page = await service.fetch('https://8.8.8.8/', 'fast');
  assert.equal(page.url, 'https://8.8.8.8/next');
  assert.equal(page.title, 'Example page');
  assert.match(page.text, /# Heading/u);
  assert.equal(calls, 2);

  const cached = await service.fetch('https://8.8.8.8/', 'fast');
  assert.deepEqual(cached, page);
  assert.equal(calls, 2);
});

test('a timed-out page retries once with the configured 3s attempt budget', async () => {
  let calls = 0;
  const service = createFetchService({
    cache: new MemoryCache(),
    settings: settings({ FETCH_TIMEOUT_SECONDS: '3' }),
    http: {
      get: async () => {
        calls += 1;
        if (calls === 1) {
          const error = new Error('timed out');
          error.name = 'TimeoutError';
          throw error;
        }
        return response(200, PAGE);
      },
    },
  });
  const page = await service.fetch('https://8.8.8.8/retry', 'fast');
  assert.equal(calls, 2);
  assert.equal(page.title, 'Example page');
});

test('fetch HTTP errors map to stable codes and transient 5xx retries', async () => {
  const notFound = createFetchService({
    cache: new MemoryCache(),
    settings: settings(),
    http: fakeHttp(() => response(404, 'gone')),
  });
  await assert.rejects(
    () => notFound.fetch('https://8.8.8.8/missing', 'fast'),
    (error: unknown) => error instanceof AppError && error.code === 'fetch_not_found',
  );

  const blocked = createFetchService({
    cache: new MemoryCache(),
    settings: settings(),
    http: fakeHttp(() => response(403, 'no')),
  });
  await assert.rejects(
    () => blocked.fetch('https://8.8.8.8/private', 'fast'),
    (error: unknown) => error instanceof AppError && error.code === 'fetch_blocked',
  );

  let attempts = 0;
  const upstream = createFetchService({
    cache: new MemoryCache(),
    settings: settings({ FETCH_TIMEOUT_SECONDS: '30' }),
    http: fakeHttp(() => {
      attempts += 1;
      return response(500, 'boom');
    }),
  });
  await assert.rejects(
    () => upstream.fetch('https://8.8.8.8/error', 'fast'),
    (error: unknown) => error instanceof AppError && error.code === 'fetch_upstream_error',
  );
  assert.equal(attempts, 2);

  const timedOut = createFetchService({
    cache: new MemoryCache(),
    settings: settings(),
    http: {
      get: async () => {
        const error = new Error('timed out');
        error.name = 'TimeoutError';
        throw error;
      },
    },
  });
  await assert.rejects(
    () => timedOut.fetch('https://8.8.8.8/slow', 'fast'),
    (error: unknown) => error instanceof AppError && error.code === 'fetch_timeout',
  );
});
