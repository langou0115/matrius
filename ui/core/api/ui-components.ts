import type {
  UiBindingSnapshot,
  UiComponentDetail,
  UiComponentSummary,
  UiComponentVersionContent,
} from '@contract/ui-component';

type ApiRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

const enc = encodeURIComponent;

export function listUiComponents(
  request: ApiRequest,
  query?: string,
): Promise<{ items: UiComponentSummary[] }> {
  const suffix = query?.trim() ? `?q=${enc(query.trim())}` : '';
  return request(`/api/ui/components${suffix}`);
}

export function createUiComponent(
  request: ApiRequest,
  input: { name?: string; description?: string; stateful?: boolean } = {},
): Promise<{ component: UiComponentSummary; conversationId: string }> {
  return request('/api/ui/components', { method: 'POST', body: JSON.stringify(input) });
}

export function getUiComponent(request: ApiRequest, id: string): Promise<UiComponentDetail> {
  return request(`/api/ui/components/${enc(id)}`);
}

export function patchUiComponent(
  request: ApiRequest,
  id: string,
  input: { name?: string; description?: string; baseRevision: number },
): Promise<UiComponentSummary> {
  return request(`/api/ui/components/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function archiveUiComponent(request: ApiRequest, id: string, baseRevision: number): Promise<{ ok: true }> {
  return request(`/api/ui/components/${enc(id)}?baseRevision=${baseRevision}`, { method: 'DELETE' });
}

export function publishUiComponent(
  request: ApiRequest,
  id: string,
  version: number,
  baseRevision: number,
): Promise<{ component: UiComponentSummary; version: UiComponentVersionContent }> {
  return request(`/api/ui/components/${enc(id)}/publish`, {
    method: 'POST',
    body: JSON.stringify({ version, baseRevision }),
  });
}

export function getUiComponentVersion(
  request: ApiRequest,
  id: string,
  version: number,
): Promise<{ version: UiComponentVersionContent }> {
  return request(`/api/ui/components/${enc(id)}/versions/${version}`);
}

export function getLatestUiComponentVersion(
  request: ApiRequest,
  id: string,
): Promise<{ version: UiComponentVersionContent }> {
  return request(`/api/ui/components/${enc(id)}/latest`);
}

export function getUiBinding(request: ApiRequest, id: string): Promise<{ binding: UiBindingSnapshot }> {
  return request(`/api/ui/bindings/${enc(id)}`);
}

export function saveUiBindingState(
  request: ApiRequest,
  id: string,
  state: unknown,
  baseRevision: number,
): Promise<{ revision: number }> {
  return request(`/api/ui/bindings/${enc(id)}/state`, {
    method: 'POST',
    body: JSON.stringify({ state, baseRevision }),
  });
}

export function reportUiCommandResult(
  request: ApiRequest,
  bindingId: string,
  commandId: string,
  result: { ok: boolean; error?: string; state?: unknown; baseRevision: number },
): Promise<{ revision?: number; status: 'applied' | 'failed' }> {
  return request(`/api/ui/bindings/${enc(bindingId)}/commands/${enc(commandId)}/result`, {
    method: 'POST',
    body: JSON.stringify(result),
  });
}
