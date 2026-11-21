import type { WorkHost } from '@contract/work-hosts';
import type {
  HostDirectoryListing,
  WorkHostEntry,
  WorkProject,
  WorkProjectInput,
} from '@contract/work-projects';
import type {
  WorkTerminalCreateInput,
  WorkTerminalPatchInput,
  WorkTerminalResumeInput,
  WorkTerminalSession,
} from '@contract/work-terminals';

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

export function updateWorkProject(
  request: ApiRequest,
  projectId: string,
  input: WorkProjectInput & { baseRevision?: number },
): Promise<WorkProject> {
  return request<WorkProject>(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
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

export function listWorkTerminals(
  request: ApiRequest,
  projectId?: string,
  signal?: AbortSignal,
): Promise<{ items: WorkTerminalSession[]; platform?: string }> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return request<{ items: WorkTerminalSession[]; platform?: string }>(`/api/work/terminals${query}`, { signal });
}

export function createWorkTerminal(
  request: ApiRequest,
  input: WorkTerminalCreateInput,
): Promise<WorkTerminalSession> {
  return request<WorkTerminalSession>('/api/work/terminals', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function resumeWorkTerminal(
  request: ApiRequest,
  terminalId: string,
  input: WorkTerminalResumeInput = {},
): Promise<WorkTerminalSession> {
  return request<WorkTerminalSession>(`/api/work/terminals/${encodeURIComponent(terminalId)}/resume`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function unlockWorkHost(
  request: ApiRequest,
  hostId: string,
  secret: string,
  persist = false,
): Promise<WorkHost> {
  return request<WorkHost>(`/api/hosts/${encodeURIComponent(hostId)}/unlock`, {
    method: 'POST',
    body: JSON.stringify({ secret, persist }),
  });
}

export function updateWorkTerminal(
  request: ApiRequest,
  terminalId: string,
  patch: WorkTerminalPatchInput,
): Promise<WorkTerminalSession> {
  return request<WorkTerminalSession>(`/api/work/terminals/${encodeURIComponent(terminalId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function deleteWorkTerminal(request: ApiRequest, terminalId: string): Promise<void> {
  return request<void>(`/api/work/terminals/${encodeURIComponent(terminalId)}`, {
    method: 'DELETE',
  });
}

export function workTerminalWsUrl(terminalId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/work/terminals/${encodeURIComponent(terminalId)}/ws`;
}

export const PREVIEW_DIRECTORY_TREE: Record<string, { parentPath: string | null; entries: WorkHostEntry[] }> = {
  '/home/dev': {
    parentPath: '/home',
    entries: [
      { kind: 'directory', name: 'projects', path: '/home/dev/projects', accessible: true },
      { kind: 'directory', name: 'restricted', path: '/home/dev/restricted', accessible: false },
      { kind: 'directory', name: 'scripts', path: '/home/dev/scripts', accessible: true },
      { kind: 'directory', name: '.config', path: '/home/dev/.config', accessible: true },
      { kind: 'file', name: 'notes.md', path: '/home/dev/notes.md', accessible: true },
    ],
  },
  '/home/dev/projects': {
    parentPath: '/home/dev',
    entries: [
      { kind: 'directory', name: 'matrius', path: '/home/dev/projects/matrius', accessible: true },
      { kind: 'directory', name: 'sandbox-api', path: '/home/dev/projects/sandbox-api', accessible: true },
      { kind: 'file', name: 'workspace.code-workspace', path: '/home/dev/projects/workspace.code-workspace', accessible: true },
    ],
  },
  '/home/dev/projects/matrius': {
    parentPath: '/home/dev/projects',
    entries: [
      { kind: 'directory', name: 'ui', path: '/home/dev/projects/matrius/ui', accessible: true },
      { kind: 'directory', name: 'server', path: '/home/dev/projects/matrius/server', accessible: true },
      { kind: 'directory', name: 'contract', path: '/home/dev/projects/matrius/contract', accessible: true },
      { kind: 'file', name: 'package.json', path: '/home/dev/projects/matrius/package.json', accessible: true },
      { kind: 'file', name: 'README.md', path: '/home/dev/projects/matrius/README.md', accessible: true },
    ],
  },
  '/home/dev/projects/matrius/ui': {
    parentPath: '/home/dev/projects/matrius',
    entries: [
      { kind: 'file', name: 'main.tsx', path: '/home/dev/projects/matrius/ui/main.tsx', accessible: true },
      { kind: 'file', name: 'global.css', path: '/home/dev/projects/matrius/ui/global.css', accessible: true },
    ],
  },
  '/home/dev/projects/matrius/server': {
    parentPath: '/home/dev/projects/matrius',
    entries: [
      { kind: 'file', name: 'app.ts', path: '/home/dev/projects/matrius/server/app.ts', accessible: true },
    ],
  },
  '/home/dev/projects/matrius/contract': {
    parentPath: '/home/dev/projects/matrius',
    entries: [
      { kind: 'file', name: 'work-projects.ts', path: '/home/dev/projects/matrius/contract/work-projects.ts', accessible: true },
    ],
  },
  '/home/dev/projects/sandbox-api': {
    parentPath: '/home/dev/projects',
    entries: [
      { kind: 'file', name: 'index.ts', path: '/home/dev/projects/sandbox-api/index.ts', accessible: true },
    ],
  },
  '/home/dev/scripts': {
    parentPath: '/home/dev',
    entries: [
      { kind: 'file', name: 'bootstrap.sh', path: '/home/dev/scripts/bootstrap.sh', accessible: true },
    ],
  },
  '/home/dev/.config': {
    parentPath: '/home/dev',
    entries: [],
  },
  '/home': {
    parentPath: '/',
    entries: [
      { kind: 'directory', name: 'dev', path: '/home/dev', accessible: true },
    ],
  },
  '/': {
    parentPath: null,
    entries: [
      { kind: 'directory', name: 'home', path: '/home', accessible: true },
    ],
  },
};

export function createPreviewDirectoryListing(hostId: string, requestedPath?: string): HostDirectoryListing {
  if (requestedPath && !PREVIEW_DIRECTORY_TREE[requestedPath]) {
    throw new Error(`无法访问目录：${requestedPath}`);
  }
  const key = requestedPath ?? '/home/dev';
  const node = PREVIEW_DIRECTORY_TREE[key];
  return {
    hostId,
    path: key,
    parentPath: node.parentPath,
    truncated: false,
    entries: node.entries,
  };
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
