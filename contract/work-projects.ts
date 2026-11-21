/**
 * Shared types and validation for desktop work projects and remote/local directory browsing.
 * Keep this module free of Node, DOM, React and SQLite imports.
 */

export const LOCAL_WORK_HOST_ID = 'local';
export const WINDOWS_DRIVES_ROOT = '此电脑';

export type WorkEntryKind = 'directory' | 'file';

export type WorkHostEntry = {
  kind: WorkEntryKind;
  name: string;
  path: string;
  accessible: boolean;
};

export type HostDirectoryListing = {
  hostId: string;
  path: string;
  parentPath: string | null;
  truncated: boolean;
  entries: WorkHostEntry[];
  selectable?: boolean;
};

export type WorkProject = {
  id: string;
  name: string;
  hostId: string;
  directory: string;
  proxyUrl?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

export type WorkProjectInput = {
  hostId: string;
  directory: string;
  name?: string;
  proxyUrl?: string;
};

export type NormalizedWorkProjectInput = {
  hostId: string;
  directory: string;
  name: string;
  proxyUrl: string;
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

export function normalizeProjectProxyUrl(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  if (hasControlChars(trimmed)) throw new Error('网络代理地址不能包含控制字符。');
  if (/\s/u.test(trimmed)) throw new Error('网络代理地址不能包含空白字符。');
  if (trimmed.length > 500) throw new Error('网络代理地址不能超过 500 个字符。');

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error('请输入合法的网络代理地址，例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080。');
  }
  if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) {
    throw new Error('网络代理仅支持 http://、https:// 或 socks5:// 协议。');
  }
  return withScheme;
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

  const proxyUrl = normalizeProjectProxyUrl(raw.proxyUrl);

  return {
    hostId,
    directory,
    name: rawName || deriveProjectName(directory),
    proxyUrl,
  };
}
