import type { AppDatabase } from '../../db/client';
import { fromDbUuid as fromHex, toMs } from '../../db/codecs';
import {
  getFileRow,
  listFileRows,
  resolveConversationId,
} from '../../db/repositories/files';
import type { StoredFileRow } from '../../db/repositories/conversations';
import { AppError, invalid, notFound } from '../../errors';
import type { MemoryCache } from '../cache';
import type { LocalStorage } from '../storage';
import { extractText } from './extract';

export type FileListEntry = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  draft: boolean;
  createdAt: number | null;
};

export type FileReadResult = {
  operation: 'read';
  fileId: string;
  filename: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
  truncated: boolean;
};

export type FileGrepResult = {
  operation: 'grep';
  fileId: string;
  filename: string;
  matches: Array<{
    line: number;
    text: string;
    contextBefore: string[];
    contextAfter: string[];
  }>;
  totalLines: number;
  truncated: boolean;
};

export type FileToolService = {
  list(instanceId: number, conversationId?: string): Promise<FileListEntry[]>;
  read(
    instanceId: number,
    fileId: string,
    options: { start: number; end?: number; maxChars: number },
  ): Promise<FileReadResult>;
  grep(
    instanceId: number,
    fileId: string,
    options: { pattern: string; context: number; maxMatches: number },
  ): Promise<FileGrepResult>;
};

const FILE_TEXT_TTL_SECONDS = 3_600;
const EXTRACTOR_VERSION = 'v3';

export function sliceText(
  fileId: string,
  filename: string,
  text: string,
  start: number,
  end: number | undefined,
  maxChars: number,
): FileReadResult {
  const lines = text.split(/\r?\n/u);
  const totalLines = lines.length;
  if (!totalLines) {
    return { operation: 'read', fileId, filename, startLine: 0, endLine: 0, totalLines: 0, text: '', truncated: false };
  }
  const normalizedStart = Math.max(1, Math.min(start, totalLines));
  const lastAllowed = end === undefined ? totalLines : Math.max(normalizedStart, Math.min(end, totalLines));
  const selected: string[] = [];
  let used = 0;
  for (let index = normalizedStart - 1; index < lastAllowed; index += 1) {
    const line = lines[index];
    const cost = line.length + (selected.length ? 1 : 0);
    if (used + cost > maxChars) break;
    selected.push(line);
    used += cost;
  }
  const endLine = selected.length ? normalizedStart + selected.length - 1 : normalizedStart - 1;
  return {
    operation: 'read',
    fileId,
    filename,
    startLine: normalizedStart,
    endLine,
    totalLines,
    text: selected.join('\n'),
    truncated: endLine < lastAllowed,
  };
}

export function grepText(
  fileId: string,
  filename: string,
  text: string,
  pattern: string,
  context: number,
  maxMatches: number,
): FileGrepResult {
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern, 'u');
  } catch {
    throw invalid('正则表达式不合法。');
  }
  const lines = text.split(/\r?\n/u);
  const matches: FileGrepResult['matches'] = [];
  let truncated = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (!compiled.test(lines[index])) continue;
    if (matches.length >= maxMatches) {
      truncated = true;
      break;
    }
    matches.push({
      line: index + 1,
      text: lines[index],
      contextBefore: lines.slice(Math.max(0, index - context), index),
      contextAfter: lines.slice(index + 1, index + 1 + context),
    });
  }
  return { operation: 'grep', fileId, filename, matches, totalLines: lines.length, truncated };
}

export function createFileToolService(options: {
  db: AppDatabase;
  cache: MemoryCache;
  storage: LocalStorage;
}): FileToolService {
  const { db, cache, storage } = options;

  async function fileText(stored: StoredFileRow): Promise<string> {
    const key = `matrius:filetext:${stored.id}:${stored.sha256}:${EXTRACTOR_VERSION}`;
    const cached = cache.get(key);
    if (cached !== null) return cached;
    let data: Buffer;
    try {
      data = storage.get(stored.object_key);
    } catch (error) {
      throw new AppError(502, 'storage_error', '无法读取文件，请稍后重试。', { cause: error });
    }
    const text = await extractText(stored.filename, data);
    cache.set(key, text, FILE_TEXT_TTL_SECONDS);
    return text;
  }

  return {
    async list(instanceId, conversationId) {
      let resolvedConversation: string | undefined;
      if (conversationId) {
        resolvedConversation = resolveConversationId(db, instanceId, conversationId);
        if (!resolvedConversation) return [];
      }
      const rows = listFileRows(db, instanceId, {
        kind: 'all',
        sort: 'created',
        order: 'desc',
        ...(resolvedConversation ? { conversationId: resolvedConversation } : {}),
        limit: 100,
      });
      return rows.slice(0, 100).map((row) => ({
        id: fromHex(row.id),
        filename: row.filename,
        contentType: row.content_type,
        size: row.size,
        draft: false,
        createdAt: toMs(row.created_at),
      }));
    },

    async read(instanceId, fileId, readOptions) {
      const stored = getFileRow(db, instanceId, fileId);
      if (!stored) throw notFound('文件不存在。');
      const text = await fileText(stored);
      return sliceText(
        fromHex(stored.id),
        stored.filename,
        text,
        readOptions.start,
        readOptions.end,
        readOptions.maxChars,
      );
    },

    async grep(instanceId, fileId, grepOptions) {
      const stored = getFileRow(db, instanceId, fileId);
      if (!stored) throw notFound('文件不存在。');
      const text = await fileText(stored);
      return grepText(
        fromHex(stored.id),
        stored.filename,
        text,
        grepOptions.pattern,
        grepOptions.context,
        grepOptions.maxMatches,
      );
    },
  };
}
