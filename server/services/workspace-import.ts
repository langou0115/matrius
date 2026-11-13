import { randomUUID } from 'node:crypto';

import type { AppDatabase } from '../db/client';
import {
  fromDbUuid,
  toDbJson,
  toDbTimestamp,
  toDbUuid,
} from '../db/codecs';
import {
  deleteConversationRow,
  findConversationByIdOrClient,
  insertConversation,
  insertMessage,
  isConversationDeleted,
  recordConversationDeletion,
} from '../db/repositories/conversations';
import { validateClientId } from '../db/validation';
import { invalid } from '../errors';
import {
  normalizeActivities,
  normalizeProcess,
} from '../routes/conversation-schemas';
import type {
  ImportConversation,
  ImportMessage,
  WorkspaceImportRequest,
} from '../routes/workspace-import-schemas';

const MAX_CONVERSATIONS = 20;
const MAX_MESSAGES = 2_000;

export type ImportResult = {
  imported: { conversations: number; messages: number };
  updated: number;
  skipped: number;
  failed: Array<{ clientId: string; reason: string }>;
};

type MessageValues = {
  content: string;
  steering: boolean;
  quote: string | null;
  feedback: 'good' | 'bad' | null;
  reasoning: string | null;
  activities: ReturnType<typeof normalizeActivities>;
  process: ReturnType<typeof normalizeProcess>;
  thinkingMs: number | null;
  status: 'complete' | 'stopped' | 'error';
  error: string | null;
  fileIds: string[];
};

function clientTime(ms: number | null | undefined): Date {
  if (!ms || ms <= 0) return new Date();
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return new Date();
  return date.getTime() > Date.now() ? new Date() : date;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function messageValues(message: ImportMessage): MessageValues {
  return {
    content: message.content,
    steering: message.steering && message.role === 'user',
    quote: message.quote ?? null,
    feedback: message.feedback ?? null,
    reasoning: message.reasoning ?? null,
    activities: normalizeActivities(message.activities),
    process: normalizeProcess(message.process),
    thinkingMs: message.thinkingMs ?? null,
    status: message.role === 'user' ? 'complete' : message.status,
    error: message.error ?? null,
    fileIds: uniqueStrings(message.fileIds),
  };
}

function normalizeMessageClientId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  try {
    return validateClientId(value);
  } catch {
    return null;
  }
}

function keepOwnedFiles(
  db: AppDatabase,
  instanceId: number,
  conversations: ImportConversation[],
): void {
  const requested = new Set<string>();
  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      for (const fileId of message.fileIds) requested.add(fileId);
    }
  }
  if (!requested.size) return;
  const ids = [...requested].map(toDbUuid);
  const placeholders = ids.map(() => '?').join(', ');
  const owned = new Set(
    (db.prepare(`SELECT id FROM files WHERE instance_id = ? AND id IN (${placeholders})`)
      .all(instanceId, ...ids) as Array<{ id: string }>).map((row) => fromDbUuid(row.id)),
  );
  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      message.fileIds = uniqueStrings(message.fileIds).filter((fileId) => owned.has(fileId));
    }
  }
}

function deleteConversations(
  db: AppDatabase,
  instanceId: number,
  rawIds: string[],
): void {
  for (const rawId of new Set(rawIds)) {
    const clientId = validateClientId(rawId);
    if (!clientId) continue;
    recordConversationDeletion(db, instanceId, clientId);
    let serverId: string | null = null;
    try {
      serverId = toDbUuid(clientId);
    } catch {
      // A non-UUID client id cannot name a server row.
    }
    const rows = db.prepare(
      `SELECT id, client_id FROM conversations
       WHERE instance_id = ? AND (client_id = ? OR id = ?)`,
    ).all(instanceId, clientId, serverId ?? '') as Array<{ id: string; client_id: string | null }>;
    for (const row of rows) {
      recordConversationDeletion(db, instanceId, fromDbUuid(row.id));
      if (row.client_id) recordConversationDeletion(db, instanceId, row.client_id);
      deleteConversationRow(db, instanceId, fromDbUuid(row.id));
    }
  }
}

