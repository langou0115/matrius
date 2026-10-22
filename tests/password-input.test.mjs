import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { PasswordInput } from '../src/components/web/password-input.tsx';

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
