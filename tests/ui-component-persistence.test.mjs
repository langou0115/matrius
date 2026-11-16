import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '../ui/core/api/instance-client.ts';
import { defaultPersonalization } from '../ui/features/settings/personalization.ts';
import { createCloudWorkspaceRepository } from '../ui/features/workspace/cloud-workspace-repository.ts';

const artifact = {
  componentId: '11111111-2222-3333-4444-555555555555',
  version: 2,
  name: '项目看板',
  props: { tasks: [{ name: '登录页' }] },
};
const boundArtifact = {
  componentId: '99999999-8888-7777-6666-555555555555',
  version: 1,
  name: '中国象棋',
  bindingId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  commandIds: ['ffffffff-0000-1111-2222-333333333333'],
};

const conversation = {
  id: 'srv-1',
  clientId: 'conv-1',
  title: 'Artifacts',
  pinned: false,
  updatedAt: 10,
  modelId: null,
  titleSource: null,
  contextSummary: null,
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
          revision: 1, fileIds: [], files: [],
          // A malformed entry must be dropped instead of breaking the stored history.
          uiComponents: [{ componentId: '', version: 0 }, artifact, boundArtifact],
        }],
        nextCursor: null,
      };
    }
    if (path === '/api/conversations/srv-1/messages') return { id: 'srv-m2', clientId: 'm2', revision: 1 };
    if (path.startsWith('/api/conversations/') && init?.method === 'PATCH') return { ...conversation, revision: 2 };
    if (path.startsWith('/api/messages/') && init?.method === 'PATCH') return { id: 'srv-m1', revision: 2 };
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`);
  };
  return { request, calls };
}

test('component artifacts survive a workspace round trip', async () => {
  const { request, calls } = fakeRequest();
  const repo = createCloudWorkspaceRepository(request);
  const loaded = await repo.load();

  const [message] = loaded.data.chat.conversations[0].messages;
  assert.deepEqual(message.uiComponents, [artifact, boundArtifact]);

  // Saving the loaded data without changes must not rewrite the message.
  const unchanged = structuredClone(loaded.data);
  await repo.save(unchanged);
  assert.equal(calls.filter((call) => call.path === '/api/conversations/srv-1/messages').length, 0);

  const data = structuredClone(loaded.data);
  const nextArtifact = {
    componentId: '12345678-1234-1234-1234-123456789012',
    version: 1,
    name: '销售图表',
    props: { points: [1, 2, 3] },
  };
  data.chat.conversations[0].messages.push({
    id: 'm2', role: 'assistant', content: '已渲染图表。', status: 'complete', uiComponents: [nextArtifact],
  });
  await repo.save(data);

  const posted = calls.find((call) => call.path === '/api/conversations/srv-1/messages');
  assert.ok(posted, 'the new message must be uploaded');
  assert.deepEqual(posted.body.uiComponents, [nextArtifact]);
  assert.equal(posted.body.role, 'assistant');
});
