import assert from 'node:assert/strict';
import test from 'node:test';

import { chatReducer } from '../ui/features/chat/chat-state.tsx';

const conversation = (id, updatedAt) => ({ id, title: id, pinned: false, updatedAt, messages: [] });
const stateWith = (...conversations) => ({
  conversations, activeId: conversations[0]?.id ?? null, sidebarOpen: true, chatVisible: true,
});
const orderOf = (state) => [...state.conversations]
  .sort((left, right) => right.updatedAt - left.updatedAt)
  .map((item) => item.id);
const updatedAtOf = (state, id) => state.conversations.find((item) => item.id === id).updatedAt;

const reply = (conversationId, message) => ({ type: 'reply', conversationId, message });

/** The sidebar sorts by `updatedAt`, so the assertions pin when that field may move. */
test('the order time moves when a message arrives or a reply finishes its body, not on stream deltas', () => {
  const realNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    let state = stateWith(conversation('a', 100), conversation('b', 200));
    state = chatReducer(state, {
      type: 'send', conversationId: 'a', message: { id: 'u-a', role: 'user', content: '问题' },
    });
    assert.equal(updatedAtOf(state, 'a'), 1_000, 'sending a message is new activity');
    assert.deepEqual(orderOf(state), ['a', 'b']);

    // The empty streaming placeholder appends a message, so it may claim the top spot once.
    state = chatReducer(state, reply('a', { id: 'r-a', role: 'assistant', content: '', status: 'streaming' }));
    assert.equal(updatedAtOf(state, 'a'), 1_000);

    now = 1_500;
    state = chatReducer(state, reply('a', {
      id: 'r-a', role: 'assistant', content: '', reasoning: '先想一下', reasoningActive: true, status: 'streaming',
    }));
    assert.equal(updatedAtOf(state, 'a'), 1_000, 'a thinking update does not move the conversation');

    now = 2_000;
    state = chatReducer(state, reply('a', {
      id: 'r-a', role: 'assistant', content: '正文', reasoning: '先想一下', reasoningActive: false, status: 'streaming',
    }));
    assert.equal(updatedAtOf(state, 'a'), 1_000, 'streaming body text is not finished work');

    now = 2_500;
    state = chatReducer(state, reply('a', {
      id: 'r-a', role: 'assistant', content: '正文继续', reasoning: '先想一下', reasoningActive: false, status: 'streaming',
    }));
    assert.equal(updatedAtOf(state, 'a'), 1_000, 'later body deltas do not move the conversation either');

    now = 3_000;
    state = chatReducer(state, reply('a', {
      id: 'r-a', role: 'assistant', content: '正文继续', reasoning: '先想一下', status: 'complete',
    }));
    assert.equal(updatedAtOf(state, 'a'), 3_000, 'the finished body overwrites the order time');

    now = 3_500;
    state = chatReducer(state, reply('a', {
      id: 'r-a', role: 'assistant', content: '正文继续', reasoning: '先想一下', status: 'complete',
    }));
    assert.equal(updatedAtOf(state, 'a'), 3_000, 'a repeated completion does not bump the order again');
  } finally {
    Date.now = realNow;
  }
});

test('a chat that is still thinking or streaming cannot overtake one whose body has finished', () => {
  const realNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    let state = stateWith(conversation('a', 100), conversation('b', 100));
    now = 1_000;
    state = chatReducer(state, {
      type: 'send', conversationId: 'a', message: { id: 'u-a', role: 'user', content: '问题 A' },
    });
    now = 1_100;
    state = chatReducer(state, reply('a', { id: 'r-a', role: 'assistant', content: '', status: 'streaming' }));

    now = 2_000;
    state = chatReducer(state, {
      type: 'send', conversationId: 'b', message: { id: 'u-b', role: 'user', content: '问题 B' },
    });
    now = 2_100;
    state = chatReducer(state, reply('b', { id: 'r-b', role: 'assistant', content: '', status: 'streaming' }));
    assert.deepEqual(orderOf(state), ['b', 'a'], 'the later message is on top while both are generating');

    now = 2_500;
    state = chatReducer(state, reply('a', {
      id: 'r-a', role: 'assistant', content: '', reasoning: 'A 还在想', reasoningActive: true, status: 'streaming',
    }));
    now = 2_600;
    state = chatReducer(state, reply('b', {
      id: 'r-b', role: 'assistant', content: '', reasoning: 'B 还在想', reasoningActive: true, status: 'streaming',
    }));
    assert.deepEqual(orderOf(state), ['b', 'a'], 'thinking deltas never reshuffle the list');

    now = 3_000;
    state = chatReducer(state, reply('a', {
      id: 'r-a', role: 'assistant', content: 'A 的正文', reasoningActive: false, status: 'streaming',
    }));
    now = 3_200;
    state = chatReducer(state, reply('b', {
      id: 'r-b', role: 'assistant', content: 'B 的正文', reasoningActive: false, status: 'streaming',
    }));
    assert.deepEqual(orderOf(state), ['b', 'a'], 'streaming bodies do not reshuffle the list');

    now = 3_500;
    state = chatReducer(state, reply('a', {
      id: 'r-a', role: 'assistant', content: 'A 的正文', reasoningActive: false, status: 'complete',
    }));
    assert.deepEqual(orderOf(state), ['a', 'b'], 'the first finished body moves to the front');

    now = 4_000;
    state = chatReducer(state, reply('b', {
      id: 'r-b', role: 'assistant', content: 'B 的正文', reasoningActive: false, status: 'complete',
    }));
    assert.deepEqual(orderOf(state), ['b', 'a'], 'the next finished body overwrites the top spot once');
  } finally {
    Date.now = realNow;
  }
});
