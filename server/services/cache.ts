import { rateLimited } from '../errors';

/**
 * In-process cache, sliding-window rate limits and in-flight caps.
 *
 * The API is a single Node process. State is intentionally lost on restart, so
 * these helpers exist only to protect upstream providers and bound memory; they
 * must never be used for durable business state.
 */

type CacheEntry = { expiresAt: number; value: string; bytes: number };
export type CacheOptions = { maxEntries?: number; maxBytes?: number };

const SWEEP_EVERY = 256;
const RATE_BUCKET_TTL_SECONDS = 3600;

export class MemoryCache {
  private readonly entries = new Map<string, CacheEntry>();
  private bytes = 0;
  private operations = 0;
  private readonly windows = new Map<string, number[]>();
  private readonly concurrency = new Map<string, number>();

  constructor(private readonly options: CacheOptions = {}) {}

  get(key: string): string | null {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry) {
      this.sweep(now);
      return null;
    }
    if (entry.expiresAt <= now) {
      this.remove(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: string, ttlSeconds: number): void {
    this.remove(key);
    const bytes = Buffer.byteLength(value, 'utf8');
    this.entries.set(key, {
      expiresAt: Date.now() + Math.max(0, ttlSeconds) * 1000,
      value,
      bytes,
    });
    this.bytes += bytes;
    this.evict();
    this.sweep(Date.now());
  }

  enforceRateLimit(name: string, identity: string, limit: number, windowSeconds = 60): void {
    const key = `${name}:${identity}`;
    const now = Date.now();
    const cutoff = now - windowSeconds * 1000;
    const bucket = this.windows.get(key) ?? [];
    while (bucket.length && bucket[0] <= cutoff) bucket.shift();
    if (bucket.length >= limit) throw rateLimited(windowSeconds);
    bucket.push(now);
    this.windows.set(key, bucket);
    this.sweep(now);
  }

  /**
   * Reject immediately when the in-flight cap is reached instead of queueing.
   * This keeps one runaway agent from occupying every shared upstream slot.
   */
  async withConcurrency<T>(name: string, identity: string, limit: number, fn: () => Promise<T>): Promise<T> {
    const key = `${name}:${identity}`;
    const current = this.concurrency.get(key) ?? 0;
    if (current >= limit) {
      throw rateLimited(5, '同时进行的请求过多，请稍后重试。');
    }
    this.concurrency.set(key, current + 1);
    try {
      return await fn();
    } finally {
      const remaining = (this.concurrency.get(key) ?? 1) - 1;
      if (remaining > 0) this.concurrency.set(key, remaining);
      else this.concurrency.delete(key);
    }
  }

  reset(): void {
    this.entries.clear();
    this.windows.clear();
    this.concurrency.clear();
    this.bytes = 0;
    this.operations = 0;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }

  private evict(): void {
    const maxEntries = this.options.maxEntries ?? 10_000;
    const maxBytes = this.options.maxBytes ?? 64 * 1024 * 1024;
    while (this.entries.size > maxEntries || this.bytes > maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  private sweep(now: number): void {
    this.operations += 1;
    if (this.operations % SWEEP_EVERY !== 0) return;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(key);
    }
    for (const [key, bucket] of this.windows) {
      while (bucket.length && bucket[0] <= now - RATE_BUCKET_TTL_SECONDS * 1000) bucket.shift();
      if (!bucket.length) this.windows.delete(key);
    }
  }
}
