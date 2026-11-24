import { execFile } from 'node:child_process';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  DiscoveredWslDistro,
  WorkHost,
  WorkHostInput,
  WslDiscoveryResult,
} from '../../contract/work-hosts';
import type { AppDatabase } from '../db/client';
import { fromDbUuid } from '../db/codecs';
import {
  createWorkHostRow,
  deleteWorkHostRow,
  listWorkHostRows,
  requireWorkHostRow,
  serializeWorkHost,
  updateWorkHostConnectionRow,
  updateWorkHostRow,
  updateWorkHostSecretRow,
  type WorkHostRow,
} from '../db/repositories/hosts';
import { invalid } from '../errors';

const INSTANCE_ID = 1;
const PROBE_TIMEOUT_MS = 8_000;

export type HostCommandResult = {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  errorCode?: string;
  timedOut?: boolean;
};

export type HostCommandRunner = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number; env?: Record<string, string>; maxBuffer?: number; input?: Buffer | string },
) => Promise<HostCommandResult>;

export type SshBannerProber = (
  host: string,
  port: number,
  timeoutMs: number,
) => Promise<{ ok: boolean; banner?: string; message?: string }>;

export type WorkHostService = {
  list(): WorkHost[];
  create(input: WorkHostInput): WorkHost;
  update(hostId: string, input: WorkHostInput & { baseRevision: number }): WorkHost;
  remove(hostId: string, baseRevision?: number): void;
  unlock(hostId: string, secret: string, persist?: boolean): WorkHost;
  connect(hostId: string): Promise<WorkHost>;
  disconnect(hostId: string): WorkHost;
  discoverWsl(): Promise<WslDiscoveryResult>;
};

export function defaultRunCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number; env?: Record<string, string>; maxBuffer?: number; input?: Buffer | string } = {},
): Promise<HostCommandResult> {
  return new Promise((resolve) => {
    const child = execFile(command, args, {
      encoding: 'buffer',
      timeout: options.timeoutMs ?? PROBE_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, ...options.env },
    }, (error, stdout, stderr) => {
      const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: string | number }) | null;
      const numericCode = typeof err?.code === 'number'
        ? err.code
        : typeof (err as { status?: unknown } | null)?.status === 'number'
          ? Number((err as { status?: number }).status)
          : error ? 1 : 0;
      const stringCode = typeof err?.code === 'string' ? err.code : undefined;
      resolve({
        code: numericCode,
        stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''),
        stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? ''),
        ...(stringCode ? { errorCode: stringCode } : {}),
        ...(err?.killed ? { timedOut: true } : {}),
      });
    });
    if (options.input !== undefined && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(options.input);
    }
  });
}

function defaultProbeSshBanner(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ ok: boolean; banner?: string; message?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host, port });
    const chunks: Buffer[] = [];
    const finish = (result: { ok: boolean; banner?: string; message?: string }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.includes('\n') || text.length >= 64) {
        const line = text.split(/\r?\n/u)[0]?.trim() ?? '';
        if (line.startsWith('SSH-')) {
          finish({ ok: true, banner: line });
        } else {
          finish({ ok: false, message: '目标端口未返回 SSH 握手响应。' });
        }
      }
    });
    socket.on('timeout', () => finish({ ok: false, message: `连接 ${host}:${port} 超时。` }));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      finish({ ok: false, message: `无法连接到 ${host}:${port}：${error.code ?? error.message}` });
    });
    socket.on('end', () => {
      const line = Buffer.concat(chunks).toString('utf8').split(/\r?\n/u)[0]?.trim() ?? '';
      if (line.startsWith('SSH-')) finish({ ok: true, banner: line });
      else finish({ ok: false, message: '远端提前关闭了连接。' });
    });
  });
}

/** Decode `wsl.exe` stdout which may arrive as UTF-16LE (default on older Windows) or UTF-8. */
export function decodeWslText(raw: Buffer | string): string {
  if (typeof raw === 'string') return raw.replaceAll('\0', '');
  if (!raw.length) return '';
  let zeroEven = 0;
  let zeroOdd = 0;
  for (let index = 0; index < Math.min(raw.length, 200); index += 1) {
    if (raw[index] !== 0) continue;
    if (index % 2 === 0) zeroEven += 1;
    else zeroOdd += 1;
  }
  const encoding = zeroOdd > zeroEven && zeroOdd >= 2 ? 'utf16le' : 'utf8';
  return raw.toString(encoding).replace(/^\uFEFF/u, '').replaceAll('\0', '');
}

export function parseWslListOutput(raw: Buffer | string): DiscoveredWslDistro[] {
  const text = decodeWslText(raw);
  const distros: DiscoveredWslDistro[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const isDefault = trimmed.startsWith('*');
    const line = isDefault ? trimmed.slice(1).trim() : trimmed;
    const match = /^(.+?)\s{2,}(Running|Stopped|Installing|Uninstalling|Converting)\s+(\d+)\s*$/iu.exec(line);
    if (!match) continue;
    distros.push({
      name: match[1].trim(),
      state: match[2],
      version: Number.parseInt(match[3], 10),
      isDefault,
    });
  }
  return distros;
}

