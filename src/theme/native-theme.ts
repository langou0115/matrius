import { useMemo } from 'react';
import { useColorScheme } from 'react-native';

import { useAppearance } from './appearance';
import { oklchToHex } from './color';
import { themePresets } from './presets';
import { resolveTheme } from './resolve-theme';

export type NativeColors = {
  background: string; foreground: string;
  card: string; cardForeground: string;
  popover: string; popoverForeground: string;
  primary: string; primaryForeground: string;
  secondary: string; secondaryForeground: string;
  muted: string; mutedForeground: string;
  accent: string; accentForeground: string;
  destructive: string; destructiveForeground: string;
  border: string; input: string; ring: string;
  sidebar: string; sidebarForeground: string;
  sidebarPrimary: string; sidebarPrimaryForeground: string;
  sidebarAccent: string; sidebarAccentForeground: string;
  sidebarBorder: string; sidebarRing: string;
};

export type NativeTheme = {
  themeId: string;
  mode: 'light' | 'dark';
  colors: NativeColors;
  radius: number;
};

const pairs = {
  background: 'background', foreground: 'foreground',
  card: 'card', cardForeground: 'card-foreground',
  popover: 'popover', popoverForeground: 'popover-foreground',
  primary: 'primary', primaryForeground: 'primary-foreground',
  secondary: 'secondary', secondaryForeground: 'secondary-foreground',
  muted: 'muted', mutedForeground: 'muted-foreground',
  accent: 'accent', accentForeground: 'accent-foreground',
  destructive: 'destructive', destructiveForeground: 'destructive-foreground',
  border: 'border', input: 'input', ring: 'ring',
  sidebar: 'sidebar', sidebarForeground: 'sidebar-foreground',
  sidebarPrimary: 'sidebar-primary', sidebarPrimaryForeground: 'sidebar-primary-foreground',
  sidebarAccent: 'sidebar-accent', sidebarAccentForeground: 'sidebar-accent-foreground',
  sidebarBorder: 'sidebar-border', sidebarRing: 'sidebar-ring',
} as const;

function themeFrom(themeId: string, mode: 'light' | 'dark', scheme: string | null): NativeTheme {
  const preset = themePresets.find((item) => item.id === themeId) ?? themePresets[0];
  const resolved = resolveTheme(preset, mode);
  const colors = {} as NativeColors;
  for (const [target, source] of Object.entries(pairs) as [keyof NativeColors, string][]) {
    colors[target] = oklchToHex(resolved[source], scheme === 'dark' ? '#ffffff' : '#000000');
  }
  const radius = Number.parseFloat(resolved.radius ?? '0.5rem') * 16;
  return { themeId: preset.id, mode, colors, radius: Number.isFinite(radius) ? radius : 8 };
}

export function useNativeTheme(): NativeTheme {
  const appearance = useAppearance();
  const scheme = useColorScheme();
  const mode: 'light' | 'dark' = appearance.mode === 'system' ? (scheme === 'dark' ? 'dark' : 'light') : appearance.mode;
  return useMemo(() => themeFrom(appearance.themeId, mode, scheme), [appearance.themeId, mode, scheme]);
}
