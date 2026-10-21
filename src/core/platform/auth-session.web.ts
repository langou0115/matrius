import type { SessionStore } from '@/core/api/auth-session';

const key = 'matrius.auth-session';
const adminKey = 'matrius.admin-session';

export function browserSessionStore(): SessionStore {
  return {
    read() { try { return sessionStorage.getItem(key); } catch { return null; } },
    write(token) {
      try { if (token) sessionStorage.setItem(key, token); else sessionStorage.removeItem(key); }
      catch { /* Memory still works when browser session storage is disabled. */ }
    },
  };
}

/** Admin login is independent from the account session used by the chat UI. */
export function browserAdminSessionStore(): SessionStore {
  return {
    read() { try { return sessionStorage.getItem(adminKey); } catch { return null; } },
    write(token) {
      try { if (token) sessionStorage.setItem(adminKey, token); else sessionStorage.removeItem(adminKey); }
      catch { /* Memory still works when browser session storage is disabled. */ }
    },
  };
}
