export type ApiRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export type ScheduledTaskKind = 'recurring' | 'once';
export type ScheduledTaskStatus = 'active' | 'paused' | 'completed';

export type ScheduledTask = {
  id: string;
  title: string;
  prompt: string;
  kind: ScheduledTaskKind;
  intervalMinutes: number | null;
  runAtMs: number | null;
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  conversationClientId: string | null;
  enabled: boolean;
  status: ScheduledTaskStatus;
  runCount: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

export type CreateScheduledTaskInput = {
  title?: string;
  prompt: string;
  kind: ScheduledTaskKind;
  intervalMinutes?: number | null;
  runAtMs?: number | null;
};

export type PatchScheduledTaskInput = {
  title?: string;
  prompt?: string;
  kind?: ScheduledTaskKind;
  intervalMinutes?: number | null;
  runAtMs?: number | null;
  enabled?: boolean;
  baseRevision?: number;
};

export async function listScheduledTasks(request: ApiRequest): Promise<ScheduledTask[]> {
  const response = await request<{ items: ScheduledTask[] }>('/api/tasks');
  return response.items;
}

export function createScheduledTask(
  request: ApiRequest,
  input: CreateScheduledTaskInput,
): Promise<ScheduledTask> {
  return request<ScheduledTask>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function patchScheduledTask(
  request: ApiRequest,
  taskId: string,
  input: PatchScheduledTaskInput,
): Promise<ScheduledTask> {
  return request<ScheduledTask>(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function triggerScheduledTask(
  request: ApiRequest,
  taskId: string,
  conversationClientId: string,
  triggeredAtMs = Date.now(),
): Promise<ScheduledTask> {
  return request<ScheduledTask>(`/api/tasks/${encodeURIComponent(taskId)}/trigger`, {
    method: 'POST',
    body: JSON.stringify({ conversationClientId, triggeredAtMs }),
  });
}

export function deleteScheduledTask(request: ApiRequest, taskId: string): Promise<void> {
  return request<void>(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
  });
}
