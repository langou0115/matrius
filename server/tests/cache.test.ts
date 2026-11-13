import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '../errors';
import { MemoryCache } from '../services/cache';

test('cache entries expire and eviction respects the entry cap', () => {
  const cache = new MemoryCache({ maxEntries: 2 });
  cache.set('a', '1', 60);
  cache.set('b', '2', 60);
  assert.equal(cache.get('a'), '1');
  cache.set('c', '3', 60);
  assert.equal(cache.get('a'), null);
  assert.equal(cache.get('c'), '3');

  cache.set('expired', 'x', 0);
  assert.equal(cache.get('expired'), null);
});

test('rate limits are enforced per name and identity', () => {
  const cache = new MemoryCache();
  cache.enforceRateLimit('read', 'instance', 2);
  cache.enforceRateLimit('read', 'instance', 2);
  assert.throws(
    () => cache.enforceRateLimit('read', 'instance', 2),
    (error: unknown) => error instanceof AppError && error.statusCode === 429,
  );
  assert.doesNotThrow(() => cache.enforceRateLimit('write', 'instance', 2));
});

test('concurrency caps reject immediately instead of queueing', async () => {
  const cache = new MemoryCache();
  let release: (() => void) | undefined;
  const first = cache.withConcurrency('tool', 'instance', 1, () => new Promise<void>((resolve) => {
    release = resolve;
  }));
  await assert.rejects(
    () => cache.withConcurrency('tool', 'instance', 1, async () => undefined),
    (error: unknown) => error instanceof AppError && error.statusCode === 429,
  );
  release?.();
  await first;
  await assert.doesNotReject(() => cache.withConcurrency('tool', 'instance', 1, async () => undefined));
});
