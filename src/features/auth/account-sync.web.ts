import { compactActivities } from '@/core/agent/activity-payload';
import type { ConversationSummary } from '@/core/agent/compaction';
import type { Conversation, Message } from '@/features/chat/chat-state';
import { readActivities, readFileIds, readMessageFiles } from '@/features/workspace/workspace-repository.web';
import type { PersonalizationPreferences } from '@/features/settings/personalization';
import type { AppearancePreferences } from '@/theme/appearance';
import { readLocalValue, writeLocalValue } from '@/core/database/browser-store.web';
import type { SyncPreferences } from './sync-preferences.web';

export type ApiRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export type SyncWorkspace = {
  chat: { conversations: Conversation[]; deletedConversationIds?: string[] };
  appearance: AppearancePreferences;
  personalization: PersonalizationPreferences;
};

export type SyncResult = {
  uploadedConversations: number;
  uploadedMessages: number;
  updatedConversations: number;
  failed: string[];
  pulled: Conversation[];
  deletedConversationIds?: string[];
};

type RemoteReadMarker = { state?: unknown; readAt?: unknown };
type RemoteConversation = {
  id?: unknown;
  clientId?: unknown;
  title?: unknown;
  pinned?: unknown;
  modelId?: unknown;
  titleSource?: unknown;
  contextSummary?: unknown;
  updatedAt?: unknown;
  readState?: { completed?: RemoteReadMarker; error?: RemoteReadMarker };
};
type RemoteMessage = {
  id?: unknown;
  clientId?: unknown;
  position?: unknown;
  role?: unknown;
  content?: unknown;
  quote?: unknown;
  feedback?: unknown;
  reasoning?: unknown;
  activities?: unknown;
  thinkingMs?: unknown;
  status?: unknown;
  error?: unknown;
  fileIds?: unknown;
  files?: unknown;
};

type ImportMessagePayload = {
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
  fileIds?: string[];
};
type ImportReadMarker = { state: 'absent' | 'unread' | 'read'; readAt?: number };
type ImportConversationPayload = {
  id: string;
  title: string;
  pinned: boolean;
  updatedAt: number;
  modelId?: string;
  titleSource?: 'auto' | 'ai' | 'manual';
  contextSummary?: ConversationSummary;
  readState?: { completed: ImportReadMarker; error: ImportReadMarker };
  messages: ImportMessagePayload[];
};
type RemoteListResponse = { items?: RemoteConversation[]; nextCursor?: unknown };
type RemoteMessagesResponse = { messages?: RemoteMessage[]; nextCursor?: unknown };
type ImportResponse = {
  imported?: { conversations?: number; messages?: number };
  updated?: number;
  failed?: { clientId?: string; reason?: string }[];
};

const MAX_BATCH_CONVERSATIONS = 20;
const MAX_BATCH_MESSAGES = 2000;
const MAX_BATCH_BYTES = 7 * 1024 * 1024;
const MAX_PAGES = 50;
const SYNC_STATE_KEY = 'account-sync-state';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasStreamingMessage(conversation: Conversation): boolean {
  return conversation.messages.some((message) => message.status === 'streaming');
}

function markerValue(marker: RemoteReadMarker | undefined): number | null | undefined {
  if (marker?.state === 'read') return typeof marker.readAt === 'number' ? marker.readAt : Date.now();
  if (marker?.state === 'unread') return null;
  if (marker?.state === 'absent') return undefined;
  return undefined;
}

/** Summaries are derived context: ignore malformed copies instead of failing the whole pull. */
function readContextSummary(value: unknown): ConversationSummary | undefined {
  if (!isRecord(value) || typeof value.coveredUntilMessageId !== 'string' || !value.coveredUntilMessageId
    || typeof value.summary !== 'string' || !value.summary.trim()) return undefined;
  return { coveredUntilMessageId: value.coveredUntilMessageId, summary: value.summary };
}

function readMarker(value: number | null | undefined): ImportReadMarker {
  if (value === undefined) return { state: 'absent' };
  if (value === null) return { state: 'unread' };
  return { state: 'read', readAt: value };
}

