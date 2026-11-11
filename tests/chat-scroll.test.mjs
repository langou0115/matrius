import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, useRef, act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { useChatAutoScroll } from '../src/features/chat/components/scroll-to-bottom.tsx';

/**
 * The button is meant for "I scrolled back to read something", not for "the page moved one line".
 *
 * Following stops at a small distance from the end, because that is what the reader meant when
 * they nudged the wheel. Visibility used to share that same threshold and therefore appeared after
 * roughly a tenth of a viewport. These assertions pin the two decisions apart: a partial nudge
 * stops the follow but must not summon the button.
 */
test('the jump button waits until the newest message is well out of view', async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  let visible = false;
  let scrollApi;

  function Harness({ followKey = 'messages' }) {
    const ref = useRef(null);
    scrollApi = useChatAutoScroll({ containerRef: ref, containerKey: 'chat', followKey });
    visible = scrollApi.visible;
    return createElement('div', { ref, id: 'scroller' });
  }

  const scroll = (scrollTop) => act(async () => {
    scroller.scrollTop = scrollTop;
    scroller.dispatchEvent(new window.Event('scroll'));
  });

  let scroller;
  try {
    await act(async () => { root.render(createElement(Harness)); });
    scroller = document.getElementById('scroller');
    const viewport = 800;
    const content = 4000;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: viewport },
      scrollHeight: { configurable: true, value: content },
      scrollTop: { configurable: true, writable: true, value: content - viewport },
      scrollTo: { configurable: true, value: ({ top }) => { scroller.scrollTop = top; } },
    });

    // Sitting at the end: nothing to jump to.
    await scroll(content - viewport);
    assert.equal(visible, false, 'at the bottom');

    // A small nudge is enough to stop auto-following, but the latest message is still on screen.
    await scroll(content - viewport - Math.round(viewport * 0.12));
    assert.equal(visible, false, 'a small nudge must not show the button');

    // Even most of a screen away is still within reach of a glance downward.
    await scroll(content - viewport - Math.round(viewport * 0.62));
    assert.equal(visible, false, 'a partial scroll must not show the button');
    await scroll(content - viewport - Math.round(viewport * 0.95));
    assert.equal(visible, false, 'even a nearly full screen must not show the button');

    // Only once the newest message is more than a full screen away is the jump worth offering.
    await scroll(content - viewport - Math.round(viewport * 1.25));
    assert.equal(visible, true, 'the button appears once the bottom is out of reach');

    // Returning to the end hides it again.
    await scroll(content - viewport - 20);
    assert.equal(visible, false, 'back at the bottom');

    const target = document.createElement('article');
    scroller.append(target);
    scroller.getBoundingClientRect = () => ({ top: 0 });
    target.getBoundingClientRect = () => ({ top: 1000 - scroller.scrollTop });
    await act(async () => { scrollApi.scrollToMessage(target); });
    assert.equal(scroller.scrollTop, 924, 'navigation leaves room for the sticky header');
    await act(async () => { root.render(createElement(Harness, { followKey: 'a new streamed token' })); });
    assert.equal(scroller.scrollTop, 924, 'streaming must not undo a navigation jump');
    await act(async () => { scrollApi.scrollToBottom(); });
    assert.equal(scroller.scrollTop, content, 'jump to latest remains available after navigation');
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

/**
 * Sending while reading older messages has to bring the reader back, and it has to
 * read as a move rather than the list teleporting under their eyes. The request is
 * made before the new message exists, so the jump must wait for layout; scrolling
 * immediately would only reach the previous end and pin would snap over it anyway.
 */
