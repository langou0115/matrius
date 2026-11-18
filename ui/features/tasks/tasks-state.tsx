import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';

import { useFeature, useInstance } from '@/features/instance/instance-state';
import { useModels } from '@/features/models/model-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { createMockTasks } from './mock-tasks';
import { useChat } from '@/features/chat/chat-state';
import { useChatRuntime } from '@/features/chat/chat-runtime';
import {
  createScheduledTask,
  deleteScheduledTask,
  listScheduledTasks,
  patchScheduledTask,
  triggerScheduledTask,
  type CreateScheduledTaskInput,
  type PatchScheduledTaskInput,
  type ScheduledTask,
} from './tasks-api';

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const POLL_INTERVAL_MS = 15_000;

type TasksContextValue = {
  tasks: ScheduledTask[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  createTask: (input: CreateScheduledTaskInput) => Promise<ScheduledTask>;
  updateTask: (taskId: string, input: PatchScheduledTaskInput) => Promise<ScheduledTask>;
  removeTask: (taskId: string) => Promise<void>;
  removeTasks: (taskIds: string[]) => Promise<void>;
  runTaskNow: (task: ScheduledTask) => Promise<boolean>;
};

const TasksContext = createContext<TasksContextValue | null>(null);

export function TasksProvider({ children }: PropsWithChildren) {
  const instance = useInstance();
  const preview = useIsPreview();
  const tasksEnabled = useFeature('tasks');
  const { conversations } = useChat();
  const runtime = useChatRuntime();
  const models = useModels();

  const [sourceMode, setSourceMode] = useState<'mock' | 'server'>(() => (preview ? 'mock' : 'server'));
  const [tasks, setTasks] = useState<ScheduledTask[]>(() => (preview ? createMockTasks() : []));
  const [loadedServer, setLoadedServer] = useState(false);
  const [manualReloading, setManualReloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentMode = preview ? 'mock' : 'server';
  if (sourceMode !== currentMode) {
    setSourceMode(currentMode);
    setTasks(preview ? createMockTasks() : []);
    setLoadedServer(false);
    setError(null);
  }

  const conversationsRef = useRef(conversations);
  const runtimeRef = useRef(runtime);
  const modelsRef = useRef(models);
  const instanceRef = useRef(instance);
  const inFlight = useRef(new Set<string>());

  useEffect(() => {
    conversationsRef.current = conversations;
    runtimeRef.current = runtime;
    modelsRef.current = models;
    instanceRef.current = instance;
  });

  const canUseServer = !preview && instance.status === 'ready' && tasksEnabled;

  const reload = useCallback(async () => {
    if (!canUseServer) return;
    setManualReloading(true);
    try {
      const items = await listScheduledTasks(instanceRef.current.request);
      setTasks(items);
      setLoadedServer(true);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法加载定时任务列表。');
    } finally {
      setManualReloading(false);
    }
  }, [canUseServer]);

  useEffect(() => {
    if (!canUseServer) return;
    let cancelled = false;
    listScheduledTasks(instanceRef.current.request)
      .then((items) => {
        if (cancelled) return;
        setTasks(items);
        setLoadedServer(true);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setLoadedServer(true);
        setError(caught instanceof Error ? caught.message : '无法加载定时任务列表。');
      });
    return () => { cancelled = true; };
  }, [canUseServer]);

  const loading = canUseServer && (!loadedServer || manualReloading);

  const visibleTasks = useMemo(
    () => (preview || canUseServer ? tasks : []),
    [preview, canUseServer, tasks],
  );

  const createTask = useCallback(async (input: CreateScheduledTaskInput) => {
    if (preview) {
      const now = Date.now();
      const firstLine = input.prompt.trim().split(/\r?\n/u)[0]?.trim() ?? '定时任务';
      const created: ScheduledTask = {
        id: createId(),
        title: input.title?.trim() || (firstLine.length > 36 ? `${firstLine.slice(0, 36)}…` : firstLine),
        prompt: input.prompt,
        kind: input.kind,
        intervalMinutes: input.kind === 'recurring' ? (input.intervalMinutes ?? 30) : null,
        runAtMs: input.kind === 'once' ? (input.runAtMs ?? now + 600_000) : null,
        nextRunAtMs: input.kind === 'recurring'
          ? now + (input.intervalMinutes ?? 30) * 60_000
          : (input.runAtMs ?? now + 600_000),
        lastRunAtMs: null,
        conversationClientId: null,
        enabled: true,
        status: 'active',
        runCount: 0,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      setTasks((current) => [created, ...current]);
      return created;
    }
    const created = await createScheduledTask(instanceRef.current.request, input);
    setTasks((current) => [created, ...current]);
    return created;
  }, [preview]);

  const updateTask = useCallback(async (taskId: string, input: PatchScheduledTaskInput) => {
    if (preview) {
      let result: ScheduledTask | undefined;
      const now = Date.now();
      setTasks((current) => current.map((item) => {
        if (item.id !== taskId) return item;
        const nextKind = input.kind ?? item.kind;
        const nextEnabled = input.enabled ?? item.enabled;
        const nextInterval = nextKind === 'recurring'
          ? (input.intervalMinutes ?? item.intervalMinutes ?? 30)
          : null;
        const nextRunAt = nextKind === 'once' ? (input.runAtMs ?? item.runAtMs ?? now + 600_000) : null;
        result = {
          ...item,
          title: input.title !== undefined ? (input.title.trim() || item.title) : item.title,
          prompt: input.prompt ?? item.prompt,
          kind: nextKind,
          intervalMinutes: nextInterval,
          runAtMs: nextRunAt,
          enabled: nextEnabled,
          status: nextEnabled ? 'active' : 'paused',
          nextRunAtMs: !nextEnabled ? null : nextKind === 'recurring'
            ? now + (nextInterval ?? 30) * 60_000
            : nextRunAt,
          revision: item.revision + 1,
          updatedAt: now,
        };
        return result;
      }));
      if (!result) throw new Error('定时任务不存在。');
      return result;
    }
    const updated = await patchScheduledTask(instanceRef.current.request, taskId, input);
    setTasks((current) => current.map((item) => (item.id === taskId ? updated : item)));
    return updated;
  }, [preview]);

  const removeTasks = useCallback(async (taskIds: string[]) => {
    const ids = Array.from(new Set(taskIds));
    if (!ids.length) return;
    if (preview) {
      const drop = new Set(ids);
      setTasks((current) => current.filter((item) => !drop.has(item.id)));
      return;
    }
    const results = await Promise.allSettled(
      ids.map((id) => deleteScheduledTask(instanceRef.current.request, id)),
    );
    const deleted = new Set<string>();
    let firstError: unknown;
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') deleted.add(ids[index]);
      else if (firstError === undefined) firstError = result.reason;
    });
    if (deleted.size) {
      setTasks((current) => current.filter((item) => !deleted.has(item.id)));
    }
    if (firstError !== undefined) throw firstError;
  }, [preview]);

  const removeTask = useCallback(async (taskId: string) => {
    await removeTasks([taskId]);
  }, [removeTasks]);

  const runTaskNow = useCallback(async (task: ScheduledTask): Promise<boolean> => {
    if (preview) {
      const now = Date.now();
      const conversationId = task.conversationClientId
        && conversationsRef.current.some((item) => item.id === task.conversationClientId)
        ? task.conversationClientId
        : 'dev-chat-1';
      setTasks((current) => current.map((item) => {
        if (item.id !== task.id) return item;
        const isRecurring = item.kind === 'recurring';
        return {
          ...item,
          lastRunAtMs: now,
          nextRunAtMs: isRecurring && item.intervalMinutes ? now + item.intervalMinutes * 60_000 : null,
          conversationClientId: conversationId,
          enabled: isRecurring ? item.enabled : false,
          status: isRecurring ? (item.enabled ? 'active' : 'paused') : 'completed',
          runCount: item.runCount + 1,
          revision: item.revision + 1,
          updatedAt: now,
        };
      }));
      return true;
    }
    if (!canUseServer || inFlight.current.has(task.id)) return false;
    const currentModels = modelsRef.current;
    if (!currentModels.ready || !currentModels.selected) {
      setError('请先在“设置 → 模型服务”中配置并选择一个可用模型，定时任务才能执行对话。');
      return false;
    }
    const existingConversation = task.conversationClientId
      && conversationsRef.current.some((item) => item.id === task.conversationClientId);
    const conversationId = existingConversation && task.conversationClientId
      ? task.conversationClientId
      : createId();
    if (runtimeRef.current.isRunning(conversationId)) return false;

    inFlight.current.add(task.id);
    try {
      const started = runtimeRef.current.send(
        task.prompt,
        conversationId,
        [],
        undefined,
        [],
        { background: true },
      );
      if (!started) return false;
      const updated = await triggerScheduledTask(
        instanceRef.current.request,
        task.id,
        conversationId,
        Date.now(),
      );
      setTasks((current) => current.map((item) => (item.id === task.id ? updated : item)));
      setError(null);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '定时任务执行失败。');
      return false;
    } finally {
      inFlight.current.delete(task.id);
    }
  }, [preview, canUseServer]);

  const tasksRef = useRef(tasks);
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  const runningCount = Object.keys(runtime.runs).length;
  const previousRunningCount = useRef(runningCount);
  useEffect(() => {
    const prev = previousRunningCount.current;
    previousRunningCount.current = runningCount;
    if (canUseServer && !preview && runningCount < prev) {
      void reload();
    }
  }, [canUseServer, preview, runningCount, reload]);

  useEffect(() => {
    if (!canUseServer || !models.ready || !models.selected) return;
    const checkDue = () => {
      const now = Date.now();
      for (const task of tasksRef.current) {
        if (!task.enabled || task.status !== 'active' || task.nextRunAtMs === null) continue;
        if (task.nextRunAtMs <= now) {
          void runTaskNow(task);
        }
      }
    };
    checkDue();
    const timer = window.setInterval(checkDue, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [canUseServer, models.ready, models.selected, tasks.length, runTaskNow]);

  const value = useMemo<TasksContextValue>(() => ({
    tasks: visibleTasks,
    loading,
    error,
    reload,
    createTask,
    updateTask,
    removeTask,
    removeTasks,
    runTaskNow,
  }), [visibleTasks, loading, error, reload, createTask, updateTask, removeTask, removeTasks, runTaskNow]);

  return <TasksContext value={value}>{children}</TasksContext>;
}

export function useTasks(): TasksContextValue {
  const value = useContext(TasksContext);
  if (!value) throw new Error('useTasks must be used inside TasksProvider');
  return value;
}
