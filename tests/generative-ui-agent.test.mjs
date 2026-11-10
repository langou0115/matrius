import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { MatriusCopilotAgent } from '../agent/src/copilot.ts';

test('Copilot AG-UI forwards offered UI tools to the model and returns renderable tool events', async () => {
  let round = 0;
  const props = { title: 'Compare', columns: ['A'], rows: [['1']] };
  const provider = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    assert.ok(request.tools.some(tool => tool.function.name === 'comparisonTable'));
    assert.ok(!request.tools.some(tool => tool.function.name === 'generateSandboxedUi'), 'unregistered frontend tools stay hidden');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const toolTurn = ++round === 1;
    const delta = toolTurn ? { role: 'assistant', tool_calls: [{ index: 0, id: 'ui-call', type: 'function', function: { name: 'comparisonTable', arguments: JSON.stringify(props) } }] } : { role: 'assistant', content: 'Done' };
    for (const [value, reason] of [[delta, null], [{}, toolTurn ? 'tool_calls' : 'stop']]) {
      res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  try {
    const events = [];
    const agent = new MatriusCopilotAgent({ config: { id: 'mock', name: 'Mock', modelId: 'mock', providerId: 'mock', providerName: 'Mock', protocol: 'completion', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, contextWindow: 128000, maxOutput: 4096, supportsImage: false, requiresApiKey: false }, apiKey: '' });
    await new Promise((resolve, reject) => agent.run({ threadId: 'thread', runId: 'run', state: {}, messages: [{ id: 'user', role: 'user', content: 'Compare' }], tools: [{ name: 'comparisonTable', description: 'Compare', parameters: { type: 'object' } }], context: [], forwardedProps: {} }).subscribe({ next: event => events.push(event), error: reject, complete: resolve }));
    assert.equal(round, 2);
    assert.deepEqual(events.filter(event => event.type.startsWith('TOOL_CALL')).map(event => event.type), ['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'TOOL_CALL_RESULT']);
    assert.deepEqual(JSON.parse(events.find(event => event.type === 'TOOL_CALL_ARGS').delta), props);
    assert.equal(events.at(-1).type, 'RUN_FINISHED');
  } finally {
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  }
});
