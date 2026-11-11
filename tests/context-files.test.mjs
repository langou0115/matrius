import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildContext,
  buildSteeringMessage,
  isContextMessage,
} from '../src/core/agent/context.ts';

const config = {
  id: 'test', name: 'Test model', protocol: 'completion', baseUrl: 'https://test.invalid/v1',
  modelId: 'test-model', contextWindow: 128000, maxOutput: 4096, requiresApiKey: true,
};
const report = {
  id: 'file-1', filename: '报告.pdf', contentType: 'application/pdf', size: 2048, revision: 1,
};

function textOf(message) {
  if (typeof message.content === 'string') return message.content;
  return message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

test('file-only messages belong to context and carry metadata but no document body', () => {
  const message = { id: 'u1', role: 'user', content: '', files: [report], fileIds: ['file-1'] };
  assert.equal(isContextMessage(message), true);
  assert.equal(isContextMessage({ id: 'u2', role: 'user', content: '   ' }), false);

  const context = buildContext([message], config);
  assert.equal(context.length, 1);
  const text = textOf(context[0]);
  assert.match(text, /\[附件\]/);
  assert.match(text, /报告\.pdf/);
  assert.match(text, /file-1/);
  assert.match(text, /2 KB/);
});

test('deleted file ids are still announced so the model does not invent a file', () => {
  const context = buildContext([
    { id: 'u1', role: 'user', content: '看看附件', fileIds: ['gone-1'] },
  ], config);
  const text = textOf(context[0]);
  assert.match(text, /看看附件/);
  assert.match(text, /gone-1/);
  assert.match(text, /文件元数据缺失/);
});

test('assistant replies list files saved during the turn', () => {
  const context = buildContext([
    { id: 'a1', role: 'assistant', content: '已生成', files: [report], status: 'complete' },
  ], config);
  const text = textOf(context[0]);
  assert.match(text, /\[本轮已保存到资料库的文件\]/);
  assert.match(text, /报告\.pdf/);
});

test('steering messages include attachment metadata', () => {
  const steering = buildSteeringMessage({
    id: 's1', role: 'user', content: '补充一下', steering: true, files: [report], fileIds: ['file-1'],
  });
  const text = textOf(steering);
  assert.match(text, /<user_steering_message>/);
  assert.match(text, /补充一下/);
  assert.match(text, /报告\.pdf/);
  assert.match(text, /file-1/);
});

test('file tool system prompt is only appended by the runtime when enabled', () => {
  const context = buildContext([
    { id: 'u1', role: 'user', content: 'hello' },
  ], config);
  assert.ok(!textOf(context[0]).includes('fileId'));
});
