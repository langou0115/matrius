import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  defaultChatDisplay, getChatDisplay, setChatDisplay,
} from '../src/features/chat/display-preferences.ts';

test('process display switches default on and update one field at a time', () => {
  setChatDisplay(defaultChatDisplay);
  assert.deepEqual(getChatDisplay(), { thinkingExpanded: true, showThinking: true });

  setChatDisplay({ thinkingExpanded: false });
  assert.deepEqual(getChatDisplay(), { thinkingExpanded: false, showThinking: true }, 'the other switch is untouched');

  setChatDisplay({ showThinking: false });
  assert.deepEqual(getChatDisplay(), { thinkingExpanded: false, showThinking: false });

  setChatDisplay(defaultChatDisplay);
  assert.deepEqual(getChatDisplay(), defaultChatDisplay);
});
