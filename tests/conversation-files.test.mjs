import assert from 'node:assert/strict';
import test from 'node:test';

import { conversationFileIds } from '../ui/features/chat/conversation-files.ts';

function conversation(id, messages) {
  return { id, title: id, pinned: false, updatedAt: 1, messages };
}

test('a conversation points at uploaded documents, reply files and in-memory images', () => {
  const uploaded = { id: 'f-upload', filename: '报告.pdf', contentType: 'application/pdf', size: 2048 };
  const generated = { id: 'f-generated', filename: '表格.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 4096 };
  const ids = conversationFileIds(conversation('c1', [
    { id: 'm1', role: 'user', content: '看附件', fileIds: ['f-upload'], files: [uploaded],
      images: [{ id: 'i1', name: '截图.png', mimeType: 'image/png', size: 10, fileId: 'f-image' }] },
    { id: 'm2', role: 'assistant', content: '好的', files: [generated], fileIds: ['f-generated'], status: 'complete' },
    // The same upload id can appear on the message and its file entry; it is deleted once.
    { id: 'm3', role: 'user', content: '再来一份', fileIds: ['f-upload'], files: [uploaded] },
  ]));
  assert.deepEqual(ids, ['f-upload', 'f-image', 'f-generated']);
});

test('files still referenced by another conversation are kept out of the cleanup', () => {
  const shared = { id: 'f-shared', filename: '共用.docx', contentType: 'application/docx', size: 12 };
  const target = conversation('c1', [
    { id: 'm1', role: 'user', content: '看附件', fileIds: ['f-shared'], files: [shared] },
    { id: 'm2', role: 'assistant', content: '生成', files: [{ id: 'f-own', filename: '本对话.pdf', contentType: 'application/pdf', size: 8 }] },
  ]);
  const fork = conversation('c2', [
    { id: 'c2-1', role: 'user', content: '看附件', fileIds: ['f-shared'], files: [shared] },
  ]);
  assert.deepEqual(conversationFileIds(target, [target, fork]), ['f-own']);
  // Without the other conversations the caller cannot know about the shared reference.
  assert.deepEqual(conversationFileIds(target), ['f-shared', 'f-own']);
});

test('a conversation without attachments offers nothing to delete', () => {
  assert.deepEqual(conversationFileIds(conversation('c1', [
    { id: 'm1', role: 'user', content: '只是聊天' },
    { id: 'm2', role: 'assistant', content: '好的', status: 'complete' },
  ])), []);
});