test('sending from an earlier position animates to the newest message', async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  let scrollApi;

  function Harness({ followKey }) {
    const ref = useRef(null);
    scrollApi = useChatAutoScroll({ containerRef: ref, containerKey: 'chat', followKey });
    return createElement('div', { ref, id: 'scroller' });
  }

  try {
    await act(async () => { root.render(createElement(Harness, { followKey: '1' })); });
    const scroller = document.getElementById('scroller');
    let behavior;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 800 },
      scrollHeight: { configurable: true, writable: true, value: 4000 },
      scrollTop: { configurable: true, writable: true, value: 3200 },
      scrollTo: { configurable: true, value: ({ top, behavior: requested }) => { behavior = requested; scroller.scrollTop = top; } },
    });

    // Scroll back to read, so the next content change would normally leave the view alone.
    await act(async () => {
      scroller.scrollTop = 600;
      scroller.dispatchEvent(new window.Event('scroll'));
    });
    await act(async () => { scrollApi.followLatest(); });
    // The sent message is laid out before the follow runs: this is the new end.
    scroller.scrollHeight = 4600;
    await act(async () => { root.render(createElement(Harness, { followKey: '2' })); });

    assert.equal(behavior, 'smooth', 'the jump is an animation, not a snap');
    assert.equal(scroller.scrollTop, 4600, 'the animation targets the end of the new content');
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('quoting accepts one assistant body, rejects controls, reasoning and cross-message ranges', async () => {
  const { readSelectionQuote } = await import('../src/features/chat/components/selection-quote.tsx');
  const { getCopyText } = await import('../src/features/chat/message-text.ts');
  const { getRequestText } = await import('../src/core/agent/context.ts');
  const { document } = parseHTML('<main><div data-quote-source><p>first paragraph</p><p>second paragraph</p><div class="message-code-header">copy</div></div><aside>reasoning</aside><div data-quote-source><p>another answer</p></div></main>');
  const container = document.querySelector('main');
  const [first, second, other] = document.querySelectorAll('p');
  const rect = { top: 100, left: 80, bottom: 130, width: 100, height: 30 };
  let includesControls = false;
  const range = { intersectsNode: () => includesControls, getClientRects: () => [rect] };
  const selected = { isCollapsed: false, rangeCount: 1, anchorNode: first.firstChild, focusNode: second.firstChild, getRangeAt: () => range, toString: () => 'first paragraph\nsecond paragraph' };
  assert.equal(readSelectionQuote(container, selected).content, 'first paragraph\nsecond paragraph');
  assert.equal(readSelectionQuote(container, { ...selected, focusNode: other.firstChild }), null);
  assert.equal(readSelectionQuote(container, { ...selected, anchorNode: document.querySelector('aside').firstChild }), null);
  assert.equal(readSelectionQuote(container, { ...selected, isCollapsed: true }), null);
  includesControls = true;
  assert.equal(readSelectionQuote(container, selected), null);
  const message = { role: 'user', content: 'explain this', quote: 'line one\nline two' };
  assert.equal(getCopyText(message), '> line one\n> line two\n\nexplain this');
  assert.ok(getRequestText(message).includes('用户本次消息：\nexplain this'));
  assert.equal(getCopyText({ role: 'assistant', content: 'original answer' }), 'original answer');
});

test('selection actions capture the passage before focus changes and dismiss without disturbing copying', async () => {
  const { SelectionQuote } = await import('../src/features/chat/components/selection-quote.tsx');
  const names = ['window', 'document', 'Node', 'innerWidth', 'innerHeight', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, { window, document, Node: window.Node, innerWidth: 1200, innerHeight: 800, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout });
  const root = createRoot(document.getElementById('root'));
  let selection = null;
  window.getSelection = () => selection;
  let quoted;
  function Harness() {
    const ref = useRef(null);
    return createElement('div', null, createElement('main', { ref }, createElement('div', { 'data-quote-source': true }, createElement('p', null, 'selected passage'))),
      createElement(SelectionQuote, { containerRef: ref, onQuote: (content) => { quoted = content; } }));
  }
  try {
    await act(async () => { root.render(createElement(Harness)); });
    document.querySelector('main').getBoundingClientRect = () => ({ top: 0, bottom: 800 });
    const text = document.querySelector('p').firstChild;
    await act(async () => { document.querySelector('p').dispatchEvent(new window.Event('pointerdown', { bubbles: true })); });
    selection = { isCollapsed: false, rangeCount: 1, anchorNode: text, focusNode: text, anchorOffset: 0, focusOffset: 16,
      getRangeAt: () => ({ intersectsNode: () => false, getClientRects: () => [{ left: 100, top: 200, bottom: 224, width: 100, height: 24 }] }),
      toString: () => 'selected passage', removeAllRanges: () => { selection = null; } };
    await act(async () => { document.querySelector('p').dispatchEvent(new window.Event('pointerup', { bubbles: true })); });
    const button = document.querySelector('.selection-quote-action');
    assert.ok(button, 'the quote action appears only after the drag completes');
    const down = new window.Event('pointerdown', { bubbles: true, cancelable: true });
    await act(async () => { button.dispatchEvent(down); button.click(); });
    assert.equal(down.defaultPrevented, true, 'pressing quote preserves the browser selection until it is captured');
    assert.equal(quoted, 'selected passage');
    assert.equal(document.querySelector('.selection-quote-action'), null);
    assert.equal(selection, null);
  } finally {
    await act(async () => { root.unmount(); });
    for (const name of names) globalThis[name] = previous[name];
  }
});

