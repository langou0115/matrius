import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';

import type {
  UiComponentCommandDeclaration,
  UiComponentEventDeclaration,
} from '../../../contract/ui-component';
import { conflict, invalid, notFound } from '../../errors';
import { escapeLike, fromDbJson, fromDbUuid, toDbBool, toDbJson, toDbTimestamp, toDbUuid } from '../codecs';
import type { AppDatabase } from '../client';

/**
 * Data access for UI workshop components.
 *
 * Rows keep hex UUIDs and SQLAlchemy-compatible timestamps like every other
 * table. Version rows are immutable: nothing here updates `html`, schemas or
 * declarations after insert; only `status` changes on publish.
 */

export type UiComponentRow = {
  id: string;
  instance_id: number;
  name: string;
  description: string;
  status: string;
  current_version: number;
  published_version: number | null;
  /** 1 when the component is bound to a conversation and stores its own state. */
  stateful: number;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
};

export type UiComponentVersionRow = {
  id: string;
  component_id: string;
  version: number;
  status: string;
  name: string;
  description: string;
  html: string;
  input_schema: string;
  state_schema: string | null;
  commands: string;
  events: string;
  protocol_version: number;
  created_at: string;
};

export type UiBindingRow = {
  id: string;
  instance_id: number;
  conversation_id: string;
  component_id: string;
  version: number;
  props: string | null;
  state: string | null;
  state_schema: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
};

export type UiCommandRow = {
  id: string;
  binding_id: string;
  name: string;
  payload: string | null;
  status: string;
  error: string | null;
  created_at: string;
  applied_at: string | null;
};

export type VersionCreateInput = {
  name: string;
  description: string;
  html: string;
  inputSchema: Record<string, unknown>;
  stateSchema: Record<string, unknown> | null;
  commands: UiComponentCommandDeclaration[];
  events: UiComponentEventDeclaration[];
  protocolVersion: number;
};

const HEX_ID = /^[0-9a-f]{32}$/u;

function hexId(id: string): string {
  return toDbUuid(id);
}

export function isUiComponentId(value: string): boolean {
  return HEX_ID.test(value.trim().replaceAll('-', '').toLowerCase());
}

export function getComponentRow(db: AppDatabase, instanceId: number, id: string): UiComponentRow | undefined {
  return db
    .prepare('SELECT * FROM ui_components WHERE id = ? AND instance_id = ?')
    .get(hexId(id), instanceId) as UiComponentRow | undefined;
}

export function listComponentRows(
  db: AppDatabase,
  instanceId: number,
  options: { query?: string; includeArchived?: boolean } = {},
): UiComponentRow[] {
  const where = ['instance_id = ?'];
  const params: SQLInputValue[] = [instanceId];
  if (!options.includeArchived) where.push("status <> 'archived'");
  const query = options.query?.trim();
  if (query) {
    where.push("(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
    const pattern = `%${escapeLike(query)}%`;
    params.push(pattern, pattern);
  }
  return db
    .prepare(`SELECT * FROM ui_components WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC`)
    .all(...params) as UiComponentRow[];
}

export function insertComponentRow(
  db: AppDatabase,
  instanceId: number,
  input: { id?: string; name: string; description?: string; conversationId?: string | null; stateful?: boolean },
): UiComponentRow {
  const id = input.id ? hexId(input.id) : hexId(randomUUID());
  const now = toDbTimestamp();
  db.prepare(
    `INSERT INTO ui_components (
      id, instance_id, name, description, status, current_version, published_version, conversation_id,
      stateful, created_at, updated_at, revision
    ) VALUES (?, ?, ?, ?, 'draft', 0, NULL, ?, ?, ?, ?, 1)`,
  ).run(
    id,
    instanceId,
    input.name,
    input.description ?? '',
    input.conversationId ? hexId(input.conversationId) : null,
    toDbBool(input.stateful ?? false),
    now,
    now,
  );
  const row = getComponentRow(db, instanceId, fromDbUuid(id));
  if (!row) throw new Error('Failed to load the component after insert.');
  return row;
}

export type ComponentPatch = {
  name?: string;
  description?: string;
  status?: 'draft' | 'published' | 'archived';
  conversationId?: string | null;
  currentVersion?: number;
  publishedVersion?: number | null;
};

export function patchComponentRow(
  db: AppDatabase,
  instanceId: number,
  id: string,
  patch: ComponentPatch,
): UiComponentRow {
  const sets: string[] = [];
  const values: SQLInputValue[] = [];
  if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name); }
  if (patch.description !== undefined) { sets.push('description = ?'); values.push(patch.description); }
  if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
  if (patch.conversationId !== undefined) {
    sets.push('conversation_id = ?');
    values.push(patch.conversationId ? hexId(patch.conversationId) : null);
  }
  if (patch.currentVersion !== undefined) { sets.push('current_version = ?'); values.push(patch.currentVersion); }
  if (patch.publishedVersion !== undefined) {
    sets.push('published_version = ?');
    values.push(patch.publishedVersion);
  }
  if (sets.length) {
    sets.push('updated_at = ?', 'revision = revision + 1');
    values.push(toDbTimestamp(), hexId(id), instanceId);
    db.prepare(`UPDATE ui_components SET ${sets.join(', ')} WHERE id = ? AND instance_id = ?`).run(...values);
  }
  const row = getComponentRow(db, instanceId, id);
  if (!row) throw notFound('组件不存在。');
  return row;
}

