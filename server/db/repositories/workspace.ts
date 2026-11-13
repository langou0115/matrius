import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';

import { conflict, invalid, notFound } from '../../errors';
import { fromDbUuid, toDbTimestamp, toDbUuid } from '../codecs';
import type { AppDatabase } from '../client';

export type PreferenceRow = {
  id: string;
  instance_id: number;
  theme_id: string;
  mode: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type ProfileRow = {
  id: string;
  instance_id: number;
  custom_instructions: string;
  about_name: string;
  occupation: string;
  about_more: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type ProfileFieldRow = {
  id: string;
  instance_id: number;
  key: string;
  value: string;
  source: string;
  client_updated_at_ms: number | null;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type MemoryRow = {
  id: string;
  instance_id: number;
  client_id: string | null;
  scope: string;
  type: string;
  status: string;
  content: string;
  source: string;
  client_created_at_ms: number | null;
  client_updated_at_ms: number | null;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type MemoryCursor = { updatedAt: string; idHex: string };

export const FIELD_KEY_RE = /^[^\s\x00-\x1f\x7f]{1,64}$/u;

export function validateFieldKey(key: string): string {
  if (!FIELD_KEY_RE.test(key)) {
    throw invalid('字段名必须是 1–64 个不含空白或控制字符的字符。');
  }
  return key;
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

function preferenceRow(db: AppDatabase, instanceId: number): PreferenceRow | undefined {
  return db.prepare('SELECT * FROM preferences WHERE instance_id = ?').get(instanceId) as
    | PreferenceRow
    | undefined;
}

export function getOrCreatePreferences(db: AppDatabase, instanceId: number): PreferenceRow {
  const existing = preferenceRow(db, instanceId);
  if (existing) return existing;
  const id = toDbUuid(randomUUID());
  const now = toDbTimestamp();
  db.prepare(
    `INSERT INTO preferences
     (id, instance_id, theme_id, mode, revision, created_at, updated_at)
     VALUES (?, ?, 'twitter', 'system', 1, ?, ?)`,
  ).run(id, instanceId, now, now);
  const created = preferenceRow(db, instanceId);
  if (!created) throw new Error('Failed to load preferences after insert.');
  return created;
}

export function updatePreferences(
  db: AppDatabase,
  instanceId: number,
  baseRevision: number,
  themeId: string,
  mode: string,
): PreferenceRow {
  const current = getOrCreatePreferences(db, instanceId);
  if (current.revision !== baseRevision) {
    throw conflict('设置已在其他设备更新，请刷新后重试。', current);
  }
  db.prepare(
    'UPDATE preferences SET theme_id = ?, mode = ?, revision = revision + 1, updated_at = ? WHERE instance_id = ?',
  ).run(themeId, mode, toDbTimestamp(), instanceId);
  const updated = preferenceRow(db, instanceId);
  if (!updated) throw new Error('Failed to load preferences after update.');
  return updated;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function profileRow(db: AppDatabase, instanceId: number): ProfileRow | undefined {
  return db.prepare('SELECT * FROM profiles WHERE instance_id = ?').get(instanceId) as
    | ProfileRow
    | undefined;
}

export function getOrCreateProfile(db: AppDatabase, instanceId: number): ProfileRow {
  const existing = profileRow(db, instanceId);
  if (existing) return existing;
  const id = toDbUuid(randomUUID());
  const now = toDbTimestamp();
  db.prepare(
    `INSERT INTO profiles
     (id, instance_id, custom_instructions, about_name, occupation, about_more, revision, created_at, updated_at)
     VALUES (?, ?, '', '', '', '', 1, ?, ?)`,
  ).run(id, instanceId, now, now);
  const created = profileRow(db, instanceId);
  if (!created) throw new Error('Failed to load profile after insert.');
  return created;
}

export function updateProfile(
  db: AppDatabase,
  instanceId: number,
  baseRevision: number,
  values: {
    customInstructions: string;
    aboutName: string;
    occupation: string;
    aboutMore: string;
  },
): ProfileRow {
  const current = getOrCreateProfile(db, instanceId);
  if (current.revision !== baseRevision) {
    throw conflict('个性化设置已在其他设备更新，请刷新后重试。', current);
  }
  db.prepare(
    `UPDATE profiles SET custom_instructions = ?, about_name = ?, occupation = ?, about_more = ?,
     revision = revision + 1, updated_at = ? WHERE instance_id = ?`,
  ).run(
    values.customInstructions,
    values.aboutName,
    values.occupation,
    values.aboutMore,
    toDbTimestamp(),
    instanceId,
  );
  const updated = profileRow(db, instanceId);
  if (!updated) throw new Error('Failed to load profile after update.');
  return updated;
}

// ---------------------------------------------------------------------------
// Profile fields
// ---------------------------------------------------------------------------

export function listProfileFields(db: AppDatabase, instanceId: number): ProfileFieldRow[] {
  return db
    .prepare('SELECT * FROM profile_fields WHERE instance_id = ? ORDER BY key')
    .all(instanceId) as ProfileFieldRow[];
}

export function getProfileField(
  db: AppDatabase,
  instanceId: number,
  key: string,
): ProfileFieldRow | undefined {
  return db
    .prepare('SELECT * FROM profile_fields WHERE instance_id = ? AND key = ?')
    .get(instanceId, key) as ProfileFieldRow | undefined;
}

export function requireProfileField(
  db: AppDatabase,
  instanceId: number,
  key: string,
): ProfileFieldRow {
  const row = getProfileField(db, instanceId, key);
  if (!row) throw notFound('画像字段不存在。');
  return row;
}

export function upsertProfileField(
  db: AppDatabase,
  instanceId: number,
  key: string,
  values: {
    baseRevision?: number | null;
    value: string;
    source: string;
    updatedAt?: number | null;
  },
): ProfileFieldRow {
  validateFieldKey(key);
  const existing = getProfileField(db, instanceId, key);
  const now = toDbTimestamp();
  if (!existing) {
    db.prepare(
      `INSERT INTO profile_fields
       (id, instance_id, key, value, source, client_updated_at_ms, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      toDbUuid(randomUUID()),
      instanceId,
      key,
      values.value,
      values.source,
      values.updatedAt ?? null,
      now,
      now,
    );
  } else {
    if (values.baseRevision !== undefined && values.baseRevision !== null
      && existing.revision !== values.baseRevision) {
      throw conflict('字段已在其他设备更新，请刷新后重试。', existing);
    }
    db.prepare(
      `UPDATE profile_fields SET value = ?, source = ?, client_updated_at_ms = ?,
       revision = revision + 1, updated_at = ? WHERE instance_id = ? AND key = ?`,
    ).run(values.value, values.source, values.updatedAt ?? null, now, instanceId, key);
  }
  const row = getProfileField(db, instanceId, key);
  if (!row) throw new Error('Failed to load profile field after upsert.');
  return row;
}

export function deleteProfileField(
  db: AppDatabase,
  instanceId: number,
  key: string,
  baseRevision?: number | null,
): void {
  const existing = requireProfileField(db, instanceId, key);
  if (baseRevision !== undefined && baseRevision !== null && existing.revision !== baseRevision) {
    throw conflict('字段已在其他设备更新，请刷新后重试。', existing);
  }
  db.prepare('DELETE FROM profile_fields WHERE instance_id = ? AND key = ?').run(instanceId, key);
}

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

export function getMemoryRow(
  db: AppDatabase,
  instanceId: number,
  id: string,
): MemoryRow | undefined {
  return db
    .prepare('SELECT * FROM memory_entries WHERE id = ? AND instance_id = ?')
    .get(toDbUuid(id), instanceId) as MemoryRow | undefined;
}

export function listMemoryRows(
  db: AppDatabase,
  instanceId: number,
  limit: number,
  filters: { status?: string; scope?: string },
  cursor?: MemoryCursor,
): MemoryRow[] {
  let sql = 'SELECT * FROM memory_entries WHERE instance_id = ?';
  const params: SQLInputValue[] = [instanceId];
  if (filters.status) {
    sql += ' AND status = ?';
    params.push(filters.status);
  }
  if (filters.scope) {
    sql += ' AND scope = ?';
    params.push(filters.scope);
  }
  if (cursor) {
    sql += ' AND (updated_at < ? OR (updated_at = ? AND id < ?))';
    params.push(cursor.updatedAt, cursor.updatedAt, cursor.idHex);
  }
  sql += ' ORDER BY updated_at DESC, id DESC LIMIT ?';
  params.push(limit + 1);
  return db.prepare(sql).all(...params) as MemoryRow[];
}

export function createMemory(
  db: AppDatabase,
  instanceId: number,
  values: {
    id?: string | null;
    clientId?: string | null;
    scope: string;
    type: string;
    status: string;
    content: string;
    source: string;
    createdAt?: number | null;
    updatedAt?: number | null;
  },
): MemoryRow {
  if (values.id) {
    const existing = db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(toDbUuid(values.id)) as
      | MemoryRow
      | undefined;
    if (existing) {
      if (existing.instance_id !== instanceId) throw conflict('该标识已被占用。');
      return existing;
    }
  }
  if (values.clientId) {
    const existing = db
      .prepare('SELECT * FROM memory_entries WHERE instance_id = ? AND client_id = ?')
      .get(instanceId, values.clientId) as MemoryRow | undefined;
    if (existing) return existing;
  }

  const id = values.id ? toDbUuid(values.id) : toDbUuid(randomUUID());
  const now = toDbTimestamp();
  db.prepare(
    `INSERT INTO memory_entries
     (id, instance_id, client_id, scope, type, status, content, source,
      client_created_at_ms, client_updated_at_ms, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    instanceId,
    values.clientId ?? null,
    values.scope,
    values.type,
    values.status,
    values.content,
    values.source,
    values.createdAt ?? null,
    values.updatedAt ?? null,
    now,
    now,
  );
  const row = getMemoryRow(db, instanceId, fromDbUuid(id));
  if (!row) throw new Error('Failed to load memory after insert.');
  return row;
}

export function updateMemory(
  db: AppDatabase,
  instanceId: number,
  id: string,
  baseRevision: number,
  patch: {
    scope?: string;
    type?: string;
    status?: string;
    content?: string;
    source?: string;
    updatedAt?: number | null;
  },
): MemoryRow {
  const current = getMemoryRow(db, instanceId, id);
  if (!current) throw notFound('记忆不存在。');
  if (current.revision !== baseRevision) {
    throw conflict('记忆已在其他设备更新，请刷新后重试。', current);
  }
  const sets: string[] = [];
  const params: SQLInputValue[] = [];
  const set = (sql: string, value: SQLInputValue) => {
    sets.push(sql);
    params.push(value);
  };
  if (patch.scope !== undefined && patch.scope !== null) set('scope = ?', patch.scope);
  if (patch.type !== undefined && patch.type !== null) set('type = ?', patch.type);
  if (patch.status !== undefined && patch.status !== null) set('status = ?', patch.status);
  if (patch.content !== undefined && patch.content !== null) set('content = ?', patch.content);
  if (patch.source !== undefined && patch.source !== null) set('source = ?', patch.source);
  if (patch.updatedAt !== undefined && patch.updatedAt !== null) {
    set('client_updated_at_ms = ?', patch.updatedAt);
  }
  if (sets.length) {
    sets.push('revision = revision + 1', 'updated_at = ?');
    params.push(toDbTimestamp(), toDbUuid(id), instanceId);
    db.prepare(`UPDATE memory_entries SET ${sets.join(', ')} WHERE id = ? AND instance_id = ?`).run(
      ...params,
    );
  }
  const row = getMemoryRow(db, instanceId, id);
  if (!row) throw new Error('Failed to load memory after update.');
  return row;
}

export function archiveMemory(
  db: AppDatabase,
  instanceId: number,
  id: string,
  baseRevision: number,
): MemoryRow {
  const current = getMemoryRow(db, instanceId, id);
  if (!current) throw notFound('记忆不存在。');
  if (current.revision !== baseRevision) {
    throw conflict('记忆已在其他设备更新，请刷新后重试。', current);
  }
  if (current.status !== 'archived') {
    db.prepare(
      `UPDATE memory_entries SET status = 'archived', revision = revision + 1, updated_at = ?
       WHERE id = ? AND instance_id = ?`,
    ).run(toDbTimestamp(), toDbUuid(id), instanceId);
  }
  const row = getMemoryRow(db, instanceId, id);
  if (!row) throw new Error('Failed to load memory after archive.');
  return row;
}

// ---------------------------------------------------------------------------
// Conversation deletion tombstones
// ---------------------------------------------------------------------------

export function listConversationDeletionIds(
  db: AppDatabase,
  instanceId: number,
  limit: number,
  cursor?: string,
): string[] {
  let sql = 'SELECT client_id FROM conversation_deletions WHERE instance_id = ?';
  const params: SQLInputValue[] = [instanceId];
  if (cursor) {
    sql += ' AND client_id > ?';
    params.push(cursor);
  }
  sql += ' ORDER BY client_id LIMIT ?';
  params.push(limit + 1);
  return (db.prepare(sql).all(...params) as Array<{ client_id: string }>).map((row) => row.client_id);
}
