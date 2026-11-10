import assert from 'node:assert/strict';
import test from 'node:test';

import { APP_TITLE, conversationDocumentTitle } from '../src/features/chat/document-title.ts';

test('the tab title uses the conversation name when one is available', () => {
  assert.equal(conversationDocumentTitle('旅行计划'), '旅行计划');
  assert.equal(conversationDocumentTitle('  旅行计划  '), '旅行计划');
});

test('empty, missing or blank titles fall back to the app name', () => {
  assert.equal(APP_TITLE, 'Matrius');
  for (const value of [null, undefined, '', '   ']) {
    assert.equal(conversationDocumentTitle(value), 'Matrius');
  }
});
