import { ProxyAgent, request, type Dispatcher } from 'undici';

import type { Settings } from '../config';
import { AppError } from '../errors';

export type HttpGetOptions = {
  timeoutMs: number;
  maxBytes: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  maxRedirects?: number;
};

export type HttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
};

export type HttpClient = {
  get(url: string, options: HttpGetOptions): Promise<HttpResponse>;
};

function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return result;
}

/** Decode a response body with its declared charset, falling back to UTF-8. */
export function decodeBody(body: Buffer, contentType = ''): string {
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/iu.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8', { fatal: false }).decode(body);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(body);
  }
}

/**
 * Minimal GET client shared by search and page fetching.
 *
 * The upstream proxy is optional but, when configured, is never bypassed: a
 * broken proxy is a 502 rather than a silent direct connection.
 */
export function createHttpClient(settings: Settings): HttpClient {
  let dispatcher: Dispatcher | undefined;
  let proxyError: string | null = null;

  if (settings.WEBTOOL_PROXY_URL) {
    try {
      const proxy = new URL(settings.WEBTOOL_PROXY_URL);
      if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
        throw new Error('Only HTTP/HTTPS upstream proxies are supported by the Node backend.');
      }
      dispatcher = new ProxyAgent(proxy.toString());
    } catch (error) {
      proxyError = error instanceof Error ? error.message : 'Invalid WEBTOOL_PROXY_URL.';
    }
  }

  return {
    async get(url, options) {
      if (proxyError) {
        throw new AppError(502, 'fetch_proxy_error', `上游代理不可用：${proxyError}`);
      }
      const timeout = AbortSignal.timeout(Math.max(1, options.timeoutMs));
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout;
      let current = url;
      const maxRedirects = options.maxRedirects ?? 0;
      for (let hop = 0; ; hop += 1) {
        const response = await request(current, {
          method: 'GET',
          dispatcher,
          headers: options.headers,
          signal,
          headersTimeout: options.timeoutMs,
          bodyTimeout: options.timeoutMs,
        });
        const headers = normalizeHeaders(response.headers);
        if (
          [301, 302, 303, 307, 308].includes(response.statusCode)
          && headers.location
          && hop < maxRedirects
        ) {
          response.body.destroy();
          current = new URL(headers.location, current).toString();
          continue;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;
        try {
          for await (const chunk of response.body) {
            const buffer = Buffer.from(chunk);
            const remaining = options.maxBytes - total;
            if (buffer.length > remaining) {
              if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
              truncated = true;
              response.body.destroy();
              break;
            }
            chunks.push(buffer);
            total += buffer.length;
          }
        } catch (error) {
          // A destroy() from the truncation branch surfaces here on some versions.
          if (!truncated) throw error;
        }

        return {
          status: response.statusCode,
          headers,
          body: Buffer.concat(chunks),
          truncated,
        };
      }
    },
  };
}
