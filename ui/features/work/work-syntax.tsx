import type { CSSProperties, ReactNode } from 'react';
import type { BundledLanguage } from 'shiki';

export const filenameLanguages: Record<string, BundledLanguage> = {
  dockerfile: 'dockerfile',
  makefile: 'make',
  '.env': 'dotenv',
};

export const extensionLanguages: Record<string, BundledLanguage> = {
  h: 'c',
  hpp: 'cpp',
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  ps1: 'powershell',
  sh: 'shellscript',
  svg: 'xml',
};

export const MAX_HIGHLIGHT_LINES = 10_000;

export type HighlightToken = {
  content: string;
  light?: string;
  dark?: string;
};

export type HighlightedFile = {
  lines: string[];
  tokens: HighlightToken[][];
  painted: ReactNode[];
};

export function paintTokens(tokens: HighlightToken[]): ReactNode {
  return tokens.map((token, index) => token.content && (
    <span
      key={index}
      className="work-preview-token"
      style={{
        '--preview-light': token.light,
        '--preview-dark': token.dark,
      } as CSSProperties}
    >
      {token.content}
    </span>
  ));
}

export async function highlightCodeLines(
  lines: string[],
  filename: string,
  maxLines = MAX_HIGHLIGHT_LINES,
): Promise<HighlightedFile | null> {
  if (lines.length === 0 || lines.length > maxLines) return null;
  const { bundledLanguages, codeToTokensWithThemes } = await import('shiki');
  const baseName = filename.split(/[\\/]/u).at(-1)?.toLowerCase() ?? '';
  const extension = baseName.includes('.') ? baseName.split('.').at(-1) ?? '' : '';
  const lang = (Object.hasOwn(filenameLanguages, baseName) ? filenameLanguages[baseName] : undefined)
    ?? (Object.hasOwn(extensionLanguages, extension) ? extensionLanguages[extension] : undefined)
    ?? (Object.hasOwn(bundledLanguages, extension) ? extension as BundledLanguage : undefined);
  if (!lang) return null;

  const tokens = await codeToTokensWithThemes(lines.join('\n'), {
    lang,
    tokenizeMaxLineLength: 10_000,
    themes: { light: 'one-light', dark: 'one-dark-pro' },
  });
  const lineTokens = lines.map((line, index) => {
    const segments = tokens[index];
    if (!segments || segments.map((token) => token.content).join('') !== line) return [];
    return segments.map((token) => ({
      content: token.content,
      light: token.variants.light.color,
      dark: token.variants.dark.color,
    }));
  });
  return {
    lines,
    tokens: lineTokens,
    painted: lineTokens.map((segments, index) => (segments.length ? paintTokens(segments) : lines[index])),
  };
}
