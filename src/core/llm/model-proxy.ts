export const MODEL_PROXY_PATH = '/api/model-proxy';
export const MODEL_PROXY_TARGET_HEADER = 'x-matrius-target-origin';

export type ModelProxyRoute = {
  /** Same-origin URL the client should use instead of the provider's base URL. */
  baseUrl: string;
  /** Header carrying the provider origin to the relay. */
  headers: Record<string, string>;
};

function isLocalHost(hostname: string) {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '127.0.0.1'
    || hostname === '[::1]'
    || hostname === '::1';
}

/**
 * Providers such as TokenHub answer normal requests but reject the browser's OPTIONS
 * preflight. When the user opts into the network compatibility mode, keep the provider's
 * path untouched and swap only the origin for the same-origin relay.
 *
 * Returns null outside the browser (native builds have no CORS) and for local endpoints,
 * which should never be routed through the server.
 */
export function resolveModelProxyRoute(baseUrl: string): ModelProxyRoute | null {
  if (typeof globalThis.location === 'undefined' || !globalThis.location.origin) return null;
  let target: URL;
  try {
    target = new URL(baseUrl);
  } catch {
    return null;
  }
  if (isLocalHost(target.hostname)) return null;
  const path = target.pathname.replace(/\/+$/u, '');
  return {
    baseUrl: `${globalThis.location.origin}${MODEL_PROXY_PATH}${path}`,
    headers: { [MODEL_PROXY_TARGET_HEADER]: target.origin },
  };
}
