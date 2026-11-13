import { invalid } from '../../errors';
import { isAllowedProperty } from './properties';

export type OfficeCommand = Record<string, unknown>;

const COMMANDS = new Set(['add', 'set', 'remove', 'duplicate', 'move']);
const ELEMENT_TYPES = new Set([
  'paragraph', 'run', 'table', 'row', 'cell', 'sheet', 'slide', 'shape', 'markdown', 'textbox',
]);
const RESOURCE_PROPERTIES = new Set([
  'background', 'fill', 'gradient', 'line', 'linegradient', 'textfill', 'fillbg',
]);
const RESOURCE_VALUE = /^\s*(?:image:|https?:\/\/|file:|data:|ftp:|[\\/]|[a-z]:[\\/])/iu;
const MAX_COMMANDS = 100;
const MAX_TEXT = 50_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw invalid(`${field} 必须以 / 开头。`);
  }
  if (value.length > 500 || value.includes('..') || value.includes('\0')
    || value.includes('\n') || value.includes('\r')) {
    throw invalid(`${field} 包含非法字符。`);
  }
  return value;
}

function validateProps(value: unknown): Record<string, string | number | boolean> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw invalid('props 必须是对象。');
  const result: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalized = key.trim().toLowerCase();
    if (!isAllowedProperty(normalized)) {
      throw invalid(`不支持的文档属性：${key}。属性名以 help 输出的元素属性表为准。`);
    }
    if (typeof raw === 'string') {
      if (raw.length > MAX_TEXT) throw invalid(`属性 ${key} 的文本过长。`);
      if (RESOURCE_PROPERTIES.has(normalized) && RESOURCE_VALUE.test(raw)) {
        throw invalid(`属性 ${key} 不支持图片、文件或 URL 引用，只接受颜色、渐变或样式值。`);
      }
      result[key] = raw;
    } else if (typeof raw === 'number' || typeof raw === 'boolean') {
      result[key] = raw;
    } else {
      throw invalid(`属性 ${key} 的值必须是字符串、数字或布尔值。`);
    }
  }
  return result;
}

/** Validate the model-facing document command list before it reaches the engine. */
export function validateOfficeCommands(value: unknown): OfficeCommand[] {
  if (!Array.isArray(value) || !value.length) throw invalid('需要 commands。');
  if (value.length > MAX_COMMANDS) throw invalid('单次最多 100 条命令。');
  return value.map((raw, index) => {
    if (!isRecord(raw)) throw invalid(`第 ${index + 1} 条命令格式不正确。`);
    const command = raw.command;
    if (typeof command !== 'string' || !COMMANDS.has(command)) {
      throw invalid(`第 ${index + 1} 条命令的 command 不受支持。`);
    }
    const result: OfficeCommand = { command };
    if (command === 'add') {
      result.parent = validatePath(raw.parent, 'parent');
      if (typeof raw.type !== 'string' || !ELEMENT_TYPES.has(raw.type)) {
        throw invalid(`第 ${index + 1} 条 add 命令的 type 不受支持。`);
      }
      result.type = raw.type;
    } else {
      result.path = validatePath(raw.path ?? raw.parent, 'path');
    }
    const props = validateProps(raw.props);
    if (Object.keys(props).length) result.props = props;
    return result;
  });
}

export function validateDocumentFilename(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 255) throw invalid('文件名不合法。');
  if (/[\\/\0\n\r]/u.test(trimmed)) throw invalid('文件名不能包含路径分隔符。');
  return trimmed;
}
