/**
 * Shared types and validation for desktop SSH and WSL work hosts.
 * Keep this module free of Node, DOM, React and SQLite imports.
 */

export type HostKind = 'ssh' | 'wsl';
export type HostConnectionStatus = 'connected' | 'disconnected' | 'error';
export type SshAuthMethod = 'agent' | 'key' | 'password';

export const SSH_AUTH_METHODS = [
  { id: 'agent', label: 'SSH Agent / 系统默认密钥' },
  { id: 'key', label: '私钥文件' },
  { id: 'password', label: '密码' },
] as const satisfies readonly { id: SshAuthMethod; label: string }[];

export type WorkHost = {
  id: string;
  kind: HostKind;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath: string;
  /** True when the server holds a stored password or key passphrase (never returned in plaintext). */
  hasSecret: boolean;
  distro: string;
  defaultDirectory: string;
  note: string;
  status: HostConnectionStatus;
  statusMessage: string | null;
  lastCheckedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

export type WorkHostInput = {
  kind: HostKind;
  name: string;
  host?: string;
  port?: number;
  username?: string;
  authMethod?: SshAuthMethod;
  privateKeyPath?: string;
  secret?: string;
  clearSecret?: boolean;
  distro?: string;
  defaultDirectory?: string;
  note?: string;
};

export type NormalizedWorkHostInput = {
  kind: HostKind;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath: string;
  distro: string;
  defaultDirectory: string;
  note: string;
};

export type DiscoveredWslDistro = {
  name: string;
  state: string;
  version: number | null;
  isDefault: boolean;
};

export type WslDiscoveryResult = {
  available: boolean;
  distros: DiscoveredWslDistro[];
  message?: string;
};

const WHITESPACE = /\s/u;

function hasControlChars(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function cleanText(value: string | undefined, maxLength: number, label: string): string {
  const trimmed = (value ?? '').trim();
  if (hasControlChars(trimmed)) throw new Error(`${label}不能包含控制字符。`);
  if (trimmed.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符。`);
  return trimmed;
}

function cleanToken(value: string | undefined, maxLength: number, label: string, { allowEmpty = false } = {}): string {
  const cleaned = cleanText(value, maxLength, label);
  if (!cleaned) {
    if (allowEmpty) return '';
    throw new Error(`请填写${label}。`);
  }
  if (WHITESPACE.test(cleaned)) throw new Error(`${label}不能包含空白字符。`);
  if (cleaned.startsWith('-')) throw new Error(`${label}不能以 "-" 开头。`);
  return cleaned;
}

export function validateWorkHostInput(raw: WorkHostInput): NormalizedWorkHostInput {
  const kind: HostKind = raw.kind === 'wsl' ? 'wsl' : 'ssh';
  const name = cleanText(raw.name, 120, '主机名称');
  if (!name) throw new Error('请填写主机名称。');

  const defaultDirectory = cleanText(raw.defaultDirectory, 500, '默认目录');
  const note = cleanText(raw.note, 500, '备注');

  if (kind === 'wsl') {
    const distro = cleanToken(raw.distro, 120, 'WSL 发行版名称');
    const username = cleanToken(raw.username, 120, '登录用户', { allowEmpty: true });
    return {
      kind: 'wsl',
      name,
      host: '',
      port: 22,
      username,
      authMethod: 'agent',
      privateKeyPath: '',
      distro,
      defaultDirectory,
      note,
    };
  }

  const host = cleanToken(raw.host, 255, '主机地址');
  const port = raw.port === undefined ? 22 : Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('端口必须是 1 到 65535 之间的整数。');
  }
  const username = cleanToken(raw.username, 120, '用户名', { allowEmpty: true });
  const authMethod: SshAuthMethod = raw.authMethod === 'key' || raw.authMethod === 'password'
    ? raw.authMethod
    : 'agent';
  const privateKeyPath = authMethod === 'key'
    ? cleanText(raw.privateKeyPath, 500, '私钥路径')
    : '';
  if (privateKeyPath.startsWith('-')) {
    throw new Error('私钥路径不能以 "-" 开头。');
  }

  return {
    kind: 'ssh',
    name,
    host,
    port,
    username,
    authMethod,
    privateKeyPath,
    distro: '',
    defaultDirectory,
    note,
  };
}

export function formatWorkHostAddress(host: Pick<WorkHost, 'kind' | 'host' | 'port' | 'username' | 'distro'>): string {
  if (host.kind === 'wsl') {
    return host.username ? `${host.username}@wsl:${host.distro}` : `wsl:${host.distro}`;
  }
  const userPrefix = host.username ? `${host.username}@` : '';
  const portSuffix = host.port !== 22 ? `:${host.port}` : '';
  return `${userPrefix}${host.host}${portSuffix}`;
}
