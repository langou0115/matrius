import { lazy, Suspense, useMemo, useSyncExternalStore, type CSSProperties, type PropsWithChildren } from 'react';

import { useAppearance } from '@/theme/appearance';
import { themePresets } from '@/theme/presets';
import { resolveTheme } from '@/theme/resolve-theme';
import { useIsPreview } from '@/features/workspace/preview-context';
import { useAdminColorMode } from '@/features/admin/admin-theme';

const DemoToolbar = import.meta.env.DEV
  ? lazy(() => import('./demo-toolbar').then((module) => ({ default: module.DemoToolbar })))
  : null;

const subscribe = (callback: () => void) => {
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
};
const getSnapshot = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
const getServerSnapshot = () => false;

export function useResolvedColorMode() {
  const { mode } = useAppearance();
  const systemDark = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
}

export function AppFrame({ children, admin = false }: PropsWithChildren<{ admin?: boolean }>) {
  const { themeId } = useAppearance();
  const preview = useIsPreview();
  const userMode = useResolvedColorMode();
  // The admin console has its own palette and light/dark switch; chat appearance
  // preferences never leak into it, and changing them here never leaks back.
  const adminMode = useAdminColorMode().mode;
  const resolvedMode = admin ? adminMode : userMode;
  const style = useMemo(() => {
    const preset = themePresets.find((item) => item.id === (admin ? 'modern-minimal' : themeId))
      ?? themePresets[2];
    return Object.fromEntries(Object.entries(resolveTheme(preset, resolvedMode)).map(([key, value]) => [`--${key}`, value])) as CSSProperties;
  }, [admin, themeId, resolvedMode]);

  return <div className="matrius-app" data-color-mode={resolvedMode} style={style}>{children}{preview && DemoToolbar && <Suspense fallback={null}><DemoToolbar /></Suspense>}</div>;
}
