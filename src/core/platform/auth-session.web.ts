import type { SessionStore } from '@/core/api/auth-session';

/** The server keeps browser sessions in HttpOnly cookies, so there is no token for JS
    to read or persist. This store exists only to satisfy the shared session contract. */
const cookieOnly: SessionStore = { read: () => null, write: () => {} };

export function browserSessionStore(): SessionStore {
  return cookieOnly;
}

/** Admin login uses its own HttpOnly cookie; the account session stays untouched. */
export function browserAdminSessionStore(): SessionStore {
  return cookieOnly;
}
