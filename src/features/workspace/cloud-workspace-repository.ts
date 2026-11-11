import { compactActivities } from '@/core/agent/activity-payload';
import type { ConversationSummary } from '@/core/agent/compaction';
import { ApiError } from '@/core/api/instance-client';
import type { Conversation, Message } from '@/features/chat/chat-state';
import { defaultPersonalization } from '@/features/settings/personalization';
import {
  defaultMemoryPreferences,
  parseMemoryField,
  readMemoryPreferences,
  serializeMemoryField,
  type MemoryPreferences,
} from '@/core/agent/memory';
import { parseWorkspace, readProcess, type WorkspaceData } from './workspace-repository';

type ApiRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

type RecordVersion = { id: string; revision: number; clientId?: string | null };
type Marker = { state: 'absent' | 'unread' | 'read'; readAt?: number };
type RemoteConversation = RecordVersion & Omit<Conversation, 'messages' | 'completedReadAt' | 'errorReadAt' | 'contextSummary'> & {
  contextSummary?: ConversationSummary | null;
  readState: { completed: Marker; error: Marker };
};
type RemoteMessage = RecordVersion & Message;
type Page<T> = { items: T[]; nextCursor: string | null };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const marker = (value: number | null | undefined): Marker => value === undefined ? { state: 'absent' }
  : value === null ? { state: 'unread' } : { state: 'read', readAt: value };
const markerValue = (value: Marker) => value.state === 'read' ? value.readAt : value.state === 'unread' ? null : undefined;
const metadata = (value: Conversation) => ({
  title: value.title, pinned: value.pinned, modelId: value.modelId ?? null, titleSource: value.titleSource ?? null,
  contextSummary: value.contextSummary ?? null,
  readState: { completed: marker(value.completedReadAt), error: marker(value.errorReadAt) },
});
const messageBody = (value: Message) => ({
  role: value.role, content: value.content, quote: value.quote ?? null, reasoning: value.reasoning ?? null,
  process: value.process ?? null,
  thinkingMs: value.thinkingMs ?? null, feedback: value.feedback ?? null,
  status: value.status === 'streaming' ? 'stopped' : value.status ?? 'complete', error: value.error ?? null,
  ...(value.role === 'user' && value.steering ? { steering: true } : {}),
  ...(value.role === 'assistant' ? { activities: compactActivities(value.activities) } : {}),
  // Image attachments contribute their cloud ids while only documents have metadata here.
  fileIds: value.fileIds ?? value.files?.map((file) => file.id) ?? [],
});

/** The server puts the conflicting record in the error body so the caller can resync. */
function conflictRevision(error: unknown): number | undefined {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined;
  const current = (error.payload as { error?: { current?: { revision?: unknown } } } | undefined)?.error?.current;
  return typeof current?.revision === 'number' ? current.revision : undefined;
}

/** A stale in-memory revision used to wedge every later save: one interrupted response left the
 * baseline behind, so every retry conflicted again until reload. Adopt the server's revision and
 * retry once; the local streaming content is still the newer copy for the record being written. */
async function withRevisionRecovery<T>(baseRevision: number, run: (baseRevision: number) => Promise<T>): Promise<T> {
  try {
    return await run(baseRevision);
  } catch (error) {
    const current = conflictRevision(error);
    if (current === undefined || current === baseRevision) throw error;
    return run(current);
  }
}

/** An settings-scoped, memory-only REST repository. It never reads or writes IndexedDB.
 * Successful operations advance their own baseline so retrying a partial save is safe. */
