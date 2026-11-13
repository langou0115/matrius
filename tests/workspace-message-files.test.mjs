import assert from 'node:assert/strict';
import test from 'node:test';

import { compactActivities, compactProcess } from '../ui/core/agent/activity-payload.ts';
import {
  parseWorkspace,
  readActivities,
  readFileIds,
  readMessageFiles,
  stripMessageImages,
} from '../ui/features/workspace/workspace-repository.ts';

const report = { id: 'f1', filename: '报告.pdf', contentType: 'application/pdf', size: 2048, revision: 3 };

function workspace(messages) {
  return {
    schemaVersion: 1,
    chat: {
      conversations: [{ id: 'c1', title: 'Files', pinned: false, updatedAt: 1, messages }],
      activeId: 'c1',
      sidebarOpen: true,
    },
    appearance: { themeId: 'twitter', mode: 'system' },
  };
}

test('stored files and file ids survive a workspace round trip', () => {
  const parsed = parseWorkspace(workspace([{
    id: 'm1', role: 'user', content: 'see attached', fileIds: ['f1'], files: [report],
  }]));
  const message = parsed.data.chat.conversations[0].messages[0];
  assert.deepEqual(message.fileIds, ['f1']);
  assert.deepEqual(message.files, [report]);
});

test('malformed file entries are dropped without losing the message', () => {
  assert.deepEqual(readMessageFiles([
    report,
    { id: '', filename: 'missing-id.pdf' },
    { id: 'f2' },
    { id: 'f3', filename: 'no-type.bin' },
    'nope',
  ]), [
    report,
    { id: 'f3', filename: 'no-type.bin', contentType: 'application/octet-stream', size: 0 },
  ]);
  assert.equal(readMessageFiles('nope'), undefined);
  assert.deepEqual(readFileIds(['f1', 'f1', 7, '', 'f2']), ['f1', 'f2']);
  assert.equal(readFileIds([]), undefined);
  assert.equal(readFileIds(['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10',
    'f11', 'f12', 'f13', 'f14', 'f15', 'f16', 'f17', 'f18', 'f19', 'f20', 'f21']).length, 20);

  const parsed = parseWorkspace(workspace([{
    id: 'm1', role: 'assistant', content: 'ok', files: [{ id: 'bad' }], status: 'complete',
  }]));
  assert.equal(parsed.data.chat.conversations[0].messages[0].files, undefined);
});

test('stripping inline image bytes keeps file references', () => {
  const [conversation] = stripMessageImages([{
    id: 'c1', title: 'x', pinned: false, updatedAt: 1,
    messages: [{
      id: 'm1', role: 'user', content: 'hi', fileIds: ['f1'], files: [report],
      images: [{ dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png' }],
    }],
  }]);
  const [message] = conversation.messages;
  assert.equal('images' in message, false);
  assert.deepEqual(message.fileIds, ['f1']);
  assert.deepEqual(message.files, [report]);
});

test('file tool activities keep their operation and saved links across a reload', () => {
  const activities = readActivities([{
    id: 'call-1', kind: 'file', status: 'running', operation: 'create',
    fileId: 'draft:1', filename: 'draft.pdf', size: 12, savedFileId: 'f9',
    warning: '结果已截断。', tookMs: 5, startedAt: 1,
  }]);
  assert.deepEqual(activities, [{
    id: 'call-1', kind: 'file', status: 'stopped', operation: 'create',
    fileId: 'draft:1', filename: 'draft.pdf', size: 12, savedFileId: 'f9',
    warning: '结果已截断。', tookMs: 5, startedAt: 1,
  }]);

  const compacted = compactActivities(activities);
  const restored = readActivities(compacted);
  assert.deepEqual(restored, activities);
});

test('a ten-page fetch keeps every page URL in the persisted activity', () => {
  const urls = Array.from({ length: 10 }, (_, index) => `https://example.com/${index}`);
  const [activity] = compactActivities([{
    id: 'fetch', kind: 'fetch', status: 'complete', url: urls[0], urls, title: 'Page',
  }]);
  assert.deepEqual(activity.urls, urls);
});

test('a multi-query search keeps every keyword in the persisted activity', () => {
  const [activity] = compactActivities([{
    id: 'search', kind: 'search', status: 'complete', query: 'first', queries: ['first', 'second'],
  }]);
  assert.deepEqual(activity.queries, ['first', 'second']);
});

test('long tool failures cannot exceed the server activity limits and wedge conversation saving', () => {
  const [activity] = compactActivities([{
    id: 'bad-call', kind: 'file', operation: 'create', status: 'error',
    error: 'Schema validation failed: '.repeat(500), warning: 'w'.repeat(1500),
    title: 't'.repeat(400), filename: 'f'.repeat(400),
  }]);
  assert.equal(activity.error.length, 1000);
  assert.equal(activity.warning.length, 1000);
  assert.equal(activity.filename.length, 300);
  assert.equal(activity.title.length, 300);
  assert.equal(activity.id, 'bad-call');
  assert.equal(activity.status, 'error');
});

test('the ordered process is compacted like activities so one merged search cannot fail the save', () => {
  const results = Array.from({ length: 30 }, (_, index) => ({
    rank: index, title: 't'.repeat(400), url: `https://example.com/${index}`, domain: 'example.com', snippet: 'snippet',
  }));
  results.push({ rank: 99, title: 'bad', url: 'ftp://example.com/x', domain: 'ftp' });
  const compacted = compactProcess([
    { id: 'think', kind: 'thinking', content: '先想一下', status: 'complete' },
    { id: 'search', kind: 'search', status: 'complete', query: 'q', queries: ['q1', 'q2'], results },
    { id: 'fetch', kind: 'fetch', status: 'complete', url: 'https://example.com/a', urls: ['https://example.com/a', 'javascript:alert(1)'] },
  ]);
  assert.equal(compacted.length, 3);
  assert.equal(compacted[0].kind, 'thinking');
  assert.equal(compacted[0].content, '先想一下');
  assert.equal(compacted[1].results.length, 20, 'the server accepts at most 20 results');
  assert.ok(compacted[1].results.every((result) => result.url.startsWith('https://')));
  assert.equal(compacted[1].results[0].title.length, 300);
  assert.deepEqual(compacted[1].queries, ['q1', 'q2']);
  assert.deepEqual(compacted[2].urls, ['https://example.com/a'], 'non-http URLs never reach the server');
});

test('a process longer than the server limit keeps its newest steps', () => {
  const process = Array.from({ length: 130 }, (_, index) => ({
    id: `t${index}`, kind: 'thinking', content: `step ${index}`, status: 'complete',
  }));
  const compacted = compactProcess(process);
  assert.equal(compacted.length, 100);
  assert.equal(compacted.at(-1).id, 't129');
});
