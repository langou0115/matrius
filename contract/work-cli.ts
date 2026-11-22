/**
 * Shared types and pure helpers for project CLI conversation discovery
 * (Claude Code, Codex, and Antigravity).
 * Keep this module free of Node, DOM, React, and SQLite imports.
 */

export type WorkCliProvider = 'claude' | 'codex' | 'antigravity';
export type WorkCliSessionStatus = 'running' | 'completed' | 'idle';

export const WORK_CLI_PROVIDERS: readonly WorkCliProvider[] = ['codex', 'antigravity', 'claude'];

export const WORK_CLI_PROVIDER_LABELS: Record<WorkCliProvider, string> = {
  codex: 'Codex',
  antigravity: 'Antigravity',
  claude: 'Claude Code',
};

export type WorkCliSession = {
  id: string;
  provider: WorkCliProvider;
  projectId: string;
  title: string;
  status: WorkCliSessionStatus;
  updatedAt: number;
};

export type WorkProjectCliSessionsResponse = {
  projectId: string;
  items: WorkCliSession[];
  total: number;
  hasMore: boolean;
};

export const CLI_SESSIONS_INITIAL_VISIBLE = 5;
export const CLI_SESSIONS_PAGE_STEP = 10;
export const CLI_SESSIONS_DEFAULT_FETCH_LIMIT = 90;

export function workCliGroupKey(projectId: string, provider: WorkCliProvider): string {
  return `${projectId}:${provider}`;
}

export function normalizeWorkCliProviderOrder(raw: readonly unknown[] | undefined): WorkCliProvider[] {
  const out: WorkCliProvider[] = [];
  const seen = new Set<WorkCliProvider>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item === 'codex' || item === 'antigravity' || item === 'claude') {
        if (!seen.has(item)) {
          seen.add(item);
          out.push(item);
        }
      }
    }
  }
  for (const fallback of WORK_CLI_PROVIDERS) {
    if (!seen.has(fallback)) {
      seen.add(fallback);
      out.push(fallback);
    }
  }
  return out;
}

export function reorderStringList(
  currentOrder: readonly string[],
  draggedId: string,
  targetId: string,
  position?: 'before' | 'after',
): string[] {
  const fromIndex = currentOrder.indexOf(draggedId);
  const toIndex = currentOrder.indexOf(targetId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return [...currentOrder];
  }
  const resolvedPosition = position ?? (fromIndex < toIndex ? 'after' : 'before');
  const withoutDragged = currentOrder.filter((id) => id !== draggedId);
  const nextTargetIndex = withoutDragged.indexOf(targetId);
  if (nextTargetIndex < 0) return [...currentOrder];
  const insertAt = resolvedPosition === 'after' ? nextTargetIndex + 1 : nextTargetIndex;
  withoutDragged.splice(insertAt, 0, draggedId);
  return withoutDragged;
}

const SAFE_CLI_SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/u;
const WINDOWS_DRIVE_PREFIX_RE = /^[A-Za-z]:(?:[\\/]|$)/u;

export function isValidCliSessionId(sessionId: string): boolean {
  return SAFE_CLI_SESSION_ID_RE.test(sessionId);
}

export function validateCliSessionId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!SAFE_CLI_SESSION_ID_RE.test(trimmed)) {
    throw new Error('CLI 会话标识格式不合法。');
  }
  return trimmed;
}

export function buildCliResumeCommand(provider: WorkCliProvider, sessionId: string): string {
  const cleanId = validateCliSessionId(sessionId);
  if (!cleanId) throw new Error('缺少有效的 CLI 会话标识。');
  if (provider === 'claude') return `claude --resume ${cleanId}`;
  if (provider === 'codex') return `codex resume ${cleanId}`;
  return `agy --conversation ${cleanId}`;
}

