import { Suspense, useEffect } from 'react';
import { Outlet } from 'react-router-dom';

import { AppErrorBoundary } from '@/components/web/app-error-boundary';
import { AppFrame } from '@/components/web/app-frame';
import { InstanceWorkspace } from '@/components/web/instance-workspace';
import { Workspace } from '@/components/web/workspace';
import { InstanceProvider } from '@/features/instance/instance-state';
import { BackgroundNotifications } from '@/features/chat/components/background-notifications';
import { rememberWorkspacePath } from '@/features/settings/settings-return';
import { usePathname } from '@/router';

import '@/global.css';

/** The single page shell: theme, instance, workspace and the notification layer around every route. */
export function AppShell() {
  const pathname = usePathname().replace(/\/$/, '');
  const preview = import.meta.env.DEV && (pathname === '/mock' || pathname.startsWith('/mock/'));
  const fullPage = pathname === '/settings' || pathname.startsWith('/settings/')
    || pathname === '/mock' || pathname === '/mock/chat/settings'
    || pathname.startsWith('/mock/chat/settings/');

  useEffect(() => {
    const viewport = window.visualViewport;
    const updateHeight = () => {
      if (viewport && viewport.scale === 1) {
        document.documentElement.style.setProperty('--app-height', `${viewport.height}px`);
      }
    };
    updateHeight();
    viewport?.addEventListener('resize', updateHeight);
    return () => {
      viewport?.removeEventListener('resize', updateHeight);
      document.documentElement.style.removeProperty('--app-height');
    };
  }, []);

  useEffect(() => {
    // A worker registered while a production build was served on this same localhost port
    // would keep answering the dev server's requests from its cache, hiding every code
    // change. Development never needs one, so drop it (and its caches) before anything else.
    if (import.meta.env.DEV) {
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
    if (!('serviceWorker' in navigator)) return;
    const register = () => { void navigator.serviceWorker.register('/sw.js').catch(() => undefined); };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }, []);

  useEffect(() => {
    // Settings is a full-page route; keep the workspace page it replaces so its back link
    // returns to that conversation or to the library instead of opening a new chat.
    rememberWorkspacePath(pathname);
  }, [pathname]);

  return (
    // A render error must show up as a message with a reload action, not as a blank page.
    <AppErrorBoundary resetKey={pathname}>
      <InstanceProvider key={preview ? 'mock' : 'instance'} preview={preview}>
        <InstanceWorkspace preview={preview}>
          <AppFrame>
            <Suspense fallback={null}>
              {fullPage ? <Outlet /> : <Workspace><Outlet /></Workspace>}
            </Suspense>
            {/* Inside the themed shell and above every route, including full-page settings. */}
            <BackgroundNotifications />
          </AppFrame>
        </InstanceWorkspace>
      </InstanceProvider>
    </AppErrorBoundary>
  );
}
