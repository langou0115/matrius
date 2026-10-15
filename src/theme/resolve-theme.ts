import type { ColorMode } from './appearance';
import type { themePresets } from './presets';

type Preset = (typeof themePresets)[number];

// Preserve the original palette's hue while giving dark surfaces and text
// a readable minimum lightness. Original tweakcn presets stay unchanged.
function withMinimumLightness(value: string, minimum: number): string {
  const match = /^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/.exec(value);
  if (!match) return value;
  return `oklch(${Math.max(Number(match[1]), minimum)} ${match[2]} ${match[3]})`;
}

export function resolveTheme(preset: Preset, mode: Exclude<ColorMode, 'system'>): Record<string, string> {
  const colors: Record<string, string> = { ...preset[mode] };
  if (mode === 'light') return colors;

  const minimums: Record<string, number> = {
    background: 0.248,
    sidebar: 0.222,
    card: 0.29,
    popover: 0.31,
    muted: 0.29,
    accent: 0.31,
    border: 0.37,
    input: 0.31,
    'sidebar-border': 0.35,
    foreground: 0.93,
    'card-foreground': 0.93,
    'popover-foreground': 0.93,
    'sidebar-foreground': 0.9,
    'muted-foreground': 0.74,
  };
  for (const [key, minimum] of Object.entries(minimums)) {
    colors[key] = withMinimumLightness(colors[key], minimum);
  }
  return colors;
}
