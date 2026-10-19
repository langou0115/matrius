import { readWorkspace } from '@/core/database/browser-store.web';
import type { Conversation, Message, PersistedChatState } from '@/features/chat/chat-state';
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
function readMessage(value: unknown): Message {
  if (!isRecord(value) || typeof value.id !== 'string' || (value.role !== 'user' && value.role !== 'assistant') || typeof value.content !== 'string') throw new Error('Invalid stored message');
  const status = value.status === 'streaming' ? 'stopped' : ['complete', 'stopped', 'error'].includes(String(value.status)) ? value.status as Message['status'] : undefined;
  return { id: value.id, role: value.role, content: value.content,
    ...(typeof value.quote === 'string' ? { quote: value.quote } : {}),
    ...(value.role === 'assistant' && (value.feedback === 'good' || value.feedback === 'bad') ? { feedback: value.feedback } : {}),
    ...(typeof value.reasoning === 'string' ? { reasoning: value.reasoning } : {}),
    ...(typeof value.thinkingMs === 'number' && Number.isFinite(value.thinkingMs) ? { thinkingMs: value.thinkingMs } : {}),
    ...(status ? { status } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}
function readConversation(value: unknown): Conversation {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.pinned !== 'boolean' || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || !Array.isArray(value.messages)) throw new Error('Invalid stored conversation');
  if (value.errorReadAt !== undefined && value.errorReadAt !== null && (typeof value.errorReadAt !== 'number' || !Number.isFinite(value.errorReadAt))) throw new Error('Invalid stored conversation error status');
  if (value.completedReadAt !== undefined && value.completedReadAt !== null && (typeof value.completedReadAt !== 'number' || !Number.isFinite(value.completedReadAt))) throw new Error('Invalid stored conversation completion status');
  const titleSource = value.titleSource === 'auto' || value.titleSource === 'ai' || value.titleSource === 'manual' ? value.titleSource : undefined;
  return { id: value.id, title: value.title, pinned: value.pinned, updatedAt: value.updatedAt,
    ...(typeof value.modelId === 'string' ? { modelId: value.modelId } : {}),
    ...(titleSource ? { titleSource } : {}),
    messages: value.messages.map(readMessage),
    ...(value.errorReadAt !== undefined ? { errorReadAt: value.errorReadAt as number | null } : {}),
    ...(value.completedReadAt !== undefined ? { completedReadAt: value.completedReadAt as number | null } : {}) };
}

export async function loadWorkspace(): Promise<LoadedWorkspace> {
  const stored = await readWorkspace();
  if (!stored) return { revision: 0, data: { schemaVersion: 1, chat: { conversations: [], activeId: null, sidebarOpen: true }, appearance: { themeId: 'twitter', mode: 'system' } } };
  const value = stored.value;
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.chat) || !isRecord(value.appearance)) throw new Error('Invalid stored workspace');
  const { chat, appearance } = value;
  if (!Array.isArray(chat.conversations) || (chat.activeId !== null && typeof chat.activeId !== 'string') || typeof chat.sidebarOpen !== 'boolean' || !isThemeId(appearance.themeId) || !['light', 'dark', 'system'].includes(String(appearance.mode))) throw new Error('Invalid stored preferences');
  const conversations = chat.conversations.map(readConversation);
  if (new Set(conversations.map((conversation) => conversation.id)).size !== conversations.length) throw new Error('Duplicate stored conversations');
  const activeId = conversations.some((item) => item.id === chat.activeId) ? chat.activeId as string : null;
  return {
    revision: stored.revision,
    data: {
      schemaVersion: 1,
      chat: { conversations, activeId, sidebarOpen: chat.sidebarOpen },
      appearance: { themeId: appearance.themeId, mode: appearance.mode as AppearancePreferences['mode'] },
      personalization: readPersonalization(value.personalization),
    },
  };
}
