import { readWorkspace } from '@/core/database/browser-store.web';
import type { ConversationSummary } from '@/core/agent/compaction';
import type { MessageFile, ProcessActivity, WebActivity, WebSearchResult } from '@/core/agent/types';
import type { Conversation, Message, PersistedChatState } from '@/features/chat/chat-state';
import { orderSteeringMessages } from '@/features/chat/message-order';
import type { AppearancePreferences } from '@/theme/appearance';
import { themePresets, type ThemeId } from '@/theme/presets';
import { readPersonalization, type PersonalizationPreferences } from '@/features/settings/personalization';

export type WorkspaceData = { schemaVersion: 1; chat: PersistedChatState; appearance: AppearancePreferences; personalization?: PersonalizationPreferences };
export type LoadedWorkspace = { data: WorkspaceData; revision: number };

/** Attached images are request-only: keep their bytes out of every snapshot written to storage.
    The in-memory messages are untouched, so the pictures stay visible until the page reloads. */
export function stripMessageImages(conversations: Conversation[]): Conversation[] {
  return conversations.map((conversation) => ({
    ...conversation,
    messages: conversation.messages.map(({ images, ...message }) => message),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isThemeId(value: unknown): value is ThemeId { return themePresets.some((preset) => preset.id === value); }
function readSearchResult(value: unknown): WebSearchResult[] {
  if (!isRecord(value) || typeof value.title !== 'string' || typeof value.url !== 'string') return [];
  return [{
    title: value.title,
    url: value.url,
    snippet: typeof value.snippet === 'string' ? value.snippet : '',
    domain: typeof value.domain === 'string' ? value.domain : '',
    engine: typeof value.engine === 'string' ? value.engine : '',
    rank: typeof value.rank === 'number' && Number.isFinite(value.rank) ? value.rank : 0,
  }];
}
/** Tool activity is optional decoration for an already-saved reply. A malformed entry is
    dropped rather than failing the whole workspace load. */
export function readActivities(value: unknown): WebActivity[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const activities: WebActivity[] = [];
  for (const item of value.slice(-50)) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id) continue;
    if (item.kind !== 'search' && item.kind !== 'fetch' && item.kind !== 'file') continue;
    if (item.status !== 'running' && item.status !== 'complete' && item.status !== 'stopped' && item.status !== 'error') continue;
    const results = item.kind === 'search' && Array.isArray(item.results)
      ? item.results.slice(0, 20).flatMap(readSearchResult)
      : undefined;
    activities.push({
      id: item.id,
      kind: item.kind,
      // No live runtime survives a document reload. Never restore a perpetual spinner.
      status: item.status === 'running' ? 'stopped' : item.status,
      ...(typeof item.query === 'string' ? { query: item.query } : {}),
      ...(results?.length ? { results } : {}),
      ...(typeof item.url === 'string' ? { url: item.url } : {}),
      ...(Array.isArray(item.urls) && item.urls.every((url) => typeof url === 'string') ? { urls: item.urls.slice(0, 4) } : {}),
      ...(typeof item.title === 'string' ? { title: item.title } : {}),
      ...(typeof item.operation === 'string' ? { operation: item.operation } : {}),
      ...(typeof item.fileId === 'string' ? { fileId: item.fileId } : {}),
      ...(typeof item.savedFileId === 'string' ? { savedFileId: item.savedFileId } : {}),
      ...(typeof item.filename === 'string' ? { filename: item.filename } : {}),
      ...(typeof item.size === 'number' && Number.isFinite(item.size) ? { size: item.size } : {}),
      ...(typeof item.warning === 'string' ? { warning: item.warning } : {}),
      ...(typeof item.tookMs === 'number' && Number.isFinite(item.tookMs) ? { tookMs: item.tookMs } : {}),
      ...(typeof item.error === 'string' ? { error: item.error } : {}),
      ...(typeof item.startedAt === 'number' && Number.isFinite(item.startedAt) ? { startedAt: item.startedAt } : {}),
      ...(typeof item.endedAt === 'number' && Number.isFinite(item.endedAt) ? { endedAt: item.endedAt } : {}),
    });
  }
  return activities.length ? activities : undefined;
}
function readProcess(value: unknown): ProcessActivity[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const process: ProcessActivity[] = [];
  const ids = new Set<string>();
  for (const item of value.slice(-100)) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id)) continue;
    if (item.kind !== 'thinking') {
      const tool = readActivities([item])?.[0];
      if (tool) { process.push(tool); ids.add(tool.id); }
      continue;
    }
    if (typeof item.content !== 'string' || !['running', 'complete', 'stopped', 'error'].includes(String(item.status))) continue;
    process.push({ id: item.id, kind: 'thinking', content: item.content,
      status: item.status === 'running' ? 'stopped' : item.status as 'complete' | 'stopped' | 'error',
      ...(typeof item.startedAt === 'number' && Number.isFinite(item.startedAt) ? { startedAt: item.startedAt } : {}),
      ...(typeof item.endedAt === 'number' && Number.isFinite(item.endedAt) ? { endedAt: item.endedAt } : {}),
    });
    ids.add(item.id);
  }
  return process.length ? process : undefined;
}
/** Stored file metadata is display-only; a malformed entry is dropped like a bad activity. */
export function readMessageFiles(value: unknown): MessageFile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files: MessageFile[] = [];
  for (const item of value.slice(0, 30)) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || typeof item.filename !== 'string' || !item.filename) continue;
    files.push({
      id: item.id,
      filename: item.filename,
      contentType: typeof item.contentType === 'string' ? item.contentType : 'application/octet-stream',
      size: typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : 0,
      ...(typeof item.revision === 'number' && Number.isFinite(item.revision) ? { revision: item.revision } : {}),
    });
  }
  return files.length ? files : undefined;
}
export function readFileIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = [...new Set(value.filter((id): id is string => typeof id === 'string' && !!id))].slice(0, 20);
  return ids.length ? ids : undefined;
}
function readMessage(value: unknown): Message {
  if (!isRecord(value) || typeof value.id !== 'string' || (value.role !== 'user' && value.role !== 'assistant') || typeof value.content !== 'string') throw new Error('Invalid stored message');
  const status = value.status === 'streaming' ? 'stopped' : ['complete', 'stopped', 'error'].includes(String(value.status)) ? value.status as Message['status'] : undefined;
  const activities = value.role === 'assistant' ? readActivities(value.activities) : undefined;
  const process = value.role === 'assistant' ? readProcess(value.process) : undefined;
  const fileIds = readFileIds(value.fileIds);
  const files = readMessageFiles(value.files);
  return { id: value.id, role: value.role, content: value.content,
    ...(fileIds ? { fileIds } : {}),
    ...(files ? { files } : {}),
    ...(value.role === 'user' && value.steering === true ? { steering: true as const } : {}),
    ...(typeof value.quote === 'string' ? { quote: value.quote } : {}),
    ...(value.role === 'assistant' && (value.feedback === 'good' || value.feedback === 'bad') ? { feedback: value.feedback } : {}),
    ...(typeof value.reasoning === 'string' ? { reasoning: value.reasoning } : {}),
    ...(activities ? { activities } : {}),
    ...(process ? { process } : {}),
    ...(typeof value.thinkingMs === 'number' && Number.isFinite(value.thinkingMs) ? { thinkingMs: value.thinkingMs } : {}),
    ...(status ? { status } : {}),
    ...(value.status === 'streaming' ? { error: '页面重新加载，回答已中断。已生成内容已保留。' }
      : typeof value.error === 'string' ? { error: value.error } : {}),
  };
}
/** A summary is a cache of derived context: malformed or stale data is dropped and rebuilt. */
function readContextSummary(value: unknown): ConversationSummary | undefined {
  if (!isRecord(value) || typeof value.coveredUntilMessageId !== 'string' || !value.coveredUntilMessageId
    || typeof value.summary !== 'string' || !value.summary.trim()) return undefined;
  return { coveredUntilMessageId: value.coveredUntilMessageId, summary: value.summary };
}
function readConversation(value: unknown): Conversation {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.pinned !== 'boolean' || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || !Array.isArray(value.messages)) throw new Error('Invalid stored conversation');
  if (value.errorReadAt !== undefined && value.errorReadAt !== null && (typeof value.errorReadAt !== 'number' || !Number.isFinite(value.errorReadAt))) throw new Error('Invalid stored conversation error status');
  if (value.completedReadAt !== undefined && value.completedReadAt !== null && (typeof value.completedReadAt !== 'number' || !Number.isFinite(value.completedReadAt))) throw new Error('Invalid stored conversation completion status');
  const titleSource = value.titleSource === 'auto' || value.titleSource === 'ai' || value.titleSource === 'manual' ? value.titleSource : undefined;
  const contextSummary = readContextSummary(value.contextSummary);
  return { id: value.id, title: value.title, pinned: value.pinned, updatedAt: value.updatedAt,
    ...(typeof value.modelId === 'string' ? { modelId: value.modelId } : {}),
    ...(titleSource ? { titleSource } : {}),
    ...(contextSummary ? { contextSummary } : {}),
    messages: orderSteeringMessages(value.messages.map(readMessage)),
    ...(value.errorReadAt !== undefined ? { errorReadAt: value.errorReadAt as number | null } : {}),
    ...(value.completedReadAt !== undefined ? { completedReadAt: value.completedReadAt as number | null } : {}) };
}

