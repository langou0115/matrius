export type InstanceInfo = { features: string[] };
export type InstanceState = {
  status: 'checking' | 'ready' | 'unavailable';
  info: InstanceInfo | null;
  error: string | null;
};

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfterMs?: number, public payload?: unknown) { super(message); }
}

export function createInstanceClient(fetcher: typeof fetch = fetch) {
  let state: InstanceState = { status: 'checking', info: null, error: null };
  let disposed = false;
  let generation = 0;
  const listeners = new Set<() => void>();
  const update = (next: InstanceState) => {
    if (disposed) return;
    state = next;
    listeners.forEach(listener => listener());
  };
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!path.startsWith('/api/') || path.includes('://')) throw new Error('无效的接口路径。');
    const headers = new Headers(init.headers);
    headers.delete('Authorization');
    if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    let response: Response;
    try {
      response = await fetcher(path, { ...init, headers, credentials: 'omit', cache: 'no-store', redirect: 'error' });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ApiError(0, 'unavailable', '无法连接服务器，请稍后重试。');
    }
    let data: unknown;
    try { data = await response.json(); } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ApiError(response.status, 'invalid_response', '服务器响应无效。');
    }
    if (!response.ok) {
      const error = (data as { error?: { code?: string; message?: string } })?.error;
      const retry = response.headers.get('Retry-After');
      const seconds = retry === null ? NaN : Number(retry);
      const retryAfterMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : retry ? Math.max(0, Date.parse(retry) - Date.now()) : undefined;
      throw new ApiError(response.status, error?.code ?? 'request_failed', error?.message ?? '请求失败，请重试。',
        retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? retryAfterMs : undefined, data);
    }
    return data as T;
  }
  async function refresh() {
    const current = ++generation;
    try {
      const data = await request<{ features: { id: string }[] }>('/api/features');
      if (!Array.isArray(data.features) || !data.features.every(f => typeof f.id === 'string')) throw new Error('实例能力响应无效。');
      if (current === generation) update({ status: 'ready', info: { features: data.features.map(f => f.id) }, error: null });
    } catch (error) {
      if (current === generation) update({ status: 'unavailable', info: null, error: error instanceof Error ? error.message : '无法连接实例。' });
    }
  }
  return {
    request, refresh,
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { disposed = true; generation++; listeners.clear(); },
  };
}