function summarizeError(raw: Buffer | string, fallback: string): string {
  const text = decodeWslText(raw)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!text) return fallback;
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}

export function expandHomePath(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2));
  return value;
}

export type WslListOutcome =
  | { ok: true; distros: DiscoveredWslDistro[] }
  | { ok: false; code: 'enoent' | 'timed_out' | 'failed'; message: string };

export async function queryWslDistros(
  wslCommand: string,
  runCommand: HostCommandRunner,
): Promise<WslListOutcome> {
  const result = await runCommand(wslCommand, ['-l', '-v'], {
    timeoutMs: 6_000,
    env: { WSL_UTF8: '1' },
  });
  if (result.errorCode === 'ENOENT') {
    return {
      ok: false,
      code: 'enoent',
      message: '本机未安装或未启用 WSL（找不到 wsl.exe）。',
    };
  }
  if (result.timedOut) {
    return {
      ok: false,
      code: 'timed_out',
      message: 'WSL 列表探测超时，请确认 WSL 服务状态。',
    };
  }
  if (result.code !== 0) {
    return {
      ok: false,
      code: 'failed',
      message: summarizeError(result.stderr, '未能获取本机 WSL 发行版列表。'),
    };
  }
  return { ok: true, distros: parseWslListOutput(result.stdout) };
}

export async function ensureWslDistroRunning(
  wslCommand: string,
  distro: string,
  runCommand: HostCommandRunner,
): Promise<{ ok: true } | { ok: false; code: 'enoent' | 'timed_out' | 'failed' | 'not_found' | 'stopped'; message: string }> {
  const listing = await queryWslDistros(wslCommand, runCommand);
  if (!listing.ok) return listing;
  const match = listing.distros.find((item) => item.name === distro)
    ?? listing.distros.find((item) => item.name.toLowerCase() === distro.toLowerCase());
  if (!match) {
    return { ok: false, code: 'not_found', message: `未找到 WSL 发行版 ${distro}，请确认已安装。` };
  }
  if (match.state.toLowerCase() !== 'running') {
    return { ok: false, code: 'stopped', message: `WSL 发行版 ${match.name} 未启动（${match.state}）。` };
  }
  return { ok: true };
}

export function resolveWslCommand(platform = process.platform): string | null {
  return platform === 'win32' ? 'wsl.exe' : null;
}

export function resolveSshCommand(platform = process.platform): string {
  return platform === 'win32' ? 'ssh.exe' : 'ssh';
}

