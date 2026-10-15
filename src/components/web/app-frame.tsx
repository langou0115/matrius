import { useMemo, useSyncExternalStore, type CSSProperties, type PropsWithChildren } from 'react';

import { useAppearance } from '@/theme/appearance';
import { themePresets } from '@/theme/presets';
import { resolveTheme } from '@/theme/resolve-theme';
import { useIsPreview } from '@/features/workspace/preview-context';
import { DemoToolbar } from './demo-toolbar';

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

export function AppFrame({ children }: PropsWithChildren) {
  const { themeId } = useAppearance();
  const preview = useIsPreview();
  const resolvedMode = useResolvedColorMode();
  const style = useMemo(() => {
    const preset = themePresets.find((item) => item.id === themeId) ?? themePresets[2];
    return Object.fromEntries(Object.entries(resolveTheme(preset, resolvedMode)).map(([key, value]) => [`--${key}`, value])) as CSSProperties;
  }, [themeId, resolvedMode]);

  return <div className="matrius-app" data-color-mode={resolvedMode} style={style}>{children}{preview && <DemoToolbar />}</div>;
}
