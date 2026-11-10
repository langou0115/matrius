import { ApiError } from '@/core/api/instance-client';

/**
 * Same contract as the browser's instance client, but rooted at the API origin instead of the
 * page origin. Tools only ever pass `/api/...` paths, so the prefix is the only difference.
 */
export function createUpstreamRequest(baseUrl: string, fetcher: typeof fetch = fetch) {
  return async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!path.startsWith('/api/') || path.includes('://')) throw new Error('无效的接口路径。');
    const headers = new Headers(init.headers);
    headers.delete('Authorization');
    if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    let response: Response;
    try {
      response = await fetcher(`${baseUrl}${path}`, {
        ...init, headers, cache: 'no-store', redirect: 'error',
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ApiError(0, 'unavailable', '无法连接服务器，请稍后重试。');
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ApiError(response.status, 'invalid_response', '服务器响应无效。');
    }
    if (!response.ok) {
      const detail = (data as { error?: { code?: string; message?: string } })?.error;
      throw new ApiError(response.status, detail?.code ?? 'request_failed', detail?.message ?? '请求失败，请重试。', undefined, data);
    }
    return data as T;
  };
}
