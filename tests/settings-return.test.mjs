import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isSettingsPath,
  rememberWorkspacePath,
  rememberedWorkspacePath,
  resetWorkspaceReturnForTests,
  workspaceReturnHref,
  workspaceReturnLabel,
} from '../ui/features/settings/settings-return.ts';

test('settings paths are recognised for real and preview routes', () => {
  for (const path of ['/settings', '/settings/', '/settings/appearance',
    '/mock/chat/settings', '/mock/chat/settings/models']) {
    assert.equal(isSettingsPath(path), true, path);
  }
  for (const path of ['/', '/c/x', '/library', '/mock/chat', '/mock/chat/c/x', '/mock/library']) {
    assert.equal(isSettingsPath(path), false, path);
  }
});

test('settings returns to the page that opened it, not to a new conversation', () => {
  resetWorkspaceReturnForTests();
  rememberWorkspacePath('/c/abc');
  // Category switches inside settings must not replace the origin.
  rememberWorkspacePath('/settings/appearance');
  assert.equal(rememberedWorkspacePath(), '/c/abc');
  assert.equal(workspaceReturnHref('abc', false), '/c/abc');
  assert.equal(workspaceReturnLabel(), '返回对话');

  rememberWorkspacePath('/library/');
  assert.equal(workspaceReturnHref(null, false), '/library');
  assert.equal(workspaceReturnLabel(), '返回资料库');
});

test('without an origin, return falls back to the active conversation or home', () => {
  resetWorkspaceReturnForTests();
  assert.equal(workspaceReturnHref('abc', false), '/c/abc');
  assert.equal(workspaceReturnHref(null, false), '/');
  assert.equal(workspaceReturnHref('m1', true), '/mock/chat/c/m1');
  assert.equal(workspaceReturnLabel(), '返回对话');
});
