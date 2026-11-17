import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';

import type {
  StoredProcessActivity,
  StoredWebActivity,
} from '../../../contract/agent-protocol';
import { conflict, invalid, notFound } from '../../errors';
import {
  fromDbJson,
  fromDbUuid,
  toDbBool,
  toDbJson,
  toDbTimestamp,
  toDbUuid,
} from '../codecs';
import type { AppDatabase } from '../client';
import { validateClientId } from '../validation';

export type ConversationRow = {
  id: string;
  instance_id: number;
  client_id: string | null;
  title: string;
  pinned: number;
  model_id: string | null;
  title_source: string | null;
  context_summary: string | null;
  client_updated_at_ms: number | null;
  completed_state: string;
  completed_read_at_ms: number | null;
  error_state: string;
  error_read_at_ms: number | null;
  updated_at: string;
  revision: number;
  created_at: string;
};

export type MessageRow = {
  id: string;
  instance_id: number;
  conversation_id: string;
  client_id: string | null;
  position: number;
  role: string;
  content: string;
  steering: number;
  quote: string | null;
  feedback: string | null;
  reasoning: string | null;
  activities: string | null;
  process: string | null;
  thinking_ms: number | null;
  status: string;
  error: string | null;
  file_ids: string;
  created_at: string;
  updated_at: string;
  revision: number;
};

export type StoredFileRow = {
  id: string;
  instance_id: number;
  client_id: string | null;
  conversation_id: string | null;
  filename: string;
  object_key: string;
  content_type: string;
  size: number;
  sha256: string;
  status: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type ContextSummary = { coveredUntilMessageId: string; summary: string };

export type ConversationCreateInput = {
  id?: string | null;
  clientId?: string | null;
  title: string;
  pinned: boolean;
  modelId?: string | null;
  titleSource?: 'auto' | 'ai' | 'manual' | null;
  contextSummary?: ContextSummary | null;
  updatedAt?: number | null;
};

export type ConversationPatch = {
  title?: string;
  pinned?: boolean;
  modelId?: string | null;
  titleSource?: 'auto' | 'ai' | 'manual' | null;
  contextSummary?: ContextSummary | null;
  completedState?: string;
  completedReadAtMs?: number | null;
  errorState?: string;
  errorReadAtMs?: number | null;
};

export type MessageCreateInput = {
  id?: string | null;
  clientId?: string | null;
  role: 'user' | 'assistant';
  content: string;
  steering: boolean;
  quote?: string | null;
  feedback?: 'good' | 'bad' | null;
  reasoning?: string | null;
  activities?: StoredWebActivity[] | null;
  process?: StoredProcessActivity[] | null;
  thinkingMs?: number | null;
  status: 'complete' | 'stopped' | 'error';
  error?: string | null;
  fileIds: string[];
};

export type MessagePatch = {
  content?: string;
  quote?: string | null;
  reasoning?: string | null;
  thinkingMs?: number | null;
  status?: 'complete' | 'stopped' | 'error';
  error?: string | null;
  feedback?: 'good' | 'bad' | null;
  activities?: StoredWebActivity[] | null;
  process?: StoredProcessActivity[] | null;
  fileIds?: string[];
};

export type ConversationCursor = { pinned: number; updatedAt: string; idHex: string };

function conversationIdHex(id: string): string {
  return toDbUuid(id);
}

export function getConversationRow(
  db: AppDatabase,
  instanceId: number,
  id: string,
): ConversationRow | undefined {
  return db
    .prepare('SELECT * FROM conversations WHERE id = ? AND instance_id = ?')
    .get(conversationIdHex(id), instanceId) as ConversationRow | undefined;
}

export function getConversationRowAnyInstance(
  db: AppDatabase,
  id: string,
): ConversationRow | undefined {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationIdHex(id)) as
    | ConversationRow
    | undefined;
}

