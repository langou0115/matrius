import { createHash } from 'node:crypto';

import type { Settings } from '../../config';
import { AppError } from '../../errors';
import type { MemoryCache } from '../cache';
import { decodeBody, type HttpClient } from '../http';
import { extractContent, resolveMime } from './extract';
import { validateFetchUrl } from './url';

export type FetchedPage = {
  title: string;
  url: string;
  text: string;
  truncated: boolean;
  chars: number;
};

export type FetchService = {
  fetch(url: string, mode: 'fast' | 'full', options?: { signal?: AbortSignal }): Promise<FetchedPage>;
};

const MAX_TITLE_CHARS = 280;
const MAX_REDIRECTS = 5;

class RetryableFetch extends Error {
  constructor(
    readonly error: AppError,
    readonly delayMs = 250,
  ) {
    super(error.message);
  }
}

function retryAfter(headers: Record<string, string>): number {
  const raw = headers['retry-after'];
  if (!raw) return 5;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 5;
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'TimeoutError'
    || error.name === 'AbortError'
    || ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR']
      .includes((error as { code?: string }).code ?? '');
}

function isProxy(error: unknown): boolean {
  return error instanceof AppError && error.code === 'fetch_proxy_error';
}

function fetchTimeoutError(): AppError {
  return new AppError(504, 'fetch_timeout', '网页读取超时，已停止等待该页面。');
}

function cancelledError(): AppError {
  return new AppError(499, 'request_cancelled', '请求已取消。');
}

/**
 * DNS validation (`validateFetchUrl`) has no timeout of its own. Race it against the page
 * deadline so a slow resolver cannot hold a batch open far beyond FETCH_TIMEOUT_SECONDS;
 * cancellation must win immediately too.
 */
function withDeadline<T>(task: Promise<T>, ms: number, signal: AbortSignal | undefined, timeout: () => AppError): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => finish(cancelledError());
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve(value as T);
      else reject(error);
    };
    if (signal?.aborted) {
      finish(cancelledError());
      return;
    }
    timer = setTimeout(() => finish(timeout()), Math.max(1, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
    task.then((value) => finish(undefined, value), (error) => finish(error));
  });
}

async function validateWithin(url: string, deadline: number, signal?: AbortSignal): Promise<string> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw fetchTimeoutError();
  return withDeadline(validateFetchUrl(url), remaining, signal, fetchTimeoutError);
}

