import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Settings } from '../../config';
import { AppError } from '../../errors';
import { resolveOfficecli } from './binaries';
import { isAllowedProperty } from './properties';
import { runProcess, type ProcessResult } from './process';

const MAX_TEXT_CHARS = 30_000;
const MAX_HELP_CHARS = 20_000;
const SAFE_ITEM_CODES = new Set(['invalid_value', 'invalid_path', 'not_found', 'unsupported']);
const ENGINE_ENV = {
  OFFICECLI_NO_AUTO_RESIDENT: '1',
  OFFICECLI_SKIP_UPDATE: '1',
  OFFICECLI_NO_AUTO_INSTALL: '1',
};

export type OfficeCommand = Record<string, unknown>;

/** Windows can hold a document handle for a moment after the helper exits. */
async function cleanup(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // A leaked temp directory must not turn a successful document operation into an error.
  }
}

function decode(result: ProcessResult): string {
  return result.stdout.toString('utf8').trim();
}

function clip(value: string, limit = 240): string {
  const cleaned = value.replace(/\s+/gu, ' ').trim();
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit)}…`;
}

function failure(action: string, envelope: unknown): AppError {
  const details: string[] = [];
  if (envelope && typeof envelope === 'object') {
    const record = envelope as Record<string, unknown>;
    const error = record.error;
    if (error && typeof error === 'object') {
      const item = error as Record<string, unknown>;
      const parts: string[] = [];
      if (typeof item.error === 'string' && item.error.trim()) parts.push(clip(item.error));
      if (typeof item.suggestion === 'string' && item.suggestion.trim()) {
        parts.push(`建议：${clip(item.suggestion, 160)}`);
      }
      if (parts.length) {
        const code = typeof item.code === 'string' && item.code ? `（${item.code.slice(0, 60)}）` : '';
        details.push(`${code}${parts.join(' ')}`);
      }
    }
    const data = record.data;
    const results = data && typeof data === 'object'
      ? (data as Record<string, unknown>).results
      : undefined;
    if (Array.isArray(results)) {
      for (const raw of results) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as Record<string, unknown>;
        if (item.success !== false) continue;
        const code = typeof item.code === 'string' ? item.code : '';
        const label = typeof item.index === 'number' ? `第 ${item.index + 1} 条命令` : '命令';
        const hints: Record<string, string> = {
          duplicate_name: '名称已存在；新建 Excel 已有 Sheet1，请 inspect 后修改已有表或使用其他名称。',
          not_found: '目标不存在，请先 inspect 确认路径。',
          invalid_path: '文档路径不合法，请先 inspect 确认路径。',
          invalid_value: '参数值、父路径或元素类型不被支持：PPT 幻灯片只能加在 "/"，先用 help 查看属性取值、用 inspect 确认路径。',
        };
        let hint = hints[code] ?? '请用 help/inspect 核对本工具支持的元素、属性和目标路径，缩小命令批次后重试。';
        if (SAFE_ITEM_CODES.has(code) && typeof item.error === 'string' && item.error.trim()) {
          hint = `${hint} 详情：${clip(item.error)}`;
        }
        details.push(`${label}${code ? `（${code.slice(0, 80)}）` : ''}：${hint}`);
        if (details.length === 3) break;
      }
    }
  }
  const message = details.join(' ') || '请用 help/inspect 核对元素、属性和路径后重试。';
  return new AppError(422, 'invalid_document_operation', `${action}失败。${message}`);
}

function check(result: ProcessResult, action: string): string {
  if (result.code === -1 && !result.stdout.length && !result.stderr.length) {
    throw new AppError(504, 'officecli_timeout', '文档处理超时，请重试。');
  }
  if (result.truncated) {
    throw new AppError(422, 'document_too_large', '文档输出过大，请缩小操作范围。');
  }
  const text = decode(result);
  let envelope: unknown = null;
  try {
    envelope = JSON.parse(text);
  } catch {
    // Non-JSON engine output still carries a meaningful exit status.
  }
  if (result.code !== 0) throw failure(action, envelope);
  if (!text) throw new AppError(502, 'document_engine_error', '文档引擎未返回结果。');
  if (envelope && typeof envelope === 'object'
    && (envelope as Record<string, unknown>).success === false) {
    throw failure(action, envelope);
  }
  return text;
}

export function truncate(text: string): string {
  return text.length <= MAX_TEXT_CHARS ? text : `${text.slice(0, MAX_TEXT_CHARS)}\n…（输出已截断）`;
}

async function engineRun(settings: Settings, argv: string[], stdin?: Buffer, cwd?: string): Promise<ProcessResult> {
  return runProcess(argv, {
    ...(stdin ? { stdin } : {}),
    timeoutSeconds: settings.OFFICECLI_TIMEOUT_SECONDS,
    maxOutputBytes: settings.OFFICECLI_MAX_OUTPUT_BYTES,
    ...(cwd ? { cwd } : {}),
    env: ENGINE_ENV,
  });
}

function compactHelp(fmt: string, element: string | undefined, raw: string): string {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw;
  }
  const properties = payload.properties;
  if (!properties || typeof properties !== 'object') return raw;
  const lines = [`${String(payload.format ?? fmt)} / ${String(payload.element ?? element ?? '')}`];
  if (typeof payload.parent === 'string' && payload.parent) lines.push(`parent: ${payload.parent}`);
  const paths = payload.paths;
  const positional = paths && typeof paths === 'object'
    ? (paths as Record<string, unknown>).positional
    : undefined;
  if (Array.isArray(positional) && positional.length) {
    lines.push(`paths: ${positional.map(String).join(', ')}`);
  }
  if (typeof payload.note === 'string' && payload.note.trim()) {
    lines.push(`note: ${clip(payload.note, 500)}`);
  }
  lines.push('values accept units such as "2cm", "72pt" or "1in"; property names are case-insensitive.');

  const entries: string[] = [];
  for (const [name, spec] of Object.entries(properties as Record<string, unknown>)) {
    if (!spec || typeof spec !== 'object') continue;
    const item = spec as Record<string, unknown>;
    if (!item.add && !item.set) continue;
    if (!isAllowedProperty(name)) continue;
    const chunks = [`${name} (${String(item.type ?? 'value')})`];
    if (Array.isArray(item.values) && item.values.length) {
      chunks.push(`values: ${item.values.slice(0, 12).map(String).join(' | ')}`);
    }
    if (Array.isArray(item.aliases) && item.aliases.length) {
      chunks.push(`aliases: ${item.aliases.slice(0, 6).map(String).join(', ')}`);
    }
    if (typeof item.description === 'string' && item.description.trim()) {
      chunks.push(clip(item.description, 160));
    }
    if (Array.isArray(item.examples) && item.examples.length) {
      chunks.push(`e.g. ${item.examples.slice(0, 2).map(String).join(' / ')}`);
    }
    entries.push(`  - ${chunks.join(' — ')}`);
  }
  lines.push(`add/set properties (${entries.length}):`, ...entries);
  const text = lines.join('\n');
  return text.length <= MAX_HELP_CHARS ? text : `${text.slice(0, MAX_HELP_CHARS)}\n…（输出已截断）`;
}

export async function officeHelp(settings: Settings, fmt: string, element?: string): Promise<string> {
  const argv = [resolveOfficecli(settings), 'help', fmt];
  if (element) argv.push(element);
  argv.push('--json');
  const raw = check(await engineRun(settings, argv), '读取帮助');
  return truncate(element ? compactHelp(fmt, element, raw) : raw);
}

export async function officeViewText(settings: Settings, filename: string, data: Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'matrius-doc-'));
  try {
    const path = join(directory, `document${filename.slice(filename.lastIndexOf('.'))}`);
    await writeFile(path, data);
    return truncate(check(await engineRun(settings, [resolveOfficecli(settings), 'view', path, 'text'], undefined, directory), '读取文档'));
  } finally {
    await cleanup(directory);
  }
}

export async function officeInspect(settings: Settings, fmt: string, data: Uint8Array, path = '/'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'matrius-doc-'));
  try {
    const target = join(directory, `document.${fmt}`);
    await writeFile(target, data);
    const result = await engineRun(
      settings,
      [resolveOfficecli(settings), 'get', target, path, '--depth', '3', '--json'],
      undefined,
      directory,
    );
    return truncate(check(result, '查看文档结构'));
  } finally {
    await cleanup(directory);
  }
}

export async function officeCreate(settings: Settings, fmt: string): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'matrius-doc-'));
  try {
    const target = join(directory, `document.${fmt}`);
    const result = await engineRun(
      settings,
      [resolveOfficecli(settings), 'create', target, '--type', fmt, '--locale', 'zh-CN', '--json'],
      undefined,
      directory,
    );
    check(result, '创建文档');
    return await readVerified(settings, fmt, target, directory);
  } finally {
    await cleanup(directory);
  }
}

export async function officeEdit(
  settings: Settings,
  fmt: string,
  data: Uint8Array,
  commands: OfficeCommand[],
): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'matrius-doc-'));
  try {
    const target = join(directory, `document.${fmt}`);
    await writeFile(target, data);
    const payload = Buffer.from(JSON.stringify(commands), 'utf8');
    const result = await engineRun(
      settings,
      [resolveOfficecli(settings), 'batch', target, '--stop-on-error', '--json'],
      payload,
      directory,
    );
    check(result, '编辑文档');
    return await readVerified(settings, fmt, target, directory);
  } finally {
    await cleanup(directory);
  }
}

async function readVerified(settings: Settings, fmt: string, target: string, directory: string): Promise<Buffer> {
  const verify = await engineRun(
    settings,
    [resolveOfficecli(settings), 'get', target, '/', '--depth', '0', '--json'],
    undefined,
    directory,
  );
  check(verify, '校验文档');
  await engineRun(settings, [resolveOfficecli(settings), 'close', target, '--json'], undefined, directory);
  const data = await readFile(target);
  if (!data.length) throw new AppError(502, 'document_engine_error', '文档引擎没有生成文件。');
  void fmt;
  return data;
}
