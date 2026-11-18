import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConversationTitle } from '../contract/agent-title.ts';
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

test('mixed-language multi-entity titles never truncate to a dangling conjunction', () => {
  assert.equal(
    normalizeConversationTitle('Cloudflare Tunnel与Tailscale用法'),
    'Cloudflare Tunnel与Tailscale用法',
  );
  assert.equal(
    normalizeConversationTitle('Cloudflare Tunnel 与 Tailscale 用法'),
    'Cloudflare Tunnel 与 Tailscale',
  );
  assert.equal(
    normalizeConversationTitle('Docker Compose 与 Kubernetes 对比'),
    'Docker Compose 与 Kubernetes 对比',
  );
  assert.equal(
    normalizeConversationTitle('Kubernetes 与 Prometheus 和 Grafana 对比'),
    'Kubernetes 与 Prometheus',
  );
  assert.equal(
    normalizeConversationTitle('A very long English prefix 12 与 Tailscale'),
    'A very long English prefix 12',
  );
});

test('short multi-word English titles, valid Chinese endings, and formatting cleanup work cleanly', () => {
  assert.equal(normalizeConversationTitle('How to use a map in Go'), 'How to use a map in Go');
  assert.equal(normalizeConversationTitle('Setup of Cloudflare Tunnel with Docker'), 'Setup of Cloudflare Tunnel');
  assert.equal(normalizeConversationTitle('数学求和'), '数学求和');
  assert.equal(normalizeConversationTitle('**Node.js 性能排查？**'), 'Node.js 性能排查');
  assert.equal(normalizeConversationTitle('```\n深圳近期天气与出行\n```'), '深圳近期天气与出行');
});
