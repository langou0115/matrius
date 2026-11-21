import { randomUUID } from 'node:crypto';

import {
  LOCAL_WORK_HOST_ID,
  serializeWorkProjectCliProxies,
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
  proxy_url: string;
  codex_proxy_url: string;
  antigravity_proxy_url: string;
  claude_proxy_url: string;
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
  const cliProxies = serializeWorkProjectCliProxies({
    codex: row.codex_proxy_url || row.proxy_url,
    antigravity: row.antigravity_proxy_url || row.proxy_url,
    claude: row.claude_proxy_url || row.proxy_url,
  });
  return {
    id: fromDbUuid(row.id),
    name: row.name,
    hostId: row.host_id,
    directory: row.directory,
    ...(cliProxies ? { cliProxies } : {}),
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

function resolveProjectHostId(db: AppDatabase, instanceId: number, rawHostId: string): string {
  if (rawHostId === LOCAL_WORK_HOST_ID) return rawHostId;
  let hostRow;
  try {
    hostRow = getWorkHostRow(db, instanceId, rawHostId);
  } catch {
    hostRow = undefined;
  }
  if (!hostRow) {
    throw invalid('所选主机不存在，请先在「设置 → 工作 → 主机」中配置。');
  }
  return fromDbUuid(hostRow.id);
}

export function createWorkProjectRow(db: AppDatabase, instanceId: number, input: WorkProjectInput): WorkProjectRow {
  const normalized = normalizeValidated(input);
  const resolvedHostId = resolveProjectHostId(db, instanceId, normalized.hostId);

  const id = toDbUuid(randomUUID());
  const now = toDbTimestamp();
  db.prepare(`
    INSERT INTO work_projects (
      id, instance_id, name, host_id, directory, proxy_url, codex_proxy_url, antigravity_proxy_url, claude_proxy_url, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    instanceId,
    normalized.name,
    resolvedHostId,
    normalized.directory,
    normalized.cliProxies.codex,
    normalized.cliProxies.antigravity,
    normalized.cliProxies.claude,
    now,
    now,
  );

  const created = db
    .prepare('SELECT * FROM work_projects WHERE id = ? AND instance_id = ?')
    .get(id, instanceId) as WorkProjectRow | undefined;
  if (!created) throw new Error('Failed to load work_projects row after insert.');
  return created;
}

export function updateWorkProjectRow(
  db: AppDatabase,
  instanceId: number,
  projectId: string,
  input: Partial<WorkProjectInput> & { baseRevision?: number },
): WorkProjectRow {
  const current = requireWorkProjectRow(db, instanceId, projectId);
  if (input.baseRevision !== undefined && current.revision !== input.baseRevision) {
    throw conflict('项目列表已在其他页面更新，请刷新后重试。', serializeWorkProject(current));
  }
  // Project name, host, and directory are immutable after creation; only CLI proxies may be updated.
  if (input.name !== undefined && input.name.trim() !== current.name) {
    throw invalid('项目创建后仅可配置网络代理，项目名称不可修改。');
  }
  if (input.hostId !== undefined && input.hostId.trim() !== current.host_id) {
    throw invalid('项目创建后仅可配置网络代理，运行主机不可修改。');
  }
  if (input.directory !== undefined && input.directory.trim() !== current.directory) {
    throw invalid('项目创建后仅可配置网络代理，项目目录不可修改。');
  }
  const normalized = normalizeValidated({
    hostId: current.host_id,
    directory: current.directory,
    name: current.name,
    ...(input.cliProxies === undefined && input.proxyUrl === undefined
      ? {
          cliProxies: {
            codex: current.codex_proxy_url || current.proxy_url,
            antigravity: current.antigravity_proxy_url || current.proxy_url,
            claude: current.claude_proxy_url || current.proxy_url,
          },
        }
      : {
          ...(input.cliProxies !== undefined ? { cliProxies: input.cliProxies } : {}),
          ...(input.proxyUrl !== undefined ? { proxyUrl: input.proxyUrl } : {}),
        }),
  });
  const now = toDbTimestamp();

  const result = input.baseRevision !== undefined
    ? db.prepare(`
        UPDATE work_projects
        SET proxy_url = '', codex_proxy_url = ?, antigravity_proxy_url = ?, claude_proxy_url = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND instance_id = ? AND revision = ?
      `).run(
        normalized.cliProxies.codex,
        normalized.cliProxies.antigravity,
        normalized.cliProxies.claude,
        now,
        current.id,
        instanceId,
        input.baseRevision,
      )
    : db.prepare(`
        UPDATE work_projects
        SET proxy_url = '', codex_proxy_url = ?, antigravity_proxy_url = ?, claude_proxy_url = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND instance_id = ?
      `).run(
        normalized.cliProxies.codex,
        normalized.cliProxies.antigravity,
        normalized.cliProxies.claude,
        now,
        current.id,
        instanceId,
      );

  if (result.changes === 0) {
    throw conflict('项目列表已在其他页面更新，请刷新后重试。');
  }
  return requireWorkProjectRow(db, instanceId, projectId);
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
