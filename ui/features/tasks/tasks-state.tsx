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

import { requestTaskSuggestions, type TaskSuggestion } from '@/core/api/agent-aux';
import { useChat } from '@/features/chat/chat-state';
import { useChatRuntime } from '@/features/chat/chat-runtime';
import { useFeature, useInstance } from '@/features/instance/instance-state';
import { pickMemoryModel } from '@/features/memory/memory-model';
import { useMemory } from '@/features/memory/memory-state';
import { useModels } from '@/features/models/model-state';
import { usePersonalization } from '@/features/settings/personalization-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { createMockTasks } from './mock-tasks';
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

export const DEFAULT_TASK_SUGGESTIONS: readonly TaskSuggestion[] = [
  {
    title: '每日 AI 开源早报',
    prompt: '每天早上9点搜索并总结今天 GitHub Trending 上最值得关注的 3 个 AI 开源项目更新，并附原文链接',
  },
  {
    title: '重要发布页巡检',
    prompt: '每隔 6 小时检查一次主要 AI 模型官网是否有新版本或 API 变更公告',
  },
  {
    title: '下班前工作复盘',
    prompt: '每天下午 6 点提醒我梳理今天完成的工作与明天优先级最高的 3 项待办',
  },
  {
    title: '10 分钟后专注提醒',
    prompt: '10 分钟后提醒我起身活动并喝一杯水',
  },
];

type TasksContextValue = {
  tasks: ScheduledTask[];
  suggestions: readonly TaskSuggestion[] | null;
  suggestionsLoading: boolean;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  createTask: (input: CreateScheduledTaskInput) => Promise<ScheduledTask>;
  updateTask: (taskId: string, input: PatchScheduledTaskInput) => Promise<ScheduledTask>;
  removeTask: (taskId: string) => Promise<void>;
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
  const memory = useMemory();
  const { preferences } = usePersonalization();

  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [suggestions, setSuggestions] = useState<readonly TaskSuggestion[] | null>(null);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const conversationsRef = useRef(conversations);
  const runtimeRef = useRef(runtime);
  const modelsRef = useRef(models);
  const memoryRef = useRef(memory);
  const preferencesRef = useRef(preferences);
  const instanceRef = useRef(instance);
  const inFlight = useRef(new Set<string>());
  const suggestionsRequested = useRef(false);

  useEffect(() => {
    conversationsRef.current = conversations;
    runtimeRef.current = runtime;
    modelsRef.current = models;
    memoryRef.current = memory;
    preferencesRef.current = preferences;
    instanceRef.current = instance;
  });

  const canUseServer = !preview && instance.status === 'ready' && tasksEnabled;

  const reload = useCallback(async () => {
    if (!canUseServer) return;
    setLoading(true);
    try {
      const items = await listScheduledTasks(instanceRef.current.request);
      setTasks(items);
      setTasksLoaded(true);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法加载定时任务列表。');
    } finally {
      setLoading(false);
    }
  }, [canUseServer]);

  useEffect(() => {
    if (preview) {
      setTasks(createMockTasks());
      setSuggestions(DEFAULT_TASK_SUGGESTIONS);
      setTasksLoaded(true);
      setError(null);
      return;
    }
    if (!canUseServer) {
      setTasks([]);
      setTasksLoaded(false);
      return;
    }
    void reload();
  }, [preview, canUseServer, reload]);

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

  const removeTask = useCallback(async (taskId: string) => {
    if (preview) {
      setTasks((current) => current.filter((item) => item.id !== taskId));
      return;
    }
    await deleteScheduledTask(instanceRef.current.request, taskId);
    setTasks((current) => current.filter((item) => item.id !== taskId));
  }, [preview]);

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

  useEffect(() => {
    if (!canUseServer || preview || !tasksLoaded || tasks.length > 0) return;
    if (suggestionsRequested.current) return;
    if (!models.ready) return;
    const memoryModel = pickMemoryModel(modelsRef.current);
    if (!memoryModel) {
      setSuggestions(DEFAULT_TASK_SUGGESTIONS);
      return;
    }
    suggestionsRequested.current = true;
    setSuggestionsLoading(true);
    const controller = new AbortController();
    const apiKey = memoryModel.requiresApiKey ? modelsRef.current.getKey(memoryModel.providerId) : '';
    void requestTaskSuggestions({
      config: memoryModel,
      apiKey,
      memorySummary: memoryRef.current.enabled ? memoryRef.current.summary : '',
      customInstructions: preferencesRef.current.customInstructions,
      aboutMore: preferencesRef.current.aboutMore,
      signal: controller.signal,
    }).then((generated) => {
      if (controller.signal.aborted) return;
      setSuggestions(generated?.length ? generated : DEFAULT_TASK_SUGGESTIONS);
    }).catch(() => {
      if (!controller.signal.aborted) setSuggestions(DEFAULT_TASK_SUGGESTIONS);
    }).finally(() => {
      if (!controller.signal.aborted) setSuggestionsLoading(false);
    });
    return () => controller.abort();
  }, [canUseServer, preview, tasksLoaded, tasks.length, models.ready, models.selected?.id, models.memoryModelId]);

  const value = useMemo<TasksContextValue>(() => ({
    tasks,
    suggestions,
    suggestionsLoading,
    loading,
    error,
    reload,
    createTask,
    updateTask,
    removeTask,
    runTaskNow,
  }), [tasks, suggestions, suggestionsLoading, loading, error, reload, createTask, updateTask, removeTask, runTaskNow]);

  return <TasksContext value={value}>{children}</TasksContext>;
}

export function useTasks(): TasksContextValue {
  const value = useContext(TasksContext);
  if (!value) throw new Error('useTasks must be used inside TasksProvider');
  return value;
}
