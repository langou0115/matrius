/** React Native cannot parse `oklch()`. The web keeps CSS strings; native converts the same
    preset values to sRGB once per theme change. */

type Oklch = { l: number; c: number; h: number; alpha: number };

function parseNumber(value: string): number {
  if (value.endsWith('%')) return Number(value.slice(0, -1)) / 100;
  return Number(value);
}

export function parseOklch(value: string): Oklch | null {
  const match = /^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+%?))?\s*\)$/i.exec(value.trim());
  if (!match) return null;
  const l = parseNumber(match[1]);
  const c = parseNumber(match[2]);
  const h = Number(match[3]);
  const alpha = match[4] === undefined ? 1 : parseNumber(match[4]);
  if (![l, c, h, alpha].every(Number.isFinite)) return null;
  return { l, c, h, alpha };
}

function toSrgb(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

const byte = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255);

export function oklchToHex(value: string, fallback = '#000000'): string {
  const color = parseOklch(value);
  if (!color) return fallback;
  const radians = color.h * Math.PI / 180;
  const a = color.c * Math.cos(radians);
  const b = color.c * Math.sin(radians);

  const l = (color.l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (color.l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (color.l - 0.0894841775 * a - 1.2914855480 * b) ** 3;

  const red = byte(toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s));
  const green = byte(toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s));
  const blue = byte(toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s));
  const hex = `#${[red, green, blue].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
  if (color.alpha >= 1) return hex;
  const alpha = byte(color.alpha).toString(16).padStart(2, '0');
  return `${hex}${alpha}`;
}

/** RN accepts 8-digit hex, but explicit rgba reads better in inline styles. */
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${Math.min(1, Math.max(0, alpha))})`;
}
