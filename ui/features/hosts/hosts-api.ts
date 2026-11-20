import type { WorkHost, WorkHostInput, WslDiscoveryResult } from '@contract/work-hosts';

type ApiRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export function listWorkHosts(request: ApiRequest, signal?: AbortSignal): Promise<{ items: WorkHost[] }> {
  return request<{ items: WorkHost[] }>('/api/hosts', { signal });
}

export function createWorkHost(request: ApiRequest, input: WorkHostInput): Promise<WorkHost> {
  return request<WorkHost>('/api/hosts', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateWorkHost(
  request: ApiRequest,
  hostId: string,
  input: WorkHostInput & { baseRevision: number },
): Promise<WorkHost> {
  return request<WorkHost>(`/api/hosts/${encodeURIComponent(hostId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteWorkHost(request: ApiRequest, hostId: string, baseRevision?: number): Promise<void> {
  const query = baseRevision !== undefined ? `?baseRevision=${baseRevision}` : '';
  return request<void>(`/api/hosts/${encodeURIComponent(hostId)}${query}`, {
    method: 'DELETE',
  });
}

export function connectWorkHost(request: ApiRequest, hostId: string): Promise<WorkHost> {
  return request<WorkHost>(`/api/hosts/${encodeURIComponent(hostId)}/connect`, {
    method: 'POST',
    body: '{}',
  });
}

export function disconnectWorkHost(request: ApiRequest, hostId: string): Promise<WorkHost> {
  return request<WorkHost>(`/api/hosts/${encodeURIComponent(hostId)}/disconnect`, {
    method: 'POST',
    body: '{}',
  });
}

export function discoverWslDistros(request: ApiRequest, signal?: AbortSignal): Promise<WslDiscoveryResult> {
  return request<WslDiscoveryResult>('/api/hosts/wsl/discover', { signal });
}
