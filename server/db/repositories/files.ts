import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';

import { fromDbUuid, toDbTimestamp, toDbUuid } from '../codecs';
import type { AppDatabase } from '../client';
import type { StoredFileRow } from './conversations';
import {
  escapeLike,
  IMAGE_EXTENSIONS,
  DOCUMENT_EXTENSIONS,
  LEGACY_DOCUMENT_EXTENSIONS,
  TEXT_EXTENSIONS,
} from '../../services/file-types';
import { validateClientId } from '../validation';

export type FileKind = 'all' | 'image' | 'file' | 'document' | 'text';
export type FileSort = 'created' | 'name' | 'size';
export type FileOrder = 'asc' | 'desc';
export type FileCursor = { value: string | number; idHex: string };

export function getFileRow(
  db: AppDatabase,
  instanceId: number,
  id: string,
): StoredFileRow | undefined {
  return db
    .prepare('SELECT * FROM files WHERE id = ? AND instance_id = ?')
    .get(toDbUuid(id), instanceId) as StoredFileRow | undefined;
}

export function getFileRowByClientId(
  db: AppDatabase,
  instanceId: number,
  clientId: string,
): StoredFileRow | undefined {
  return db
    .prepare('SELECT * FROM files WHERE instance_id = ? AND client_id = ?')
    .get(instanceId, clientId) as StoredFileRow | undefined;
}

export function insertFileRow(
  db: AppDatabase,
  values: {
    id?: string;
    instanceId: number;
    clientId: string | null;
    conversationId: string | null;
    filename: string;
    objectKey: string;
    contentType: string;
    size: number;
    sha256: string;
  },
): StoredFileRow {
  const id = toDbUuid(values.id ?? randomUUID());
  const now = toDbTimestamp();
  db.prepare(
    `INSERT INTO files
     (id, instance_id, client_id, conversation_id, filename, object_key, content_type, size,
      sha256, status, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 1, ?, ?)`,
  ).run(
    id,
    values.instanceId,
    validateClientId(values.clientId),
    values.conversationId ? toDbUuid(values.conversationId) : null,
    values.filename,
    values.objectKey,
    values.contentType,
    values.size,
    values.sha256,
    now,
    now,
  );
  const row = getFileRow(db, values.instanceId, fromDbUuid(id));
  if (!row) throw new Error('Failed to load file after insert.');
  return row;
}

function suffixClause(column: string, extensions: Set<string>): { sql: string; params: string[] } {
  const suffixes = [...extensions].sort();
  return {
    sql: suffixes.map(() => `${column} LIKE ?`).join(' OR '),
    params: suffixes.map((suffix) => `%.${suffix}`),
  };
}

function imageClause(column: string): { sql: string; params: string[] } {
  return suffixClause(`LOWER(${column})`, IMAGE_EXTENSIONS);
}

export function listFileRows(
  db: AppDatabase,
  instanceId: number,
  options: {
    query?: string;
    kind: FileKind;
    sort: FileSort;
    order: FileOrder;
    conversationId?: string;
    cursor?: FileCursor;
    limit: number;
  },
): StoredFileRow[] {
  let sql = 'SELECT * FROM files WHERE instance_id = ?';
  const params: SQLInputValue[] = [instanceId];

  if (options.conversationId) {
    sql += ' AND conversation_id = ?';
    params.push(toDbUuid(options.conversationId));
  }

  const term = (options.query ?? '').trim();
  if (term) {
    sql += " AND LOWER(filename) LIKE ? ESCAPE '\\'";
    params.push(`%${escapeLike(term.toLowerCase())}%`);
  }

  if (options.kind === 'image') {
    const clause = imageClause('filename');
    sql += ` AND (${clause.sql})`;
    params.push(...clause.params);
  } else if (options.kind === 'document') {
    const clause = suffixClause('LOWER(filename)', new Set([
      ...DOCUMENT_EXTENSIONS,
      ...LEGACY_DOCUMENT_EXTENSIONS,
    ]));
    sql += ` AND (${clause.sql})`;
    params.push(...clause.params);
  } else if (options.kind === 'text') {
    const clause = suffixClause('LOWER(filename)', TEXT_EXTENSIONS);
    sql += ` AND (${clause.sql})`;
    params.push(...clause.params);
  } else if (options.kind === 'file') {
    const clause = imageClause('filename');
    sql += ` AND NOT (${clause.sql})`;
    params.push(...clause.params);
  }

  const column = options.sort === 'created' ? 'created_at' : options.sort === 'name' ? 'filename' : 'size';
  const descending = options.order === 'desc';
  if (options.cursor) {
    const operator = descending ? '<' : '>';
    sql += ` AND (${column} ${operator} ? OR (${column} = ? AND id ${operator} ?))`;
    params.push(options.cursor.value, options.cursor.value, options.cursor.idHex);
  }
  sql += ` ORDER BY ${column} ${descending ? 'DESC' : 'ASC'}, id ${descending ? 'DESC' : 'ASC'} LIMIT ?`;
  params.push(options.limit + 1);
  return db.prepare(sql).all(...params) as StoredFileRow[];
}

