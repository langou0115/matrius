/**
 * Shared types and validation for desktop work projects and remote/local directory browsing.
 * Keep this module free of Node, DOM, React and SQLite imports.
 */

import {
  WORK_CLI_PROVIDERS,
  WORK_CLI_PROVIDER_LABELS,
  type WorkCliProvider,
} from './work-cli';
import { defaultTerminalCommand, type WorkTerminalPreset } from './work-terminals';

export const WORK_EDITOR_DIFF_LAYOUTS = ['inline', 'split'] as const;
export type WorkEditorDiffLayout = (typeof WORK_EDITOR_DIFF_LAYOUTS)[number];

export function normalizeWorkEditorDiffLayout(value: unknown): WorkEditorDiffLayout {
  return value === 'split' ? 'split' : 'inline';
}

export const DEFAULT_WORK_EDITOR_FONT_SIZE = 14;
export const MIN_WORK_EDITOR_FONT_SIZE = 10;
export const MAX_WORK_EDITOR_FONT_SIZE = 32;

export function normalizeWorkEditorFontSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)
    || value < MIN_WORK_EDITOR_FONT_SIZE || value > MAX_WORK_EDITOR_FONT_SIZE) {
    return DEFAULT_WORK_EDITOR_FONT_SIZE;
  }
  return value;
}

export const LOCAL_WORK_HOST_ID = 'local';
export const WINDOWS_DRIVES_ROOT = '此电脑';

export type WorkEntryKind = 'directory' | 'file';

export type WorkHostEntry = {
  kind: WorkEntryKind;
  name: string;
  path: string;
  accessible: boolean;
};

export type WorkFileTab = WorkHostEntry & {
  localOutsideProject?: boolean;
};

export function workFileTabPath(file: WorkFileTab): string {
  return file.localOutsideProject ? `local:\0${file.path}` : file.path;
}

export type WorkFileSearchResponse = {
  items: WorkFileTab[];
  source: 'everything' | 'local';
  indexing: boolean;
  limited: boolean;
};

export type HostFilePreview = { text: string; revision: string };

export type HostDirectoryListing = {
  hostId: string;
  path: string;
  parentPath: string | null;
  truncated: boolean;
  entries: WorkHostEntry[];
  selectable?: boolean;
};

export type WorkProjectCliProxies = Partial<Record<WorkCliProvider, string>>;

export type NormalizedWorkProjectCliProxies = Record<WorkCliProvider, string>;

export type WorkProjectCliArgs = Partial<Record<WorkCliProvider, string>>;

export type NormalizedWorkProjectCliArgs = Record<WorkCliProvider, string>;

export const WORK_PROJECT_AI_CLI_ITEMS: ReadonlyArray<{
  id: WorkCliProvider;
  label: string;
}> = WORK_CLI_PROVIDERS.map((id) => ({
  id,
  label: WORK_CLI_PROVIDER_LABELS[id],
}));

export const WORK_PROJECT_PROXY_CLI_ITEMS = WORK_PROJECT_AI_CLI_ITEMS;

export function normalizeWorkProjectOrder(raw: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > 120 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function sortWorkProjectsByOrder(
  projects: readonly WorkProject[],
  projectOrder: readonly string[],
): WorkProject[] {
  if (projects.length <= 1 || projectOrder.length === 0) return [...projects];
  const orderIndex = new Map(projectOrder.map((id, index) => [id, index]));
  const unpinned: WorkProject[] = [];
  const pinned: Array<{ project: WorkProject; order: number }> = [];
  for (const project of projects) {
    const idx = orderIndex.get(project.id);
    if (idx === undefined) unpinned.push(project);
    else pinned.push({ project, order: idx });
  }
  pinned.sort((left, right) => left.order - right.order);
  return [...unpinned, ...pinned.map((entry) => entry.project)];
}

export type WorkProject = {
  id: string;
  name: string;
  hostId: string;
  directory: string;
  cliProxies?: WorkProjectCliProxies;
  cliArgs?: WorkProjectCliArgs;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

export type WorkProjectInput = {
  hostId: string;
  directory: string;
  name?: string;
  cliProxies?: WorkProjectCliProxies;
  cliArgs?: WorkProjectCliArgs;
  /** @deprecated Legacy single proxy field retained for backward compatibility; applies only to CLIs, never shell. */
  proxyUrl?: string;
};

export type WorkProjectUpdateInput = {
  cliProxies?: WorkProjectCliProxies;
  cliArgs?: WorkProjectCliArgs;
  /** @deprecated Legacy single proxy field retained for backward compatibility; applies only to CLIs, never shell. */
  proxyUrl?: string;
};

export type NormalizedWorkProjectInput = {
  hostId: string;
  directory: string;
  name: string;
  cliProxies: NormalizedWorkProjectCliProxies;
  cliArgs: NormalizedWorkProjectCliArgs;
};

function hasControlChars(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Derive a concise project name from a POSIX or Windows directory/file path. */
export function deriveProjectName(directory: string): string {
  const trimmed = directory.trim();
  if (!trimmed) return '未命名项目';
  if (trimmed === '/' || trimmed === '\\') return trimmed;
  const withoutTrailing = trimmed.replace(/[\\/]+$/u, '');
  if (!withoutTrailing) return '/';
  const parts = withoutTrailing.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? withoutTrailing;
}

export function validateBrowsePath(rawPath: string | undefined): string {
  const trimmed = (rawPath ?? '').trim();
  if (!trimmed) return '';
  if (hasControlChars(trimmed)) throw new Error('路径不能包含控制字符。');
  if (trimmed.length > 1000) throw new Error('路径长度不能超过 1000 个字符。');
  return trimmed;
}

const SUPPORTED_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);

export function normalizeProjectProxyUrl(raw: string | undefined, label?: string): string {
  const prefix = label ? `${label} ` : '';
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  if (hasControlChars(trimmed)) throw new Error(`${prefix}网络代理地址不能包含控制字符。`);
  if (/\s/u.test(trimmed)) throw new Error(`${prefix}网络代理地址不能包含空白字符。`);
  if (trimmed.length > 500) throw new Error(`${prefix}网络代理地址不能超过 500 个字符。`);

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`${prefix}请输入合法的网络代理地址，例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080。`);
  }
  if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) {
    throw new Error(`${prefix}网络代理仅支持 http://、https:// 或 socks5:// 协议。`);
  }
  return withScheme;
}

