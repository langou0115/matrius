import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createAuthSession } from '../src/core/api/auth-session.ts';
import { createCloudWorkspaceRepository } from '../src/features/workspace/cloud-workspace-repository.ts';
import { workspaceScope } from '../src/features/workspace/workspace-mode.ts';

const profile = { customInstructions: '', aboutName: '', occupation: '', aboutMore: '' };
const appearance = { themeId: 'twitter', mode: 'system' };
const contextSummary = { coveredUntilMessageId: 'old-client-m', summary: '云端摘要' };
const conversation = { id: 'server-c', clientId: 'old-client-c', revision: 3, title: 'Cloud only', pinned: false,
  contextSummary, updatedAt: 20, readState: { completed: { state: 'unread' }, error: { state: 'absent' } } };
const message = { id: 'server-m', clientId: 'old-client-m', revision: 4, role: 'assistant', content: 'cloud reply', status: 'complete', feedback: 'good',
  activities: [{ id: 'call-1', kind: 'search', status: 'complete', query: '资料', tookMs: 12,
    results: [{ title: 'A', url: 'https://a.test/x', domain: 'a.test', rank: 1, snippet: '省略', engine: 'ddg' }] }],
  process: [
    { id: 'thinking:1:0', kind: 'thinking', content: '先想一下', status: 'complete', startedAt: 1, endedAt: 2 },
    { id: 'call-1', kind: 'search', status: 'complete', query: '资料', tookMs: 12 },
  ] };
function fixture({ fail, memory = { enabled: true, summary: '# 记忆\n- 喜欢简洁' } } = {}) {
  const calls = [];
  const request = async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method ?? 'GET', body });
    if (fail?.(path, init)) throw new Error('conflict');
    if (init.method) {
      // The memory summary uses the generic profile-field endpoint, not /api/profile.
      if (path === '/api/profile/fields/memory') return { revision: (body?.baseRevision ?? 0) + 1 };
      return { id: path.includes('/messages') ? 'server-m' : 'server-c', revision: (body?.baseRevision ?? 0) + 1 };
    }
    if (path === '/api/preferences') return { ...appearance, revision: 2 };
    if (path === '/api/profile') return { ...profile, revision: 5 };
    if (path === '/api/profile/fields/memory') {
      if (memory === null) throw new ApiError(404, 'not_found', '记忆字段不存在。');
      return { key: 'memory', value: JSON.stringify(memory), source: 'tool', updatedAt: 10, revision: 3 };
    }
    if (path.startsWith('/api/conversations?')) return { items: [conversation], nextCursor: null };
    if (path.startsWith('/api/conversations/server-c?')) return { messages: [message], nextCursor: null };
    throw new Error(`Unexpected request: ${path}`);
  };
  return { calls, repo: createCloudWorkspaceRepository(request) };
}

test('workspace identity isolates local, accounts, validation and preview', () => {
  const auth = (status, id) => ({ status, user: id ? { id, mustChangePassword: false } : null });
  assert.equal(workspaceScope(auth('anonymous'), false), 'local');
  assert.equal(workspaceScope(auth('checking'), false), 'pending');
  assert.equal(workspaceScope(auth('authenticated', 'a'), false), 'cloud:a');
  assert.equal(workspaceScope(auth('checking', 'a'), false), 'cloud:a', 'background validation keeps the workspace mounted');
  assert.equal(workspaceScope(auth('authenticated', 'b'), false), 'cloud:b');
  assert.equal(workspaceScope(auth('unavailable'), false), 'pending', 'network errors must not fall back to local storage');
  assert.equal(workspaceScope(auth('anonymous'), false), 'local', 'logout restores the original local workspace');
  assert.equal(workspaceScope(auth('authenticated', 'a'), true), 'preview');
});