test('quote drafts are isolated per conversation and survive screen remounts', async () => {
  const { DraftProvider, useDrafts } = await import('../src/features/chat/draft-state.tsx');
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window; globalThis.document = document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  let drafts;
  function Harness() { drafts = useDrafts(); return null; }
  try {
    await act(async () => { root.render(createElement(DraftProvider, null, createElement(Harness))); });
    await act(async () => { drafts.setDraft('a', 'question'); drafts.setQuote('a', 'selected passage'); drafts.setQuote('b', 'another passage'); });
    await act(async () => { root.render(createElement(DraftProvider, null)); });
    await act(async () => { root.render(createElement(DraftProvider, null, createElement(Harness))); });
    assert.equal(drafts.drafts.a, 'question');
    assert.equal(drafts.quotes.a, 'selected passage');
    assert.equal(drafts.quotes.b, 'another passage');
    await act(async () => { drafts.setQuote('a', ''); });
    assert.equal(drafts.quotes.a, '');
    assert.equal(drafts.drafts.a, 'question', 'removing a quote keeps the typed question');
    assert.equal(drafts.quotes.b, 'another passage');
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('each conversation reopens where it was left, using the position saved in the browser', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT, localStorage: globalThis.localStorage };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window; globalThis.document = document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: () => null,
    get length() { return values.size; },
  };
  const root = createRoot(document.getElementById('root'));
  function Harness({ containerKey, scrollKey }) {
    const ref = useRef(null);
    useChatAutoScroll({ containerRef: ref, containerKey, followKey: containerKey, scrollKey });
    return createElement('div', { ref, id: 'scroller' });
  }
  try {
    await act(async () => { root.render(createElement(Harness, { containerKey: 'a', scrollKey: 'a' })); });
    const scroller = document.getElementById('scroller');
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 800 },
      scrollHeight: { configurable: true, value: 4000 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    await act(async () => { scroller.scrollTop = 900; scroller.dispatchEvent(new window.Event('scroll')); });
    // Leave the conversation; its offset is captured even if the save debounce has not fired.
    await act(async () => { root.render(createElement(Harness, { containerKey: 'b', scrollKey: 'b' })); });
    assert.equal(scroller.scrollTop, 4000, 'a conversation without a position opens at the newest message');
    await act(async () => { scroller.dispatchEvent(new window.Event('scroll')); });
    await act(async () => { root.render(createElement(Harness, { containerKey: 'a', scrollKey: 'a' })); });
    assert.equal(scroller.scrollTop, 900, 'returning to a conversation restores its reading position');
    await act(async () => { scroller.scrollTop = 4000; scroller.dispatchEvent(new window.Event('scroll')); });
    await act(async () => { root.render(createElement(Harness, { containerKey: 'b', scrollKey: 'b' })); });
    await act(async () => { root.render(createElement(Harness, { containerKey: 'a', scrollKey: 'a' })); });
    assert.equal(scroller.scrollTop, 4000, 'a conversation left at the bottom opens at the bottom');
    const saved = JSON.parse(values.get('matrius.chat-scroll-positions'));
    assert.deepEqual(saved.a, { top: 4000, atBottom: true });
    assert.deepEqual(saved.b, { top: 4000, atBottom: true });
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
    if (previous.localStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous.localStorage;
  }
});

test('conversation navigation tracks reading, opens the question card and jumps to a selected question', async () => {
  const { ConversationNavigator } = await import('../src/features/chat/components/conversation-navigator.tsx');
  const names = ['window', 'document', 'Node', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, { window, document, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (callback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout });
  const root = createRoot(document.getElementById('root'));
  const messages = Array.from({ length: 20 }, (_, index) => ({ id: `u${index}`, role: 'user', content: `question ${index}` }));
  let jumped;
  function Harness({ count = 20 }) {
    const ref = useRef(null);
    return createElement('div', null,
      createElement('main', { ref, id: 'chat' }, messages.slice(0, count).map((message, index) => createElement('article', { key: message.id, 'data-user-message-id': message.id, 'data-offset': index * 500 }, message.content))),
      createElement(ConversationNavigator, { messages: messages.slice(0, count), containerRef: ref, onNavigate: (element) => { jumped = element.dataset.userMessageId; } }));
  }
  try {
    await act(async () => { root.render(createElement(Harness, { count: 3 })); });
    assert.equal(document.querySelector('nav'), null, 'short conversations stay uncluttered');
    // The navigator measures the scroller as soon as it mounts; install the fake metrics while
    // the short conversation is on screen so its first sync sees the real reading position.
    const container = document.getElementById('chat');
    Object.defineProperties(container, { clientHeight: { value: 800 }, scrollHeight: { value: 11000 }, scrollTop: { writable: true, value: 0 } });
    container.getBoundingClientRect = () => ({ top: 0 });
    const positionChildren = () => {
      for (const element of container.children) element.getBoundingClientRect = () => ({ top: Number(element.dataset.offset) - container.scrollTop });
    };
    positionChildren();
    await act(async () => { root.render(createElement(Harness)); });
    positionChildren();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    assert.equal(document.querySelectorAll('.navigator-bars > span').length, 15, 'the compact rail stays bounded');
    await act(async () => { document.querySelector('.conversation-navigator-trigger').click(); });
    assert.equal(document.querySelectorAll('.conversation-navigator-list > button').length, 20, 'the full card includes every question');
    assert.equal(document.querySelector('.conversation-navigator-list [aria-current]').textContent, '1question 0');
    await act(async () => { container.scrollTop = 1600; container.dispatchEvent(new window.Event('scroll')); await new Promise(resolve => setTimeout(resolve, 5)); });
    assert.equal(document.querySelector('.conversation-navigator-list [aria-current]').textContent, '4question 3');
    await act(async () => { document.querySelectorAll('.conversation-navigator-list > button')[12].click(); });
    assert.equal(jumped, 'u12', 'the selected question is passed to the actual message scroller');
    await act(async () => { document.querySelector('nav').dispatchEvent(Object.assign(new window.Event('keydown', { bubbles: true, cancelable: true }), { key: 'Escape' })); });
    assert.equal(document.querySelector('.conversation-navigator-card'), null);
  } finally {
    await act(async () => { root.unmount(); });
    for (const name of names) globalThis[name] = previous[name];
  }
});