export function normalizeWorkProjectCliProxies(
  raw: WorkProjectCliProxies | undefined,
  legacyProxyUrl?: string,
): NormalizedWorkProjectCliProxies {
  const legacy = raw === undefined && legacyProxyUrl !== undefined
    ? normalizeProjectProxyUrl(legacyProxyUrl)
    : '';
  const values: NormalizedWorkProjectCliProxies = {
    codex: legacy,
    antigravity: legacy,
    claude: legacy,
  };
  if (!raw) return values;
  for (const item of WORK_PROJECT_PROXY_CLI_ITEMS) {
    values[item.id] = normalizeProjectProxyUrl(raw[item.id], item.label);
  }
  return values;
}

export function serializeWorkProjectCliProxies(
  values: NormalizedWorkProjectCliProxies,
): WorkProjectCliProxies | undefined {
  const next: WorkProjectCliProxies = {};
  for (const item of WORK_PROJECT_PROXY_CLI_ITEMS) {
    const value = values[item.id]?.trim();
    if (value) next[item.id] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

export function resolveWorkTerminalProxyUrl(
  project: Pick<WorkProject, 'cliProxies'>,
  preset: WorkTerminalPreset,
): string | undefined {
  // Regular terminals never inherit CLI proxy settings by default.
  if (preset === 'shell') return undefined;
  const value = project.cliProxies?.[preset]?.trim();
  return value || undefined;
}

export function normalizeProjectCliArgs(raw: string | undefined, label?: string): string {
  const prefix = label ? `${label} ` : '';
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  if (hasControlChars(trimmed)) throw new Error(`${prefix}启动参数不能包含控制字符。`);
  if (trimmed.length > 500) throw new Error(`${prefix}启动参数不能超过 500 个字符。`);
  return trimmed;
}

export function normalizeWorkProjectCliArgs(
  raw: WorkProjectCliArgs | undefined,
): NormalizedWorkProjectCliArgs {
  const values: NormalizedWorkProjectCliArgs = {
    codex: '',
    antigravity: '',
    claude: '',
  };
  if (!raw) return values;
  for (const item of WORK_PROJECT_AI_CLI_ITEMS) {
    values[item.id] = normalizeProjectCliArgs(raw[item.id], item.label);
  }
  return values;
}

export function serializeWorkProjectCliArgs(
  values: NormalizedWorkProjectCliArgs,
): WorkProjectCliArgs | undefined {
  const next: WorkProjectCliArgs = {};
  for (const item of WORK_PROJECT_AI_CLI_ITEMS) {
    const value = values[item.id]?.trim();
    if (value) next[item.id] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

export function resolveWorkTerminalCommand(
  project: Pick<WorkProject, 'cliArgs'>,
  preset: WorkTerminalPreset,
  baseCommand: string,
): string {
  const trimmedBase = baseCommand.trim();
  // Regular shell terminals never inherit CLI launch arguments.
  if (preset === 'shell') return trimmedBase;
  const extraArgs = project.cliArgs?.[preset]?.trim() ?? '';
  const effectiveBase = trimmedBase || defaultTerminalCommand(preset);
  if (!effectiveBase) return extraArgs;
  if (preset === 'codex') {
    const resumeMatch = /^(codex\s+resume)\s+(.+)$/u.exec(effectiveBase);
    if (effectiveBase === 'codex' || resumeMatch) {
      const inlineFlag = /(?:^|\s)--no-alt-screen(?:\s|$)/u.test(`${extraArgs} ${resumeMatch?.[2] ?? ''}`)
        ? ''
        : '--no-alt-screen';
      return [resumeMatch?.[1] ?? effectiveBase, inlineFlag, extraArgs, resumeMatch?.[2]]
        .filter(Boolean)
        .join(' ');
    }
  }
  return extraArgs ? `${effectiveBase} ${extraArgs}` : trimmedBase;
}

export function validateWorkProjectInput(raw: WorkProjectInput): NormalizedWorkProjectInput {
  const hostId = (raw.hostId ?? '').trim();
  if (!hostId) throw new Error('请选择项目运行主机。');
  if (hasControlChars(hostId)) throw new Error('主机标识不合法。');

  const directory = (raw.directory ?? '').trim();
  if (!directory) throw new Error('请选择项目目录。');
  if (hasControlChars(directory)) throw new Error('项目目录不能包含控制字符。');
  if (directory.length > 1000) throw new Error('项目目录不能超过 1000 个字符。');

  const rawName = (raw.name ?? '').trim();
  if (hasControlChars(rawName)) throw new Error('项目名称不能包含控制字符。');
  if (rawName.length > 120) throw new Error('项目名称不能超过 120 个字符。');

  const cliProxies = normalizeWorkProjectCliProxies(raw.cliProxies, raw.proxyUrl);
  const cliArgs = normalizeWorkProjectCliArgs(raw.cliArgs);

  return {
    hostId,
    directory,
    name: rawName || deriveProjectName(directory),
    cliProxies,
    cliArgs,
  };
}
