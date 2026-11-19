import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { ApiError } from '../ui/core/api/instance-client.ts';
import { AuthUnlockScreen } from '../ui/features/instance/auth-unlock-screen.tsx';

function setInputValue(input, value) {
  const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps'));
  assert.ok(propsKey);
  input.value = value;
  input[propsKey].onChange({ target: input });
}

test('AuthUnlockScreen toggles visibility, surfaces server errors, and submits secret', async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
    HTMLElement: globalThis.HTMLElement,
  };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const submitted = [];
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => root.render(createElement(AuthUnlockScreen, {
      onUnlock: async (secret) => {
        submitted.push(secret);
        if (secret === 'bad') throw new ApiError(401, 'invalid_secret', '访问密钥不正确。');
      },
    })));

    const input = document.querySelector('input');
    const toggle = document.querySelector('.auth-unlock-toggle');
    const form = document.querySelector('form');
    const submit = document.querySelector('.auth-unlock-submit');
    assert.ok(input && toggle && form && submit);
    assert.equal(input.getAttribute('type'), 'password');
    assert.equal(submit.disabled, true);

    await act(async () => { toggle.click(); });
    assert.equal(input.getAttribute('type'), 'text');

    await act(async () => { setInputValue(input, '  bad  '); });
    assert.equal(submit.disabled, false);

    const formProps = Object.keys(form).find((key) => key.startsWith('__reactProps'));
    assert.ok(formProps);
    await act(async () => { await form[formProps].onSubmit({ preventDefault() {} }); });
    assert.deepEqual(submitted, ['bad']);
    assert.equal(document.querySelector('.auth-unlock-error')?.textContent, '访问密钥不正确。');

    await act(async () => { setInputValue(input, 'good-secret'); });
    await act(async () => { await form[formProps].onSubmit({ preventDefault() {} }); });
    assert.deepEqual(submitted, ['bad', 'good-secret']);
    assert.equal(document.querySelector('.auth-unlock-error'), null);
  } finally {
    await act(async () => root.unmount());
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.HTMLElement = previous.HTMLElement;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});
