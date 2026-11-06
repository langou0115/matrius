import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { AuthProvider } from '../src/features/auth/auth-state.tsx';
import { LoginDialog } from '../src/features/auth/login-dialog.tsx';

test('a rejected login is reported once inside the login dialog', async () => {
  const keys = ['window', 'document', 'HTMLElement', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'];
  const saved = Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  for (const [key, value] of Object.entries({ window, document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  window.HTMLElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLElement.prototype.close = function () { this.removeAttribute('open'); };
  globalThis.fetch = async (url) => new Response(JSON.stringify({
    error: {
      code: 'unauthorized',
      message: url === '/api/auth/login' ? '用户名或密码错误。' : '请重新登录。',
    },
  }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  function Harness() {
    const [open, setOpen] = useState(true);
    return open
      ? createElement(LoginDialog, { onClose: () => setOpen(false) })
      : createElement('button', { id: 'reopen', onClick: () => setOpen(true) }, '重新登录');
  }

  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => root.render(createElement(AuthProvider, { preview: false }, createElement(Harness))));
    assert.equal(document.querySelectorAll('dialog[open]').length, 1);
    await act(async () => {
      document.querySelector('.login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    const failure = document.querySelector('dialog[open] .login-error');
    assert.match(failure.textContent, /用户名或密码错误/);
    assert.equal(document.querySelectorAll('dialog[open]').length, 1, 'the failure does not open a second dialog');

    await act(async () => { document.querySelector('[aria-label="关闭弹窗"]').click(); });
    await act(async () => { document.querySelector('#reopen').click(); });
    assert.equal(document.querySelector('.login-error'), null, 'reopening the dialog does not replay a stale failure');
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