export function stripWindowsExtendedPathPrefix(rawPath: string): string {
  if (rawPath.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${rawPath.slice(8)}`;
  }
  if (rawPath.startsWith('\\\\?\\')) {
    return rawPath.slice(4);
  }
  return rawPath;
}

/**
 * Normalize a local or remote directory string so project path comparisons match
 * reliably across Windows drive casing, trailing slashes, and `\\?\` prefixes.
 */
export function normalizeProjectDirectory(
  rawDirectory: string,
  platformHint?: 'win32' | 'posix',
): string {
  let value = stripWindowsExtendedPathPrefix(rawDirectory.trim());
  if (!value) return '';

  const looksWindows = platformHint === 'win32'
    || WINDOWS_DRIVE_PREFIX_RE.test(value)
    || value.startsWith('\\\\');

  if (looksWindows) {
    value = value.replaceAll('/', '\\');
    if (/^[A-Za-z]:$/u.test(value)) {
      value = `${value}\\`;
    }
    while (value.length > 3 && value.endsWith('\\')) {
      value = value.slice(0, -1);
    }
    return value.toLowerCase();
  }

  value = value.replaceAll('\\', '/');
  while (value.length > 1 && value.endsWith('/')) {
    value = value.slice(0, -1);
  }
  return value;
}

/**
 * Convert a `file://` workspace URI (e.g. `file:///D:/Engineer/matrius` or
 * `file:///home/dev/repo`) into a filesystem path without Node dependencies.
 */
export function fileUriToPath(rawUri: string): string | null {
  const trimmed = rawUri.trim();
  if (!trimmed.toLowerCase().startsWith('file://')) return null;

  let rest = trimmed.slice(7);
  if (!rest.startsWith('/')) {
    // Handle `file://host/share` UNC paths.
    const slashIdx = rest.indexOf('/');
    if (slashIdx > 0) {
      const host = rest.slice(0, slashIdx);
      const tail = rest.slice(slashIdx);
      try {
        return `//${host}${decodeURIComponent(tail)}`;
      } catch {
        return `//${host}${tail}`;
      }
    }
    return null;
  }

  try {
    rest = decodeURIComponent(rest);
  } catch {
    // Keep raw path if percent-encoding is malformed.
  }

  // Strip the leading `/` from Windows URI paths like `/D:/Engineer/matrius`.
  if (/^\/[A-Za-z]:(?:\/|$)/u.test(rest)) {
    return rest.slice(1);
  }
  return rest;
}

/**
 * Compute Claude Code's `~/.claude/projects/<slug>` directory name from an
 * absolute working directory by replacing non-alphanumeric chars with `-`.
 */
export function claudeProjectSlug(directory: string): string {
  let cleaned = stripWindowsExtendedPathPrefix(directory.trim());
  if (!cleaned) return '';
  if (WINDOWS_DRIVE_PREFIX_RE.test(cleaned)) {
    cleaned = cleaned.replaceAll('/', '\\');
    while (cleaned.length > 3 && cleaned.endsWith('\\')) {
      cleaned = cleaned.slice(0, -1);
    }
  } else {
    cleaned = cleaned.replaceAll('\\', '/');
    while (cleaned.length > 1 && cleaned.endsWith('/')) {
      cleaned = cleaned.slice(0, -1);
    }
  }
  return cleaned.replace(/[^A-Za-z0-9]/gu, '-');
}

export function normalizeCliSessionTitle(raw: string | undefined | null, fallback: string): string {
  if (!raw) return fallback;
  // Strip Claude Code injected wrapper blocks (tag + inner content) and stray markup tags.
  const withoutBlocks = raw.replace(
    /<(?:system-reminder|ide_opened_file|ide_selection|local-command-caveat|local-command-stdout)>[\s\S]*?<\/(?:system-reminder|ide_opened_file|ide_selection|local-command-caveat|local-command-stdout)>/giu,
    ' ',
  );
  const withoutTags = withoutBlocks.replace(/<\/?[a-zA-Z0-9_-]+>/gu, ' ');
  const singleLine = withoutTags.replace(/\s+/gu, ' ').trim();
  if (!singleLine) return fallback;
  if (singleLine.length <= 120) return singleLine;
  return `${singleLine.slice(0, 119).trimEnd()}…`;
}

function stripControlChars(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    out += (code <= 0x1f || code === 0x7f) ? ' ' : text[index];
  }
  return out;
}

export const NEW_CLI_SESSION_TITLE = '新对话';

const FALLBACK_CLI_SESSION_TITLES = new Set<string>([
  NEW_CLI_SESSION_TITLE,
  'CLI 对话',
  'Claude Code',
  'Codex',
  'Antigravity',
  'Claude Code 对话',
  'Codex 对话',
  'Antigravity 对话',
]);

export function isFallbackCliSessionTitle(title: string | null | undefined): boolean {
  const trimmed = typeof title === 'string' ? title.replace(/\s+/gu, ' ').trim() : '';
  return !trimmed || FALLBACK_CLI_SESSION_TITLES.has(trimmed);
}

export function formatCliTerminalTitle(
  rawTitle: string,
  provider: WorkCliProvider,
): string {
  const fallback = provider === 'claude'
    ? 'Claude Code'
    : provider === 'codex'
      ? 'Codex'
      : 'Antigravity';
  const cleaned = stripControlChars(rawTitle).replace(/\s+/gu, ' ').trim();
  if (!cleaned) return fallback;
  if (cleaned.length <= 80) return cleaned;
  return `${cleaned.slice(0, 79).trimEnd()}…`;
}

export function parseIsoTimestampMs(raw: string | number | null | undefined): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw * 1000;
  }
  if (typeof raw !== 'string') return 0;
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  // Normalize timestamps like `2026-11-21 11:41:28.5827866+00:00` for consistent Date.parse.
  const normalized = trimmed
    .replace(' ', 'T')
    .replace(/\.(\d{3})\d+(?=[+-Z])/u, '.$1');
  const parsed = Date.parse(normalized);
  if (Number.isFinite(parsed)) return parsed;
  const fallback = Date.parse(trimmed);
  return Number.isFinite(fallback) ? fallback : 0;
}
