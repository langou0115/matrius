import { randomUUID } from 'node:crypto';

import {
  LOCAL_WORK_HOST_ID,
  validateWorkProjectInput,
  type WorkProject,
  type WorkProjectInput,
} from '../../../contract/work-projects';
import { conflict, invalid, notFound } from '../../errors';
import { fromDbUuid, toDbTimestamp, toDbUuid, toMs } from '../codecs';
import type { AppDatabase } from '../client';
import { getWorkHostRow } from './hosts';

export type WorkProjectRow = {
  id: string;
  instance_id: number;
  name: string;
  host_id: string;
  directory: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

function parseProjectId(raw: string): string {
  try {
    return toDbUuid(raw);
  } catch {
    throw notFound('项目不存在。');
  }
}

export function serializeWorkProject(row: WorkProjectRow): WorkProject {
  return {
    id: fromDbUuid(row.id),
    name: row.name,
    hostId: row.host_id,
    directory: row.directory,
    revision: row.revision,
    createdAt: toMs(row.created_at) ?? Date.now(),
    updatedAt: toMs(row.updated_at) ?? Date.now(),
  };
}

function normalizeValidated(input: WorkProjectInput) {
  try {
    return validateWorkProjectInput(input);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : '项目配置不合法。');
  }
}

export function listWorkProjectRows(db: AppDatabase, instanceId: number): WorkProjectRow[] {
  return db
    .prepare('SELECT * FROM work_projects WHERE instance_id = ? ORDER BY updated_at DESC, rowid DESC')
    .all(instanceId) as WorkProjectRow[];
}

export function requireWorkProjectRow(db: AppDatabase, instanceId: number, projectId: string): WorkProjectRow {
  const dbId = parseProjectId(projectId);
  const row = db
    .prepare('SELECT * FROM work_projects WHERE id = ? AND instance_id = ?')
    .get(dbId, instanceId) as WorkProjectRow | undefined;
  if (!row) throw notFound('项目不存在。');
  return row;
}

export function createWorkProjectRow(db: AppDatabase, instanceId: number, input: WorkProjectInput): WorkProjectRow {
  const normalized = normalizeValidated(input);
  let resolvedHostId = normalized.hostId;
  if (resolvedHostId !== LOCAL_WORK_HOST_ID) {
    let hostRow;
    try {
      hostRow = getWorkHostRow(db, instanceId, resolvedHostId);
    } catch {
      hostRow = undefined;
    }
    if (!hostRow) {
      throw invalid('所选主机不存在，请先在「设置 → 工作 → 主机」中配置。');
    }
    resolvedHostId = fromDbUuid(hostRow.id);
  }

  const id = toDbUuid(randomUUID());
  const now = toDbTimestamp();
  db.prepare(`
    INSERT INTO work_projects (
      id, instance_id, name, host_id, directory, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, instanceId, normalized.name, resolvedHostId, normalized.directory, now, now);

  const created = db
    .prepare('SELECT * FROM work_projects WHERE id = ? AND instance_id = ?')
    .get(id, instanceId) as WorkProjectRow | undefined;
  if (!created) throw new Error('Failed to load work_projects row after insert.');
  return created;
}

export function deleteWorkProjectRow(db: AppDatabase, instanceId: number, projectId: string, baseRevision?: number): void {
  const current = requireWorkProjectRow(db, instanceId, projectId);
  if (baseRevision !== undefined && current.revision !== baseRevision) {
    throw conflict('项目列表已在其他页面更新，请刷新后重试。', serializeWorkProject(current));
  }
  const result = baseRevision !== undefined
    ? db.prepare('DELETE FROM work_projects WHERE id = ? AND instance_id = ? AND revision = ?').run(current.id, instanceId, baseRevision)
    : db.prepare('DELETE FROM work_projects WHERE id = ? AND instance_id = ?').run(current.id, instanceId);
  if (result.changes === 0) {
    throw conflict('项目列表已在其他页面更新，请刷新后重试。');
  }
}
