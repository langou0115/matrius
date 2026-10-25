// Exercise the production relay against a local synthetic SSE upstream without external calls.
// Only this isolated VM replaces DNS and the outbound network destination. Production guards stay intact.
import http from 'node:http';
import dns from 'node:dns';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));
const upstream = http.createServer((req, res) => {
  req.resume();
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  let count = 0;
  const timer = setInterval(() => {
    res.write(`data: ${JSON.stringify({ text: 'synthetic token '.repeat(8) })}\n\n`);
    if (++count === 50) { clearInterval(timer); res.end('data: [DONE]\n\n'); }
  }, 100);
  res.on('close', () => clearInterval(timer));
});
await listen(upstream);
const sandbox = {
  module: { exports: {} }, URL,
  require(name) {
    if (name === 'node:dns') return { ...dns, promises: { ...dns.promises,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    } };
    if (name === 'node:http') return { ...http, request(options, callback) {
      return http.request({ ...options, hostname: '127.0.0.1', port: upstream.address().port,
        lookup: undefined }, callback);
    } };
    return require(name);
  },
};
vm.runInNewContext(readFileSync(new URL('./model-proxy.cjs', import.meta.url), 'utf8'), sandbox);
const relay = http.createServer((req, res) => {
  if (!sandbox.module.exports.handleModelProxy(req, res)) { res.statusCode = 404; res.end(); }
});
await listen(relay);
const agent = new http.Agent({ keepAlive: true, maxSockets: 250 });
const results = [];
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
try {
  for (const concurrency of [1, 25, 100, 200]) {
    const start = performance.now();
    const samples = await Promise.all(Array.from({ length: concurrency }, () => new Promise((resolve) => {
      const tick = performance.now();
      let first = null;
      let bytes = 0;
      let frames = 0;
      let pending = '';
      const req = http.request({ hostname: '127.0.0.1', port: relay.address().port,
        path: '/api/model-proxy/v1/chat/completions', method: 'POST', agent,
        headers: { 'x-matrius-target-origin': 'http://model-benchmark.invalid', 'content-type': 'application/json' },
      }, (res) => {
        res.on('data', (chunk) => {
          first ??= performance.now() - tick;
          bytes += chunk.length;
          pending += chunk.toString();
          const parts = pending.split('\n\n');
          pending = parts.pop();
          frames += parts.length;
        });
        res.on('end', () => resolve({ status: res.statusCode, first_ms: first,
          total_ms: performance.now() - tick, bytes, frames }));
        res.on('error', () => resolve({ status: 'stream_error', first_ms: first, total_ms: performance.now() - tick }));
      });
      req.setTimeout(15000, () => req.destroy(new Error('timeout')));
      req.on('error', () => resolve({ status: 'request_error', first_ms: first, total_ms: performance.now() - tick }));
      req.end('{"stream":true}');
    })));
    const successful = samples.filter((sample) => sample.status === 200 && sample.frames === 51);
    const result = { concurrency, seconds: Number(((performance.now() - start) / 1000).toFixed(2)),
      complete_streams: successful.length, errors: samples.length - successful.length,
      first_chunk_p95_ms: Number(percentile(successful.map((sample) => sample.first_ms), .95)?.toFixed(2)),
      total_p95_ms: Number(percentile(samples.map((sample) => sample.total_ms), .95).toFixed(2)),
      process_rss_mib: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  writeFileSync(new URL('../doc/benchmark-relay-results.json', import.meta.url), JSON.stringify({
    timestamp: new Date().toISOString(), node: process.version, platform: process.platform,
    upstream: 'synthetic local SSE, 50 frames at 100ms intervals plus DONE',
    scope: 'real relay code, VM network substitution; no TLS, external DNS, Caddy or provider quotas', results,
  }, null, 2));
} finally {
  agent.destroy();
  await Promise.all([close(relay), close(upstream)]);
}
