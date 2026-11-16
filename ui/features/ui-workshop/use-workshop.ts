import { useCallback, useEffect, useRef, useState } from 'react';

import { memoryPromptBlock } from '@contract/agent-memory';
import { buildSystemPrompt } from '@contract/agent-prompt';
import type { Message, MessageFile, MessageImage } from '@contract/agent-types';
import { createRemoteAgentRuntime } from '@/core/api/agent-runs';
import { useInstance } from '@/features/instance/instance-state';
import { useMemory } from '@/features/memory/memory-state';
import { useModels } from '@/features/models/model-state';
import { usePersonalization } from '@/features/settings/personalization-state';

const enc = encodeURIComponent;
const EMPTY_MESSAGES: Message[] = [];

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  return '请求失败，请重试。';
}

type StoredMessage = {
  id?: unknown;
  clientId?: unknown;
  role?: unknown;
  content?: unknown;
  status?: unknown;
  error?: unknown;
  files?: unknown;
  fileIds?: unknown;
  steering?: unknown;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isMessageFile(value: unknown): value is MessageFile {
  if (!value || typeof value !== 'object') return false;
  const file = value as Record<string, unknown>;
  return typeof file.id === 'string' && typeof file.filename === 'string'
    && typeof file.contentType === 'string' && typeof file.size === 'number';
}

function toMessage(row: StoredMessage): Message | null {
  if (row.role !== 'user' && row.role !== 'assistant') return null;
  const status = row.status === 'complete' || row.status === 'stopped' || row.status === 'error' ? row.status : undefined;
  const files = Array.isArray(row.files) ? row.files.filter(isMessageFile) : [];
  const fileIds = Array.isArray(row.fileIds)
    ? row.fileIds.filter((id): id is string => typeof id === 'string' && UUID.test(id)).slice(0, 20)
    : [];
  return {
    id: String(row.clientId ?? row.id ?? createId()),
    role: row.role,
    content: typeof row.content === 'string' ? row.content : '',
    ...(status ? { status } : {}),
    ...(typeof row.error === 'string' && row.error ? { error: row.error } : {}),
    ...(files.length ? { files } : {}),
    ...(fileIds.length ? { fileIds } : {}),
    ...(row.role === 'user' && row.steering === true ? { steering: true as const } : {}),
  };
}

async function persistMessage(
  request: <T>(path: string, init?: RequestInit) => Promise<T>,
  conversationId: string,
  message: Message,
): Promise<void> {
  const fileIds = [...new Set([
    ...(message.fileIds ?? []),
    ...(message.files ?? []).map((file) => file.id),
  ])].filter((id) => UUID.test(id)).slice(0, 20);
  await request(`/api/conversations/${enc(conversationId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      clientId: message.id,
      role: message.role,
      content: message.content,
      ...(fileIds.length ? { fileIds } : {}),
      ...(message.role === 'user' && message.steering ? { steering: true } : {}),
      ...(message.role === 'assistant'
        ? { status: message.status === 'streaming' || !message.status ? 'stopped' : message.status, ...(message.error ? { error: message.error } : {}) }
        : {}),
    }),
  });
}

export type WorkshopChat = ReturnType<typeof useWorkshopChat>;

/**
 * The workshop conversation reuses the same server Agent, SSE transport and
 * messages table as ordinary chat. Messages are kept per conversation so
 * switching components never shows the previous component's turns, and the
 * workshop session stays out of the chat sidebar because the server filters
 * `kind = 'workshop'` out of `/api/conversations`.
 */
export function useWorkshopChat(options: {
  componentId: string | null;
  conversationId: string | null;
  onChange: () => void;
}) {
  const { request } = useInstance();
  const models = useModels();
  const { preferences } = usePersonalization();
  const memory = useMemory();
  const [messagesByConversation, setMessagesByConversation] = useState<Record<string, Message[]>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  // Which conversation has finished loading its stored turns, so the page can wait
  // before auto-sending the prompt that created the component.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const conversationKey = options.conversationId ?? '';
  const messages = messagesByConversation[conversationKey] ?? EMPTY_MESSAGES;
  const messagesRef = useRef(messages);
  const runningRef = useRef(running);
  const persisted = useRef(new Set<string>());
  const contextRef = useRef({ request, models, preferences, memory, onChange: options.onChange });
  const agentRef = useRef<ReturnType<typeof createRemoteAgentRuntime> | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => {
    contextRef.current = { request, models, preferences, memory, onChange: options.onChange };
  });

  // The runtime is created after mount so its callbacks only read refs, never
  // values captured during render.
  useEffect(() => {
    const agent = createRemoteAgentRuntime({
      onReply: (conversationId, message) => {
        setMessagesByConversation((current) => {
          const list = current[conversationId] ?? EMPTY_MESSAGES;
          const index = list.findIndex((item) => item.id === message.id);
          const next = index < 0
            ? [...list, message]
            : list.map((item, position) => (position === index ? message : item));
          return { ...current, [conversationId]: next };
        });
        const context = contextRef.current;
        if (message.uiComponentChange) context.onChange();
        if (message.status && message.status !== 'streaming') {
          setRunning((current) => (current[conversationId] ? { ...current, [conversationId]: false } : current));
          if (!persisted.current.has(message.id)) {
            persisted.current.add(message.id);
            void persistMessage(context.request, conversationId, message)
              .catch(() => setNotice('工坊对话记录保存失败，本轮内容仍保留在当前页面。'));
          }
          context.onChange();
        }
      },
    });
    agentRef.current = agent;
    return () => {
      agent.stop();
      agent.dispose();
      agentRef.current = null;
    };
  }, []);

  // Load the stored turns when a component is selected. A run already in flight
  // owns its conversation, so its live messages are not overwritten by the read.
  useEffect(() => {
    const conversationId = options.conversationId;
    if (!conversationId) return undefined;
    let cancelled = false;
    void (async () => {
      if (runningRef.current[conversationId]) return;
      try {
        const detail = await request<{ messages: StoredMessage[] }>(
          `/api/conversations/${enc(conversationId)}?messageLimit=200`,
        );
        if (cancelled || runningRef.current[conversationId]) return;
        const loaded = detail.messages.map(toMessage).filter((item): item is Message => Boolean(item));
        setMessagesByConversation((current) => ({ ...current, [conversationId]: loaded }));
        setLoadedFor(conversationId);
        setError(null);
        setNotice(null);
      } catch (reason) {
        if (!cancelled) setError(`无法加载工坊对话：${errorMessage(reason)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [options.conversationId, request]);

  const send = useCallback(async (text: string, images: MessageImage[] = [], files: MessageFile[] = []) => {
    const content = text.trim();
    const { componentId, conversationId } = options;
    if ((!content && !images.length && !files.length) || !componentId || !conversationId || runningRef.current[conversationId]) return false;
    const agent = agentRef.current;
    if (!agent) {
      setError('UI 工坊正在初始化，请稍后重试。');
      return false;
    }
    const context = contextRef.current;
    const config = context.models.selected;
    if (!config) {
      setError('请先在设置 → 模型服务中添加并选择模型。');
      return false;
    }
    const apiKey = config.requiresApiKey ? context.models.getKey(config.providerId) : '';
    const userMessage: Message = {
      id: createId(),
      role: 'user',
      content,
      ...(images.length ? { images } : {}),
      ...(files.length ? { files, fileIds: files.map((file) => file.id) } : {}),
    };
    setRunning((current) => ({ ...current, [conversationId]: true }));
    setError(null);
    try {
      await persistMessage(context.request, conversationId, userMessage);
    } catch (reason) {
      setRunning((current) => ({ ...current, [conversationId]: false }));
      setError(`发送失败：${errorMessage(reason)}`);
      return false;
    }
    const history = [...messagesRef.current, userMessage];
    setMessagesByConversation((current) => ({
      ...current,
      [conversationId]: [...(current[conversationId] ?? EMPTY_MESSAGES), userMessage],
    }));
    const started = agent.start({
      conversationId,
      replyId: createId(),
      messages: history,
      config,
      apiKey,
      thinkingEffort: config.thinkingEffort ?? 'low',
      memoryText: memoryPromptBlock(context.memory),
      systemPrompt: buildSystemPrompt(context.preferences),
      // Files stay enabled so an attached document can be read while designing the component.
      enabledTools: { ui: true, web: false, files: true },
      scope: 'workshop',
      uiComponentId: componentId,
    });
    if (!started) {
      setRunning((current) => ({ ...current, [conversationId]: false }));
      setError('无法启动生成，请检查模型配置或稍后重试。');
      return false;
    }
    return true;
  }, [options]);

  /** A supplement while the workshop run is still generating, matching the chat composer. */
  const steer = useCallback(async (text: string) => {
    const content = text.trim();
    const conversationId = options.conversationId;
    if (!content || !conversationId || !runningRef.current[conversationId]) return false;
    const agent = agentRef.current;
    if (!agent) return false;
    const message: Message = { id: createId(), role: 'user', content, steering: true };
    if (!agent.steer(conversationId, message)) return false;
    setMessagesByConversation((current) => ({
      ...current,
      [conversationId]: [...(current[conversationId] ?? EMPTY_MESSAGES), message],
    }));
    void persistMessage(contextRef.current.request, conversationId, message)
      .catch(() => setNotice('补充消息保存失败。'));
    return true;
  }, [options.conversationId]);

  const stop = useCallback(() => {
    const conversationId = options.conversationId;
    if (!conversationId) return;
    agentRef.current?.stop(conversationId);
    setRunning((current) => (current[conversationId] ? { ...current, [conversationId]: false } : current));
  }, [options.conversationId]);

  return {
    messages,
    loaded: Boolean(conversationKey) && loadedFor === conversationKey,
    sending: conversationKey ? Boolean(running[conversationKey]) : false,
    error,
    notice,
    clearError: () => setError(null),
    clearNotice: () => setNotice(null),
    send,
    steer,
    stop,
  };
}
