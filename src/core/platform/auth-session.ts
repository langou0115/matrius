import * as SecureStore from 'expo-secure-store';

import type { SessionStore } from '@/core/api/auth-session';

const TOKEN_KEY = 'matrius.auth.token';

/** Native sessions use a Bearer token. SecureStore is async while `createAuthSession`
    expects a synchronous read, so the cached value is hydrated once at startup and writes
    update both the cache and the keychain. */
let token: string | null = null;
let hydrated = false;

export function nativeSessionStore(): SessionStore & { load(): Promise<string | null> } {
  return {
    read: () => token,
    write(next: string | null) {
      token = next;
      // Writes are idempotent and ordered by call time; a failed keychain write must not
      // break the in-memory session, so errors are surfaced only as a rejected promise.
      void (next ? SecureStore.setItemAsync(TOKEN_KEY, next) : SecureStore.deleteItemAsync(TOKEN_KEY));
    },
    async load() {
      if (hydrated) return token;
      token = await SecureStore.getItemAsync(TOKEN_KEY);
      hydrated = true;
      return token;
    },
  };
}
