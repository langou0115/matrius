import { randomUUID } from 'node:crypto';

import {
  validateWorkHostInput,
  type HostConnectionStatus,
  type HostKind,
  type SshAuthMethod,
  type WorkHost,
  type WorkHostInput,
} from '../../../contract/work-hosts';
import { conflict, invalid, notFound } from '../../errors';
import { fromDbUuid, toDbTimestamp, toDbUuid, toMs } from '../codecs';
import type { AppDatabase } from '../client';

export type WorkHostRow = {
  id: string;
  instance_id: number;
  kind: HostKind;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method: SshAuthMethod;
  private_key_path: string;
  secret_value: string;
  distro: string;
  default_directory: string;
  note: string;
  status: HostConnectionStatus;
  status_message: string | null;
  last_checked_at_ms: number | null;
  revision: number;
  created_at: string;
  updated_at: string;
};

function parseHostId(raw: string): string {
  try {
    return toDbUuid(raw);
  } catch {
    throw notFound('主机不存在。');
  }
}

export function serializeWorkHost(row: WorkHostRow): WorkHost {
  return {
    id: fromDbUuid(row.id),
    kind: row.kind,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    authMethod: row.auth_method,
    privateKeyPath: row.private_key_path,
    hasSecret: row.secret_value.length > 0,
    distro: row.distro,
    defaultDirectory: row.default_directory,
    note: row.note,
    status: row.status,
    statusMessage: row.status_message,
    lastCheckedAt: row.last_checked_at_ms,
    revision: row.revision,
    createdAt: toMs(row.created_at) ?? Date.now(),
    updatedAt: toMs(row.updated_at) ?? Date.now(),
  };
}

function normalizeValidated(input: WorkHostInput) {
  try {
    return validateWorkHostInput(input);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : '主机配置不合法。');
  }
}

export function listWorkHostRows(db: AppDatabase, instanceId: number): WorkHostRow[] {
  return db
    .prepare('SELECT * FROM work_hosts WHERE instance_id = ? ORDER BY updated_at DESC, name ASC')
    .all(instanceId) as WorkHostRow[];
}

export function getWorkHostRow(db: AppDatabase, instanceId: number, hostId: string): WorkHostRow | undefined {
  const dbId = parseHostId(hostId);
  return db
    .prepare('SELECT * FROM work_hosts WHERE id = ? AND instance_id = ?')
    .get(dbId, instanceId) as WorkHostRow | undefined;
}

export function requireWorkHostRow(db: AppDatabase, instanceId: number, hostId: string): WorkHostRow {
  const row = getWorkHostRow(db, instanceId, hostId);
  if (!row) throw notFound('主机不存在。');
  return row;
}

export function createWorkHostRow(db: AppDatabase, instanceId: number, input: WorkHostInput): WorkHostRow {
  const normalized = normalizeValidated(input);
  const id = toDbUuid(randomUUID());
  const now = toDbTimestamp();
  const secretValue = normalized.kind === 'ssh' && normalized.authMethod !== 'agent'
    ? (input.secret ?? '').trim()
    : '';

  db.prepare(`
    INSERT INTO work_hosts (
      id, instance_id, kind, name, host, port, username, auth_method,
      private_key_path, secret_value, distro, default_directory, note,
      status, status_message, last_checked_at_ms, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'disconnected', NULL, NULL, 1, ?, ?)
  `).run(
    id,
    instanceId,
    normalized.kind,
    normalized.name,
    normalized.host,
    normalized.port,
    normalized.username,
    normalized.authMethod,
    normalized.privateKeyPath,
    secretValue,
    normalized.distro,
    normalized.defaultDirectory,
    normalized.note,
    now,
    now,
  );

  const created = db
    .prepare('SELECT * FROM work_hosts WHERE id = ? AND instance_id = ?')
    .get(id, instanceId) as WorkHostRow | undefined;
  if (!created) throw new Error('Failed to load work_hosts row after insert.');
  return created;
}

export function updateWorkHostRow(
  db: AppDatabase,
  instanceId: number,
  hostId: string,
  input: WorkHostInput & { baseRevision: number },
): WorkHostRow {
  const current = requireWorkHostRow(db, instanceId, hostId);
  if (current.revision !== input.baseRevision) {
    throw conflict('主机配置已在其他页面更新，请刷新后重试。', serializeWorkHost(current));
  }

  const normalized = normalizeValidated(input);
  let nextSecret = current.secret_value;
  if (normalized.kind === 'wsl' || normalized.authMethod === 'agent') {
    nextSecret = '';
  } else if (input.clearSecret) {
    nextSecret = '';
  } else if (typeof input.secret === 'string' && input.secret.trim()) {
    nextSecret = input.secret.trim();
  }

  const result = db.prepare(`
    UPDATE work_hosts
    SET kind = ?, name = ?, host = ?, port = ?, username = ?, auth_method = ?,
        private_key_path = ?, secret_value = ?, distro = ?, default_directory = ?, note = ?,
        revision = revision + 1, updated_at = ?
    WHERE id = ? AND instance_id = ? AND revision = ?
  `).run(
    normalized.kind,
    normalized.name,
    normalized.host,
    normalized.port,
    normalized.username,
    normalized.authMethod,
    normalized.privateKeyPath,
    nextSecret,
    normalized.distro,
    normalized.defaultDirectory,
    normalized.note,
    toDbTimestamp(),
    current.id,
    instanceId,
    input.baseRevision,
  );

  if (result.changes === 0) {
    throw conflict('主机配置已在其他页面更新，请刷新后重试。', serializeWorkHost(requireWorkHostRow(db, instanceId, hostId)));
  }
  return requireWorkHostRow(db, instanceId, hostId);
}

export function updateWorkHostConnectionRow(
  db: AppDatabase,
  instanceId: number,
  hostId: string,
  update: {
    status: HostConnectionStatus;
    statusMessage: string | null;
    lastCheckedAtMs?: number | null;
  },
): WorkHostRow {
  const current = requireWorkHostRow(db, instanceId, hostId);
  const nextCheckedAt = update.lastCheckedAtMs !== undefined ? update.lastCheckedAtMs : current.last_checked_at_ms;
  db.prepare(`
    UPDATE work_hosts
    SET status = ?, status_message = ?, last_checked_at_ms = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND instance_id = ?
  `).run(
    update.status,
    update.statusMessage,
    nextCheckedAt,
    toDbTimestamp(),
    current.id,
    instanceId,
  );
  return requireWorkHostRow(db, instanceId, hostId);
}

export function deleteWorkHostRow(
  db: AppDatabase,
  instanceId: number,
  hostId: string,
  baseRevision?: number,
): void {
  const current = requireWorkHostRow(db, instanceId, hostId);
  if (baseRevision !== undefined && current.revision !== baseRevision) {
    throw conflict('主机配置已在其他页面更新，请刷新后重试。', serializeWorkHost(current));
  }
  const result = baseRevision !== undefined
    ? db.prepare('DELETE FROM work_hosts WHERE id = ? AND instance_id = ? AND revision = ?')
      .run(current.id, instanceId, baseRevision)
    : db.prepare('DELETE FROM work_hosts WHERE id = ? AND instance_id = ?')
      .run(current.id, instanceId);
  if (result.changes === 0) {
    throw conflict('主机配置已在其他页面更新，请刷新后重试。', serializeWorkHost(requireWorkHostRow(db, instanceId, hostId)));
  }
}
