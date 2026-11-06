import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '../src/core/api/auth-session.ts';
import { defaultPersonalization } from '../src/features/settings/personalization.ts';
import { createCloudWorkspaceRepository } from '../src/features/workspace/cloud-workspace-repository.ts';

const saved = {
  id: 'saved-1', filename: 'final.pdf', contentType: 'application/pdf', size: 2048, revision: 1,
};
const conversation = {
  id: 'srv-1', clientId: 'conv-1', title: 'Files', pinned: false, updatedAt: 10, revision: 1,
  modelId: null, titleSource: null, contextSummary: null,
  readState: { completed: { state: 'absent' }, error: { state: 'absent' } },
};

function fakeRequest() {
  const calls = [];
  const request = async (path, init) => {
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
    if (path === '/api/preferences') return { themeId: 'twitter', mode: 'system', revision: 1 };
    if (path === '/api/profile') return { ...defaultPersonalization, revision: 1 };
    if (path === '/api/profile/fields/memory') throw new ApiError(404, 'not_found', '记忆字段不存在。');
    if (path === '/api/conversations?limit=100') return { items: [conversation], nextCursor: null };
    if (path === '/api/conversations/srv-1?messageLimit=100') {
      return {
        messages: [{
          id: 'srv-m1', clientId: 'm1', role: 'assistant', content: 'answer', status: 'complete',
          revision: 1, fileIds: ['saved-1'], files: [saved],
        }],
        nextCursor: null,
      };
    }
    if (path.startsWith('/api/conversations/') && init?.method === 'PATCH') {
      return { ...conversation, revision: (calls.filter((call) => call.method === 'PATCH').length + 1) };
    }
    if (path === '/api/conversations/srv-1/messages') return { id: 'srv-m2', clientId: 'm2', revision: 1 };
    if (path === '/api/messages/srv-m1' && init?.method === 'PATCH') return { id: 'srv-m1', revision: 2 };
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`);
  };
  return { request, calls };
}

test('cloud load restores file metadata and keeps ids aligned with the server', async () => {
  const { request } = fakeRequest();
  const repo = createCloudWorkspaceRepository(request);
  const loaded = await repo.load();

  const [remoteConversation] = loaded.data.chat.conversations;
  assert.equal(remoteConversation.id, 'conv-1');
  const [message] = remoteConversation.messages;
  assert.deepEqual(message.fileIds, ['saved-1']);
  assert.deepEqual(message.files, [saved]);
});

test('cloud save sends fileIds derived from attachments when a message has no explicit ids', async () => {
  const { request, calls } = fakeRequest();
  const repo = createCloudWorkspaceRepository(request);
  const loaded = await repo.load();

  const data = structuredClone(loaded.data);
  data.chat.conversations[0].messages.push({
    id: 'm2', role: 'user', content: '', files: [{
      id: 'uploaded-1', filename: 'notes.txt', contentType: 'text/plain', size: 5,
    }],
  });
  await repo.save(data);

  const posted = calls.find((call) => call.path === '/api/conversations/srv-1/messages');
  assert.ok(posted, 'the new message must be uploaded');
  assert.equal(posted.method, 'POST');
  assert.deepEqual(posted.body.fileIds, ['uploaded-1']);
  assert.equal(posted.body.content, '');
});