export function createFetchService(options: {
  cache: MemoryCache;
  settings: Settings;
  http: HttpClient;
}): FetchService {
  const { cache, settings, http } = options;
  const flights = new Map<string, Promise<FetchedPage>>();

  async function download(url: string, timeoutMs: number, signal?: AbortSignal): Promise<{
    finalUrl: string;
    body: string;
    truncated: boolean;
    contentType: string;
  }> {
    // Resolve the initial host before starting the HTTP clock. DNS is local and usually
    // instant, but a slow resolver must not consume the proxy's whole 3s budget; redirects
    // are validated inside the remaining HTTP deadline below.
    let current = await validateWithin(url, Date.now() + Math.min(1_500, timeoutMs), signal);
    const deadline = Date.now() + timeoutMs;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AppError(504, 'fetch_timeout', '网页读取超时，已停止等待该页面。');
      const response = await http.get(current, {
        timeoutMs: Math.max(250, remaining),
        maxBytes: settings.FETCH_MAX_BYTES,
        maxRedirects: 0,
        headers: {
          'User-Agent': settings.SEARCH_USER_AGENT,
          Accept: 'text/markdown,text/x-markdown;q=0.95,text/plain;q=0.9,text/html;q=0.85,application/xhtml+xml;q=0.8,*/*;q=0.1',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        ...(signal ? { signal } : {}),
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.location;
        if (!location) throw new AppError(502, 'upstream_error', '网页重定向缺少目标地址。');
        if (hop === MAX_REDIRECTS) throw new AppError(502, 'upstream_error', '网页重定向次数过多。');
        current = await validateWithin(new URL(location, current).toString(), deadline, signal);
        continue;
      }

      const contentTypeHeader = response.headers['content-type'] ?? '';
      if (response.status === 401 || response.status === 403) {
        throw new AppError(422, 'fetch_blocked', '该网页拒绝自动访问或需要登录，请尝试其他公开来源。');
      }
      if (response.status === 404 || response.status === 410) {
        throw new AppError(422, 'fetch_not_found', `网页不存在或已删除（HTTP ${response.status}）。`);
      }
      if (response.status === 429) {
        const delay = retryAfter(response.headers);
        const error = new AppError(503, 'fetch_rate_limited', '目标网站暂时限流，请稍后读取或更换来源。', {
          headers: { 'Retry-After': String(Math.ceil(delay)) },
        });
        if (delay <= 5) throw new RetryableFetch(error, delay);
        throw error;
      }
      if (response.status >= 500) {
        throw new RetryableFetch(new AppError(502, 'fetch_upstream_error', `目标网站返回 HTTP ${response.status}。`));
      }
      if (response.status >= 400) {
        throw new AppError(502, 'fetch_upstream_error', `目标网站返回 HTTP ${response.status}。`);
      }

      // Resolve the type before decoding: binaries are rejected without spending time on a
      // charset guess, and a mislabelled HTML page still gets the right decoder.
      const contentType = resolveMime(contentTypeHeader, response.body);
      return {
        finalUrl: current,
        body: decodeBody(response.body, contentTypeHeader),
        truncated: response.truncated,
        contentType,
      };
    }
    throw new AppError(502, 'upstream_error', '网页重定向次数过多。');
  }

  async function fetchPage(
    url: string,
    mode: 'fast' | 'full',
    options: { signal?: AbortSignal } = {},
  ): Promise<FetchedPage> {
    // FETCH_TIMEOUT_SECONDS is the budget for one attempt, not the whole page: a page that
    // timed out during connect/TLS can usually succeed on the warmed second connection.
    const attemptTimeoutMs = Math.max(250, settings.FETCH_TIMEOUT_SECONDS * 1000);
    let attempts = 0;
    let downloaded: { finalUrl: string; body: string; truncated: boolean; contentType: string } | undefined;
    try {
      while (!downloaded) {
        attempts += 1;
        try {
          downloaded = await download(url, attemptTimeoutMs, options.signal);
        } catch (error) {
          if (options.signal?.aborted) throw new AppError(499, 'request_cancelled', '请求已取消。');
          if (error instanceof RetryableFetch) {
            if (attempts >= settings.FETCH_MAX_ATTEMPTS) throw error.error;
            await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(250, error.delayMs))));
            continue;
          }
          const timedOut = error instanceof AppError ? error.code === 'fetch_timeout' : isTimeout(error);
          if (timedOut && attempts < settings.FETCH_MAX_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            continue;
          }
          throw error;
        }
      }

      const extracted = extractContent(
        downloaded.body,
        downloaded.finalUrl,
        mode,
        downloaded.contentType,
      );
      if (!extracted.text.trim()) {
        throw new AppError(502, 'fetch_empty', '未能提取到网页正文。');
      }
      const limit = settings.FETCH_MAX_CHARS;
      const truncated = downloaded.truncated || extracted.text.length > limit;
      const text = extracted.text.slice(0, limit);
      return {
        title: (extracted.title.trim() || downloaded.finalUrl).slice(0, MAX_TITLE_CHARS),
        url: downloaded.finalUrl,
        text,
        truncated,
        chars: text.length,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (options.signal?.aborted) throw new AppError(499, 'request_cancelled', '请求已取消。');
      if (isProxy(error)) throw error;
      if (isTimeout(error)) throw new AppError(504, 'fetch_timeout', '目标网页连接或传输超时。');
      throw new AppError(502, 'fetch_network_error', '无法连接目标网页，请稍后读取或更换来源。');
    }
  }

  return {
    async fetch(url, mode, options = {}) {
      // v4: the extractor moved to Readability with charset detection, so old cached excerpts
      // must not keep serving the previous body dump.
      const key = `matrius:fetch:v4:${createHash('sha256').update(`${url}|${mode}`).digest('hex')}`;
      const cached = cache.get(key);
      if (cached) {
        try {
          return JSON.parse(cached) as FetchedPage;
        } catch {
          // Ignore a corrupted entry.
        }
      }
      const flight = flights.get(key);
      if (flight) return flight;
      const task = fetchPage(url, mode, options)
        .then((page) => {
          cache.set(key, JSON.stringify(page), settings.FETCH_CACHE_TTL_SECONDS);
          return page;
        })
        .finally(() => flights.delete(key));
      flights.set(key, task);
      return task;
    },
  };
}
