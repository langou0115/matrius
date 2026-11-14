import { detect } from 'chardet';
import {
  brotliDecompressSync,
  constants,
  gunzipSync,
  inflateSync,
  zstdDecompressSync,
} from 'node:zlib';
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

const CHARSET_HEADER = /charset\s*=\s*["']?([^;"'\s]+)/iu;
const CHARSET_META = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/iu;
const CHARSET_META_CONTENT = /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w.:-]+)/iu;
const CHARSET_XML = /<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)/iu;
const UTF8_SAMPLE_BYTES = 65_536;

function supportedCharset(label: string | undefined): string | undefined {
  if (!label) return undefined;
  try {
    // Throws for an unknown label, so a bogus site header falls through to detection instead
    // of turning the whole page into replacement characters.
    return new TextDecoder(label).encoding;
  } catch {
    return undefined;
  }
}

function decodeWith(body: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(body);
  }
}

function bomCharset(body: Buffer): string | undefined {
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return 'utf-8';
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) return 'utf-16le';
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) return 'utf-16be';
  return undefined;
}

/** Header wins over the document declaration, matching browser behaviour for HTML. */
function declaredCharset(body: Buffer, contentType: string): string | undefined {
  const header = supportedCharset(CHARSET_HEADER.exec(contentType)?.[1]);
  if (header) return header;
  const head = body.subarray(0, 8_192).toString('latin1');
  if (!head.trimStart().startsWith('<')) return undefined;
  return supportedCharset(
    CHARSET_META.exec(head)?.[1] ?? CHARSET_META_CONTENT.exec(head)?.[1] ?? CHARSET_XML.exec(head)?.[1],
  );
}

/** A truncated multibyte character at the sample edge is fine; a GBK page is not. */
function isLikelyUtf8(body: Buffer): boolean {
  const sample = body.subarray(0, UTF8_SAMPLE_BYTES);
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(sample);
  if (!decoded.includes('\uFFFD')) return true;
  // Only a cut-off character at the very end is expected (maxBytes can split a code point).
  return /\uFFFD{1,3}$/u.test(decoded) && (decoded.match(/\uFFFD/gu) ?? []).length <= 3;
}

function replacementRatio(text: string): number {
  const replacements = (text.match(/\uFFFD/gu) ?? []).length;
  return replacements / Math.max(1, text.length);
}

/**
 * Decode a response body. A clean UTF-8 stream wins even when the site mislabels it as a
 * legacy encoding; otherwise the header/meta declaration is used unless its own decode is
 * visibly broken. Only then does statistical detection run (the Python server used
 * charset_normalizer for the same fallback).
 */
export function decodeBody(body: Buffer, contentType = ''): string {
  const bom = bomCharset(body);
  if (bom) return decodeWith(body, bom);
  if (isLikelyUtf8(body)) return decodeWith(body, 'utf-8');
  const declared = declaredCharset(body, contentType);
  if (declared) {
    const decoded = decodeWith(body, declared);
    if (replacementRatio(decoded) < 0.002) return decoded;
  }
  const detected = supportedCharset(detect(body.subarray(0, UTF8_SAMPLE_BYTES)) ?? undefined);
  return decodeWith(body, detected ?? 'utf-8');
}

/** Decode `Content-Encoding`; servers are asked for compression like Python's httpx did. */
function decompress(body: Buffer, contentEncoding: string, maxBytes: number): { body: Buffer; truncated: boolean } {
  const encodings = contentEncoding.split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value && value !== 'identity')
    .reverse();
  if (!encodings.length || !body.length) return { body, truncated: false };
  const limit = Math.max(maxBytes * 4, maxBytes + 1);
  let output = body;
  for (const encoding of encodings) {
    try {
      if (encoding === 'gzip' || encoding === 'x-gzip') {
        output = gunzipSync(output, { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: limit });
      } else if (encoding === 'deflate') {
        output = inflateSync(output, { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: limit });
      } else if (encoding === 'br') {
        output = brotliDecompressSync(output, { maxOutputLength: limit });
      } else if (encoding === 'zstd') {
        output = zstdDecompressSync(output, { maxOutputLength: limit });
      } else {
        // Unknown encoding: keep the bytes instead of failing the whole page.
        return { body, truncated: false };
      }
    } catch {
      // A truncated compressed stream may still fail. Keep the raw bytes and let extraction
      // report an unusable page; do not turn it into a proxy or network failure.
      return { body, truncated: true };
    }
  }
  if (output.length > maxBytes) return { body: output.subarray(0, maxBytes), truncated: true };
  return { body: output, truncated: false };
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
          headers: { 'accept-encoding': 'gzip, deflate, br, zstd', ...options.headers },
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

        const decoded = decompress(Buffer.concat(chunks), headers['content-encoding'] ?? '', options.maxBytes);
        return {
          status: response.statusCode,
          headers,
          body: decoded.body,
          truncated: truncated || decoded.truncated,
        };
      }
    },
  };
}