export function findConversationByIdOrClient(
  db: AppDatabase,
  instanceId: number,
  id: string | null | undefined,
  clientId: string | null | undefined,
): ConversationRow | undefined {
  if (id) {
    const row = getConversationRowAnyInstance(db, id);
    if (row) {
      if (row.instance_id !== instanceId) throw conflict('该标识已被占用。');
      return row;
    }
  }
  if (clientId) {
    return db
      .prepare('SELECT * FROM conversations WHERE instance_id = ? AND client_id = ?')
      .get(instanceId, clientId) as ConversationRow | undefined;
  }
  return undefined;
}

export function isConversationDeleted(
  db: AppDatabase,
  instanceId: number,
  clientId: string | null | undefined,
): boolean {
  if (!clientId) return false;
  return Boolean(
    db
      .prepare('SELECT 1 AS found FROM conversation_deletions WHERE instance_id = ? AND client_id = ?')
      .get(instanceId, clientId),
  );
}

export function recordConversationDeletion(
  db: AppDatabase,
  instanceId: number,
  clientId: string,
): void {
  db.prepare('INSERT OR IGNORE INTO conversation_deletions (instance_id, client_id) VALUES (?, ?)')
    .run(instanceId, clientId);
}

export function insertConversation(
  db: AppDatabase,
  instanceId: number,
  payload: ConversationCreateInput,
): ConversationRow {
  const id = payload.id ? conversationIdHex(payload.id) : conversationIdHex(randomUUID());
  const clientId = validateClientId(payload.clientId);
  const now = toDbTimestamp();
  db.prepare(
    `INSERT INTO conversations (
      id, instance_id, client_id, title, pinned, model_id, title_source, context_summary,
      client_updated_at_ms, completed_state, completed_read_at_ms, error_state, error_read_at_ms,
      updated_at, revision, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'absent', NULL, 'absent', NULL, ?, 1, ?)`,
  ).run(
    id,
    instanceId,
    clientId,
    payload.title,
    toDbBool(payload.pinned),
    payload.modelId ?? null,
    payload.titleSource ?? null,
    toDbJson(payload.contextSummary ?? null),
    payload.updatedAt ?? null,
    now,
    now,
  );
  const row = getConversationRow(db, instanceId, fromDbUuid(id));
  if (!row) throw new Error('Failed to load the conversation after insert.');
  return row;
}

export function listConversationRows(
  db: AppDatabase,
  instanceId: number,
  limit: number,
  cursor?: ConversationCursor,
): ConversationRow[] {
  let sql = 'SELECT * FROM conversations WHERE instance_id = ?';
  const params: SQLInputValue[] = [instanceId];
  if (cursor) {
    sql += ` AND (
      pinned < ? OR
      (pinned = ? AND (
        updated_at < ? OR
        (updated_at = ? AND id < ?)
      ))
    )`;
    params.push(cursor.pinned, cursor.pinned, cursor.updatedAt, cursor.updatedAt, cursor.idHex);
  }
  sql += ' ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ?';
  params.push(limit + 1);
  return db.prepare(sql).all(...params) as ConversationRow[];
}