export async function loadWorkspace(): Promise<LoadedWorkspace> {
  const stored = await readWorkspace();
  if (!stored) return { revision: 0, data: { schemaVersion: 1, chat: { conversations: [], activeId: null, sidebarOpen: true }, appearance: { themeId: 'twitter', mode: 'system' } } };
  return parseWorkspace(stored.value, stored.revision);
}

export function parseWorkspace(value: unknown, revision = 0): LoadedWorkspace {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.chat) || !isRecord(value.appearance)) throw new Error('Invalid stored workspace');
  const { chat, appearance } = value;
  if (!Array.isArray(chat.conversations) || (chat.activeId !== null && typeof chat.activeId !== 'string') || typeof chat.sidebarOpen !== 'boolean' || !isThemeId(appearance.themeId) || !['light', 'dark', 'system'].includes(String(appearance.mode))) throw new Error('Invalid stored preferences');
  if (chat.deletedConversationIds !== undefined && (!Array.isArray(chat.deletedConversationIds)
    || chat.deletedConversationIds.some((id) => typeof id !== 'string' || !id || id.length > 128))) throw new Error('Invalid stored conversation deletions');
  const deletedConversationIds = [...new Set(chat.deletedConversationIds as string[] | undefined)];
  const deleted = new Set(deletedConversationIds);
  const conversations = chat.conversations.map(readConversation).filter((item) => !deleted.has(item.id));
  if (new Set(conversations.map((conversation) => conversation.id)).size !== conversations.length) throw new Error('Duplicate stored conversations');
  const activeId = conversations.some((item) => item.id === chat.activeId) ? chat.activeId as string : null;
  return {
    revision,
    data: {
      schemaVersion: 1,
      chat: { conversations, ...(deletedConversationIds.length ? { deletedConversationIds } : {}), activeId, sidebarOpen: chat.sidebarOpen },
      appearance: { themeId: appearance.themeId, mode: appearance.mode as AppearancePreferences['mode'] },
      personalization: readPersonalization(value.personalization),
    },
  };
}
