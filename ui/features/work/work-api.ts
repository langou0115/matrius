import type {
  WorkGitCheckoutRequest,
  WorkGitCommit,
  WorkGitCommitFile,
  WorkGitCommitNode,
  WorkGitDiff,
  WorkGitDiffRequest,
  WorkGitPathsRequest,
  WorkGitStatus,
} from '@contract/work-git';
import {
  CLI_SESSIONS_DEFAULT_FETCH_LIMIT,
  type WorkProjectCliSessionsResponse,
} from '@contract/work-cli';
import type { WorkHost } from '@contract/work-hosts';
import type {
  HostDirectoryListing,
  HostFilePreview,
  WorkHostEntry,
  WorkProject,
  WorkProjectInput,
  WorkProjectUpdateInput,
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
  input: WorkProjectUpdateInput & { baseRevision?: number },
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

export function listProjectCliSessions(
  request: ApiRequest,
  projectId: string,
  limit = CLI_SESSIONS_DEFAULT_FETCH_LIMIT,
  signal?: AbortSignal,
): Promise<WorkProjectCliSessionsResponse> {
  const query = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
  return request<WorkProjectCliSessionsResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/cli-sessions${query}`,
    { signal },
  );
}

export function createPreviewCliSessions(projectId: string): WorkProjectCliSessionsResponse {
  const now = Date.now();
  const items = [
    {
      id: `${projectId}-codex-1`,
      provider: 'codex' as const,
      projectId,
      title: '完善终端断线重连与 SQLite 快照恢复',
      status: 'running' as const,
      updatedAt: now - 10_000,
    },
    {
      id: `${projectId}-codex-2`,
      provider: 'codex' as const,
      projectId,
      title: '优化设置页面返回值与路由守卫',
      status: 'completed' as const,
      updatedAt: now - 120_000,
    },
    {
      id: `${projectId}-codex-3`,
      provider: 'codex' as const,
      projectId,
      title: '拆分 CLI 会话按工具分组与排序持久化',
      status: 'completed' as const,
      updatedAt: now - 240_000,
    },
    {
      id: `${projectId}-codex-4`,
      provider: 'codex' as const,
      projectId,
      title: '支持终端右键复制选中内容与快捷键粘贴',
      status: 'completed' as const,
      updatedAt: now - 360_000,
    },
    {
      id: `${projectId}-codex-5`,
      provider: 'codex' as const,
      projectId,
      title: '清理非运行终端标签页状态圆点',
      status: 'completed' as const,
      updatedAt: now - 480_000,
    },
    {
      id: `${projectId}-codex-6`,
      provider: 'codex' as const,
      projectId,
      title: '重构目录浏览器驱动器切换逻辑',
      status: 'completed' as const,
      updatedAt: now - 600_000,
    },
    {
      id: `${projectId}-codex-7`,
      provider: 'codex' as const,
      projectId,
      title: '补充项目代理分段校验单测',
      status: 'completed' as const,
      updatedAt: now - 720_000,
    },
    {
      id: `${projectId}-agy-1`,
      provider: 'antigravity' as const,
      projectId,
      title: '排查 Windows ConPTY 清屏残留问题',
      status: 'completed' as const,
      updatedAt: now - 300_000,
    },
    {
      id: `${projectId}-agy-2`,
      provider: 'antigravity' as const,
      projectId,
      title: '接入 SSH 密钥认证与主机解锁弹窗',
      status: 'completed' as const,
      updatedAt: now - 2_400_000,
    },
    {
      id: `${projectId}-claude-1`,
      provider: 'claude' as const,
      projectId,
      title: '重构侧栏项目树与 CLI 对话列表',
      status: 'completed' as const,
      updatedAt: now - 90_000,
    },
    {
      id: `${projectId}-claude-2`,
      provider: 'claude' as const,
      projectId,
      title: '补充目录浏览器的权限异常提示测试',
      status: 'completed' as const,
      updatedAt: now - 1_500_000,
    },
  ];
  return {
    projectId,
    items,
    total: items.length,
    hasMore: false,
  };
}

export function readHostFilePreview(
  request: ApiRequest,
  hostId: string,
  path: string,
  signal?: AbortSignal,
): Promise<HostFilePreview> {
  const query = new URLSearchParams({ path });
  return request<HostFilePreview>(`/api/hosts/${encodeURIComponent(hostId)}/fs/preview?${query}`, { signal });
}

export function saveWorkFile(
  request: ApiRequest,
  projectId: string,
  input: { path: string; text: string; baseRevision: string },
): Promise<HostFilePreview> {
  return request<HostFilePreview>(`/api/projects/${encodeURIComponent(projectId)}/files/text`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function browseHostDirectory(
  request: ApiRequest,
  hostId: string,
  path?: string,
  signal?: AbortSignal,
  options?: { refresh?: boolean },
): Promise<HostDirectoryListing> {
  const params: string[] = [];
  if (path) params.push(`path=${encodeURIComponent(path)}`);
  if (options?.refresh) params.push('refresh=1');
  const query = params.length > 0 ? `?${params.join('&')}` : '';
  return request<HostDirectoryListing>(`/api/hosts/${encodeURIComponent(hostId)}/fs${query}`, { signal });
}

export function listWorkTerminals(
  request: ApiRequest,
  projectId?: string,
  signal?: AbortSignal,
): Promise<{ items: WorkTerminalSession[]; platform?: string; windowsBuild?: number }> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return request<{ items: WorkTerminalSession[]; platform?: string; windowsBuild?: number }>(`/api/work/terminals${query}`, { signal });
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

export function readWorkGit(request: ApiRequest, projectId: string, signal?: AbortSignal): Promise<WorkGitStatus> {
  return request<WorkGitStatus>(`/api/projects/${encodeURIComponent(projectId)}/git`, { signal });
}

export function commitWorkGit(request: ApiRequest, projectId: string, input: WorkGitCommit): Promise<{ oid: string }> {
  return request<{ oid: string }>(`/api/projects/${encodeURIComponent(projectId)}/git/commits`, {
    method: 'POST', body: JSON.stringify(input),
  });
}

export function fetchWorkGit(request: ApiRequest, projectId: string): Promise<WorkGitStatus> {
  return request<WorkGitStatus>(`/api/projects/${encodeURIComponent(projectId)}/git/fetch`, { method: 'POST' });
}

export function pullWorkGit(request: ApiRequest, projectId: string): Promise<WorkGitStatus> {
  return request<WorkGitStatus>(`/api/projects/${encodeURIComponent(projectId)}/git/pull`, { method: 'POST' });
}

export function pushWorkGit(request: ApiRequest, projectId: string): Promise<WorkGitStatus> {
  return request<WorkGitStatus>(`/api/projects/${encodeURIComponent(projectId)}/git/push`, { method: 'POST' });
}

export function stageWorkGit(request: ApiRequest, projectId: string, input: WorkGitPathsRequest): Promise<WorkGitStatus> {
  return request<WorkGitStatus>(`/api/projects/${encodeURIComponent(projectId)}/git/stage`, {
    method: 'POST', body: JSON.stringify(input),
  });
}

export function unstageWorkGit(request: ApiRequest, projectId: string, input: WorkGitPathsRequest): Promise<WorkGitStatus> {
  return request<WorkGitStatus>(`/api/projects/${encodeURIComponent(projectId)}/git/unstage`, {
    method: 'POST', body: JSON.stringify(input),
  });
}

export function discardWorkGit(request: ApiRequest, projectId: string, input: WorkGitPathsRequest): Promise<WorkGitStatus> {
  return request<WorkGitStatus>(`/api/projects/${encodeURIComponent(projectId)}/git/discard`, {
    method: 'POST', body: JSON.stringify(input),
  });
}

export function checkoutWorkGit(request: ApiRequest, projectId: string, input: WorkGitCheckoutRequest): Promise<WorkGitStatus> {
  return request<WorkGitStatus>(`/api/projects/${encodeURIComponent(projectId)}/git/checkout`, {
    method: 'POST', body: JSON.stringify(input),
  });
}

export function readWorkGitDiff(
  request: ApiRequest,
  projectId: string,
  file: WorkGitDiffRequest,
  signal?: AbortSignal,
): Promise<WorkGitDiff> {
  const query = new URLSearchParams(file);
  return request<WorkGitDiff>(`/api/projects/${encodeURIComponent(projectId)}/git/diff?${query}`, { signal });
}

export function readWorkGitGraph(request: ApiRequest, projectId: string, signal?: AbortSignal): Promise<WorkGitCommitNode[]> {
  return request<WorkGitCommitNode[]>(`/api/projects/${encodeURIComponent(projectId)}/git/graph`, { signal });
}

export function readWorkGitCommitFiles(request: ApiRequest, projectId: string, oid: string, signal?: AbortSignal): Promise<WorkGitCommitFile[]> {
  return request<WorkGitCommitFile[]>(`/api/projects/${encodeURIComponent(projectId)}/git/commits/${encodeURIComponent(oid)}/files`, { signal });
}

export function readWorkGitCommitDiff(request: ApiRequest, projectId: string, oid: string, path?: string, signal?: AbortSignal): Promise<WorkGitDiff> {
  const query = path ? `?${new URLSearchParams({ path })}` : '';
  return request<WorkGitDiff>(`/api/projects/${encodeURIComponent(projectId)}/git/commits/${encodeURIComponent(oid)}/diff${query}`, { signal });
}