test('an in-flight or failed login keeps the current workspace mounted', async () => {
  let respond;
  const auth = createAuthSession({ read: () => null, write() {} },
    () => new Promise((resolve) => { respond = resolve; }));
  assert.equal(workspaceScope(auth.getSnapshot(), false), 'local');
  const attempt = auth.login('alice', 'wrong-password');
  assert.equal(workspaceScope(auth.getSnapshot(), false), 'local',
    'login progress belongs to the dialog, not a full-screen workspace swap');
  respond(new Response(JSON.stringify({ error: { code: 'invalid_credentials', message: '账号或密码不正确。' } }),
    { status: 401, headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(attempt, /账号或密码不正确/);
  assert.equal(workspaceScope(auth.getSnapshot(), false), 'local', 'a failed login returns to the same local workspace');
});

test('cloud reads only REST, retains imported identities, and unchanged data causes no writes', async () => {
  const { repo, calls } = fixture();
  // No IndexedDB is installed in this test process. Cloud operations must not require it.
  const { data } = await repo.load();
  assert.equal(data.chat.conversations[0].id, 'old-client-c');
  assert.equal(data.chat.conversations[0].messages[0].id, 'old-client-m');
  assert.equal(data.chat.conversations[0].completedReadAt, null);
  assert.equal(data.chat.conversations[0].messages[0].content, 'cloud reply');
  const activity = data.chat.conversations[0].messages[0].activities[0];
  assert.equal(activity.query, '资料');
  assert.deepEqual(activity.results[0], { title: 'A', url: 'https://a.test/x', domain: 'a.test', rank: 1, snippet: '', engine: '' },
    'cloud history keeps the tool steps but not their snippets');
  assert.deepEqual(data.chat.conversations[0].contextSummary, contextSummary);
  assert.deepEqual(data.memory, { enabled: true, summary: '# 记忆\n- 喜欢简洁', updatedAt: null }, 'the memory summary loads from a profile field');
  assert.deepEqual(data.chat.conversations[0].messages[0].process.map((step) => step.kind), ['thinking', 'search'],
    'the ordered process survives a cloud reload');
  calls.length = 0;
  await repo.save(data);
  assert.deepEqual(calls, []);
});

test('cloud edits, streaming, feedback removal and preferences use REST revisions without uploading models', async () => {
  const { repo, calls } = fixture();
  const { data } = await repo.load();
  calls.length = 0;
  const c = data.chat.conversations[0];
  c.title = 'Renamed';
  c.contextSummary = { coveredUntilMessageId: 'old-client-m', summary: '更新后的摘要' };
  c.messages[0].content = 'partial reply';
  c.messages[0].status = 'streaming';
  delete c.messages[0].feedback;
  data.appearance = { themeId: 'twitter', mode: 'dark' };
  data.personalization.aboutName = 'Tester';
  await repo.save(data);
  const patch = calls.find((call) => call.path === '/api/messages/server-m');
  assert.equal(patch.body.baseRevision, 4);
  assert.equal(patch.body.feedback, null);
  assert.equal(patch.body.status, 'stopped', 'reload never restores a live stream');
  assert.deepEqual(patch.body.activities[0].results[0], { title: 'A', url: 'https://a.test/x', domain: 'a.test', rank: 1 },
    'the server payload drops snippets and engines');
  assert.equal(patch.body.process[0].content, '先想一下', 'the full process is written with the message');
  assert.deepEqual(patch.body.process.map((step) => step.kind), ['thinking', 'search']);
  const conversationPatch = calls.find((call) => call.path === '/api/conversations/server-c').body;
  assert.equal(conversationPatch.baseRevision, 3);
  assert.deepEqual(conversationPatch.contextSummary, c.contextSummary, 'the rolling summary syncs with metadata');
  assert.equal(calls.find((call) => call.path === '/api/preferences').body.baseRevision, 2);
  assert.equal(calls.find((call) => call.path === '/api/profile').body.baseRevision, 5);
  assert.ok(calls.every((call) => !call.path.includes('/import')));
  assert.ok(!JSON.stringify(calls).includes('apiKey'));
  calls.length = 0;
  c.messages[0].status = 'complete';
  await repo.save(data);
  assert.equal(calls.find((call) => call.path === '/api/messages/server-m').body.baseRevision, 5);
});

test('cloud message and conversation deletions use server identities and revisions', async () => {
  const { repo, calls } = fixture();
  const { data } = await repo.load();
  calls.length = 0;
  data.chat.conversations[0].messages = [];
  await repo.save(data);
  assert.ok(calls.some((call) => call.method === 'DELETE' && call.path === '/api/messages/server-m?baseRevision=4'));
  calls.length = 0;
  data.chat.conversations = [];
  await repo.save(data);
  assert.deepEqual(calls, [{ path: '/api/conversations/server-c?baseRevision=4', method: 'DELETE', body: undefined }]);
});

test('cloud conflicts surface without switching to a local write or incrementing the failed revision', async () => {
  let failed = false;
  const { repo, calls } = fixture({ fail: (path, init) => {
    if (!failed && init.method === 'PATCH' && path === '/api/messages/server-m') { failed = true; return true; }
  } });
  const { data } = await repo.load();
  data.chat.conversations[0].messages[0].content = 'edit';
  await assert.rejects(repo.save(data), /conflict/);
  await repo.save(data);
  const patches = calls.filter((call) => call.path === '/api/messages/server-m');
  assert.deepEqual(patches.map((call) => call.body.baseRevision), [4, 4]);
});

test('streaming body updates patch only the message, not the conversation', async () => {
  const { repo, calls } = fixture();
  const { data } = await repo.load();
  calls.length = 0;
  data.chat.conversations[0].messages[0].content = 'a longer partial reply';
  await repo.save(data);
  assert.deepEqual(calls.map((call) => [call.method, call.path]),
    [['PATCH', '/api/messages/server-m']], 'the 1.5s streaming save must not double its writes');
});

test('a stale revision adopts the server revision and retries once', async () => {
  let conflicted = false;
  const { repo, calls } = fixture({ fail: (path, init) => {
    if (!conflicted && init.method === 'PATCH' && path === '/api/messages/server-m') {
      conflicted = true;
      throw new ApiError(409, 'conflict', '消息已在其他设备更新，请刷新后重试。', undefined,
        { error: { code: 'conflict', message: '冲突', current: { revision: 9 } } });
    }
  } });
  const { data } = await repo.load();
  const message = data.chat.conversations[0].messages[0];
  message.content = 'edit';
  await repo.save(data);
  const patches = calls.filter((call) => call.path === '/api/messages/server-m');
  assert.deepEqual(patches.map((call) => call.body.baseRevision), [4, 9], 'the retry uses the server revision');
  calls.length = 0;
  message.content = 'edit again';
  await repo.save(data);
  assert.equal(calls.find((call) => call.path === '/api/messages/server-m').body.baseRevision, 10,
    'the recovered revision becomes the new baseline instead of wedging later saves');
});

test('cloud new conversations and messages use idempotent client ids and do not include local workspaces', async () => {
  const { repo, calls } = fixture();
  const { data } = await repo.load();
  calls.length = 0;
  data.chat.conversations.push({ id: 'new-c', title: 'New', pinned: false, updatedAt: 30,
    messages: [{ id: 'new-m', role: 'user', content: 'question' }] });
  await repo.save(data);
  assert.equal(calls.find((call) => call.path === '/api/conversations').body.clientId, 'new-c');
  assert.equal(calls.find((call) => call.path === '/api/conversations/server-c/messages').body.clientId, 'new-m');
});

test('memory summary writes through its own profile-field revision', async () => {
  const { repo, calls } = fixture();
  const { data } = await repo.load();
  calls.length = 0;
  data.memory = { enabled: false, summary: '# 新摘要\n- 偏好中文', updatedAt: 789 };
  await repo.save(data);
  const write = calls.find((call) => call.path === '/api/profile/fields/memory');
  assert.equal(write.method, 'PUT');
  assert.equal(write.body.baseRevision, 3);
  assert.deepEqual(JSON.parse(write.body.value), { enabled: false, summary: '# 新摘要\n- 偏好中文', updatedAt: 789 });
  assert.deepEqual(calls.map((call) => call.path), ['/api/profile/fields/memory']);
  calls.length = 0;
  await repo.save(data);
  assert.deepEqual(calls, [], 'unchanged memory causes no write');
});

test('an account without a memory field starts with an empty memory', async () => {
  const { repo } = fixture({ memory: null });
  const { data } = await repo.load();
  assert.deepEqual(data.memory, { enabled: true, summary: '', updatedAt: null });
});
