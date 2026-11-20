import type { WorkHost } from '@contract/work-hosts';
import type {
  HostDirectoryListing,
  WorkProject,
  WorkProjectInput,
} from '@contract/work-projects';

type ApiRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export function listWorkProjects(request: ApiRequest, signal?: AbortSignal): Promise<{ items: WorkProject[] }> {
  return request<{ items: WorkProject[] }>('/api/projects', { signal });
}

export function createWorkProject(request: ApiRequest, input: WorkProjectInput): Promise<WorkProject> {
  return request<WorkProject>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteWorkProject(request: ApiRequest, projectId: string, baseRevision?: number): Promise<void> {
  const query = baseRevision !== undefined ? `?baseRevision=${baseRevision}` : '';
  return request<void>(`/api/projects/${encodeURIComponent(projectId)}${query}`, {
    method: 'DELETE',
  });
}

export function browseHostDirectory(
  request: ApiRequest,
  hostId: string,
  path?: string,
  signal?: AbortSignal,
): Promise<HostDirectoryListing> {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  return request<HostDirectoryListing>(`/api/hosts/${encodeURIComponent(hostId)}/fs${query}`, { signal });
}

export function createPreviewWorkHosts(): WorkHost[] {
  const now = Date.now();
  return [
    {
      id: 'mock-host-wsl',
      kind: 'wsl',
      name: 'Ubuntu-24.04',
      host: '',
      port: 22,
      username: 'matrius',
      authMethod: 'agent',
      privateKeyPath: '',
      hasSecret: false,
      distro: 'Ubuntu-24.04',
      defaultDirectory: '',
      note: '',
      status: 'connected',
      statusMessage: 'WSL 发行版连接正常',
      lastCheckedAt: now,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'mock-host-ssh',
      kind: 'ssh',
      name: '开发服务器',
      host: '192.168.10.24',
      port: 22,
      username: 'dev',
      authMethod: 'key',
      privateKeyPath: '~/.ssh/id_ed25519',
      hasSecret: false,
      distro: '',
      defaultDirectory: '',
      note: '',
      status: 'connected',
      statusMessage: '连接成功',
      lastCheckedAt: now,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
  ];
}