export function applyConversationPatch(
  db: AppDatabase,
  instanceId: number,
  id: string,
  patch: ConversationPatch,
): ConversationRow {
  const sets: string[] = [];
  const values: SQLInputValue[] = [];
  const set = (sql: string, value: SQLInputValue) => {
    sets.push(sql);
    values.push(value);
  };

  if (patch.title !== undefined) set('title = ?', patch.title);
  if (patch.pinned !== undefined) set('pinned = ?', toDbBool(patch.pinned));
  if (patch.modelId !== undefined) set('model_id = ?', patch.modelId);
  if (patch.titleSource !== undefined) set('title_source = ?', patch.titleSource);
  if (patch.contextSummary !== undefined) set('context_summary = ?', toDbJson(patch.contextSummary));
  if (patch.completedState !== undefined) {
    set('completed_state = ?', patch.completedState);
    set('completed_read_at_ms = ?', patch.completedReadAtMs ?? null);
  }
  if (patch.errorState !== undefined) {
    set('error_state = ?', patch.errorState);
    set('error_read_at_ms = ?', patch.errorReadAtMs ?? null);
  }

  if (sets.length) {
    sets.push('revision = revision + 1');
    values.push(conversationIdHex(id), instanceId);
    db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ? AND instance_id = ?`).run(
      ...values,
    );
  }

  const row = getConversationRow(db, instanceId, id);
  if (!row) throw notFound('对话不存在。');
  return row;
}

export function deleteConversationRow(
  db: AppDatabase,
  instanceId: number,
  id: string,
): void {
  db.prepare('DELETE FROM conversations WHERE id = ? AND instance_id = ?').run(
    conversationIdHex(id),
    instanceId,
  );
}

export function findMessageByIdOrClient(
  db: AppDatabase,
  instanceId: number,
  id: string | null | undefined,
  clientId: string | null | undefined,
): MessageRow | undefined {
  if (id) {
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(conversationIdHex(id)) as
      | MessageRow
      | undefined;
    if (row) {
      if (row.instance_id !== instanceId) throw conflict('该标识已被占用。');
      return row;
    }
  }
  if (clientId) {
    return db
      .prepare('SELECT * FROM messages WHERE instance_id = ? AND client_id = ?')
      .get(instanceId, clientId) as MessageRow | undefined;
  }
  return undefined;
}

export function getMessageRow(
  db: AppDatabase,
  instanceId: number,
  id: string,
): MessageRow | undefined {
  return db
    .prepare('SELECT * FROM messages WHERE id = ? AND instance_id = ?')
    .get(conversationIdHex(id), instanceId) as MessageRow | undefined;
}

export function listMessageRows(
  db: AppDatabase,
  conversationId: string,
  limit: number,
  before?: number,
): MessageRow[] {
  let sql = 'SELECT * FROM messages WHERE conversation_id = ?';
  const params: SQLInputValue[] = [conversationIdHex(conversationId)];
  if (before !== undefined) {
    sql += ' AND position < ?';
    params.push(before);
  }
  sql += ' ORDER BY position DESC LIMIT ?';
  params.push(limit + 1);
  return db.prepare(sql).all(...params) as MessageRow[];
}

export function nextMessagePosition(db: AppDatabase, conversationId: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(position), 0) + 1 AS position FROM messages WHERE conversation_id = ?')
    .get(conversationIdHex(conversationId)) as { position: number };
  return Number(row.position);
}

export function loadFilesByIds(
  db: AppDatabase,
  instanceId: number,
  fileIds: string[],
): Map<string, StoredFileRow> {
  const unique = [...new Set(fileIds)].filter(
    (id) => /^[0-9a-f]{32}$/iu.test(id) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id),
  );
  if (!unique.length) return new Map();
  const placeholders = unique.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT * FROM files WHERE instance_id = ? AND id IN (${placeholders})`)
    .all(instanceId, ...unique.map((id) => conversationIdHex(id))) as StoredFileRow[];
  return new Map(rows.map((row) => [fromDbUuid(row.id), row]));
}

/**
 * Bind files to the conversation, preserving the order the message declared.
 * A file that already belongs to another conversation is a 422, never silently
 * moved.
 */
export function attachFiles(
  db: AppDatabase,
  instanceId: number,
  conversationId: string,
  fileIds: string[],
): StoredFileRow[] {
  const unique = [...new Set(fileIds)];
  if (!unique.length) return [];
  const files = loadFilesByIds(db, instanceId, unique);
  if (files.size !== unique.length) throw invalid('文件不存在或不属于当前用户。');
  const ordered = unique.map((id) => files.get(id)).filter((row): row is StoredFileRow => Boolean(row));
  for (const file of ordered) {
    if (file.conversation_id === null) {
      db.prepare('UPDATE files SET conversation_id = ? WHERE id = ?').run(
        conversationIdHex(conversationId),
        file.id,
      );
      file.conversation_id = conversationIdHex(conversationId);
    } else if (file.conversation_id !== conversationIdHex(conversationId)) {
      throw invalid('文件属于其他对话。');
    }
  }
  return ordered;
}

