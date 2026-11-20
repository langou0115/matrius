/**
 * Shared types and validation for desktop work projects and remote/local directory browsing.
 * Keep this module free of Node, DOM, React and SQLite imports.
 */

export const LOCAL_WORK_HOST_ID = 'local';

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
};

export type WorkProject = {
  id: string;
  name: string;
  hostId: string;
  directory: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

export type WorkProjectInput = {
  hostId: string;
  directory: string;
  name?: string;
};

export type NormalizedWorkProjectInput = {
  hostId: string;
  directory: string;
  name: string;
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

  return {
    hostId,
    directory,
    name: rawName || deriveProjectName(directory),
  };
}
