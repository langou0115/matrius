import type { FastifyInstance } from 'fastify';

import {
  decodeCursor,
  encodeCursor,
  formatDbTimestampCursor,
  parseDbTimestampCursor,
} from '../db/cursors';
import { notFound } from '../errors';
import type { AppDatabase } from '../db/client';
import { fromDbUuid, toDbUuid } from '../db/codecs';
import {
  archiveMemory,
  createMemory,
  deleteProfileField,
  getMemoryRow,
  getOrCreatePreferences,
  getOrCreateProfile,
  getProfileField,
  listConversationDeletionIds,
  listMemoryRows,
  listProfileFields,
  requireProfileField,
  updateMemory,
  updatePreferences,
  updateProfile,
  upsertProfileField,
  validateFieldKey,
  type MemoryCursor,
} from '../db/repositories/workspace';
import { clampPageSize } from '../db/validation';
import { AppError, conflict, invalid } from '../errors';
import {
  deleteMemoryQuerySchema,
  deleteProfileFieldQuerySchema,
  listConversationDeletionsQuerySchema,
  listMemoriesQuerySchema,
  memoryCreateSchema,
  memoryIdSchema,
  memoryPatchSchema,
  preferencesUpdateSchema,
  profileFieldUpdateSchema,
  profileUpdateSchema,
} from './workspace-schemas';
import {
  memoryOut,
  preferencesOut,
  profileFieldOut,
  profileOut,
} from './workspace-serializers';
import { workspaceImportSchema } from './workspace-import-schemas';
import { importWorkspace } from '../services/workspace-import';

export type WorkspaceRouteDeps = { db: AppDatabase };

const INSTANCE_ID = 1;

function pathParam(params: unknown, name: string): string {
  return String((params as Record<string, unknown>)[name]);
}

