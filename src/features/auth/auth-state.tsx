import { createContext, useContext, useEffect, useState, useSyncExternalStore, type PropsWithChildren } from 'react';
import { ActivityIndicator, AppState, StyleSheet, View } from 'react-native';

import { createAuthSession } from '@/core/api/auth-session';
import { hasFeature } from '@/core/features/capabilities';
import { apiBaseUrl } from '@/core/platform/api-base';
import { nativeSessionStore } from '@/core/platform/auth-session';

type Session = ReturnType<typeof createAuthSession>;
const AuthContext = createContext<Session | null>(null);

/** Native auth: Bearer token in SecureStore, refreshed whenever the app returns to foreground. */
export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    let active = true;
    const store = nativeSessionStore();
    const base = apiBaseUrl();
    store.load().then(() => {
      if (!active) return;
      const fetcher = ((path: string, init?: RequestInit) => fetch(`${base}${path}`, init)) as typeof fetch;
      const next = createAuthSession(store, fetcher, { cookieAuth: false });
      setSession(next);
      void next.refresh();
    }).catch(() => {
      if (!active) return;
      // A keychain read failure must not lock the user out of the local workspace.
      const fetcher = ((path: string, init?: RequestInit) => fetch(`${base}${path}`, init)) as typeof fetch;
      setSession(createAuthSession(store, fetcher, { cookieAuth: false }));
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!session) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void session.refresh();
    });
    return () => { subscription.remove(); session.dispose(); };
  }, [session]);

  if (!session) {
    return <View style={styles.loading}><ActivityIndicator /></View>;
  }
  return <AuthContext value={session}>{children}</AuthContext>;
}

const styles = StyleSheet.create({ loading: { flex: 1, alignItems: 'center', justifyContent: 'center' } });

export function useAuth() {
  const session = useContext(AuthContext);
  if (!session) throw new Error('AuthProvider is required.');
  return { ...useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot), ...session };
}

export function useFeature(feature: string) {
  const auth = useAuth();
  return hasFeature(auth.status === 'authenticated' ? auth.user : null, feature);
}

export function FeatureGate({ name, children }: PropsWithChildren<{ name: string }>) {
  return useFeature(name) ? children : null;
}