function importSettings(
  db: AppDatabase,
  instanceId: number,
  payload: WorkspaceImportRequest,
): void {
  const now = toDbTimestamp();
  if (payload.appearance) {
    const current = db.prepare('SELECT theme_id, mode FROM preferences WHERE instance_id = ?')
      .get(instanceId) as { theme_id: string; mode: string } | undefined;
    if (!current) {
      db.prepare(
        `INSERT INTO preferences (id, instance_id, theme_id, mode, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        toDbUuid(randomUUID()),
        instanceId,
        payload.appearance.themeId,
        payload.appearance.mode,
        now,
        now,
      );
    } else if (current.theme_id !== payload.appearance.themeId || current.mode !== payload.appearance.mode) {
      db.prepare(
        `UPDATE preferences SET theme_id = ?, mode = ?, revision = revision + 1, updated_at = ?
         WHERE instance_id = ?`,
      ).run(payload.appearance.themeId, payload.appearance.mode, now, instanceId);
    }
  }

  if (payload.personalization) {
    const values = payload.personalization;
    const current = db.prepare(
      `SELECT custom_instructions, about_name, occupation, about_more
       FROM profiles WHERE instance_id = ?`,
    ).get(instanceId) as {
      custom_instructions: string;
      about_name: string;
      occupation: string;
      about_more: string;
    } | undefined;
    if (!current) {
      db.prepare(
        `INSERT INTO profiles (
          id, instance_id, custom_instructions, about_name, occupation, about_more,
          revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        toDbUuid(randomUUID()),
        instanceId,
        values.customInstructions,
        values.aboutName,
        values.occupation,
        values.aboutMore,
        now,
        now,
      );
    } else if (
      current.custom_instructions !== values.customInstructions
      || current.about_name !== values.aboutName
      || current.occupation !== values.occupation
      || current.about_more !== values.aboutMore
    ) {
      db.prepare(
        `UPDATE profiles SET custom_instructions = ?, about_name = ?, occupation = ?,
         about_more = ?, revision = revision + 1, updated_at = ? WHERE instance_id = ?`,
      ).run(
        values.customInstructions,
        values.aboutName,
        values.occupation,
        values.aboutMore,
        now,
        instanceId,
      );
    }
  }
}

function readAt(marker: { state: string; readAt?: number | null }): number | null {
  if (marker.readAt !== undefined && marker.readAt !== null) return marker.readAt;
  return marker.state === 'read' ? Date.now() : null;
}

function applyReadState(
  db: AppDatabase,
  instanceId: number,
  conversationId: string,
  readState: ImportConversation['readState'],
): boolean {
  if (!readState) return false;
  const row = db.prepare(
    `SELECT completed_state, completed_read_at_ms, error_state, error_read_at_ms
     FROM conversations WHERE id = ? AND instance_id = ?`,
  ).get(toDbUuid(conversationId), instanceId) as {
    completed_state: string;
    completed_read_at_ms: number | null;
    error_state: string;
    error_read_at_ms: number | null;
  };
  let changed = false;
  if (readState.completed) {
    const nextReadAt = readAt(readState.completed);
    if (row.completed_state !== readState.completed.state || row.completed_read_at_ms !== nextReadAt) {
      db.prepare(
        'UPDATE conversations SET completed_state = ?, completed_read_at_ms = ? WHERE id = ? AND instance_id = ?',
      ).run(readState.completed.state, nextReadAt, toDbUuid(conversationId), instanceId);
      changed = true;
    }
  }
  if (readState.error) {
    const nextReadAt = readAt(readState.error);
    if (row.error_state !== readState.error.state || row.error_read_at_ms !== nextReadAt) {
      db.prepare(
        'UPDATE conversations SET error_state = ?, error_read_at_ms = ? WHERE id = ? AND instance_id = ?',
      ).run(readState.error.state, nextReadAt, toDbUuid(conversationId), instanceId);
      changed = true;
    }
  }
  return changed;
}

function setConversationTimestamps(
  db: AppDatabase,
  instanceId: number,
  conversationId: string,
  updatedAt: number | null | undefined,
): void {
  db.prepare(
    'UPDATE conversations SET updated_at = ?, client_updated_at_ms = ? WHERE id = ? AND instance_id = ?',
  ).run(
    toDbTimestamp(clientTime(updatedAt)),
    updatedAt ?? null,
    toDbUuid(conversationId),
    instanceId,
  );
}

function createConversation(
  db: AppDatabase,
  instanceId: number,
  clientId: string,
  item: ImportConversation,
  messages: Array<{ message: ImportMessage; clientId: string | null }>,
): number {
  const row = insertConversation(db, instanceId, {
    clientId,
    title: item.title,
    pinned: item.pinned,
    modelId: item.modelId ?? null,
    titleSource: item.titleSource ?? null,
    contextSummary: item.contextSummary ?? null,
    updatedAt: item.updatedAt ?? null,
  });
  const conversationId = fromDbUuid(row.id);
  setConversationTimestamps(db, instanceId, conversationId, item.updatedAt);
  for (const { message, clientId: messageClientId } of messages) {
    const values = messageValues(message);
    insertMessage(db, instanceId, conversationId, {
      clientId: messageClientId,
      role: message.role,
      content: values.content,
      steering: values.steering,
      quote: values.quote,
      feedback: values.feedback,
      reasoning: values.reasoning,
      activities: values.activities,
      process: values.process,
      thinkingMs: values.thinkingMs,
      status: values.status,
      error: values.error,
      fileIds: values.fileIds,
    });
  }
  applyReadState(db, instanceId, conversationId, item.readState);
  return messages.length;
}

function messageMatches(row: Record<string, unknown>, values: MessageValues): boolean {
  return row.content === values.content
    && Number(row.steering) === Number(values.steering)
    && (row.quote ?? null) === values.quote
    && (row.feedback ?? null) === values.feedback
    && (row.reasoning ?? null) === values.reasoning
    && (row.activities ?? 'null') === toDbJson(values.activities)
    && (values.process === null || (row.process ?? 'null') === toDbJson(values.process))
    && (row.thinking_ms ?? null) === values.thinkingMs
    && row.status === values.status
    && (row.error ?? null) === values.error
    && (row.file_ids ?? 'null') === toDbJson(values.fileIds);
}

function mergeConversation(
  db: AppDatabase,
  instanceId: number,
  existingId: string,
  item: ImportConversation,
  messages: Array<{ message: ImportMessage; clientId: string | null }>,
): { added: number; changed: boolean } {
  const stored = db.prepare('SELECT * FROM messages WHERE conversation_id = ?')
    .all(toDbUuid(existingId)) as Array<Record<string, unknown>>;
  const byClient = new Map<string, Record<string, unknown>>();
  for (const row of stored) {
    if (typeof row.client_id === 'string') byClient.set(row.client_id, row);
  }
  let added = 0;
  let changed = false;
  for (const { message, clientId: messageClientId } of messages) {
    if (!messageClientId) continue;
    const values = messageValues(message);
    const found = byClient.get(messageClientId);
    if (found) {
      if (messageMatches(found, values)) continue;
      db.prepare(
        `UPDATE messages SET content = ?, steering = ?, quote = ?, feedback = ?, reasoning = ?,
         activities = ?, process = COALESCE(?, process), thinking_ms = ?, status = ?, error = ?,
         file_ids = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND instance_id = ?`,
      ).run(
        values.content,
        values.steering ? 1 : 0,
        values.quote,
        values.feedback,
        values.reasoning,
        toDbJson(values.activities),
        values.process === null ? null : toDbJson(values.process),
        values.thinkingMs,
        values.status,
        values.error,
        toDbJson(values.fileIds),
        toDbTimestamp(),
        String(found.id),
        instanceId,
      );
      changed = true;
      continue;
    }
    insertMessage(db, instanceId, existingId, {
      clientId: messageClientId,
      role: message.role,
      content: values.content,
      steering: values.steering,
      quote: values.quote,
      feedback: values.feedback,
      reasoning: values.reasoning,
      activities: values.activities,
      process: values.process,
      thinkingMs: values.thinkingMs,
      status: values.status,
      error: values.error,
      fileIds: values.fileIds,
    });
    added += 1;
    changed = true;
  }

  const row = db.prepare(
    `SELECT client_updated_at_ms, title, pinned, model_id, title_source, context_summary, revision
     FROM conversations WHERE id = ? AND instance_id = ?`,
  ).get(toDbUuid(existingId), instanceId) as {
    client_updated_at_ms: number | null;
    title: string;
    pinned: number;
    model_id: string | null;
    title_source: string | null;
    context_summary: string;
    revision: number;
  };

  if (item.readState && applyReadState(db, instanceId, existingId, item.readState)) changed = true;

  if (item.updatedAt !== null && item.updatedAt !== undefined
    && item.updatedAt >= (row.client_updated_at_ms ?? 0)) {
    const metadataChanged = row.title !== item.title
      || Boolean(row.pinned) !== item.pinned
      || row.model_id !== (item.modelId ?? null)
      || row.title_source !== (item.titleSource ?? null)
      || row.context_summary !== toDbJson(item.contextSummary ?? null);
    if (metadataChanged) {
      db.prepare(
        `UPDATE conversations SET title = ?, pinned = ?, model_id = ?, title_source = ?,
         context_summary = ?, client_updated_at_ms = ? WHERE id = ? AND instance_id = ?`,
      ).run(
        item.title,
        item.pinned ? 1 : 0,
        item.modelId ?? null,
        item.titleSource ?? null,
        toDbJson(item.contextSummary ?? null),
        item.updatedAt,
        toDbUuid(existingId),
        instanceId,
      );
      changed = true;
    }
  }

  if (changed) {
    db.prepare(
      'UPDATE conversations SET revision = revision + 1, updated_at = ? WHERE id = ? AND instance_id = ?',
    ).run(
      toDbTimestamp(clientTime(item.updatedAt)),
      toDbUuid(existingId),
      instanceId,
    );
  }
  return { added, changed };
}

/** Merge one browser workspace export into the single server instance. */
export function importWorkspace(
  db: AppDatabase,
  instanceId: number,
  payload: WorkspaceImportRequest,
): ImportResult {
  if (payload.schemaVersion !== 1) throw invalid('不支持的导入数据版本。');
  const conversations = payload.chat.conversations;
  if (conversations.length > MAX_CONVERSATIONS) {
    throw invalid(`单批最多导入 ${MAX_CONVERSATIONS} 个对话。`);
  }
  if (conversations.reduce((total, item) => total + item.messages.length, 0) > MAX_MESSAGES) {
    throw invalid(`单批最多导入 ${MAX_MESSAGES} 条消息。`);
  }

  return db.transaction(() => {
    keepOwnedFiles(db, instanceId, conversations);
    deleteConversations(db, instanceId, payload.chat.deletedConversationIds);
    importSettings(db, instanceId, payload);

    let importedConversations = 0;
    let importedMessages = 0;
    let updated = 0;
    let skipped = 0;
    const failed: ImportResult['failed'] = [];
    const seenMessageIds = new Set<string>();

    for (const item of conversations) {
      let clientId: string | null;
      try {
        clientId = validateClientId(item.id);
      } catch {
        failed.push({ clientId: item.id, reason: '对话标识不合法' });
        continue;
      }
      if (!clientId) continue;
      if (isConversationDeleted(db, instanceId, clientId)) {
        skipped += 1;
        continue;
      }

      const messages = item.messages.map((message) => {
        let messageClientId = normalizeMessageClientId(message.id);
        if (messageClientId) {
          if (seenMessageIds.has(messageClientId)) messageClientId = null;
          else seenMessageIds.add(messageClientId);
        }
        return { message, clientId: messageClientId };
      });

      const existing = findConversationByIdOrClient(db, instanceId, null, clientId);
      try {
        db.transaction(() => {
          if (!existing) {
            importedMessages += createConversation(db, instanceId, clientId, item, messages);
            importedConversations += 1;
          } else {
            const result = mergeConversation(
              db,
              instanceId,
              fromDbUuid(existing.id),
              item,
              messages,
            );
            importedMessages += result.added;
            if (result.changed) updated += 1;
            else skipped += 1;
          }
        });
      } catch {
        failed.push({ clientId: item.id, reason: '写入失败' });
      }
    }

    return {
      imported: { conversations: importedConversations, messages: importedMessages },
      updated,
      skipped,
      failed,
    };
  });
}