export function fileUsageStats(
  db: AppDatabase,
  instanceId: number,
): { used: number; total: number; imageBytes: number; imageCount: number } {
  const images = imageClause('filename');
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(size), 0) AS used,
         COUNT(id) AS total,
         COALESCE(SUM(CASE WHEN (${images.sql}) THEN size ELSE 0 END), 0) AS image_bytes,
         COALESCE(SUM(CASE WHEN (${images.sql}) THEN 1 ELSE 0 END), 0) AS image_count
       FROM files WHERE instance_id = ?`,
    )
    .get(...images.params, ...images.params, instanceId) as {
      used: number;
      total: number;
      image_bytes: number;
      image_count: number;
    };
  return {
    used: Number(row.used),
    total: Number(row.total),
    imageBytes: Number(row.image_bytes),
    imageCount: Number(row.image_count),
  };
}

export function selectOwnedFileRows(
  db: AppDatabase,
  instanceId: number,
  ids: string[],
): StoredFileRow[] {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const placeholders = unique.map(() => '?').join(', ');
  return db
    .prepare(`SELECT * FROM files WHERE instance_id = ? AND id IN (${placeholders})`)
    .all(instanceId, ...unique.map((id) => toDbUuid(id))) as StoredFileRow[];
}

export function deleteFileRows(
  db: AppDatabase,
  instanceId: number,
  ids: string[],
): StoredFileRow[] {
  const rows = selectOwnedFileRows(db, instanceId, ids);
  for (const row of rows) {
    db.prepare('DELETE FROM files WHERE id = ? AND instance_id = ?').run(row.id, instanceId);
  }
  return rows;
}

export function replaceFileContent(
  db: AppDatabase,
  instanceId: number,
  id: string,
  values: {
    filename: string;
    objectKey: string;
    contentType: string;
    size: number;
    sha256: string;
  },
): StoredFileRow {
  db.prepare(
    `UPDATE files SET filename = ?, object_key = ?, content_type = ?, size = ?, sha256 = ?,
     status = 'ready', revision = revision + 1, updated_at = ?
     WHERE id = ? AND instance_id = ?`,
  ).run(
    values.filename,
    values.objectKey,
    values.contentType,
    values.size,
    values.sha256,
    toDbTimestamp(),
    toDbUuid(id),
    instanceId,
  );
  const row = getFileRow(db, instanceId, id);
  if (!row) throw new Error('Failed to load file after content update.');
  return row;
}

export function updateFileRow(
  db: AppDatabase,
  instanceId: number,
  id: string,
  values: { filename: string; objectKey: string },
): StoredFileRow {
  db.prepare(
    `UPDATE files SET filename = ?, object_key = ?, revision = revision + 1, updated_at = ?
     WHERE id = ? AND instance_id = ?`,
  ).run(values.filename, values.objectKey, toDbTimestamp(), toDbUuid(id), instanceId);
  const row = getFileRow(db, instanceId, id);
  if (!row) throw new Error('Failed to load file after rename.');
  return row;
}

/** Resolve a server UUID or a client-generated conversation id to the server id. */
export function resolveConversationId(
  db: AppDatabase,
  instanceId: number,
  value: string | null | undefined,
): string | undefined {
  if (!value) return undefined;
  try {
    const row = db
      .prepare(
        'SELECT id FROM conversations WHERE instance_id = ? AND (client_id = ? OR id = ?) LIMIT 1',
      )
      .get(instanceId, value, toDbUuid(value)) as { id: string } | undefined;
    return row ? fromDbUuid(row.id) : undefined;
  } catch {
    const row = db
      .prepare('SELECT id FROM conversations WHERE instance_id = ? AND client_id = ? LIMIT 1')
      .get(instanceId, value) as { id: string } | undefined;
    return row ? fromDbUuid(row.id) : undefined;
  }
}
