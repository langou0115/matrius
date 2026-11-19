export type InstanceInfo = { features: string[] };
export type InstanceState = {
  status: 'checking' | 'locked' | 'ready' | 'unavailable';
  info: InstanceInfo | null;
  authRequired: boolean;
  error: string | null;
};

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfterMs?: number, public payload?: unknown) { super(message); }
}

export function createInstanceClient(fetcher: typeof fetch = fetch) {
  let state: InstanceState = { status: 'checking', info: null, authRequired: false, error: null };
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
      response = await fetcher(path, { ...init, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ApiError(0, 'unavailable', '无法连接服务器，请稍后重试。');
    }
    if (response.status === 204 || response.status === 205) {
      return undefined as T;
    }
    let data: unknown;
    try { data = await response.json(); } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ApiError(response.status, 'invalid_response', '服务器响应无效。');
    }
    if (!response.ok) {
      const error = (data as { error?: { code?: string; message?: string } })?.error;
      const code = error?.code ?? 'request_failed';
      if (response.status === 401 && path !== '/api/auth/unlock') {
        generation++;
        update({ status: 'locked', info: null, authRequired: true, error: null });
      }
      const retry = response.headers.get('Retry-After');
      const seconds = retry === null ? NaN : Number(retry);
      const retryAfterMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : retry ? Math.max(0, Date.parse(retry) - Date.now()) : undefined;
      throw new ApiError(response.status, code, error?.message ?? '请求失败，请重试。',
        retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? retryAfterMs : undefined, data);
    }
    return data as T;
  }
  async function refresh() {
    const current = ++generation;
    let response: Response;
    try {
      response = await fetcher('/api/features', {
        headers: new Headers(),
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
      });
    } catch (error) {
      if (current === generation) {
        update({
          status: 'unavailable',
          info: null,
          authRequired: state.authRequired,
          error: error instanceof Error ? error.message : '无法连接实例。',
        });
      }
      return;
    }
    if (response.status === 401) {
      if (current === generation) update({ status: 'locked', info: null, authRequired: true, error: null });
      return;
    }
    let data: { features?: { id: string }[]; error?: { message?: string } } | null = null;
    try {
      data = await response.json() as { features?: { id: string }[]; error?: { message?: string } };
    } catch {
      if (current === generation) update({ status: 'unavailable', info: null, authRequired: state.authRequired, error: '服务器响应无效。' });
      return;
    }
    if (!response.ok) {
      if (current === generation) {
        update({
          status: 'unavailable',
          info: null,
          authRequired: state.authRequired,
          error: data?.error?.message ?? '无法连接实例。',
        });
      }
      return;
    }
    if (!Array.isArray(data?.features) || !data.features.every(f => typeof f.id === 'string')) {
      if (current === generation) update({ status: 'unavailable', info: null, authRequired: state.authRequired, error: '实例能力响应无效。' });
      return;
    }
    const authRequired = response.headers.get('X-Matrius-Auth') === 'required';
    if (current === generation) update({ status: 'ready', info: { features: data.features.map(f => f.id) }, authRequired, error: null });
  }
  async function unlock(secret: string) {
    await request('/api/auth/unlock', {
      method: 'POST',
      body: JSON.stringify({ secret }),
    });
    await refresh();
  }
  async function lock() {
    generation++;
    await request('/api/auth/lock', { method: 'POST', body: '{}' }).catch(() => undefined);
    update({ status: 'locked', info: null, authRequired: true, error: null });
  }
  return {
    request, refresh, unlock, lock,
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { disposed = true; generation++; listeners.clear(); },
  };
}
