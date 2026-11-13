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
  applyConversationPatch,
  applyMessagePatch,
  attachFiles,
  deleteConversationRow,
  deleteMessageRow,
  findConversationByIdOrClient,
  findMessageByIdOrClient,
  getConversationRow,
  getMessageRow,
  insertConversation,
  insertMessage,
  isConversationDeleted,
  listConversationRows,
  listMessageRows,
  loadFilesByIds,
  messageFileIds,
  recordConversationDeletion,
  setConversationAfterAppend,
  type ConversationCursor,
  type ConversationPatch,
  type MessagePatch,
  type StoredFileRow,
} from '../db/repositories/conversations';
import { clampPageSize, parsePositiveInt, validateClientId } from '../db/validation';
import { AppError, conflict, invalid, notFound } from '../errors';
import { conversationOut, messageOut } from './conversation-serializers';
import {
  conversationCreateSchema,
  conversationIdSchema,
  conversationPatchSchema,
  deleteConversationQuerySchema,
  deleteMessageQuerySchema,
  getConversationQuerySchema,
  listConversationsQuerySchema,
  messageCreateSchema,
  messageIdSchema,
  messagePatchSchema,
  normalizeActivities,
  normalizeProcess,
} from './conversation-schemas';

export type ConversationRouteDeps = { db: AppDatabase };

const INSTANCE_ID = 1;

function pathParam(params: unknown, name: string): string {
  return String((params as Record<string, unknown>)[name]);
}

