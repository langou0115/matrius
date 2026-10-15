import { readWorkspace } from '@/core/database/browser-store.web';
import type { ChatState, Conversation, Message } from '@/features/chat/chat-state';
import type { AppearancePreferences } from '@/theme/appearance';
import { themePresets, type ThemeId } from '@/theme/presets';

export type WorkspaceData = { schemaVersion: 1; chat: ChatState; appearance: AppearancePreferences };
export type LoadedWorkspace = { data: WorkspaceData; revision: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isThemeId(value: unknown): value is ThemeId { return themePresets.some((preset) => preset.id === value); }
function readMessage(value: unknown): Message {
  if (!isRecord(value) || typeof value.id !== 'string' || (value.role !== 'user' && value.role !== 'assistant') || typeof value.content !== 'string') throw new Error('Invalid stored message');
  return { id: value.id, role: value.role, content: value.content };
}
function readConversation(value: unknown): Conversation {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.pinned !== 'boolean' || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || !Array.isArray(value.messages)) throw new Error('Invalid stored conversation');
  return { id: value.id, title: value.title, pinned: value.pinned, updatedAt: value.updatedAt, messages: value.messages.map(readMessage) };
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
  return {
    revision: stored.revision,
    data: {
      schemaVersion: 1,
      chat: { conversations, activeId: conversations.some((item) => item.id === chat.activeId) ? chat.activeId as string : null, sidebarOpen: chat.sidebarOpen },
      appearance: { themeId: appearance.themeId, mode: appearance.mode as AppearancePreferences['mode'] },
    },
  };
}
