import { compactActivities } from '@/core/agent/activity-payload';
import type { ConversationSummary } from '@/core/agent/compaction';
import type { ApiRequest } from '@/core/api/api-request';
import type { Conversation, Message } from '@/features/chat/chat-state';
import { defaultPersonalization } from '@/features/settings/personalization';
import { cloneJson } from '@/core/platform/clone';
import { parseWorkspace, type WorkspaceData } from './workspace-schema';

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
  thinkingMs: value.thinkingMs ?? null, feedback: value.feedback ?? null,
  status: value.status === 'streaming' ? 'stopped' : value.status ?? 'complete', error: value.error ?? null,
  ...(value.role === 'user' && value.steering ? { steering: true } : {}),
  ...(value.role === 'assistant' ? { activities: compactActivities(value.activities) } : {}),
});

/** An account-scoped, memory-only REST repository. It never reads or writes IndexedDB.
 * Successful operations advance their own baseline so retrying a partial save is safe. */
export function createCloudWorkspaceRepository(request: ApiRequest) {
  const conversations = new Map<string, { remote: RecordVersion; value: Conversation }>();
  const messages = new Map<string, { remote: RecordVersion; value: Message }>();
  let appearance: WorkspaceData['appearance'];
  let personalization: NonNullable<WorkspaceData['personalization']>;
  let appearanceRevision = 0;
  let profileRevision = 0;
  let loaded = false;

  async function load() {
    conversations.clear();
    messages.clear();
    loaded = false;
    const preferences = await request<WorkspaceData['appearance'] & { revision: number }>('/api/preferences');
    const profile = await request<NonNullable<WorkspaceData['personalization']> & { revision: number }>('/api/profile');
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
            const value: Message = { ...messageBody(item), id: item.clientId || item.id } as Message;
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
      appearance: preferences, personalization: profile,
    });
    appearance = cloneJson(result.data.appearance);
    personalization = cloneJson(result.data.personalization ?? defaultPersonalization);
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
      await request(`/api/conversations/${encodeURIComponent(previous.remote.id)}?baseRevision=${previous.remote.revision}`, { method: 'DELETE' });
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
        await request(`/api/messages/${encodeURIComponent(old.remote.id)}?baseRevision=${old.remote.revision}`, { method: 'DELETE' });
        messages.delete(key);
      }
      for (const message of value.messages) {
        const key = JSON.stringify([value.id, message.id]);
        const old = messages.get(key);
        const body = messageBody(message);
        if (old && same(messageBody(old.value), body)) continue;
        const remote = await request<RecordVersion>(old ? `/api/messages/${encodeURIComponent(old.remote.id)}`
          : `/api/conversations/${encodeURIComponent(previous.remote.id)}/messages`, {
          method: old ? 'PATCH' : 'POST',
          body: JSON.stringify({ ...body, ...(old ? { baseRevision: old.remote.revision } : { clientId: message.id }) }),
        });
        messages.set(key, { remote, value: cloneJson(message) });
      }
      // Message appends set read markers on the server, so always restore the UI's markers
      // after a changed message list (including when the user is watching the conversation).
      if (!same(metadata(previous.value), metadata(value)) || !same(previous.value.messages.map(messageBody), value.messages.map(messageBody))) {
        const remote = await request<RecordVersion>(`/api/conversations/${encodeURIComponent(previous.remote.id)}`, {
          method: 'PATCH', body: JSON.stringify({ ...metadata(value), baseRevision: previous.remote.revision }),
        });
        previous.remote = remote;
      }
      previous.value = cloneJson(value);
    }
    if (!same(appearance, data.appearance)) {
      const remote = await request<{ revision: number }>('/api/preferences', {
        method: 'PUT', body: JSON.stringify({ ...data.appearance, baseRevision: appearanceRevision }),
      });
      appearanceRevision = remote.revision;
      appearance = cloneJson(data.appearance);
    }
    const nextProfile = data.personalization ?? { ...defaultPersonalization };
    if (!same(personalization, nextProfile)) {
      const remote = await request<{ revision: number }>('/api/profile', {
        method: 'PUT', body: JSON.stringify({ ...nextProfile, baseRevision: profileRevision }),
      });
      profileRevision = remote.revision;
      personalization = cloneJson(nextProfile);
    }
  }
  return { load, save };
}
