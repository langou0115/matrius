import { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';

import type { ThemeId } from './presets';

export type ColorMode = 'light' | 'dark' | 'system';
export type AppearancePreferences = { themeId: ThemeId; mode: ColorMode };

function useAppearanceState(initialPreferences?: AppearancePreferences) {
  const [themeId, setThemeId] = useState<ThemeId>(initialPreferences?.themeId ?? 'twitter');
  const [mode, setMode] = useState<ColorMode>(initialPreferences?.mode ?? 'system');
  return useMemo(() => ({ themeId, setThemeId, mode, setMode }), [themeId, mode]);
}

const AppearanceContext = createContext<ReturnType<typeof useAppearanceState> | null>(null);

export function AppearanceProvider({ children, initialPreferences }: PropsWithChildren<{ initialPreferences?: AppearancePreferences }>) {
  return <AppearanceContext value={useAppearanceState(initialPreferences)}>{children}</AppearanceContext>;
}

export function useAppearance() {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error('AppearanceProvider is required');
  return value;
}