export function createWorkHostService(options: {
  db: AppDatabase;
  runCommand?: HostCommandRunner;
  probeSshBanner?: SshBannerProber;
  wslCommand?: string | null;
  runtimeHostSecrets?: Map<string, string>;
}): WorkHostService {
  const { db } = options;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const probeSshBanner = options.probeSshBanner ?? defaultProbeSshBanner;
  const wslCommand = options.wslCommand !== undefined ? options.wslCommand : resolveWslCommand();
  const runtimeHostSecrets = options.runtimeHostSecrets ?? new Map<string, string>();

  async function probeSsh(row: WorkHostRow): Promise<{ status: 'connected' | 'error'; message: string }> {
    const startedAt = Date.now();
    if (row.auth_method === 'password') {
      if (!row.secret_value && !runtimeHostSecrets.get(fromDbUuid(row.id))) {
        return { status: 'error', message: '未保存 SSH 密码，请先编辑主机并填写密码。' };
      }
      const probe = await probeSshBanner(row.host, row.port, 5_000);
      const elapsed = Math.max(1, Date.now() - startedAt);
      if (!probe.ok) {
        return { status: 'error', message: probe.message ?? '无法连接 SSH 服务。' };
      }
      return {
        status: 'connected',
        message: `SSH 服务可达（${probe.banner ?? 'SSH-2.0'}，${elapsed} ms）`,
      };
    }

    const args = [
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=8',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-p', String(row.port),
    ];
    if (row.auth_method === 'key' && row.private_key_path) {
      args.push('-i', expandHomePath(row.private_key_path), '-o', 'IdentitiesOnly=yes');
    }
    const target = row.username ? `${row.username}@${row.host}` : row.host;
    args.push('--', target, 'printf', 'matrius-ok');

    const result = await runCommand('ssh', args, { timeoutMs: PROBE_TIMEOUT_MS });
    const elapsed = Math.max(1, Date.now() - startedAt);
    if (result.errorCode === 'ENOENT') {
      return { status: 'error', message: '本机未找到 ssh 客户端，请先安装 OpenSSH Client。' };
    }
    if (result.timedOut) {
      return { status: 'error', message: 'SSH 连接超时，请检查主机地址、端口或代理配置。' };
    }
    if (result.code === 0 && decodeWslText(result.stdout).includes('matrius-ok')) {
      return { status: 'connected', message: `连接成功（${elapsed} ms）` };
    }
    return {
      status: 'error',
      message: summarizeError(result.stderr, 'SSH 认证或连接失败。'),
    };
  }

  async function probeWsl(row: WorkHostRow): Promise<{ status: 'connected' | 'error'; message: string }> {
    if (!wslCommand) {
      return { status: 'error', message: '当前仅支持在 Windows 主机检测 WSL 发行版。' };
    }
    const runningCheck = await ensureWslDistroRunning(wslCommand, row.distro, runCommand);
    if (!runningCheck.ok) {
      return { status: 'error', message: runningCheck.message };
    }

    const startedAt = Date.now();
    const args = ['-d', row.distro];
    if (row.username) args.push('--user', row.username);
    args.push('--exec', 'sh', '-c', 'printf matrius-ok');

    const result = await runCommand(wslCommand, args, {
      timeoutMs: 10_000,
      env: { WSL_UTF8: '1' },
    });
    const elapsed = Math.max(1, Date.now() - startedAt);
    if (result.errorCode === 'ENOENT') {
      return { status: 'error', message: '未找到 wsl.exe，请确认系统已启用 WSL。' };
    }
    if (result.timedOut) {
      return { status: 'error', message: `WSL 发行版 ${row.distro} 执行检测超时。` };
    }
    if (result.code === 0 && decodeWslText(result.stdout).includes('matrius-ok')) {
      return { status: 'connected', message: `WSL 发行版连接正常（${elapsed} ms）` };
    }
    return {
      status: 'error',
      message: summarizeError(result.stderr, `无法连接到 WSL 发行版 ${row.distro}。`),
    };
  }

  return {
    list() {
      return listWorkHostRows(db, INSTANCE_ID).map(serializeWorkHost);
    },

    create(input) {
      return db.transaction(() => serializeWorkHost(createWorkHostRow(db, INSTANCE_ID, input)));
    },

    update(hostId, input) {
      return db.transaction(() => {
        const updated = serializeWorkHost(updateWorkHostRow(db, INSTANCE_ID, hostId, input));
        if (input.clearSecret || updated.kind === 'wsl' || updated.authMethod === 'agent') {
          runtimeHostSecrets.delete(updated.id);
        } else if (typeof input.secret === 'string' && input.secret.trim()) {
          runtimeHostSecrets.set(updated.id, input.secret.trim());
        }
        return updated;
      });
    },

    remove(hostId, baseRevision) {
      const targetId = fromDbUuid(requireWorkHostRow(db, INSTANCE_ID, hostId).id);
      runtimeHostSecrets.delete(targetId);
      db.transaction(() => deleteWorkHostRow(db, INSTANCE_ID, hostId, baseRevision));
    },

    unlock(hostId, secret, persist = false) {
      const trimmed = secret.trim();
      if (!trimmed) {
        throw invalid('请输入主机密码。');
      }
      const row = requireWorkHostRow(db, INSTANCE_ID, hostId);
      const serialized = serializeWorkHost(row);
      if (row.kind !== 'ssh') {
        throw invalid('仅 SSH 主机支持密码解锁。');
      }
      runtimeHostSecrets.set(serialized.id, trimmed);
      if (persist && row.auth_method === 'password') {
        return db.transaction(() => serializeWorkHost(updateWorkHostSecretRow(db, INSTANCE_ID, hostId, trimmed)));
      }
      return serialized;
    },

    async connect(hostId) {
      const row = requireWorkHostRow(db, INSTANCE_ID, hostId);
      const outcome = row.kind === 'wsl' ? await probeWsl(row) : await probeSsh(row);
      const checkedAt = Date.now();
      return db.transaction(() => serializeWorkHost(updateWorkHostConnectionRow(db, INSTANCE_ID, hostId, {
        status: outcome.status,
        statusMessage: outcome.message,
        lastCheckedAtMs: checkedAt,
      })));
    },

    disconnect(hostId) {
      const row = requireWorkHostRow(db, INSTANCE_ID, hostId);
      runtimeHostSecrets.delete(serializeWorkHost(row).id);
      return db.transaction(() => serializeWorkHost(updateWorkHostConnectionRow(db, INSTANCE_ID, hostId, {
        status: 'disconnected',
        statusMessage: '已断开连接',
      })));
    },

    async discoverWsl() {
      if (!wslCommand) {
        return {
          available: false,
          distros: [],
          message: '当前仅支持在 Windows 宿主上自动扫描本机 WSL 发行版。',
        };
      }
      const listing = await queryWslDistros(wslCommand, runCommand);
      if (!listing.ok) {
        return {
          available: false,
          distros: [],
          message: listing.message,
        };
      }
      return {
        available: true,
        distros: listing.distros,
      };
    },
  };
}