function toLocalMessage(value: RemoteMessage): Message | null {
  if (value.role !== 'user' && value.role !== 'assistant') return null;
  if (typeof value.content !== 'string') return null;
  const id = typeof value.clientId === 'string' && value.clientId ? value.clientId : value.id;
  if (typeof id !== 'string' || !id) return null;
  const status = value.status === 'complete' || value.status === 'stopped' || value.status === 'error'
    ? value.status : undefined;
  const activities = value.role === 'assistant' ? readActivities(value.activities) : undefined;
  const fileIds = readFileIds(value.fileIds);
  const files = readMessageFiles(value.files);
  return {
    id,
    role: value.role,
    content: value.content,
    ...(fileIds ? { fileIds } : {}),
    ...(files ? { files } : {}),
    ...(typeof value.quote === 'string' ? { quote: value.quote } : {}),
    ...(value.role === 'assistant' && (value.feedback === 'good' || value.feedback === 'bad') ? { feedback: value.feedback } : {}),
    ...(typeof value.reasoning === 'string' ? { reasoning: value.reasoning } : {}),
    ...(activities ? { activities } : {}),
    ...(typeof value.thinkingMs === 'number' && Number.isFinite(value.thinkingMs) ? { thinkingMs: value.thinkingMs } : {}),
    ...(status ? { status } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

function toImportMessage(message: Message): ImportMessagePayload {
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
    ...((message.fileIds?.length || message.files?.length)
      ? { fileIds: message.fileIds ?? message.files!.map((file) => file.id) } : {}),
  };
}

function conversationPayload(conversation: Conversation, includeReadState: boolean): ImportConversationPayload {
  return {
    id: conversation.id,
    title: conversation.title,
    pinned: conversation.pinned,
    updatedAt: conversation.updatedAt,
    ...(conversation.modelId ? { modelId: conversation.modelId } : {}),
    ...(conversation.titleSource ? { titleSource: conversation.titleSource } : {}),
    ...(conversation.contextSummary ? { contextSummary: conversation.contextSummary } : {}),
    ...(includeReadState ? {
      readState: {
        completed: readMarker(conversation.completedReadAt),
        error: readMarker(conversation.errorReadAt),
      },
    } : {}),
    messages: conversation.messages.filter((message) => message.status !== 'streaming').map(toImportMessage),
  };
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function buildBatches(conversations: Conversation[], includeReadState: boolean) {
  const batches: ImportConversationPayload[][] = [];
  const tooLarge: string[] = [];
  let current: ImportConversationPayload[] = [];
  let currentMessages = 0;
  let currentBytes = 0;

  function flush() {
    if (current.length) batches.push(current);
    current = [];
    currentMessages = 0;
    currentBytes = 0;
  }

  for (const conversation of conversations) {
    const payload = conversationPayload(conversation, includeReadState);
    const bytes = byteLength(payload);
    if (bytes > MAX_BATCH_BYTES) {
      tooLarge.push(conversation.id);
      continue;
    }
    if (current.length && (current.length >= MAX_BATCH_CONVERSATIONS
      || currentMessages + payload.messages.length > MAX_BATCH_MESSAGES
      || currentBytes + bytes > MAX_BATCH_BYTES)) {
      flush();
    }
    current.push(payload);
    currentMessages += payload.messages.length;
    currentBytes += bytes;
  }
  flush();
  return { batches, tooLarge };
}

export async function pushWorkspace(
  request: ApiRequest,
  workspace: SyncWorkspace,
  preferences: SyncPreferences,
): Promise<Omit<SyncResult, 'pulled'>> {
  const conversations = preferences.conversations
    ? workspace.chat.conversations.filter((conversation) => !hasStreamingMessage(conversation)
      && !workspace.chat.deletedConversationIds?.includes(conversation.id))
    : [];
  // Keep tombstones after acknowledgement: an offline device can return with an old copy.
  const deleted = preferences.conversations ? workspace.chat.deletedConversationIds ?? [] : [];
  for (let offset = 0; offset < deleted.length; offset += MAX_BATCH_MESSAGES) {
    await request('/api/account/import', { method: 'POST', body: JSON.stringify({
      schemaVersion: 1, chat: { deletedConversationIds: deleted.slice(offset, offset + MAX_BATCH_MESSAGES) },
    }) });
  }
  const { batches, tooLarge } = buildBatches(conversations, preferences.reading);
  const appearance = preferences.appearance ? workspace.appearance : null;
  const personalization = preferences.personalization ? workspace.personalization : null;
  if (!batches.length && !appearance && !personalization) {
    return { uploadedConversations: 0, uploadedMessages: 0, updatedConversations: 0, failed: tooLarge };
  }
  if (!batches.length) batches.push([]);

  let uploadedConversations = 0;
  let uploadedMessages = 0;
  let updatedConversations = 0;
  const failed = [...tooLarge];

  for (const [index, batch] of batches.entries()) {
    const response = await request<ImportResponse>('/api/account/import', {
      method: 'POST',
      body: JSON.stringify({
        schemaVersion: 1,
        chat: { conversations: batch },
        ...(index === 0 && appearance ? { appearance } : {}),
        ...(index === 0 && personalization ? { personalization } : {}),
      }),
    });
    uploadedConversations += response.imported?.conversations ?? 0;
    uploadedMessages += response.imported?.messages ?? 0;
    updatedConversations += response.updated ?? 0;
    for (const item of response.failed ?? []) {
      failed.push(item.clientId ?? 'unknown');
    }
  }

  return { uploadedConversations, uploadedMessages, updatedConversations, failed };
}

async function listRemoteConversations(request: ApiRequest): Promise<RemoteConversation[]> {
  const items: RemoteConversation[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = `limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const response: RemoteListResponse = await request<RemoteListResponse>(`/api/conversations?${query}`);
    if (Array.isArray(response.items)) items.push(...response.items);
    cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null;
    if (!cursor) break;
  }
  return items;
}

async function fetchRemoteMessages(request: ApiRequest, conversationId: string): Promise<RemoteMessage[]> {
  const pages: RemoteMessage[][] = [];
  let before: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = `messageLimit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    const response: RemoteMessagesResponse = await request<RemoteMessagesResponse>(
      `/api/conversations/${encodeURIComponent(conversationId)}?${query}`,
    );
    if (Array.isArray(response.messages)) pages.unshift(response.messages);
    before = typeof response.nextCursor === 'string' ? response.nextCursor : null;
    if (!before) break;
  }
  return pages.flat();
}

function mergeMessages(local: Message[], remote: Message[]): Message[] {
  const seen = new Set(local.map((message) => message.id));
  return [...local, ...remote.filter((message) => !seen.has(message.id))];
}

function remoteConversationToLocal(
  remote: RemoteConversation,
  remoteMessages: Message[],
  local: Conversation | undefined,
): Conversation | null {
  if (typeof remote.updatedAt !== 'number' || !Number.isFinite(remote.updatedAt)) return null;
  if (typeof remote.title !== 'string' || typeof remote.pinned !== 'boolean') return null;
  const id = typeof remote.clientId === 'string' && remote.clientId
    ? remote.clientId
    : typeof remote.id === 'string' ? remote.id : null;
  if (!id) return null;
  if (local && hasStreamingMessage(local)) return null;

  const remoteNewer = !local || remote.updatedAt > local.updatedAt;
  const base = local && !remoteNewer ? local : null;
  const remoteTitleSource = remote.titleSource === 'auto' || remote.titleSource === 'ai' || remote.titleSource === 'manual'
    ? remote.titleSource : undefined;
  const remoteModelId = typeof remote.modelId === 'string' ? remote.modelId : undefined;
  const remoteContextSummary = readContextSummary(remote.contextSummary);
  const titleSource = base ? base.titleSource : remoteTitleSource;
  const modelId = base ? base.modelId : remoteModelId;
  const contextSummary = base ? base.contextSummary : remoteContextSummary;
  const completed = base ? base.completedReadAt : markerValue(remote.readState?.completed);
  const error = base ? base.errorReadAt : markerValue(remote.readState?.error);

  const messages = local
    ? remoteNewer ? mergeMessages(remoteMessages, local.messages) : mergeMessages(local.messages, remoteMessages)
    : remoteMessages;

  const next: Conversation = {
    id,
    title: base ? base.title : remote.title,
    pinned: base ? base.pinned : remote.pinned,
    updatedAt: Math.max(local?.updatedAt ?? 0, remote.updatedAt),
    ...(modelId ? { modelId } : {}),
    ...(titleSource ? { titleSource } : {}),
    ...(contextSummary ? { contextSummary } : {}),
    ...(completed !== undefined ? { completedReadAt: completed } : {}),
    ...(error !== undefined ? { errorReadAt: error } : {}),
    messages,
  };
  if (local && JSON.stringify(next) === JSON.stringify(local)) return null;
  return next;
}

export async function pullWorkspace(
  request: ApiRequest,
  localConversations: Conversation[],
  preferences: SyncPreferences,
  deletedConversationIds: string[] = [],
): Promise<Conversation[]> {
  if (!preferences.conversations) return [];
  const remoteList = await listRemoteConversations(request);
  const localById = new Map(localConversations.map((conversation) => [conversation.id, conversation]));
  const merged: Conversation[] = [];

  for (const remote of remoteList) {
    const id = typeof remote.clientId === 'string' && remote.clientId
      ? remote.clientId
      : typeof remote.id === 'string' ? remote.id : null;
    if (!id) continue;
    if (deletedConversationIds.includes(id)) continue;
    const local = localById.get(id);
    const remoteId = typeof remote.id === 'string' ? remote.id : null;
    if (!remoteId) continue;
    const needsMessages = !local || (typeof remote.updatedAt === 'number' && remote.updatedAt > local.updatedAt);
    const remoteMessages = needsMessages
      ? (await fetchRemoteMessages(request, remoteId)).map(toLocalMessage).filter((message): message is Message => message !== null)
      : local?.messages ?? [];
    const conversation = remoteConversationToLocal(remote, remoteMessages, local);
    if (conversation) merged.push(conversation);
  }
  return merged;
}

export async function syncAccount(
  request: ApiRequest,
  workspace: SyncWorkspace,
  preferences: SyncPreferences,
): Promise<SyncResult> {
  const pushed = await pushWorkspace(request, workspace, preferences);
  const deleted = new Set(workspace.chat.deletedConversationIds ?? []);
  if (preferences.conversations) {
    let cursor: string | null = null;
    // Read every page; silently truncating tombstones would resurrect older deletions.
    do {
      const response: { items: string[]; nextCursor?: string | null } = await request(
        `/api/account/conversation-deletions?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      for (const id of response.items) deleted.add(id);
      cursor = response.nextCursor ?? null;
    } while (cursor);
  }
  const deletedConversationIds = [...deleted];
  const pulled = await pullWorkspace(request, workspace.chat.conversations, preferences, deletedConversationIds);
  return { ...pushed, pulled, deletedConversationIds };
}

export async function loadLastSyncedAt(userId: string): Promise<number | null> {
  try {
    const stored = await readLocalValue(SYNC_STATE_KEY);
    if (!isRecord(stored?.value)) return null;
    const users = stored.value.users;
    if (!isRecord(users) || !isRecord(users[userId])) return null;
    const value = users[userId].lastSyncedAt;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export async function saveLastSyncedAt(userId: string, syncedAt: number): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const stored = await readLocalValue(SYNC_STATE_KEY);
      const users = isRecord(stored?.value) && isRecord(stored.value.users) ? stored.value.users : {};
      await writeLocalValue(SYNC_STATE_KEY, { users: { ...users, [userId]: { lastSyncedAt: syncedAt } } }, stored?.revision ?? 0);
      return;
    } catch {
      if (attempt === 1) return;
    }
  }
}
