import {
  normalizeWorkCliProviderOrder,
  type WorkCliProvider,
} from '@contract/work-cli';
import { normalizeWorkEditorFontSize, normalizeWorkProjectOrder } from '@contract/work-projects';
import {
  DEFAULT_WINDOWS_SHELL,
  normalizeWindowsShell,
  normalizeWorkTerminalOrder,
  type WindowsTerminalShell,
} from '@contract/work-terminals';

export type WorkSettingsPayload = {
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

type ApiRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export async function loadWorkSettings(request: ApiRequest): Promise<WorkSettingsPayload> {
  const res = await request<Partial<WorkSettingsPayload>>('/api/work/settings');
  return {
    defaultWindowsShell: normalizeWindowsShell(res.defaultWindowsShell ?? DEFAULT_WINDOWS_SHELL),
    activeProjectId: typeof res.activeProjectId === 'string' && res.activeProjectId.trim()
      ? res.activeProjectId
      : null,
    activeTerminals: res.activeTerminals && typeof res.activeTerminals === 'object' && !Array.isArray(res.activeTerminals)
      ? res.activeTerminals
      : {},
    filesPanelOpen: res.filesPanelOpen !== false,
    filesPanelWidth: typeof res.filesPanelWidth === 'number' && Number.isFinite(res.filesPanelWidth)
      ? res.filesPanelWidth
      : null,
    persistTerminalScrollback: res.persistTerminalScrollback === true,
    editorFontSize: normalizeWorkEditorFontSize(res.editorFontSize),
    editorAutoSave: res.editorAutoSave === true,
    projectOrder: normalizeWorkProjectOrder(res.projectOrder),
    cliProviderOrder: normalizeWorkCliProviderOrder(res.cliProviderOrder),
    terminalOrder: normalizeWorkTerminalOrder(res.terminalOrder),
  };
}

export function saveWorkSettings(
  request: ApiRequest,
  patch: Partial<WorkSettingsPayload>,
): Promise<WorkSettingsPayload> {
  return request<WorkSettingsPayload>('/api/work/settings', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

export async function loadDefaultWindowsShell(request: ApiRequest): Promise<WindowsTerminalShell> {
  const settings = await loadWorkSettings(request);
  return settings.defaultWindowsShell;
}

export async function saveDefaultWindowsShell(
  request: ApiRequest,
  shell: WindowsTerminalShell,
): Promise<WindowsTerminalShell> {
  const saved = await saveWorkSettings(request, {
    defaultWindowsShell: normalizeWindowsShell(shell),
  });
  return normalizeWindowsShell(saved.defaultWindowsShell ?? shell);
}

export async function savePersistTerminalScrollback(
  request: ApiRequest,
  enabled: boolean,
): Promise<boolean> {
  const saved = await saveWorkSettings(request, {
    persistTerminalScrollback: Boolean(enabled),
  });
  return saved.persistTerminalScrollback === true;
}
