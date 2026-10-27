import { createContext, useContext, useEffect, useState, useSyncExternalStore, type PropsWithChildren } from 'react';

import { createAuthSession } from '@/core/api/auth-session';
import { hasFeature } from '@/core/features/capabilities';
import { browserSessionStore } from '@/core/platform/auth-session.web';

const AuthContext = createContext<ReturnType<typeof createAuthSession> | null>(null);

export function AuthProvider({ children, preview }: PropsWithChildren<{ preview: boolean }>) {
  const [session] = useState(() => createAuthSession(
    preview ? { read: () => null, write: () => {} } : browserSessionStore(),
    fetch,
    { cookieAuth: !preview },
  ));
  useEffect(() => {
    if (preview) return;
    void session.refresh();
    const refresh = () => { if (document.visibilityState === 'visible') void session.refresh(); };
    document.addEventListener('visibilitychange', refresh);
    return () => { document.removeEventListener('visibilitychange', refresh); session.dispose(); };
  }, [session, preview]);
  return <AuthContext value={session}>{children}</AuthContext>;
}

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