export function archiveComponentRow(db: AppDatabase, instanceId: number, id: string): UiComponentRow {
  return patchComponentRow(db, instanceId, id, { status: 'archived' });
}

export function getVersionRow(
  db: AppDatabase,
  componentId: string,
  version: number,
): UiComponentVersionRow | undefined {
  return db
    .prepare('SELECT * FROM ui_component_versions WHERE component_id = ? AND version = ?')
    .get(hexId(componentId), version) as UiComponentVersionRow | undefined;
}

export function listVersionRows(db: AppDatabase, componentId: string): UiComponentVersionRow[] {
  return db
    .prepare('SELECT * FROM ui_component_versions WHERE component_id = ? ORDER BY version DESC')
    .all(hexId(componentId)) as UiComponentVersionRow[];
}

export function countVersionRows(db: AppDatabase, componentId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM ui_component_versions WHERE component_id = ?')
    .get(hexId(componentId)) as { count: number };
  return Number(row.count);
}

export function listPublishedComponentRows(db: AppDatabase, instanceId: number): UiComponentRow[] {
  return db
    .prepare(
      `SELECT * FROM ui_components
       WHERE instance_id = ? AND status = 'published' AND published_version IS NOT NULL
       ORDER BY updated_at DESC LIMIT 50`,
    )
    .all(instanceId) as UiComponentRow[];
}

/** Keep only the newest drafts so repeated edits cannot grow a component without bound. */
function pruneDrafts(db: AppDatabase, componentId: string, keep: number): void {
  const drafts = db
    .prepare("SELECT version FROM ui_component_versions WHERE component_id = ? AND status = 'draft' ORDER BY version DESC")
    .all(hexId(componentId)) as Array<{ version: number }>;
  const doomed = drafts.slice(keep);
  if (!doomed.length) return;
  const remove = db.prepare('DELETE FROM ui_component_versions WHERE component_id = ? AND version = ?');
  for (const item of doomed) remove.run(hexId(componentId), item.version);
}

/**
 * Insert the next immutable version and advance the component pointer in one
 * transaction. Publishing stays a separate step: a new version is always a draft.
 */
