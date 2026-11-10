import assert from 'node:assert/strict';
import test from 'node:test';
import { createReplyRun } from '../agent/src/core/remote-run.ts';
import { editMemorySummary } from '../agent/src/core/remote-client.ts';

test('remote runs stream split frames and report interrupted streams without losing updates', async (t) => {
  const updates = [];
  const encoder = new TextEncoder();
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(JSON.parse(init.body).conversationId, 'chat');
    return new Response(new ReadableStream({ start(controller) {
      for (const text of ['event: up', 'date\ndata: {"content":"你好"}\n\n', 'event: done\ndata: {"status":"complete"}\n\n']) controller.enqueue(encoder.encode(text));
      controller.close();
    } }));
  });
  const run = createReplyRun({ conversationId: 'chat', replyId: 'reply', config: {}, apiKey: '', messages: [], onUpdate: value => updates.push(value) });
  assert.deepEqual(await run.start(), { status: 'complete' });
  assert.deepEqual(updates, [{ content: '你好' }]);
});

test('memory editing sends the instruction to the service and preserves an explicit empty summary', async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, '/api/agent/memory/edit');
    assert.equal(init.signal, controller.signal);
    assert.equal(JSON.parse(init.body).instruction, 'clear');
    return Response.json({ summary: '' });
  });
  assert.equal(await editMemorySummary({}, '', 'old memory', 'clear', controller.signal), '');
});