export function insertMessage(
  db: AppDatabase,
  instanceId: number,
  conversationId: string,
  payload: MessageCreateInput,
): MessageRow {
  const id = payload.id ? conversationIdHex(payload.id) : conversationIdHex(randomUUID());
  const clientId = validateClientId(payload.clientId);
  const now = toDbTimestamp();
  const position = nextMessagePosition(db, conversationId);
  db.prepare(
    `INSERT INTO messages (
      id, instance_id, conversation_id, client_id, position, role, content, steering, quote,
      feedback, reasoning, activities, process, thinking_ms, status, error, file_ids, created_at,
      updated_at, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    id,
    instanceId,
    conversationIdHex(conversationId),
    clientId,
    position,
    payload.role,
    payload.content,
    toDbBool(payload.steering && payload.role === 'user'),
    payload.quote ?? null,
    payload.feedback ?? null,
    payload.reasoning ?? null,
    toDbJson(payload.activities ?? null),
    toDbJson(payload.process ?? null),
    payload.thinkingMs ?? null,
    payload.role === 'user' ? 'complete' : payload.status,
    payload.error ?? null,
    toDbJson(payload.fileIds),
    now,
    now,
  );
  const row = getMessageRow(db, instanceId, fromDbUuid(id));
  if (!row) throw new Error('Failed to load the message after insert.');
  return row;
}

export function setConversationAfterAppend(
  db: AppDatabase,
  instanceId: number,
  conversationId: string,
  role: 'user' | 'assistant',
  status: string,
): void {
  const now = toDbTimestamp();
  if (role === 'assistant' && status === 'error') {
    db.prepare(
      `UPDATE conversations SET updated_at = ?, error_state = 'unread', error_read_at_ms = NULL
       WHERE id = ? AND instance_id = ?`,
    ).run(now, conversationIdHex(conversationId), instanceId);
    return;
  }
  if (role === 'assistant') {
    db.prepare(
      `UPDATE conversations SET updated_at = ?, completed_state = 'unread', completed_read_at_ms = NULL
       WHERE id = ? AND instance_id = ?`,
    ).run(now, conversationIdHex(conversationId), instanceId);
    return;
  }
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ? AND instance_id = ?').run(
    now,
    conversationIdHex(conversationId),
    instanceId,
  );
}

export function applyMessagePatch(
  db: AppDatabase,
  instanceId: number,
  id: string,
  patch: MessagePatch,
): MessageRow {
  const sets: string[] = [];
  const values: SQLInputValue[] = [];
  const set = (sql: string, value: SQLInputValue) => {
    sets.push(sql);
    values.push(value);
  };

  if (patch.content !== undefined) set('content = ?', patch.content);
  if (patch.quote !== undefined) set('quote = ?', patch.quote);
  if (patch.reasoning !== undefined) set('reasoning = ?', patch.reasoning);
  if (patch.thinkingMs !== undefined) set('thinking_ms = ?', patch.thinkingMs);
  if (patch.status !== undefined) set('status = ?', patch.status);
  if (patch.error !== undefined) set('error = ?', patch.error);
  if (patch.feedback !== undefined) set('feedback = ?', patch.feedback);
  if (patch.activities !== undefined) set('activities = ?', toDbJson(patch.activities));
  if (patch.process !== undefined) set('process = ?', toDbJson(patch.process));
  if (patch.fileIds !== undefined) set('file_ids = ?', toDbJson(patch.fileIds));

  if (sets.length) {
    sets.push('revision = revision + 1', 'updated_at = ?');
    values.push(toDbTimestamp());
    values.push(conversationIdHex(id), instanceId);
    db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ? AND instance_id = ?`).run(
      ...values,
    );
  }

  const row = getMessageRow(db, instanceId, id);
  if (!row) throw notFound('消息不存在。');
  return row;
}

export function deleteMessageRow(db: AppDatabase, instanceId: number, id: string): void {
  db.prepare('DELETE FROM messages WHERE id = ? AND instance_id = ?').run(
    conversationIdHex(id),
    instanceId,
  );
}

export function messageFileIds(row: MessageRow): string[] {
  return fromDbJson<string[]>(row.file_ids) ?? [];
}

export function messageActivities(row: MessageRow): StoredWebActivity[] | null {
  return fromDbJson<StoredWebActivity[]>(row.activities);
}

export function messageProcess(row: MessageRow): StoredProcessActivity[] | null {
  return fromDbJson<StoredProcessActivity[]>(row.process);
}