function parseConversationCursor(cursor: string): ConversationCursor {
  try {
    const [pinnedRaw, updatedRaw, idRaw] = decodeCursor(cursor, 3);
    if (pinnedRaw !== '0' && pinnedRaw !== '1') throw invalid('分页游标无效。');
    return {
      pinned: pinnedRaw === '1' ? 1 : 0,
      updatedAt: parseDbTimestampCursor(updatedRaw),
      idHex: toDbUuid(idRaw),
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid('分页游标无效。');
  }
}

function nextConversationCursor(row: { pinned: number; updated_at: string; id: string }): string {
  return encodeCursor(
    row.pinned ? '1' : '0',
    formatDbTimestampCursor(row.updated_at),
    fromDbUuid(row.id),
  );
}

function parseMessageCursor(cursor: string): number {
  return parsePositiveInt(decodeCursor(cursor, 1)[0]);
}

export function registerConversationRoutes(
  app: FastifyInstance,
  deps: ConversationRouteDeps,
): void {
  const { db } = deps;

  app.get('/api/conversations', async (request) => {
    const query = listConversationsQuerySchema.parse(request.query);
    const pageSize = clampPageSize(query.limit);
    const cursor = query.cursor ? parseConversationCursor(query.cursor) : undefined;
    const rows = listConversationRows(db, INSTANCE_ID, pageSize, cursor);
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    return {
      items: page.map(conversationOut),
      nextCursor: hasMore && page.length ? nextConversationCursor(page[page.length - 1]) : null,
    };
  });

  app.post('/api/conversations', async (request, reply) => {
    const payload = conversationCreateSchema.parse(request.body);
    const clientId = validateClientId(payload.clientId);
    try {
      const row = db.transaction(() => {
        for (const identity of [clientId, payload.id]) {
          if (identity && isConversationDeleted(db, INSTANCE_ID, identity)) {
            throw conflict('对话已删除，请创建新的对话。');
          }
        }
        const existing = findConversationByIdOrClient(db, INSTANCE_ID, payload.id, clientId);
        if (existing) return existing;
        return insertConversation(db, INSTANCE_ID, { ...payload, clientId });
      });
      reply.code(201);
      return conversationOut(row);
    } catch (error) {
      if (error instanceof AppError) throw error;
      const existing = findConversationByIdOrClient(db, INSTANCE_ID, payload.id, clientId);
      if (existing) return conversationOut(existing);
      throw conflict('对话已存在，请刷新后重试。');
    }
  });

  app.get('/api/conversations/:conversationId', async (request) => {
    const conversationId = conversationIdSchema.parse(pathParam(request.params, 'conversationId'));
    const query = getConversationQuerySchema.parse(request.query);
    const pageSize = clampPageSize(query.messageLimit);
    const conversation = getConversationRow(db, INSTANCE_ID, conversationId);
    if (!conversation) throw notFound('对话不存在。');

    const before = query.before ? parseMessageCursor(query.before) : undefined;
    const rows = listMessageRows(db, conversationId, pageSize, before);
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    page.reverse();
    const filesById = loadFilesByIds(
      db,
      INSTANCE_ID,
      page.flatMap((row) => messageFileIds(row)),
    );
    return {
      conversation: conversationOut(conversation),
      messages: page.map((row) => messageOut(row, filesById)),
      nextCursor: hasMore && page.length ? encodeCursor(String(page[0].position)) : null,
    };
  });

  app.patch('/api/conversations/:conversationId', async (request) => {
    const conversationId = conversationIdSchema.parse(pathParam(request.params, 'conversationId'));
    const payload = conversationPatchSchema.parse(request.body);

    const row = db.transaction(() => {
      const current = getConversationRow(db, INSTANCE_ID, conversationId);
      if (!current) throw notFound('对话不存在。');
      if (current.revision !== payload.baseRevision) {
        throw conflict('对话已在其他设备更新，请刷新后重试。', conversationOut(current));
      }

      const patch: ConversationPatch = {};
      if (payload.title !== undefined && payload.title !== null) patch.title = payload.title;
      if (payload.pinned !== undefined && payload.pinned !== null) patch.pinned = payload.pinned;
      if (Object.hasOwn(payload, 'modelId')) patch.modelId = payload.modelId ?? null;
      if (Object.hasOwn(payload, 'titleSource')) patch.titleSource = payload.titleSource ?? null;
      if (Object.hasOwn(payload, 'contextSummary')) patch.contextSummary = payload.contextSummary ?? null;

      if (payload.readState) {
        for (const name of ['completed', 'error'] as const) {
          const marker = payload.readState[name];
          if (!marker) continue;
          const readAt = marker.state === 'read' ? marker.readAt ?? Date.now() : null;
          if (name === 'completed') {
            patch.completedState = marker.state;
            patch.completedReadAtMs = readAt;
          } else {
            patch.errorState = marker.state;
            patch.errorReadAtMs = readAt;
          }
        }
      }

      return applyConversationPatch(db, INSTANCE_ID, conversationId, patch);
    });
    return conversationOut(row);
  });

  app.delete('/api/conversations/:conversationId', async (request) => {
    const conversationId = conversationIdSchema.parse(pathParam(request.params, 'conversationId'));
    const query = deleteConversationQuerySchema.parse(request.query);
    db.transaction(() => {
      const current = getConversationRow(db, INSTANCE_ID, conversationId);
      if (!current) throw notFound('对话不存在。');
      if (current.revision !== query.baseRevision) {
        throw conflict('对话已在其他设备更新，请刷新后重试。', conversationOut(current));
      }
      recordConversationDeletion(db, INSTANCE_ID, fromDbUuid(current.id));
      if (current.client_id) recordConversationDeletion(db, INSTANCE_ID, current.client_id);
      deleteConversationRow(db, INSTANCE_ID, conversationId);
    });
    return { ok: true };
  });

  app.post('/api/conversations/:conversationId/messages', async (request, reply) => {
    const conversationId = conversationIdSchema.parse(pathParam(request.params, 'conversationId'));
    const payload = messageCreateSchema.parse(request.body);
    const clientId = validateClientId(payload.clientId);

    try {
      const result = db.transaction(() => {
        const existing = findMessageByIdOrClient(db, INSTANCE_ID, payload.id, clientId);
        if (existing) {
          if (existing.conversation_id !== toDbUuid(conversationId)) {
            throw conflict('消息标识已被其他对话使用。');
          }
          return {
            row: existing,
            files: loadFilesByIds(db, INSTANCE_ID, messageFileIds(existing)),
          };
        }

        const conversation = getConversationRow(db, INSTANCE_ID, conversationId);
        if (!conversation) throw notFound('对话不存在。');

        const storedFiles = attachFiles(db, INSTANCE_ID, conversationId, payload.fileIds);
        const row = insertMessage(db, INSTANCE_ID, conversationId, {
          ...payload,
          clientId,
          fileIds: storedFiles.map((file) => fromDbUuid(file.id)),
          activities: normalizeActivities(payload.activities),
          process: normalizeProcess(payload.process),
        });
        setConversationAfterAppend(db, INSTANCE_ID, conversationId, payload.role, row.status);
        return {
          row,
          files: new Map(storedFiles.map((file) => [fromDbUuid(file.id), file])),
        };
      });
      reply.code(201);
      return messageOut(result.row, result.files);
    } catch (error) {
      if (error instanceof AppError) throw error;
      const existing = findMessageByIdOrClient(db, INSTANCE_ID, payload.id, clientId);
      if (existing) {
        return messageOut(existing, loadFilesByIds(db, INSTANCE_ID, messageFileIds(existing)));
      }
      throw conflict('消息写入冲突，请重试。');
    }
  });

  app.patch('/api/messages/:messageId', async (request) => {
    const messageId = messageIdSchema.parse(pathParam(request.params, 'messageId'));
    const payload = messagePatchSchema.parse(request.body);

    const result = db.transaction(() => {
      const current = getMessageRow(db, INSTANCE_ID, messageId);
      if (!current) throw notFound('消息不存在。');
      if (current.revision !== payload.baseRevision) {
        throw conflict(
          '消息已在其他设备更新，请刷新后重试。',
          messageOut(current, loadFilesByIds(db, INSTANCE_ID, messageFileIds(current))),
        );
      }

      const patch: MessagePatch = {};
      if (Object.hasOwn(payload, 'content')) {
        if (payload.content === null || payload.content === undefined) {
          throw invalid('消息正文和状态不能为空。');
        }
        patch.content = payload.content;
      }
      if (Object.hasOwn(payload, 'status')) {
        if (payload.status === null || payload.status === undefined) {
          throw invalid('消息正文和状态不能为空。');
        }
        if (current.role === 'user' && payload.status !== 'complete') {
          throw invalid('用户消息状态必须为 complete。');
        }
        patch.status = payload.status;
      }
      if (Object.hasOwn(payload, 'quote')) patch.quote = payload.quote ?? null;
      if (Object.hasOwn(payload, 'reasoning')) patch.reasoning = payload.reasoning ?? null;
      if (Object.hasOwn(payload, 'thinkingMs')) patch.thinkingMs = payload.thinkingMs ?? null;
      if (Object.hasOwn(payload, 'error')) patch.error = payload.error ?? null;
      if (Object.hasOwn(payload, 'feedback')) patch.feedback = payload.feedback ?? null;
      if (Object.hasOwn(payload, 'activities')) {
        patch.activities = normalizeActivities(payload.activities);
      }
      if (Object.hasOwn(payload, 'process')) {
        patch.process = normalizeProcess(payload.process);
      }

      let attached = new Map<string, StoredFileRow>();
      if (Object.hasOwn(payload, 'fileIds')) {
        const files = attachFiles(db, INSTANCE_ID, current.conversation_id, payload.fileIds ?? []);
        patch.fileIds = files.map((file) => fromDbUuid(file.id));
        attached = new Map(files.map((file) => [fromDbUuid(file.id), file]));
      }

      const row = applyMessagePatch(db, INSTANCE_ID, messageId, patch);
      const files = attached.size
        ? attached
        : loadFilesByIds(db, INSTANCE_ID, messageFileIds(row));
      return { row, files };
    });
    return messageOut(result.row, result.files);
  });

  app.delete('/api/messages/:messageId', async (request) => {
    const messageId = messageIdSchema.parse(pathParam(request.params, 'messageId'));
    const query = deleteMessageQuerySchema.parse(request.query);
    db.transaction(() => {
      const current = getMessageRow(db, INSTANCE_ID, messageId);
      if (!current) throw notFound('消息不存在。');
      if (current.revision !== query.baseRevision) {
        throw conflict(
          '消息已在其他设备更新，请刷新后重试。',
          messageOut(current, loadFilesByIds(db, INSTANCE_ID, messageFileIds(current))),
        );
      }
      deleteMessageRow(db, INSTANCE_ID, messageId);
    });
    return { ok: true };
  });
}
