import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { InstanceProvider } from '../ui/features/instance/instance-state.tsx';
import { DesktopChatSettingsForm } from '../ui/features/settings/desktop-chat-settings.tsx';

function setupDom() {
  const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    Event: globalThis.Event,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };

  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  return {
    window,
    document,
    restore() {
      globalThis.window = previous.window;
      globalThis.document = previous.document;
      globalThis.HTMLElement = previous.HTMLElement;
      globalThis.Node = previous.Node;
      globalThis.Event = previous.Event;
      globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
    },
  };
}

function reactProps(element) {
  const key = Object.keys(element).find((prop) => prop.startsWith('__reactProps'));
  assert.ok(key);
  return element[key];
}

test('DesktopChatSettingsForm shows storage limit in MB and auto-saves without a Save button', async (t) => {
  const dom = setupDom();
  const root = createRoot(dom.document.getElementById('root'));
  const previousFetch = globalThis.fetch;
  let serverState = { storageLimitBytes: 134217728, webtoolProxyUrl: '', revision: 0 };
  const putBodies = [];
  let nextPutConflict = false;

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/desktop/chat-settings') {
      if ((init.method ?? 'GET') === 'GET') {
        return Response.json(serverState);
      }
      if (init.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        putBodies.push(body);
        if (nextPutConflict) {
          nextPutConflict = false;
          return Response.json({ detail: '设置已更新，请刷新后重试。' }, { status: 409 });
        }
        serverState = {
          storageLimitBytes: body.storageLimitBytes,
          webtoolProxyUrl: body.webtoolProxyUrl,
          revision: serverState.revision + 1,
        };
        return Response.json(serverState);
      }
    }
    return Response.json({});
  };

  try {
    await act(async () => {
      root.render(createElement(InstanceProvider, { preview: false }, createElement(DesktopChatSettingsForm)));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const limitInput = dom.document.querySelector('input[type="number"]');
    const proxyInput = dom.document.querySelector('input[type="url"]');
    assert.ok(limitInput && proxyInput);
    assert.match(limitInput.closest('label')?.textContent ?? '', /上传文件总量上限（MB）/u);
    assert.equal(limitInput.value, '128');
    assert.equal(proxyInput.value, '');
    assert.equal(dom.document.querySelector('button[type="submit"]'), null);

    // Editing storage limit auto-saves in bytes after the 400ms debounce.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await act(async () => {
      limitInput.value = '256';
      reactProps(limitInput).onChange({ target: limitInput });
    });
    assert.equal(putBodies.length, 0);
    await act(async () => {
      t.mock.timers.tick(400);
      await Promise.resolve();
    });
    assert.deepEqual(putBodies[0], {
      storageLimitBytes: 256 * 1024 * 1024,
      webtoolProxyUrl: '',
      baseRevision: 0,
    });

    // Editing proxy URL and blurring flushes immediately with chained revision.
    await act(async () => {
      proxyInput.value = 'http://127.0.0.1:7890';
      reactProps(proxyInput).onChange({ target: proxyInput });
    });
    await act(async () => {
      reactProps(proxyInput).onBlur({ currentTarget: proxyInput });
      await Promise.resolve();
    });
    assert.deepEqual(putBodies[1], {
      storageLimitBytes: 256 * 1024 * 1024,
      webtoolProxyUrl: 'http://127.0.0.1:7890',
      baseRevision: 1,
    });

    // Invalid proxy URL on blur shows validation feedback and does not PUT.
    const countBeforeInvalid = putBodies.length;
    await act(async () => {
      proxyInput.value = 'ftp://bad';
      reactProps(proxyInput).onChange({ target: proxyInput });
    });
    await act(async () => {
      reactProps(proxyInput).onBlur({ currentTarget: proxyInput });
      await Promise.resolve();
    });
    assert.equal(putBodies.length, countBeforeInvalid);
    assert.match(dom.document.querySelector('.settings-message.is-error')?.textContent ?? '', /代理地址/u);

    // Reverting to a valid proxy URL clears the error on auto-save; 409 conflict surfaces reload.
    nextPutConflict = true;
    await act(async () => {
      proxyInput.value = '';
      reactProps(proxyInput).onChange({ target: proxyInput });
    });
    await act(async () => {
      reactProps(proxyInput).onBlur({ currentTarget: proxyInput });
      await Promise.resolve();
    });
    assert.ok(dom.document.querySelector('.settings-message.is-error'));
    assert.ok(dom.document.querySelector('.settings-message-reload'));
  } finally {
    t.mock.timers.reset();
    await act(async () => { root.unmount(); });
    globalThis.fetch = previousFetch;
    dom.restore();
  }
});
