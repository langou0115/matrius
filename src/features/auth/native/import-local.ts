import { compactActivities } from '@/core/agent/activity-payload';
import type { Message } from '@/core/agent/types';
import type { ApiRequest } from '@/core/api/api-request';
import type { Conversation } from '@/features/chat/chat-state';
import { loadWorkspace } from '@/features/workspace/workspace-repository';

/** Mirrors the server's import limits so one oversized conversation cannot fail a whole batch. */
const MAX_BATCH_CONVERSATIONS = 20;
const MAX_BATCH_MESSAGES = 2000;
const MAX_BATCH_BYTES = 7 * 1024 * 1024;

type ReadMarker = { state: 'absent' | 'unread' | 'read'; readAt?: number };
type ImportMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  quote?: string;
  feedback?: 'good' | 'bad';
  reasoning?: string;
  activities?: unknown[];
  thinkingMs?: number;
  status?: 'complete' | 'stopped' | 'error';
  error?: string;
};
type ImportConversation = {
  id: string;
  title: string;
  pinned: boolean;
  updatedAt: number;
  modelId?: string;
  titleSource?: 'auto' | 'ai' | 'manual';
  contextSummary?: Conversation['contextSummary'];
  readState?: { completed: ReadMarker; error: ReadMarker };
  messages: ImportMessage[];
};
type ImportResponse = {
  imported?: { conversations?: number; messages?: number };
  updated?: number;
  failed?: { clientId?: string; reason?: string }[];
};

export type LocalImportResult = { conversations: number; messages: number; skipped: number };

function marker(value: number | null | undefined): ReadMarker {
  if (value === undefined) return { state: 'absent' };
  if (value === null) return { state: 'unread' };
  return { state: 'read', readAt: value };
}

function messagePayload(message: Message): ImportMessage {
  const activities = message.role === 'assistant' ? compactActivities(message.activities) : undefined;
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    ...(message.quote ? { quote: message.quote } : {}),
    ...(message.role === 'assistant' && message.feedback ? { feedback: message.feedback } : {}),
    ...(message.reasoning ? { reasoning: message.reasoning } : {}),
    ...(activities ? { activities } : {}),
    ...(typeof message.thinkingMs === 'number' ? { thinkingMs: message.thinkingMs } : {}),
    ...(message.status && message.status !== 'streaming' ? { status: message.status } : {}),
    ...(message.error ? { error: message.error } : {}),
  };
}

function conversationPayload(conversation: Conversation): ImportConversation {
  return {
    id: conversation.id,
    title: conversation.title,
    pinned: conversation.pinned,
    updatedAt: conversation.updatedAt,
    ...(conversation.modelId ? { modelId: conversation.modelId } : {}),
    ...(conversation.titleSource ? { titleSource: conversation.titleSource } : {}),
    ...(conversation.contextSummary ? { contextSummary: conversation.contextSummary } : {}),
    readState: { completed: marker(conversation.completedReadAt), error: marker(conversation.errorReadAt) },
    messages: conversation.messages.filter((message) => message.status !== 'streaming').map(messagePayload),
  };
}

function byteLength(value: unknown) {
  const text = JSON.stringify(value);
  if (typeof TextEncoder === 'undefined') return text.length * 2;
  return new TextEncoder().encode(text).length;
}

/** Uploads the local workspace into the signed-in account in server-sized batches. */
export async function importLocalWorkspace(request: ApiRequest): Promise<LocalImportResult> {
  const local = await loadWorkspace();
  const conversations = local.data.chat.conversations.filter((conversation) =>
    conversation.messages.length > 0 && conversation.messages.some((message) => message.status !== 'streaming'));
  const appearance = local.data.appearance;
  const personalization = local.data.personalization;

  const batches: ImportConversation[][] = [];
  let current: ImportConversation[] = [];
  let currentMessages = 0;
  let currentBytes = 0;
  let skipped = 0;

  for (const conversation of conversations) {
    const payload = conversationPayload(conversation);
    const bytes = byteLength(payload);
    // An individual conversation above the server limit would fail every batch it joins.
    if (bytes > MAX_BATCH_BYTES) { skipped += 1; continue; }
    if (current.length && (current.length >= MAX_BATCH_CONVERSATIONS
      || currentMessages + payload.messages.length > MAX_BATCH_MESSAGES
      || currentBytes + bytes > MAX_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      currentMessages = 0;
      currentBytes = 0;
    }
    current.push(payload);
    currentMessages += payload.messages.length;
    currentBytes += bytes;
  }
  if (current.length) batches.push(current);

  if (!batches.length && !appearance && !personalization) return { conversations: 0, messages: 0, skipped };
  if (!batches.length) batches.push([]);

  let importedConversations = 0;
  let importedMessages = 0;
  for (const [index, batch] of batches.entries()) {
    const response: ImportResponse = await request('/api/account/import', {
      method: 'POST',
      body: JSON.stringify({
        schemaVersion: 1,
        chat: { conversations: batch },
        ...(index === 0 && appearance ? { appearance } : {}),
        ...(index === 0 && personalization ? { personalization } : {}),
      }),
    });
    importedConversations += response.imported?.conversations ?? 0;
    importedMessages += response.imported?.messages ?? 0;
    skipped += response.failed?.length ?? 0;
  }
  return { conversations: importedConversations, messages: importedMessages, skipped };
}
