import { useEffect } from 'react';
import { Slot, usePathname } from 'expo-router';
import { FontDisplay, useFonts } from 'expo-font';
import Head from 'expo-router/head';

import { AppFrame } from '@/components/web/app-frame';
import { AppErrorBoundary } from '@/components/web/app-error-boundary.web';
import { Workspace } from '@/components/web/workspace';
import { LocalWorkspace } from '@/components/web/local-workspace';
import { BackgroundNotifications } from '@/features/chat/components/background-notifications.web';
import { AuthProvider } from '@/features/auth/auth-state.web';
import { startDevelopmentHmrRecovery } from '@/core/platform/hmr-watchdog.web';
import '@/global.css';
import { version as katexVersion } from 'katex';

// Metro never reconnects its HMR socket, so a restarted dev server leaves the
// open tab stale until it is refreshed by hand.
if (__DEV__) startDevelopmentHmrRecovery();

export default function WebLayout() {
  const pathname = usePathname().replace(/\/$/, '');
  const preview = __DEV__ && (pathname === '/mock' || pathname.startsWith('/mock/'));
  const fullPage = pathname === '/admin' || pathname === '/settings' || pathname.startsWith('/settings/') || pathname === '/mock'
    || pathname === '/mock/chat/settings' || pathname.startsWith('/mock/chat/settings/');
  useEffect(() => {
    // A worker registered while a production build was served on this same localhost port
    // would keep answering Metro requests from its cache, hiding every code change.
    // Development never needs one, so drop it (and its caches) before doing anything else.
    if (__DEV__) {
      if ('serviceWorker' in navigator) {
        void navigator.serviceWorker.getRegistrations()
          .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
          .catch(() => undefined);
      }
      if (globalThis.caches) {
        void caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))).catch(() => undefined);
      }
      return;
    }
    // The dev server has no built service worker; registering there would cache
    // Metro output and break hot updates.
    if (!('serviceWorker' in navigator)) return;
    const register = () => { void navigator.serviceWorker.register('/sw.js').catch(() => undefined); };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }, []);
  useFonts({
    Inter: { uri: require('@/assets/fonts/Inter-Regular.ttf'), display: FontDisplay.SWAP },
    InterMedium: { uri: require('@/assets/fonts/Inter-Medium.ttf'), display: FontDisplay.SWAP },
    InterSemiBold: { uri: require('@/assets/fonts/Inter-SemiBold.ttf'), display: FontDisplay.SWAP },
    NotoSansSC: { uri: require('@/assets/fonts/NotoSansSC-Regular.ttf'), display: FontDisplay.SWAP },
    NotoSansSCSemiBold: { uri: require('@/assets/fonts/NotoSansSC-SemiBold.ttf'), display: FontDisplay.SWAP },
    JetBrainsMono: { uri: require('@/assets/fonts/JetBrainsMono-Regular.ttf'), display: FontDisplay.SWAP },
  });
  return <>
    <Head><title>Matrius · 自由对话</title><link rel="stylesheet" href={`/vendor/katex/${katexVersion}/katex.min.css`} /></Head>
    {/* A render error must show up as a message with a reload action, not as a blank page. */}
    <AppErrorBoundary resetKey={pathname}>
      <AuthProvider key={preview ? 'mock' : 'local'} preview={preview}><LocalWorkspace preview={preview}><AppFrame admin={pathname === '/admin'}>
        {fullPage ? <Slot /> : <Workspace><Slot /></Workspace>}
        {/* Inside the themed shell and above every route, including full-page settings. */}
        <BackgroundNotifications />
      </AppFrame></LocalWorkspace></AuthProvider>
    </AppErrorBoundary>
  </>;
}
