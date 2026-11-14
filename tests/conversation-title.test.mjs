import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConversationTitle } from '../ui/core/agent/title.ts';
import { deriveConversationTitle } from '../ui/features/chat/chat-state.tsx';

test('mixed-language titles keep the topic instead of collapsing to the product name', () => {
  assert.equal(normalizeConversationTitle('Claude Desktop 最近更新'), 'Claude Desktop 最近更新');
  assert.equal(normalizeConversationTitle('Claude Desktop 最近更新与功能变化详解'), 'Claude Desktop 最近更新与功能变化');
  assert.equal(normalizeConversationTitle('一'.repeat(20)), '一'.repeat(16));
  assert.equal(normalizeConversationTitle('Title: Hello world from the test'), 'Hello world from the test');
});

test('the first-message fallback keeps a mixed topic readable', () => {
  assert.equal(
    deriveConversationTitle({ content: 'claude desktop最近有什么更新嘛' }),
    'claude desktop最近有什么更新嘛',
  );
});
