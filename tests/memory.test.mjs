import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MEMORY_SUMMARY_LIMIT,
  createMemoryTool,
  defaultMemoryPreferences,
  memoryPromptBlock,
  normalizeMemorySummary,
  parseMemoryField,
  readMemoryPreferences,
  serializeMemoryField,
} from '../ui/core/agent/memory.ts';
import { requestContextMessage } from '../ui/core/agent/context.ts';
import { buildSystemPrompt } from '../ui/core/agent/system-prompt.ts';

const profile = { customInstructions: '', aboutName: '', occupation: '', aboutMore: '' };

test('memory preferences default, validate and round-trip through the cloud field', () => {
  assert.deepEqual(readMemoryPreferences(undefined), defaultMemoryPreferences);
  assert.deepEqual(readMemoryPreferences({ enabled: false, summary: '# 记忆' }), { enabled: false, summary: '# 记忆', updatedAt: null });
  assert.deepEqual(readMemoryPreferences({ enabled: false, summary: '# 记忆', updatedAt: 123 }), { enabled: false, summary: '# 记忆', updatedAt: 123 });
  assert.throws(() => readMemoryPreferences('nope'), /Invalid memory/);
  assert.throws(() => readMemoryPreferences({ enabled: 'yes', summary: '' }), /Invalid memory/);
  assert.throws(() => readMemoryPreferences({ enabled: true, summary: '', updatedAt: 'yesterday' }), /Invalid memory/);
  assert.throws(() => readMemoryPreferences({ enabled: true, summary: 'x'.repeat(MEMORY_SUMMARY_LIMIT + 1) }), /Invalid memory/);

  const memory = { enabled: false, summary: '# 偏好\n- 中文', updatedAt: 456 };
  assert.deepEqual(parseMemoryField(serializeMemoryField(memory)), memory);
  assert.deepEqual(parseMemoryField('{not json'), defaultMemoryPreferences, 'a corrupt field degrades to empty memory');
  assert.deepEqual(parseMemoryField(JSON.stringify({ enabled: true, summary: 'x'.repeat(MEMORY_SUMMARY_LIMIT + 1) })), defaultMemoryPreferences);
});

test('memory normalization strips wrappers and fences from a generated summary', () => {
  assert.equal(normalizeMemorySummary('<memory>\n# 记忆\n- 简洁\n</memory>'), '# 记忆\n- 简洁');
  assert.equal(normalizeMemorySummary('```markdown\n# 记忆\n- 简洁\n```'), '# 记忆\n- 简洁');
  assert.equal(normalizeMemorySummary('  # 记忆  '), '# 记忆');
});

test('memory travels in the trailing request context only while enabled and non-empty', () => {
  const base = buildSystemPrompt(profile);
  assert.ok(!base.includes('<user_memory>'), 'the cacheable system prompt stays free of volatile memory');
  const memory = { enabled: true, summary: '# 记忆\n- 用户偏好中文' };
  assert.match(memoryPromptBlock(memory), /<user_memory>[\s\S]*用户偏好中文[\s\S]*<\/user_memory>/);
  assert.equal(memoryPromptBlock({ enabled: false, summary: memory.summary }), '');
  const message = requestContextMessage(memoryPromptBlock(memory));
  assert.equal(message.role, 'user');
  assert.match(message.content, /<user_memory>[\s\S]*用户偏好中文[\s\S]*<\/user_memory>/);
  assert.match(message.content, /<current_context>/);
});

test('the memory tool replaces the full summary and rejects oversized writes', async () => {
  let current = '# 旧记忆';
  const writes = [];
  const tool = createMemoryTool({
    getSummary: () => current,
    onUpdate: (summary) => { current = summary; writes.push(summary); },
  });
  assert.equal(tool.name, 'memory');
  const result = await tool.execute('call-1', { summary: '# 新记忆\n- 喜欢简洁' });
  assert.equal(current, '# 新记忆\n- 喜欢简洁');
  assert.deepEqual(writes, ['# 新记忆\n- 喜欢简洁']);
  assert.match(result.content[0].text, /已更新/);
  await assert.rejects(() => tool.execute('call-2', { summary: 'x'.repeat(MEMORY_SUMMARY_LIMIT + 1) }), /不能超过/);
});