function parseMemoryCursor(cursor: string): MemoryCursor {
  try {
    const [updatedRaw, idRaw] = decodeCursor(cursor, 2);
    return { updatedAt: parseDbTimestampCursor(updatedRaw), idHex: toDbUuid(idRaw) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid('分页游标无效。');
  }
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  deps: WorkspaceRouteDeps,
): void {
  const { db } = deps;

  app.get('/api/preferences', async () => {
    return preferencesOut(getOrCreatePreferences(db, INSTANCE_ID));
  });

  app.put('/api/preferences', async (request) => {
    const payload = preferencesUpdateSchema.parse(request.body);
    const row = db.transaction(() => {
      const current = getOrCreatePreferences(db, INSTANCE_ID);
      if (current.revision !== payload.baseRevision) {
        throw conflict('设置已在其他设备更新，请刷新后重试。', preferencesOut(current));
      }
      return updatePreferences(db, INSTANCE_ID, payload.baseRevision, payload.themeId, payload.mode);
    });
    return preferencesOut(row);
  });

  app.get('/api/profile', async () => {
    return profileOut(getOrCreateProfile(db, INSTANCE_ID));
  });

  app.put('/api/profile', async (request) => {
    const payload = profileUpdateSchema.parse(request.body);
    const row = db.transaction(() => {
      const current = getOrCreateProfile(db, INSTANCE_ID);
      if (current.revision !== payload.baseRevision) {
        throw conflict('个性化设置已在其他设备更新，请刷新后重试。', profileOut(current));
      }
      return updateProfile(db, INSTANCE_ID, payload.baseRevision, payload);
    });
    return profileOut(row);
  });

  app.get('/api/profile/fields', async () => {
    return { items: listProfileFields(db, INSTANCE_ID).map(profileFieldOut) };
  });

  app.get('/api/profile/fields/:key', async (request) => {
    const key = validateFieldKey(pathParam(request.params, 'key'));
    return profileFieldOut(requireProfileField(db, INSTANCE_ID, key));
  });

  app.put('/api/profile/fields/:key', async (request) => {
    const key = validateFieldKey(pathParam(request.params, 'key'));
    const payload = profileFieldUpdateSchema.parse(request.body);
    const row = db.transaction(() => {
      const current = getProfileField(db, INSTANCE_ID, key);
      if (current && payload.baseRevision !== undefined && payload.baseRevision !== null
        && current.revision !== payload.baseRevision) {
        throw conflict('字段已在其他设备更新，请刷新后重试。', profileFieldOut(current));
      }
      return upsertProfileField(db, INSTANCE_ID, key, payload);
    });
    return profileFieldOut(row);
  });

  app.delete('/api/profile/fields/:key', async (request) => {
    const key = validateFieldKey(pathParam(request.params, 'key'));
    const query = deleteProfileFieldQuerySchema.parse(request.query);
    db.transaction(() => {
      const current = requireProfileField(db, INSTANCE_ID, key);
      if (query.baseRevision !== undefined && query.baseRevision !== null
        && current.revision !== query.baseRevision) {
        throw conflict('字段已在其他设备更新，请刷新后重试。', profileFieldOut(current));
      }
      deleteProfileField(db, INSTANCE_ID, key, query.baseRevision);
    });
    return { ok: true };
  });

  app.get('/api/memories', async (request) => {
    const query = listMemoriesQuerySchema.parse(request.query);
    const pageSize = clampPageSize(query.limit);
    const cursor = query.cursor ? parseMemoryCursor(query.cursor) : undefined;
    const rows = listMemoryRows(
      db,
      INSTANCE_ID,
      pageSize,
      { status: query.status, scope: query.scope },
      cursor,
    );
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    const last = page[page.length - 1];
    return {
      items: page.map(memoryOut),
      nextCursor: hasMore && last
        ? encodeCursor(formatDbTimestampCursor(last.updated_at), fromDbUuid(last.id))
        : null,
    };
  });

  app.post('/api/memories', async (request, reply) => {
    const payload = memoryCreateSchema.parse(request.body);
    const clientId = payload.clientId?.trim() || null;
    if (clientId && !/^[^\s\x00-\x1f\x7f]{1,128}$/u.test(clientId)) {
      throw invalid('clientId 必须是 1–128 个不含空白或控制字符的字符。');
    }
    const row = db.transaction(() => createMemory(db, INSTANCE_ID, { ...payload, clientId }));
    reply.code(201);
    return memoryOut(row);
  });

  app.patch('/api/memories/:memoryId', async (request) => {
    const memoryId = memoryIdSchema.parse(pathParam(request.params, 'memoryId'));
    const payload = memoryPatchSchema.parse(request.body);
    const row = db.transaction(() => {
      const current = getMemoryRow(db, INSTANCE_ID, memoryId);
      if (!current) throw notFound('记忆不存在。');
      if (current.revision !== payload.baseRevision) {
        throw conflict('记忆已在其他设备更新，请刷新后重试。', memoryOut(current));
      }
      const patch: {
        scope?: string;
        type?: string;
        status?: string;
        content?: string;
        source?: string;
        updatedAt?: number | null;
      } = {};
      if (payload.scope !== null && payload.scope !== undefined) patch.scope = payload.scope;
      if (payload.type !== null && payload.type !== undefined) patch.type = payload.type;
      if (payload.status !== null && payload.status !== undefined) patch.status = payload.status;
      if (payload.content !== null && payload.content !== undefined) patch.content = payload.content;
      if (payload.source !== null && payload.source !== undefined) patch.source = payload.source;
      if (Object.hasOwn(payload, 'updatedAt')) patch.updatedAt = payload.updatedAt ?? null;
      return updateMemory(db, INSTANCE_ID, memoryId, payload.baseRevision, patch);
    });
    return memoryOut(row);
  });

  app.delete('/api/memories/:memoryId', async (request) => {
    const memoryId = memoryIdSchema.parse(pathParam(request.params, 'memoryId'));
    const query = deleteMemoryQuerySchema.parse(request.query);
    const row = db.transaction(() => {
      const current = getMemoryRow(db, INSTANCE_ID, memoryId);
      if (!current) throw notFound('记忆不存在。');
      if (current.revision !== query.baseRevision) {
        throw conflict('记忆已在其他设备更新，请刷新后重试。', memoryOut(current));
      }
      return archiveMemory(db, INSTANCE_ID, memoryId, query.baseRevision);
    });
    return memoryOut(row);
  });

  app.post('/api/workspace/import', {
    bodyLimit: 8 * 1024 * 1024,
  }, async (request) => {
    const payload = workspaceImportSchema.parse(request.body);
    return importWorkspace(db, INSTANCE_ID, payload);
  });

  app.get('/api/workspace/conversation-deletions', async (request) => {
    const query = listConversationDeletionsQuerySchema.parse(request.query);
    const pageSize = clampPageSize(query.limit);
    const cursor = query.cursor ? decodeCursor(query.cursor, 1)[0] : undefined;
    const rows = listConversationDeletionIds(db, INSTANCE_ID, pageSize, cursor);
    const hasMore = rows.length > pageSize;
    const items = rows.slice(0, pageSize);
    return {
      items,
      nextCursor: hasMore && items.length ? encodeCursor(items[items.length - 1]) : null,
    };
  });
}
