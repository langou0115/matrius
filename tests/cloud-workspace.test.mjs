import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthSession } from '../src/core/api/auth-session.ts';
import { createCloudWorkspaceRepository } from '../src/features/workspace/cloud-workspace-repository.ts';
import { workspaceScope } from '../src/features/workspace/workspace-mode.ts';

const profile = { customInstructions: '', aboutName: '', occupation: '', aboutMore: '' };
const appearance = { themeId: 'twitter', mode: 'system' };
const conversation = { id: 'server-c', clientId: 'old-client-c', revision: 3, title: 'Cloud only', pinned: false,
  updatedAt: 20, readState: { completed: { state: 'unread' }, error: { state: 'absent' } } };
const message = { id: 'server-m', clientId: 'old-client-m', revision: 4, role: 'assistant', content: 'cloud reply', status: 'complete', feedback: 'good' };
function fixture({ fail } = {}) {
  const calls = [];
  const request = async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method ?? 'GET', body });
    if (fail?.(path, init)) throw new Error('conflict');
    if (init.method) return { id: path.includes('/messages') ? 'server-m' : 'server-c', revision: (body?.baseRevision ?? 0) + 1 };
    if (path === '/api/preferences') return { ...appearance, revision: 2 };
    if (path === '/api/profile') return { ...profile, revision: 5 };
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
  assert.equal(calls.find((call) => call.path === '/api/conversations/server-c').body.baseRevision, 3);
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
