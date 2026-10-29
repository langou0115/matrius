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
  constructor(public status: number, public code: string, message: string, public retryAfterMs?: number) { super(message); }
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
  logoutPath?: string;
  /**
   * The server keeps the session in an HttpOnly cookie, so the browser cannot read
   * the token. Restore the account through /me on load instead of checking a stored token.
   */
  cookieAuth?: boolean;
};

/** No React, DOM or platform storage. Late requests cannot restore an older account. */
export function createAuthSession(store: SessionStore, fetcher: typeof fetch = fetch, options: AuthSessionOptions = {}) {
  const loginPath = options.loginPath ?? '/api/auth/login';
  const mePath = options.mePath ?? '/api/auth/me';
  const logoutPath = options.logoutPath ?? '/api/auth/logout';
  const cookieAuth = options.cookieAuth === true;
  let token = cookieAuth ? null : store.read();
  let generation = 0;
  let state: AuthState = {
    status: token || cookieAuth ? 'checking' : 'anonymous', user: null, error: null,
  };
  const listeners = new Set<() => void>();
  const update = (next: AuthState) => { state = next; listeners.forEach((listener) => listener()); };
  const saveToken = (next: string | null) => { token = next; store.write(next); };

  async function request<T>(path: string, init: RequestInit = {}, authToken = token): Promise<T> {
    if (!path.startsWith('/api/') || path.includes('://')) throw new Error('无效的接口路径。');
    const headers = new Headers(init.headers);
    if (authToken) headers.set('Authorization', `Bearer ${authToken}`);
    else headers.delete('Authorization');
    // FormData needs the browser-generated multipart boundary; forcing JSON breaks uploads.
    if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    let response: Response;
    try {
      response = await fetcher(path, {
        ...init, headers, credentials: cookieAuth ? 'include' : 'omit',
        cache: 'no-store', redirect: 'error',
      });
    }
    catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ApiError(0, 'unavailable', '无法连接服务器，请稍后重试。');
    }
    let data: unknown;
    try { data = await response.json(); }
    catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ApiError(response.status, 'invalid_response', '服务器响应无效，请稍后重试。');
    }
    if (!response.ok) {
      if (response.status === 401 && (
        authToken ? token === authToken : cookieAuth && state.status === 'authenticated'
      )) {
        generation += 1;
        saveToken(null);
        update({ status: 'anonymous', user: null, error: '登录已失效，请重新登录。' });
      }
      const error = (data as { error?: { code?: string; message?: string } })?.error;
      const retryAfter = response.headers.get('Retry-After');
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      const retryAfterMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000)
        : retryAfter ? Math.max(0, Date.parse(retryAfter) - Date.now()) : undefined;
      throw new ApiError(response.status, error?.code ?? 'request_failed',
        typeof error?.message === 'string' ? error.message : '请求未能完成，请重试。',
        retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? retryAfterMs : undefined);
    }
    return data as T;
  }

  async function refresh() {
    const version = ++generation;
    if (!token && !cookieAuth) { update({ status: 'anonymous', user: null, error: null }); return; }
    update({ status: 'checking', user: state.user, error: null });
    try {
      const user = parseAccount(await request(mePath));
      if (version === generation) update({ status: 'authenticated', user, error: null });
    } catch (error) {
      if (version !== generation) return;
      // A missing or revoked cookie is normal for first-time visitors.
      if (error instanceof ApiError && error.status === 401) {
        saveToken(null);
        update({ status: 'anonymous', user: null, error: null });
        return;
      }
      update({ status: 'unavailable', user: null, error: error instanceof Error ? error.message : '无法验证账号。' });
    }
  }

  async function login(username: string, password: string) {
    const version = ++generation;
    const previous = state.user;
    saveToken(null);
    // The dialog owns login progress and errors. Staying anonymous (or keeping the
    // previous account) keeps the current workspace mounted; a server answer is the
    // only thing that may switch it to the account workspace.
    update({ status: previous ? 'checking' : 'anonymous', user: previous, error: null });
    try {
      const result = await request<{ token: string; user: unknown }>(loginPath, {
        method: 'POST', body: JSON.stringify({ username, password }),
      }, null);
      const user = parseAccount(result.user);
      if (typeof result.token !== 'string' || !result.token) throw new Error('登录响应无效。');
      if (version !== generation) return;
      // The browser relies on the HttpOnly cookie set by this response.
      if (!cookieAuth) saveToken(result.token);
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
    // The request clears the HttpOnly cookie on the server, so it must run in cookie mode too.
    if (previous || cookieAuth) {
      await request(logoutPath, { method: 'POST' }, previous);
    }
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

/** Admin sessions use a separate HttpOnly cookie and require admin scope. */
export function createAdminSession(store: SessionStore, fetcher: typeof fetch = fetch) {
  return createAuthSession(store, fetcher, {
    cookieAuth: true,
    loginPath: '/api/admin/auth/login',
    mePath: '/api/admin/auth/me',
    logoutPath: '/api/admin/auth/logout',
  });
}
