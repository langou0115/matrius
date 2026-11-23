import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { brotliCompressSync, gzipSync } from 'node:zlib';

import { loadSettings } from '../config';
import { createHttpClient } from '../services/http';

test('the HTTP client advertises compression and decodes the response', async () => {
  const page = '<html><body>compressed page body</body></html>';
  const seen: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    const accept = request.headers['accept-encoding'];
    seen.push(typeof accept === 'string' ? accept : undefined);
    const useBrotli = typeof accept === 'string' && accept.includes('br');
    const body = useBrotli ? brotliCompressSync(page) : gzipSync(page);
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-encoding': useBrotli ? 'br' : 'gzip',
    });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const settings = loadSettings({ APP_ENV: 'test', LOG_LEVEL: 'silent', WEBTOOL_PROXY_URL: '' });
    const client = createHttpClient(settings);
    const response = await client.get(`http://127.0.0.1:${port}/`, {
      timeoutMs: 3000,
      maxBytes: 1_000_000,
      headers: {},
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.toString('utf8'), page);
    assert.match(seen[0] ?? '', /gzip/u);
    assert.match(seen[0] ?? '', /br/u);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('the HTTP client follows redirects with unended bodies and truncates safely without crashing', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/target' });
      // Leave the redirect body open so response.body.destroy() triggers undici's abort path.
      response.write('redirecting...');
      return;
    }
    if (request.url === '/target') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('ok');
      return;
    }
    if (request.url === '/large') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.write('0123456789');
      setTimeout(() => {
        if (!response.destroyed) response.end('abcdefghijklmnopqrstuvwxyz');
      }, 20);
      return;
    }
    response.writeHead(200, { 'content-length': '100' });
    response.write('partial');
    setTimeout(() => response.socket?.destroy(), 20);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const settings = loadSettings({ APP_ENV: 'test', LOG_LEVEL: 'silent', WEBTOOL_PROXY_URL: '' });
    const client = createHttpClient(settings);

    const redirected = await client.get(`http://127.0.0.1:${port}/redirect`, {
      timeoutMs: 3000,
      maxBytes: 1024,
      maxRedirects: 2,
    });
    assert.equal(redirected.status, 200);
    assert.equal(redirected.body.toString('utf8'), 'ok');

    const truncated = await client.get(`http://127.0.0.1:${port}/large`, {
      timeoutMs: 3000,
      maxBytes: 8,
    });
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.body.toString('utf8'), '01234567');

    await assert.rejects(() => client.get(`http://127.0.0.1:${port}/aborted`, {
      timeoutMs: 3000,
      maxBytes: 1024,
    }));

    // Allow any setImmediate stream cleanup callbacks to fire before closing the test.
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('the HTTP client uses proxy changes without being recreated', async (t) => {
  const server = createServer((request, response) => {
    response.end(request.url?.startsWith('http://') ? 'proxied' : 'direct');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const settings = loadSettings({ APP_ENV: 'test' });
  const client = createHttpClient(settings);
  t.after(async () => {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const request = () => client.get(url, { timeoutMs: 3000, maxBytes: 1024 });
  assert.equal((await request()).body.toString(), 'direct');
  settings.WEBTOOL_PROXY_URL = url;
  assert.equal((await request()).body.toString(), 'proxied');
  settings.WEBTOOL_PROXY_URL = '';
  assert.equal((await request()).body.toString(), 'direct');
});
