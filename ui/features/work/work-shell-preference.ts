import {
  DEFAULT_WINDOWS_SHELL,
  normalizeWindowsShell,
  type WindowsTerminalShell,
} from '@contract/work-terminals';

export type WorkSettingsPayload = {
  defaultWindowsShell: WindowsTerminalShell;
  activeProjectId: string | null;
  activeTerminals: Record<string, string | null>;
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
