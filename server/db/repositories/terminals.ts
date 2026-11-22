import {
  WORK_CLI_PROVIDERS,
  normalizeWorkCliProviderOrder,
  type WorkCliProvider,
} from '../../../contract/work-cli';
import { DEFAULT_WORK_EDITOR_FONT_SIZE, normalizeWorkEditorFontSize, normalizeWorkProjectOrder } from '../../../contract/work-projects';
import {
  DEFAULT_WINDOWS_SHELL,
  normalizeOptionalWindowsShell,
  normalizeTerminalPreset,
  normalizeWindowsShell,
  normalizeWorkTerminalOrder,
  type WindowsTerminalShell,
  type WorkTerminalSession,
  type WorkTerminalStatus,
} from '../../../contract/work-terminals';
import { fromDbUuid, toDbUuid } from '../codecs';
import type { AppDatabase } from '../client';

export type WorkTerminalRow = {
  id: string;
  instance_id: number;
  project_id: string;
  host_id: string;
  title: string;
  preset: string;
  shell: string | null;
  cli_session_id: string | null;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  pinned: number;
  scrollback: string;
  last_status: string;
  last_exit_code: number | null;
  error_message: string | null;
  created_at_ms: number;
  updated_at_ms: number;
};

export function normalizePersistedTerminalStatus(raw: string): WorkTerminalStatus {
  if (raw === 'exited' || raw === 'error' || raw === 'restored') return raw;
  // Any running session stored on disk before shutdown must wake in `restored` state until re-spawned.
  return 'restored';
}

export function serializeWorkTerminalRow(row: WorkTerminalRow): WorkTerminalSession {
  const shell = normalizeOptionalWindowsShell(row.shell);
  const cliSessionId = row.cli_session_id?.trim() || undefined;
  return {
    id: row.id,
    projectId: fromDbUuid(row.project_id),
    hostId: row.host_id,
    title: row.title,
    preset: normalizeTerminalPreset(row.preset),
    ...(shell ? { shell } : {}),
    ...(cliSessionId ? { cliSessionId } : {}),
    command: row.command,
    cwd: row.cwd,
    status: normalizePersistedTerminalStatus(row.last_status),
    exitCode: row.last_exit_code,
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    pinned: Boolean(row.pinned),
    createdAt: Number(row.created_at_ms) || Date.now(),
  };
}

export function listWorkTerminalRows(db: AppDatabase, instanceId: number): WorkTerminalRow[] {
  return db
    .prepare(
      `SELECT * FROM work_terminals
       WHERE instance_id = ?
       ORDER BY pinned DESC, created_at_ms ASC`,
    )
    .all(instanceId) as WorkTerminalRow[];
}