export function insertVersionRow(
  db: AppDatabase,
  instanceId: number,
  componentId: string,
  input: VersionCreateInput,
  limits: { maxVersions: number; keepDrafts: number },
): { component: UiComponentRow; version: UiComponentVersionRow } {
  return db.transaction(() => {
    const component = getComponentRow(db, instanceId, componentId);
    if (!component) throw notFound('组件不存在。');
    if (countVersionRows(db, componentId) >= limits.maxVersions) pruneDrafts(db, componentId, limits.keepDrafts);
    if (countVersionRows(db, componentId) >= limits.maxVersions) {
      throw invalid('这个组件的版本太多了，请先清理未发布的草稿版本。');
    }
    const version = component.current_version + 1;
    const now = toDbTimestamp();
    db.prepare(
      `INSERT INTO ui_component_versions (
        id, component_id, version, status, name, description, html, input_schema, state_schema,
        commands, events, protocol_version, created_at
      ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hexId(randomUUID()),
      hexId(componentId),
      version,
      input.name,
      input.description,
      input.html,
      toDbJson(input.inputSchema),
      input.stateSchema ? toDbJson(input.stateSchema) : null,
      toDbJson(input.commands),
      toDbJson(input.events),
      input.protocolVersion,
      now,
    );
    const updated = patchComponentRow(db, instanceId, componentId, {
      currentVersion: version,
      name: input.name,
      description: input.description,
      ...(component.status === 'archived' ? { status: 'draft' as const } : {}),
    });
    const row = getVersionRow(db, componentId, version);
    if (!row) throw new Error('Failed to load the version after insert.');
    return { component: updated, version: row };
  });
}

export function publishVersionRow(
  db: AppDatabase,
  instanceId: number,
  componentId: string,
  version: number,
): { component: UiComponentRow; version: UiComponentVersionRow } {
  return db.transaction(() => {
    const component = getComponentRow(db, instanceId, componentId);
    if (!component) throw notFound('组件不存在。');
    const row = getVersionRow(db, componentId, version);
    if (!row) throw notFound('组件版本不存在。');
    if (row.status !== 'published') {
      db.prepare("UPDATE ui_component_versions SET status = 'published' WHERE component_id = ? AND version = ?")
        .run(hexId(componentId), version);
    }
    const updated = patchComponentRow(db, instanceId, componentId, {
      publishedVersion: version,
      status: 'published',
    });
    const published = getVersionRow(db, componentId, version);
    if (!published) throw notFound('组件版本不存在。');
    return { component: updated, version: published };
  });
}

export function insertBindingRow(
  db: AppDatabase,
  input: {
    instanceId: number;
    conversationId: string;
    componentId: string;
    version: number;
    props: unknown;
    stateSchema: Record<string, unknown> | null;
  },
): UiBindingRow {
  const id = hexId(randomUUID());
  const now = toDbTimestamp();
  db.prepare(
    `INSERT INTO ui_component_bindings (
      id, instance_id, conversation_id, component_id, version, props, state, state_schema,
      created_at, updated_at, revision
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1)`,
  ).run(
    id,
    input.instanceId,
    hexId(input.conversationId),
    hexId(input.componentId),
    input.version,
    toDbJson(input.props),
    input.stateSchema ? toDbJson(input.stateSchema) : null,
    now,
    now,
  );
  const row = getBindingRow(db, input.instanceId, fromDbUuid(id));
  if (!row) throw new Error('Failed to load the binding after insert.');
  return row;
}

export function getBindingRow(db: AppDatabase, instanceId: number, id: string): UiBindingRow | undefined {
  return db
    .prepare('SELECT * FROM ui_component_bindings WHERE id = ? AND instance_id = ?')
    .get(hexId(id), instanceId) as UiBindingRow | undefined;
}

export function updateBindingState(
  db: AppDatabase,
  instanceId: number,
  id: string,
  state: unknown,
  baseRevision: number,
): UiBindingRow {
  return db.transaction(() => {
    const row = getBindingRow(db, instanceId, id);
    if (!row) throw notFound('组件绑定不存在。');
    if (row.revision !== baseRevision) throw conflict('组件状态已在别处更新，请刷新后重试。', { revision: row.revision });
    db.prepare('UPDATE ui_component_bindings SET state = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND instance_id = ?')
      .run(toDbJson(state), toDbTimestamp(), hexId(id), instanceId);
    const updated = getBindingRow(db, instanceId, id);
    if (!updated) throw notFound('组件绑定不存在。');
    return updated;
  });
}

export function insertCommandRow(
  db: AppDatabase,
  bindingId: string,
  name: string,
  payload: unknown,
): UiCommandRow {
  const id = hexId(randomUUID());
  db.prepare(
    `INSERT INTO ui_binding_commands (id, binding_id, name, payload, status, error, created_at, applied_at)
     VALUES (?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
  ).run(id, hexId(bindingId), name, toDbJson(payload), toDbTimestamp());
  const row = db.prepare('SELECT * FROM ui_binding_commands WHERE id = ?').get(id) as UiCommandRow | undefined;
  if (!row) throw new Error('Failed to load the command after insert.');
  return row;
}

export function listPendingCommandRows(db: AppDatabase, bindingId: string): UiCommandRow[] {
  return db
    .prepare("SELECT * FROM ui_binding_commands WHERE binding_id = ? AND status = 'pending' ORDER BY created_at ASC, id ASC")
    .all(hexId(bindingId)) as UiCommandRow[];
}

export function finishCommandRow(
  db: AppDatabase,
  bindingId: string,
  commandId: string,
  result: { ok: boolean; error?: string },
): UiCommandRow {
  return db.transaction(() => {
    const row = db
      .prepare('SELECT * FROM ui_binding_commands WHERE id = ? AND binding_id = ?')
      .get(hexId(commandId), hexId(bindingId)) as UiCommandRow | undefined;
    if (!row) throw notFound('组件命令不存在。');
    if (row.status === 'pending') {
      db.prepare('UPDATE ui_binding_commands SET status = ?, error = ?, applied_at = ? WHERE id = ?')
        .run(result.ok ? 'applied' : 'failed', result.ok ? null : (result.error ?? '命令执行失败。'), toDbTimestamp(), hexId(commandId));
    }
    const updated = db
      .prepare('SELECT * FROM ui_binding_commands WHERE id = ?')
      .get(hexId(commandId)) as UiCommandRow | undefined;
    if (!updated) throw notFound('组件命令不存在。');
    return updated;
  });
}

export function versionDeclarations(
  row: UiComponentVersionRow,
): { commands: UiComponentCommandDeclaration[]; events: UiComponentEventDeclaration[] } {
  return {
    commands: fromDbJson<UiComponentCommandDeclaration[]>(row.commands) ?? [],
    events: fromDbJson<UiComponentEventDeclaration[]>(row.events) ?? [],
  };
}
