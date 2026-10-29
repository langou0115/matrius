import assert from 'node:assert/strict';
import test from 'node:test';

import { pullWorkspace, pushWorkspace } from '../src/features/auth/account-sync.web.ts';

const file = {
  id: 'f1', filename: '报告.pdf', contentType: 'application/pdf', size: 2048, revision: 2,
};
const preferences = { conversations: true, reading: true, appearance: false, personalization: false };
const workspace = (messages) => ({
  chat: {
    conversations: [{
      id: 'conv-1', title: 'Files', pinned: false, updatedAt: 10, messages,
    }],
  },
  appearance: { themeId: 'twitter', mode: 'system' },
  personalization: {},
});

test('local uploads carry file ids even when only metadata is present', async () => {
  const calls = [];
  const request = async (path, init) => {
    calls.push({ path, body: JSON.parse(init.body) });
    return { imported: { conversations: 1, messages: 1 }, updated: 0, failed: [] };
  };

  await pushWorkspace(request, workspace([{
    id: 'm1', role: 'user', content: '', files: [file],
  }]), preferences);

  const message = calls[0].body.chat.conversations[0].messages[0];
  assert.deepEqual(message.fileIds, ['f1']);
  assert.equal(message.content, '');
});

test('server exports keep file metadata when they are merged back', async () => {
  const request = async (path) => {
    if (path.startsWith('/api/conversations?')) {
      return {
        items: [{
          id: 'srv-1', clientId: 'conv-1', title: 'Files', pinned: false, updatedAt: 10,
          readState: { completed: { state: 'absent' }, error: { state: 'absent' } },
        }],
        nextCursor: null,
      };
    }
    if (path.startsWith('/api/conversations/srv-1?')) {
      return {
        messages: [{
          id: 'srv-m1', clientId: 'm1', role: 'user', content: 'see attached',
          status: 'complete', fileIds: ['f1'], files: [file],
        }],
        nextCursor: null,
      };
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  const [conversation] = await pullWorkspace(request, [], preferences);
  const [message] = conversation.messages;
  assert.deepEqual(message.fileIds, ['f1']);
  assert.deepEqual(message.files, [file]);
});