export function insertWorkTerminalRow(
  db: AppDatabase,
  instanceId: number,
  input: {
    session: WorkTerminalSession;
    cols: number;
    rows: number;
    scrollback: string;
  },
): void {
  const { session, cols, rows, scrollback } = input;
  const now = Date.now();
  db.prepare(`
    INSERT INTO work_terminals (
      id, instance_id, project_id, host_id, title, preset, shell, cli_session_id, command,
      cwd, cols, rows, pinned, scrollback, last_status, last_exit_code,
      error_message, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.id,
    instanceId,
    toDbUuid(session.projectId),
    session.hostId,
    session.title,
    session.preset,
    session.shell ?? null,
    session.cliSessionId ?? null,
    session.command,
    session.cwd,
    cols,
    rows,
    session.pinned ? 1 : 0,
    scrollback,
    session.status,
    session.exitCode,
    session.errorMessage ?? null,
    session.createdAt,
    now,
  );
}

export function updateWorkTerminalMetaRow(
  db: AppDatabase,
  instanceId: number,
  terminalId: string,
  patch: {
    title?: string;
    pinned?: boolean;
    cliSessionId?: string | null;
    command?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
    lastStatus?: WorkTerminalStatus;
    lastExitCode?: number | null;
    errorMessage?: string | null;
  },
): void {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if (patch.title !== undefined) {
    sets.push('title = ?');
    params.push(patch.title);
  }
  if (patch.pinned !== undefined) {
    sets.push('pinned = ?');
    params.push(patch.pinned ? 1 : 0);
  }
  if (patch.cliSessionId !== undefined) {
    sets.push('cli_session_id = ?');
    params.push(patch.cliSessionId);
  }
  if (patch.command !== undefined) {
    sets.push('command = ?');
    params.push(patch.command);
  }
  if (patch.cwd !== undefined) {
    sets.push('cwd = ?');
    params.push(patch.cwd);
  }
  if (patch.cols !== undefined) {
    sets.push('cols = ?');
    params.push(patch.cols);
  }
  if (patch.rows !== undefined) {
    sets.push('rows = ?');
    params.push(patch.rows);
  }
  if (patch.lastStatus !== undefined) {
    sets.push('last_status = ?');
    params.push(patch.lastStatus);
  }
  if (patch.lastExitCode !== undefined) {
    sets.push('last_exit_code = ?');
    params.push(patch.lastExitCode);
  }
  if (patch.errorMessage !== undefined) {
    sets.push('error_message = ?');
    params.push(patch.errorMessage);
  }
  if (sets.length === 0) return;
  sets.push('updated_at_ms = ?');
  params.push(Date.now(), terminalId, instanceId);
  db.prepare(`UPDATE work_terminals SET ${sets.join(', ')} WHERE id = ? AND instance_id = ?`).run(...params);
}

export function saveWorkTerminalSnapshotRow(
  db: AppDatabase,
  instanceId: number,
  terminalId: string,
  input: {
    scrollback: string;
    cwd: string;
    lastStatus: WorkTerminalStatus;
    lastExitCode: number | null;
    errorMessage?: string | null;
  },
): void {
  db.prepare(`
    UPDATE work_terminals
    SET scrollback = ?, cwd = ?, last_status = ?, last_exit_code = ?, error_message = ?, updated_at_ms = ?
    WHERE id = ? AND instance_id = ?
  `).run(
    input.scrollback,
    input.cwd,
    input.lastStatus,
    input.lastExitCode,
    input.errorMessage ?? null,
    Date.now(),
    terminalId,
    instanceId,
  );
}

export function deleteWorkTerminalRow(db: AppDatabase, instanceId: number, terminalId: string): void {
  db.prepare('DELETE FROM work_terminals WHERE id = ? AND instance_id = ?').run(terminalId, instanceId);
}

export function clearWorkTerminalScrollbacks(db: AppDatabase, instanceId: number): void {
  db.prepare(`UPDATE work_terminals SET scrollback = '' WHERE instance_id = ?`).run(instanceId);
}

export type PersistedWorkSettings = {
  defaultWindowsShell: WindowsTerminalShell;
  activeProjectId: string | null;
  activeTerminals: Record<string, string | null>;
  filesPanelOpen: boolean;
  filesPanelWidth: number | null;
  persistTerminalScrollback: boolean;
  editorFontSize: number;
  editorAutoSave: boolean;
  projectOrder: string[];
  cliProviderOrder: WorkCliProvider[];
  terminalOrder: string[];
};

type WorkSettingsRow = {
  instance_id: number;
  default_windows_shell: string;
  active_project_id: string | null;
  active_terminals_json: string;
  files_panel_open: number;
  files_panel_width: number | null;
  persist_terminal_scrollback: number;
  editor_font_size: number;
  editor_auto_save: number;
  project_order_json: string;
  cli_provider_order_json: string;
  terminal_order_json: string;
  updated_at_ms: number;
};

function clampPanelWidth(raw: number | null | undefined): number | null {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return null;
  const rounded = Math.round(raw);
  if (rounded <= 0) return null;
  return Math.max(220, Math.min(640, rounded));
}

function parseActiveTerminalsJson(raw: string): Record<string, string | null> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.trim()) out[key] = value;
      else if (value === null) out[key] = null;
    }
    return out;
  } catch {
    return {};
  }
}

function parseProjectOrderJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? normalizeWorkProjectOrder(parsed) : [];
  } catch {
    return [];
  }
}

function parseTerminalOrderJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? normalizeWorkTerminalOrder(parsed) : [];
  } catch {
    return [];
  }
}

function parseCliProviderOrderJson(raw: string | null | undefined): WorkCliProvider[] {
  if (!raw) return [...WORK_CLI_PROVIDERS];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? normalizeWorkCliProviderOrder(parsed) : [...WORK_CLI_PROVIDERS];
  } catch {
    return [...WORK_CLI_PROVIDERS];
  }
}

export function getWorkSettingsRow(db: AppDatabase, instanceId: number): PersistedWorkSettings {
  const existing = db
    .prepare('SELECT * FROM work_settings WHERE instance_id = ?')
    .get(instanceId) as WorkSettingsRow | undefined;
  if (!existing) {
    return {
      defaultWindowsShell: DEFAULT_WINDOWS_SHELL,
      activeProjectId: null,
      activeTerminals: {},
      filesPanelOpen: true,
      filesPanelWidth: null,
      persistTerminalScrollback: false,
      editorFontSize: DEFAULT_WORK_EDITOR_FONT_SIZE,
      editorAutoSave: false,
      projectOrder: [],
      cliProviderOrder: [...WORK_CLI_PROVIDERS],
      terminalOrder: [],
    };
  }
  return {
    defaultWindowsShell: normalizeWindowsShell(existing.default_windows_shell),
    activeProjectId: existing.active_project_id?.trim() ? existing.active_project_id : null,
    activeTerminals: parseActiveTerminalsJson(existing.active_terminals_json),
    filesPanelOpen: existing.files_panel_open !== 0,
    filesPanelWidth: clampPanelWidth(existing.files_panel_width),
    persistTerminalScrollback: Boolean(existing.persist_terminal_scrollback),
    editorFontSize: normalizeWorkEditorFontSize(existing.editor_font_size),
    editorAutoSave: Boolean(existing.editor_auto_save),
    projectOrder: parseProjectOrderJson(existing.project_order_json),
    cliProviderOrder: parseCliProviderOrderJson(existing.cli_provider_order_json),
    terminalOrder: parseTerminalOrderJson(existing.terminal_order_json),
  };
}

export function updateWorkSettingsRow(
  db: AppDatabase,
  instanceId: number,
  patch: Partial<PersistedWorkSettings>,
): PersistedWorkSettings {
  const current = getWorkSettingsRow(db, instanceId);
  const next: PersistedWorkSettings = {
    defaultWindowsShell: patch.defaultWindowsShell !== undefined
      ? normalizeWindowsShell(patch.defaultWindowsShell)
      : current.defaultWindowsShell,
    activeProjectId: patch.activeProjectId !== undefined
      ? (patch.activeProjectId?.trim() ? patch.activeProjectId : null)
      : current.activeProjectId,
    activeTerminals: patch.activeTerminals !== undefined
      ? parseActiveTerminalsJson(JSON.stringify(patch.activeTerminals))
      : current.activeTerminals,
    filesPanelOpen: patch.filesPanelOpen !== undefined
      ? Boolean(patch.filesPanelOpen)
      : current.filesPanelOpen,
    filesPanelWidth: patch.filesPanelWidth !== undefined
      ? clampPanelWidth(patch.filesPanelWidth)
      : current.filesPanelWidth,
    persistTerminalScrollback: patch.persistTerminalScrollback !== undefined
      ? Boolean(patch.persistTerminalScrollback)
      : current.persistTerminalScrollback,
    editorFontSize: normalizeWorkEditorFontSize(patch.editorFontSize ?? current.editorFontSize),
    editorAutoSave: patch.editorAutoSave ?? current.editorAutoSave,
    projectOrder: patch.projectOrder !== undefined
      ? normalizeWorkProjectOrder(patch.projectOrder)
      : current.projectOrder,
    cliProviderOrder: patch.cliProviderOrder !== undefined
      ? normalizeWorkCliProviderOrder(patch.cliProviderOrder)
      : current.cliProviderOrder,
    terminalOrder: patch.terminalOrder !== undefined
      ? normalizeWorkTerminalOrder(patch.terminalOrder)
      : current.terminalOrder,
  };
  db.prepare(`
    INSERT INTO work_settings (
      instance_id, default_windows_shell, active_project_id, active_terminals_json,
      files_panel_open, files_panel_width, persist_terminal_scrollback, editor_font_size, editor_auto_save,
      project_order_json, cli_provider_order_json, terminal_order_json, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(instance_id) DO UPDATE SET
      default_windows_shell = excluded.default_windows_shell,
      active_project_id = excluded.active_project_id,
      active_terminals_json = excluded.active_terminals_json,
      files_panel_open = excluded.files_panel_open,
      files_panel_width = excluded.files_panel_width,
      persist_terminal_scrollback = excluded.persist_terminal_scrollback,
      editor_font_size = excluded.editor_font_size,
      editor_auto_save = excluded.editor_auto_save,
      project_order_json = excluded.project_order_json,
      cli_provider_order_json = excluded.cli_provider_order_json,
      terminal_order_json = excluded.terminal_order_json,
      updated_at_ms = excluded.updated_at_ms
  `).run(
    instanceId,
    next.defaultWindowsShell,
    next.activeProjectId,
    JSON.stringify(next.activeTerminals),
    next.filesPanelOpen ? 1 : 0,
    next.filesPanelWidth,
    next.persistTerminalScrollback ? 1 : 0,
    next.editorFontSize,
    next.editorAutoSave ? 1 : 0,
    JSON.stringify(next.projectOrder),
    JSON.stringify(next.cliProviderOrder),
    JSON.stringify(next.terminalOrder),
    Date.now(),
  );
  return next;
}
