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
