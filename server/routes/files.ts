import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { fromDbUuid, toDbUuid } from '../db/codecs';
import type { AppDatabase } from '../db/client';
import {
  decodeCursor,
  encodeCursor,
  formatDbTimestampCursor,
  parseDbTimestampCursor,
} from '../db/cursors';
import {
  deleteFileRows,
  fileUsageStats,
  getFileRow,
  getFileRowByClientId,
  insertFileRow,
  listFileRows,
  resolveConversationId,
  updateFileRow,
  type FileCursor,
  type FileKind,
  type FileOrder,
  type FileSort,
} from '../db/repositories/files';
import { clampPageSize, validateClientId } from '../db/validation';
import { AppError, conflict, invalid, notFound } from '../errors';
import {
  extensionOf,
  guessContentType,
  isAllowedExtension,
  safeFilename,
} from '../services/file-types';
import type { MemoryCache } from '../services/cache';
import type { LocalStorage } from '../services/storage';
import type { Settings } from '../config';
import {
  bulkDeleteFilesSchema,
  fileIdSchema,
  filePatchSchema,
  listFilesQuerySchema,
} from './file-schemas';
import { fileOut } from './file-serializers';

export type FileRouteDeps = {
  db: AppDatabase;
  storage: LocalStorage;
  cache: MemoryCache;
  settings: Settings;
};

const INSTANCE_ID = 1;

function pathParam(params: unknown, name: string): string {
  return String((params as Record<string, unknown>)[name]);
}

