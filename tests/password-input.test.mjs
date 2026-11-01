import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { PasswordInput } from '../src/components/web/password-input.tsx';
import { AuthProvider } from '../src/features/auth/auth-state.web.tsx';
import { ChangePasswordDialog } from '../src/features/auth/change-password-dialog.web.tsx';

test('restored first-login sessions show only new password fields; normal changes require the current password', async () => {
  const keys = ['window', 'document', 'HTMLElement', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'];
  const saved = Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  for (const [key, value] of Object.entries({ window, document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  window.HTMLElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLElement.prototype.close = function () { this.removeAttribute('open'); };
  const root = createRoot(document.getElementById('root'));
  try {
    for (const initial of [true, false]) {
      globalThis.fetch = async () => new Response(JSON.stringify({
        id: 'alice', username: 'alice', isAdmin: false, mustChangePassword: initial, features: [],
      }));
      await act(async () => root.render(createElement(AuthProvider, { preview: false, key: String(initial) },
        createElement(ChangePasswordDialog, { onClose() {}, onSuccess() {} }))));
      assert.equal(document.querySelector('h2').textContent, initial ? '设置新密码' : '修改密码');
      assert.equal(document.querySelectorAll('input').length, initial ? 2 : 3);
      assert.equal(Boolean(document.querySelector('input[aria-label="当前密码"]')), !initial);
      assert(document.querySelector('input[aria-label="新密码"]'));
      assert(document.querySelector('input[aria-label="确认新密码"]'));
    }
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});

test('password visibility matches the icon and each field toggles independently without submitting', async () => {
  const saved = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  for (const [key, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const root = createRoot(document.getElementById('root'));
  let submissions = 0;
  try {
    await act(async () => root.render(createElement('form', { onSubmit: () => submissions++ },
      createElement(PasswordInput, { label: '新密码', defaultValue: 'x', required: true, maxLength: 256 }),
      createElement(PasswordInput, { label: '确认新密码', defaultValue: 'x', required: true, maxLength: 256 }))));
    const [password, confirmation] = document.querySelectorAll('input');
    assert.equal(password.type, 'password');
    assert.equal(confirmation.type, 'password');
    assert.equal(document.querySelectorAll('.lucide-eye-off').length, 2);
    assert.equal(password.hasAttribute('minlength'), false);
    await act(async () => document.querySelector('[aria-label="显示确认新密码"]').click());
    assert.equal(confirmation.type, 'text');
    assert.equal(password.type, 'password');
    assert(document.querySelector('[aria-label="隐藏确认新密码"] .lucide-eye'));
    assert.equal(document.querySelector('[aria-label="隐藏确认新密码"]').getAttribute('aria-pressed'), 'true');
    await act(async () => document.querySelector('[aria-label="隐藏确认新密码"]').click());
    assert.equal(confirmation.type, 'password');
    assert.equal(confirmation.value, 'x');
    assert.equal(password.value, 'x');
    assert.equal(submissions, 0);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