export function createCloudWorkspaceRepository(request: ApiRequest) {
  const conversations = new Map<string, { remote: RecordVersion; value: Conversation }>();
  const messages = new Map<string, { remote: RecordVersion; value: Message }>();
  let appearance: WorkspaceData['appearance'];
  let personalization: NonNullable<WorkspaceData['personalization']>;
  let memory: MemoryPreferences;
  let appearanceRevision = 0;
  let profileRevision = 0;
  // `null` means the instance has no memory field yet, so the first write has no base revision.
  let memoryRevision: number | null = null;
  let loaded = false;

  async function load() {
    conversations.clear();
    messages.clear();
    loaded = false;
    const preferences = await request<WorkspaceData['appearance'] & { revision: number }>('/api/preferences');
    const profile = await request<NonNullable<WorkspaceData['personalization']> & { revision: number }>('/api/profile');
    memory = { ...defaultMemoryPreferences };
    memoryRevision = null;
    try {
      const field = await request<{ value: string; revision: number }>('/api/profile/fields/memory');
      memory = parseMemoryField(field.value);
      memoryRevision = field.revision;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
    }
    const values: Conversation[] = [];
    let cursor: string | null = null;
    do {
      const page: Page<RemoteConversation> = await request(`/api/conversations?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const remote of page.items) {
        const id = remote.clientId || remote.id;
        const pages: Message[][] = [];
        let before: string | null = null;
        do {
          const detail: { messages: RemoteMessage[]; nextCursor: string | null } = await request(
            `/api/conversations/${encodeURIComponent(remote.id)}?messageLimit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`,
          );
          pages.unshift(detail.messages.map((item) => {
            // The server validates the stored process; re-read it so a malformed row cannot
            // break the reasoning panel with an unexpected shape.
            const process = readProcess(item.process);
            const value: Message = { ...messageBody(item), id: item.clientId || item.id,
              ...(process ? { process } : {}),
              ...(item.files?.length ? { files: item.files } : {}) } as Message;
            messages.set(JSON.stringify([id, value.id]), { remote: item, value });
            return value;
          }));
          before = detail.nextCursor;
        } while (before);
        const value: Conversation = {
          id, title: remote.title, pinned: remote.pinned, updatedAt: remote.updatedAt,
          ...(remote.modelId ? { modelId: remote.modelId } : {}),
          ...(remote.titleSource ? { titleSource: remote.titleSource } : {}),
          ...(remote.contextSummary ? { contextSummary: remote.contextSummary } : {}),
          completedReadAt: markerValue(remote.readState.completed), errorReadAt: markerValue(remote.readState.error),
          messages: pages.flat(),
        };
        conversations.set(id, { remote, value });
        values.push(value);
      }
      cursor = page.nextCursor;
    } while (cursor);
    const result = parseWorkspace({
      schemaVersion: 1, chat: { conversations: values, activeId: null, sidebarOpen: true },
      appearance: preferences, personalization: profile, memory,
    });
    appearance = structuredClone(result.data.appearance);
    personalization = structuredClone(result.data.personalization ?? defaultPersonalization);
    memory = structuredClone(result.data.memory ?? { ...defaultMemoryPreferences });
    appearanceRevision = preferences.revision;
    profileRevision = profile.revision;
    loaded = true;
    return result;
  }

  async function save(data: WorkspaceData) {
    if (!loaded) throw new Error('Cloud workspace has not loaded');
    const ids = new Set(data.chat.conversations.map((item) => item.id));
    for (const [id, previous] of conversations) {
      if (ids.has(id)) continue;
      await withRevisionRecovery(previous.remote.revision, (baseRevision) => request(
        `/api/conversations/${encodeURIComponent(previous.remote.id)}?baseRevision=${baseRevision}`, { method: 'DELETE' }));
      conversations.delete(id);
      for (const key of messages.keys()) if (JSON.parse(key)[0] === id) messages.delete(key);
    }
    for (const value of data.chat.conversations) {
      let previous = conversations.get(value.id);
      if (!previous) {
        const remote = await request<RecordVersion>('/api/conversations', {
          method: 'POST', body: JSON.stringify({ clientId: value.id, ...metadata(value) }),
        });
        previous = { remote, value: { ...value, messages: [] } };
        conversations.set(value.id, previous);
      }
      const messageIds = new Set(value.messages.map((item) => item.id));
      for (const [key, old] of messages) {
        if (JSON.parse(key)[0] !== value.id || messageIds.has(old.value.id)) continue;
        await withRevisionRecovery(old.remote.revision, (baseRevision) => request(
          `/api/messages/${encodeURIComponent(old.remote.id)}?baseRevision=${baseRevision}`, { method: 'DELETE' }));
        messages.delete(key);
      }
      for (const message of value.messages) {
        const key = JSON.stringify([value.id, message.id]);
        const old = messages.get(key);
        const body = messageBody(message);
        if (old && same(messageBody(old.value), body)) continue;
        const remote = old
          ? await withRevisionRecovery(old.remote.revision, (baseRevision) => request<RecordVersion>(
            `/api/messages/${encodeURIComponent(old.remote.id)}`,
            { method: 'PATCH', body: JSON.stringify({ ...body, baseRevision }) }))
          : await request<RecordVersion>(`/api/conversations/${encodeURIComponent(previous.remote.id)}/messages`, {
            method: 'POST', body: JSON.stringify({ ...body, clientId: message.id }),
          });
        messages.set(key, { remote, value: structuredClone(message) });
      }
      // Message appends set read markers on the server, so restore the UI's markers whenever the
      // message list changes. Streaming only rewrites message bodies, so comparing ids keeps the
      // 1.5s save from also PATCHing the conversation and doubling both writes and revisions.
      if (!same(metadata(previous.value), metadata(value))
        || !same(previous.value.messages.map((item) => item.id), value.messages.map((item) => item.id))) {
        previous.remote = await withRevisionRecovery(previous.remote.revision, (baseRevision) => request<RecordVersion>(
          `/api/conversations/${encodeURIComponent(previous.remote.id)}`,
          { method: 'PATCH', body: JSON.stringify({ ...metadata(value), baseRevision }) }));
      }
      previous.value = structuredClone(value);
    }
    if (!same(appearance, data.appearance)) {
      const remote = await request<{ revision: number }>('/api/preferences', {
        method: 'PUT', body: JSON.stringify({ ...data.appearance, baseRevision: appearanceRevision }),
      });
      appearanceRevision = remote.revision;
      appearance = structuredClone(data.appearance);
    }
    const nextProfile = data.personalization ?? { ...defaultPersonalization };
    if (!same(personalization, nextProfile)) {
      const remote = await request<{ revision: number }>('/api/profile', {
        method: 'PUT', body: JSON.stringify({ ...nextProfile, baseRevision: profileRevision }),
      });
      profileRevision = remote.revision;
      personalization = structuredClone(nextProfile);
    }
    const nextMemory = readMemoryPreferences(data.memory ?? { ...defaultMemoryPreferences });
    if (!same(memory, nextMemory)) {
      let baseRevision = memoryRevision;
      for (let attempt = 0; ; attempt += 1) {
        try {
          const remote = await request<{ revision: number }>('/api/profile/fields/memory', {
            method: 'PUT',
            body: JSON.stringify({
              value: serializeMemoryField(nextMemory),
              source: 'tool',
              updatedAt: Date.now(),
              ...(baseRevision === null ? {} : { baseRevision }),
            }),
          });
          memoryRevision = remote.revision;
          break;
        } catch (error) {
          const current = conflictRevision(error);
          if (attempt > 0 || current === undefined || current === baseRevision) throw error;
          baseRevision = current;
        }
      }
      memory = structuredClone(nextMemory);
    }
  }
  return { load, save };
}
