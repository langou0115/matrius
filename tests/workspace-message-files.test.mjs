import assert from 'node:assert/strict';
import test from 'node:test';

import { compactActivities } from '../src/core/agent/activity-payload.ts';
import {
  parseWorkspace,
  readActivities,
  readFileIds,
  readMessageFiles,
  stripMessageImages,
} from '../src/features/workspace/workspace-repository.web.ts';

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
