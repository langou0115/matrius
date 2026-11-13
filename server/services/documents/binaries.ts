import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Settings } from '../../config';
import { AppError } from '../../errors';

const SERVER_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VENDOR_ROOT = resolve(SERVER_ROOT, 'vendor');
const OFFICECLI_ROOT = resolve(VENDOR_ROOT, 'officecli');
const FONT_PATH = resolve(VENDOR_ROOT, 'fonts', 'NotoSansSC.ttf');
const SUMS_PATH = resolve(OFFICECLI_ROOT, 'SHA256SUMS');

function platformBinary(): string | null {
  if (process.platform === 'win32') return resolve(OFFICECLI_ROOT, 'win-x64', 'officecli.exe');
  if (process.platform === 'linux') return resolve(OFFICECLI_ROOT, 'linux-x64', 'officecli');
  return null;
}

function readSums(): Map<string, string> {
  const sums = new Map<string, string>();
  if (!existsSync(SUMS_PATH)) return sums;
  for (const line of readFileSync(SUMS_PATH, 'utf8').split(/\r?\n/u)) {
    const parts = line.trim().split(/\s+/u);
    if (parts.length !== 2) continue;
    sums.set(parts[1].replace(/^\*/u, '').replaceAll('\\', '/'), parts[0].toLowerCase());
  }
  return sums;
}

const digestCache = new Map<string, string>();

function digest(path: string): string {
  const cached = digestCache.get(path);
  if (cached) return cached;
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  const value = hash.digest('hex');
  digestCache.set(path, value);
  return value;
}

function verifyDigest(path: string, relative: string): void {
  const expected = readSums().get(relative);
  if (!expected) return;
  if (digest(path) !== expected) {
    throw new AppError(503, 'officecli_unavailable', '文档引擎校验失败，请重新部署。');
  }
}

export function resolveOfficecli(settings: Settings): string {
  const configured = settings.OFFICECLI_PATH.trim();
  const path = configured ? resolve(configured) : platformBinary();
  if (!path) {
    throw new AppError(503, 'officecli_unavailable', '当前平台未内置 Office 文档引擎，请设置 OFFICECLI_PATH。');
  }
  if (!existsSync(path)) {
    throw new AppError(503, 'officecli_unavailable', '未找到 Office 文档引擎。');
  }
  if (path.startsWith(OFFICECLI_ROOT)) {
    verifyDigest(path, path.slice(OFFICECLI_ROOT.length + 1).replaceAll('\\', '/'));
  }
  return path;
}

export function fontPath(settings: Settings): string {
  void settings;
  if (!existsSync(FONT_PATH)) {
    throw new AppError(503, 'document_engine_error', '缺少中文字体文件。');
  }
  return FONT_PATH;
}

export function documentEngineStatus(settings: Settings): Record<string, string> {
  try {
    return { officecli: `ok:${resolveOfficecli(settings).split(/[\\/]/u).pop()}` };
  } catch (error) {
    return {
      officecli: error instanceof AppError ? error.code : 'document_engine_error',
    };
  }
}
