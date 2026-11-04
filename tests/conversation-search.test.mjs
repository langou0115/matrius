import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatRelativeTime,
  searchConversations,
  splitMatches,
  toPlainText,
} from '../src/features/chat/conversation-search.ts';

const message = (content, id = content) => ({ id, role: 'user', content });
const conversation = (id, title, updatedAt, messages) => ({
  id, title, pinned: false, updatedAt, messages,
});

test('an empty query lists recent conversations and previews their newest message', () => {
  const results = searchConversations([
    conversation('older', '较早', 100, [message('第一条'), message('  最新\n  内容  ')]),
    conversation('newer', '较新', 200, [message('只有一条')]),
  ], '   ');

  assert.deepEqual(results.map((item) => item.id), ['newer', 'older']);
  assert.equal(results[0].snippet, '只有一条');
  assert.equal(results[1].snippet, '最新 内容');
});

test('matches titles and the newest matching message, not every message', () => {
  const results = searchConversations([
    conversation('title', 'Alpha 项目复盘', 100, [message('无关内容')]),
    conversation('body', '普通对话', 200, [
      message('很早就提到 alpha 的旧消息', 'old'),
      message('最近这条也提到 Alpha，应被选中', 'new'),
    ]),
    conversation('other', '其他', 100, [message('没有关键词')]),
  ], 'alpha');

  assert.deepEqual(results.map((item) => item.id), ['body', 'title']);
  assert.match(results[0].snippet, /最近这条也提到 Alpha/);
  assert.equal(results[1].snippet, '无关内容', 'a title hit still gets a quiet preview');
});

test('snippets center the hit and flatten whitespace', () => {
  const content = `${'开头'.repeat(30)}\n\n  Needle \n ${'结尾'.repeat(40)}`;
  const [result] = searchConversations([conversation('one', '无关标题', 1, [message(content)])], 'needle');
  assert.ok(result.snippet.startsWith('…'));
  assert.ok(result.snippet.includes('Needle'));
  assert.ok(!result.snippet.includes('\n'));
});

test('markdown is stripped from previews while its text stays searchable', () => {
  const content = [
    '## 小结',
    '',
    '正文同时包含 **粗体**、*斜体*、`inline code` 和 ~~删除线~~。',
    '',
    '```ts',
    'const answer = 42;',
    '```',
  ].join('\n');
  assert.equal(
    toPlainText(content),
    '小结 正文同时包含 粗体、斜体、inline code 和 删除线。 const answer = 42;',
  );

  const [result] = searchConversations([
    conversation('markdown', '格式', 1, [message(content)]),
  ], '粗体');
  assert.ok(result);
  assert.ok(result.snippet.includes('粗体'));
  assert.ok(!result.snippet.includes('**'));
  assert.ok(!result.snippet.includes('```'));
});

test('respects the result limit and returns nothing when the query is absent', () => {
  const data = [
    conversation('a', 'alpha one', 3, []),
    conversation('b', 'alpha two', 2, []),
    conversation('c', 'alpha three', 1, []),
  ];
  assert.equal(searchConversations(data, 'alpha').length, 3);
  assert.equal(searchConversations(data, 'alpha', 2).length, 2);
  assert.deepEqual(searchConversations(data, 'missing'), []);
  assert.deepEqual(searchConversations(data, 'alpha', 0), []);
});

test('splits text into case-insensitive highlight parts', () => {
  assert.deepEqual(splitMatches('Hello hello', 'hello'), [
    { text: 'Hello', match: true },
    { text: ' ', match: false },
    { text: 'hello', match: true },
  ]);
  assert.deepEqual(splitMatches('对话标题', ''), [{ text: '对话标题', match: false }]);
  assert.deepEqual(splitMatches('abc', 'zzz'), [{ text: 'abc', match: false }]);
});

test('formats relative recency at the minute, hour, day, and date boundaries', () => {
  const now = new Date(2026, 10, 4, 12, 0, 0).getTime();
  assert.equal(formatRelativeTime(now - 30_000, now), '刚刚');
  assert.equal(formatRelativeTime(now - 5 * 60_000, now), '5 分钟前');
  assert.equal(formatRelativeTime(now - 2 * 3_600_000, now), '2 小时前');
  assert.equal(formatRelativeTime(now - 3 * 86_400_000, now), '3 天前');
  assert.equal(formatRelativeTime(new Date(2026, 9, 25, 12).getTime(), now), '10月25日');
  assert.equal(formatRelativeTime(new Date(2025, 11, 31, 12).getTime(), now), '2025年12月31日');
  assert.equal(formatRelativeTime(now + 60_000, now), '刚刚');
  assert.equal(formatRelativeTime(Number.NaN, now), '');
  assert.equal(formatRelativeTime(0, now), '');
});