function parseFileCursor(cursor: string, sort: FileSort): FileCursor {
  try {
    const [rawValue, rawId] = decodeCursor(cursor, 2);
    const value = sort === 'created'
      ? parseDbTimestampCursor(rawValue)
      : sort === 'size'
        ? Number(rawValue)
        : rawValue;
    if (sort === 'size' && !Number.isSafeInteger(value)) throw invalid('分页游标无效。');
    return { value, idHex: toDbUuid(rawId) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid('分页游标无效。');
  }
}

function nextFileCursor(row: { created_at: string; filename: string; size: number; id: string }, sort: FileSort): string {
  const value = sort === 'created'
    ? formatDbTimestampCursor(row.created_at)
    : sort === 'name'
      ? row.filename
      : String(row.size);
  return encodeCursor(value, fromDbUuid(row.id));
}

export function registerFileRoutes(app: FastifyInstance, deps: FileRouteDeps): void {
  const { db, storage, cache, settings } = deps;

  app.post('/api/files', async (request, reply) => {
    await cache.enforceRateLimit('upload', 'instance', 20);

    const fields = new Map<string, string>();
    let filePart: { filename: string; mimetype: string; data: Buffer } | undefined;
    let tooLarge = false;
    try {
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          if (typeof part.value === 'string') fields.set(part.fieldname, part.value);
          continue;
        }
        if (filePart) throw invalid('一次只能上传一个文件。');
        try {
          const data = await part.toBuffer();
          if (part.file.truncated || data.length > settings.MAX_UPLOAD_BYTES) tooLarge = true;
          filePart = { filename: part.filename, mimetype: part.mimetype, data };
        } catch (error) {
          if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
            tooLarge = true;
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw invalid('无法解析上传内容。');
    }

    if (tooLarge) throw new AppError(413, 'file_too_large', '单个文件不能超过 20 MiB。');
    if (!filePart) throw invalid('文件为空。');

    const clientId = validateClientId(fields.get('clientId'));
    if (clientId) {
      const existing = getFileRowByClientId(db, INSTANCE_ID, clientId);
      if (existing) {
        reply.code(201);
        return fileOut(existing);
      }
    }

    const filename = safeFilename(filePart.filename || 'file');
    if (!isAllowedExtension(filename)) {
      throw new AppError(415, 'unsupported_file_type', '不支持的文件类型。');
    }

    const rawConversationId = fields.get('conversationId');
    const conversationId = rawConversationId
      ? resolveConversationId(db, INSTANCE_ID, rawConversationId)
      : undefined;
    if (rawConversationId && !conversationId) throw notFound('对话不存在。');

    const data = await cache.withConcurrency('upload', 'instance', 2, async () => {
      const buffer = filePart?.data;
      if (!buffer) throw invalid('文件为空。');
      if (!buffer.length) throw invalid('文件为空。');
      if (buffer.length > storage.diskUsage().free) {
        throw new AppError(413, 'disk_full', '服务器磁盘空间不足。');
      }
      return buffer;
    });

    const storedId = randomUUID();
    const objectKey = `${storedId}/${filename}`;
    const contentType = filePart.mimetype || guessContentType(filename);
    const digest = createHash('sha256').update(data).digest('hex');

    try {
      storage.put(objectKey, data);
    } catch (error) {
      throw new AppError(502, 'storage_error', '文件上传失败，请稍后重试。', { cause: error });
    }

    try {
      const row = insertFileRow(db, {
        id: storedId,
        instanceId: INSTANCE_ID,
        clientId,
        conversationId: conversationId ?? null,
        filename,
        objectKey,
        contentType,
        size: data.length,
        sha256: digest,
      });
      reply.code(201);
      return fileOut(row);
    } catch (error) {
      storage.delete(objectKey);
      if (error instanceof AppError) throw error;
      throw conflict('文件已存在，请刷新后重试。');
    }
  });

  app.get('/api/files/usage', async () => {
    const stats = fileUsageStats(db, INSTANCE_ID);
    return {
      used: stats.used,
      disk: storage.diskUsage(),
      files: { bytes: stats.used - stats.imageBytes, count: stats.total - stats.imageCount },
      images: { bytes: stats.imageBytes, count: stats.imageCount },
    };
  });

  app.post('/api/files/bulk-delete', async (request) => {
    const payload = bulkDeleteFilesSchema.parse(request.body);
    const rows = db.transaction(() => deleteFileRows(db, INSTANCE_ID, payload.ids));
    for (const row of rows) {
      try {
        storage.delete(row.object_key);
      } catch {
        // An orphaned object is recoverable; never leave a row pointing at a deleted object.
      }
    }
    return { deleted: rows.length };
  });

  app.get('/api/files', async (request) => {
    const query = listFilesQuerySchema.parse(request.query);
    const pageSize = clampPageSize(query.limit, 200);
    const conversationId = query.conversationId
      ? resolveConversationId(db, INSTANCE_ID, query.conversationId)
      : undefined;
    if (query.conversationId && !conversationId) {
      return { items: [], nextCursor: null };
    }
    const cursor = query.cursor ? parseFileCursor(query.cursor, query.sort) : undefined;
    const rows = listFileRows(db, INSTANCE_ID, {
      query: query.query,
      kind: query.kind as FileKind,
      sort: query.sort as FileSort,
      order: query.order as FileOrder,
      conversationId,
      cursor,
      limit: pageSize,
    });
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    const last = page[page.length - 1];
    return {
      items: page.map(fileOut),
      nextCursor: hasMore && last ? nextFileCursor(last, query.sort as FileSort) : null,
    };
  });

  app.patch('/api/files/:fileId', async (request) => {
    const fileId = fileIdSchema.parse(pathParam(request.params, 'fileId'));
    const payload = filePatchSchema.parse(request.body);
    const filename = safeFilename(payload.filename);
    const row = db.transaction(() => {
      const stored = getFileRow(db, INSTANCE_ID, fileId);
      if (!stored) throw notFound('文件不存在。');
      if (extname(filename).toLowerCase() !== extname(stored.filename).toLowerCase()) {
        throw invalid('不能修改文件扩展名。');
      }
      if (filename === stored.filename) return stored;

      const oldKey = stored.object_key;
      const newKey = `${fromDbUuid(stored.id)}/${filename}`;
      const data = storage.get(oldKey);
      storage.put(newKey, data);
      let updated;
      try {
        updated = updateFileRow(db, INSTANCE_ID, fileId, { filename, objectKey: newKey });
      } catch (error) {
        storage.delete(newKey);
        throw error;
      }
      storage.delete(oldKey);
      return updated;
    });
    return fileOut(row);
  });

  app.get('/api/files/:fileId', async (request) => {
    const fileId = fileIdSchema.parse(pathParam(request.params, 'fileId'));
    const row = getFileRow(db, INSTANCE_ID, fileId);
    if (!row) throw notFound('文件不存在。');
    return fileOut(row);
  });

  app.get('/api/files/:fileId/content', async (request, reply) => {
    const fileId = fileIdSchema.parse(pathParam(request.params, 'fileId'));
    const row = getFileRow(db, INSTANCE_ID, fileId);
    if (!row) throw notFound('文件不存在。');
    let data: Buffer;
    try {
      data = storage.get(row.object_key);
    } catch (error) {
      throw new AppError(502, 'storage_error', '无法读取文件，请稍后重试。', { cause: error });
    }
    const disposition = row.content_type.startsWith('image/') ? 'inline' : 'attachment';
    reply
      .header('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(row.filename)}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=3600')
      .type(row.content_type);
    return data;
  });

  app.delete('/api/files/:fileId', async (request) => {
    const fileId = fileIdSchema.parse(pathParam(request.params, 'fileId'));
    const row = getFileRow(db, INSTANCE_ID, fileId);
    if (!row) throw notFound('文件不存在。');
    storage.delete(row.object_key);
    db.prepare('DELETE FROM files WHERE id = ? AND instance_id = ?').run(row.id, INSTANCE_ID);
    return { ok: true };
  });
}
