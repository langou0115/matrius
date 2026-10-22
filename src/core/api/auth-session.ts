export type Account = {
  id: string;
  username: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
  features: string[];
};
export type AuthState = {
  status: 'checking' | 'anonymous' | 'authenticated' | 'unavailable';
  user: Account | null;
  error: string | null;
};
export type SessionStore = { read(): string | null; write(token: string | null): void };
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

function parseAccount(value: unknown): Account {
  if (!value || typeof value !== 'object') throw new Error('账号响应无效。');
  const user = value as Record<string, unknown>;
  if (typeof user.id !== 'string' || typeof user.username !== 'string'
    || typeof user.isAdmin !== 'boolean' || typeof user.mustChangePassword !== 'boolean'
    || !Array.isArray(user.features) || !user.features.every((feature) => typeof feature === 'string')) {
    throw new Error('账号响应无效。');
  }
  return { id: user.id, username: user.username, isAdmin: user.isAdmin,
    mustChangePassword: user.mustChangePassword, features: [...new Set(user.features)] };
}

export type AuthSessionOptions = {
  /** Admin sessions log in through the admin-scoped endpoint. */
  loginPath?: string;
  mePath?: string;
};

/** No React, DOM or platform storage. Late requests cannot restore an older account. */
export function createAuthSession(store: SessionStore, fetcher: typeof fetch = fetch, options: AuthSessionOptions = {}) {
  const loginPath = options.loginPath ?? '/api/auth/login';
  const mePath = options.mePath ?? '/api/auth/me';
  let token = store.read();
  let generation = 0;
  let state: AuthState = { status: token ? 'checking' : 'anonymous', user: null, error: null };
  const listeners = new Set<() => void>();
  const update = (next: AuthState) => { state = next; listeners.forEach((listener) => listener()); };
  const saveToken = (next: string | null) => { token = next; store.write(next); };

  async function request<T>(path: string, init: RequestInit = {}, authToken = token): Promise<T> {
    if (!path.startsWith('/api/') || path.includes('://')) throw new Error('无效的接口路径。');
    const headers = new Headers(init.headers);
    if (authToken) headers.set('Authorization', `Bearer ${authToken}`);
    else headers.delete('Authorization');
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    let response: Response;
    try { response = await fetcher(path, { ...init, headers, credentials: 'omit', cache: 'no-store', redirect: 'error' }); }
    catch { throw new ApiError(0, 'unavailable', '无法连接服务器，请稍后重试。'); }
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new ApiError(response.status, 'invalid_response', '服务器响应无效，请稍后重试。'); }
    if (!response.ok) {
      if (response.status === 401 && authToken && token === authToken) {
        generation += 1;
        saveToken(null);
        update({ status: 'anonymous', user: null, error: '登录已失效，请重新登录。' });
      }
      const error = (data as { error?: { code?: string; message?: string } })?.error;
      throw new ApiError(response.status, error?.code ?? 'request_failed',
        typeof error?.message === 'string' ? error.message : '请求未能完成，请重试。');
    }
    return data as T;
  }

  async function refresh() {
    const version = ++generation;
    if (!token) { update({ status: 'anonymous', user: null, error: null }); return; }
    update({ status: 'checking', user: null, error: null });
    try {
      const user = parseAccount(await request(mePath));
      if (version === generation) update({ status: 'authenticated', user, error: null });
    } catch (error) {
      if (version !== generation) return;
      update({ status: 'unavailable', user: null, error: error instanceof Error ? error.message : '无法验证账号。' });
    }
  }

  async function login(username: string, password: string) {
    const version = ++generation;
    saveToken(null);
    update({ status: 'checking', user: null, error: null });
    try {
      const result = await request<{ token: string; user: unknown }>(loginPath, {
        method: 'POST', body: JSON.stringify({ username, password }),
      }, null);
      const user = parseAccount(result.user);
      if (typeof result.token !== 'string' || !result.token) throw new Error('登录响应无效。');
      if (version !== generation) return;
      saveToken(result.token);
      update({ status: 'authenticated', user, error: null });
      return user;
    } catch (error) {
      if (version === generation) update({ status: 'anonymous', user: null,
        error: error instanceof Error ? error.message : '登录失败，请重试。' });
      throw error;
    }
  }

  async function logout() {
    const previous = token;
    generation += 1;
    saveToken(null);
    update({ status: 'anonymous', user: null, error: null });
    if (previous) await request('/api/auth/logout', { method: 'POST' }, previous);
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh, login, logout, request,
    async changePassword(currentPassword: string, newPassword: string) {
      const version = generation;
      await request('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
      if (version === generation) await refresh();
    },
    dispose() { generation += 1; listeners.clear(); },
  };
}

/** Admin tokens are separate from the current-tab user session and require admin scope. */
export function createAdminSession(store: SessionStore, fetcher: typeof fetch = fetch) {
  return createAuthSession(store, fetcher, {
    loginPath: '/api/admin/auth/login',
    mePath: '/api/admin/auth/me',
  });
}
