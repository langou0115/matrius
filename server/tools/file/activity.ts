import type { WebActivity } from '../../../contract/agent-protocol';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function resultText(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
  for (const item of result.content) {
    if (!isRecord(item) || item.type !== 'text') continue;
    const text = stringValue(item.text);
    if (text) return text;
  }
  return undefined;
}

export function startFileActivity(toolCallId: string, args: unknown): WebActivity {
  const record = isRecord(args) ? args : {};
  return {
    id: toolCallId,
    kind: 'file',
    status: 'running',
    ...(stringValue(record.operation) ? { operation: stringValue(record.operation) } : {}),
    ...(stringValue(record.fileId) ? { fileId: stringValue(record.fileId) } : {}),
  };
}

export function endFileActivity(
  toolCallId: string,
  result: unknown,
  isError: boolean,
  previous?: WebActivity,
): WebActivity {
  const details = isRecord(result) && isRecord(result.details) ? result.details : {};
  const operation = stringValue(details.operation) ?? previous?.operation;
  const error = isError ? resultText(result) ?? '文件操作失败。' : stringValue(details.warning);
  return {
    id: toolCallId,
    kind: 'file',
    status: isError ? 'error' : 'complete',
    ...(operation ? { operation } : {}),
    ...(stringValue(details.fileId) ?? previous?.fileId ? { fileId: stringValue(details.fileId) ?? previous?.fileId } : {}),
    ...(stringValue(details.savedFileId) ? { savedFileId: stringValue(details.savedFileId) } : {}),
    ...(stringValue(details.filename) ? { filename: stringValue(details.filename) } : {}),
    ...(numberValue(details.size) !== undefined ? { size: numberValue(details.size) } : {}),
    ...(error ? { error } : {}),
    ...(numberValue(details.tookMs) !== undefined ? { tookMs: numberValue(details.tookMs) } : {}),
  };
}
