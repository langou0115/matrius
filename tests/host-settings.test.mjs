import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { ChatProvider } from '../ui/features/chat/chat-state.tsx';
import HostSettingsScreen from '../ui/features/hosts/host-settings-screen.tsx';
import { InstanceProvider } from '../ui/features/instance/instance-state.tsx';
import { PreviewContext } from '../ui/features/workspace/preview-context.ts';

function setInputValue(input, value) {
  const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps'));
  assert.ok(propsKey);
  input.value = value;
  input[propsKey].onChange({ target: input });
}

function setupDom({ mobile = false, target = 'desktop' } = {}) {
  const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    Event: globalThis.Event,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
    dev: globalThis.__DEV__,
    target: globalThis.__MATRIUS_TARGET__,
  };

  window.matchMedia = (query) => ({
    matches: query === '(max-width: 767px)' ? mobile : false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  window.HTMLElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLElement.prototype.close = function () { this.removeAttribute('open'); };
  window.HTMLElement.prototype.focus = function () {};
  window.HTMLElement.prototype.scrollIntoView = function () {};

  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.__DEV__ = true;
  globalThis.__MATRIUS_TARGET__ = target;

  return {
    document,
    restore() {
      globalThis.window = previous.window;
      globalThis.document = previous.document;
      globalThis.HTMLElement = previous.HTMLElement;
      globalThis.Node = previous.Node;
      globalThis.Event = previous.Event;
      globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
      globalThis.__DEV__ = previous.dev;
      globalThis.__MATRIUS_TARGET__ = previous.target;
    },
  };
}

test('desktop host settings screen renders 工作 group above 应用 and manages SSH/WSL hosts in preview', async () => {
  const dom = setupDom({ mobile: false, target: 'desktop' });
  const root = createRoot(dom.document.getElementById('root'));

  try {
    await act(async () => {
      root.render(
        createElement(
          InstanceProvider,
          { preview: true },
          createElement(
            PreviewContext.Provider,
            { value: true },
            createElement(
              ChatProvider,
              null,
              createElement(HostSettingsScreen),
            ),
          ),
        ),
      );
    });

    const navGroups = Array.from(dom.document.querySelectorAll('.settings-nav-group > h2'))
      .map((heading) => heading.textContent?.trim());
    assert.deepEqual(navGroups, ['偏好', '工作', '应用']);

    const cards = Array.from(dom.document.querySelectorAll('.host-card'));
    assert.equal(cards.length, 2);
    assert.match(dom.document.body.textContent ?? '', /开发服务器/);
    assert.match(dom.document.body.textContent ?? '', /Ubuntu-24\.04/);

    // Filter to WSL only.
    const filterButtons = Array.from(dom.document.querySelectorAll('[aria-label="主机类型筛选"] button'));
    await act(async () => { filterButtons[2].click(); });
    assert.equal(dom.document.querySelectorAll('.host-card').length, 1);

    // Filter back to All and disconnect first host.
    await act(async () => { filterButtons[0].click(); });
    const disconnectBtn = Array.from(dom.document.querySelectorAll('.host-card button'))
      .find((btn) => btn.textContent?.includes('断开'));
    assert.ok(disconnectBtn);
    await act(async () => { disconnectBtn.click(); });
    assert.match(dom.document.body.textContent ?? '', /已断开/);

    // Discover WSL distros inside a modal dialog and add Debian.
    assert.equal(dom.document.querySelector('.hosts-discovery-dialog[open]'), null);
    const discoverBtn = Array.from(dom.document.querySelectorAll('button'))
      .find((btn) => btn.textContent?.includes('检测本机 WSL'));
    assert.ok(discoverBtn);
    await act(async () => { discoverBtn.click(); });

    const discoverDialog = dom.document.querySelector('.hosts-discovery-dialog[open]');
    assert.ok(discoverDialog);
    assert.match(discoverDialog.textContent ?? '', /本机 WSL 发行版/);
    assert.match(discoverDialog.textContent ?? '', /Debian/);
    assert.equal(dom.document.querySelectorAll('.hosts-discovery-card').length, 0);

    const addDebian = Array.from(discoverDialog.querySelectorAll('.hosts-discovery-item button'))
      .find((btn) => btn.textContent?.includes('添加到主机'));
    assert.ok(addDebian);
    await act(async () => { addDebian.click(); });
    assert.equal(dom.document.querySelectorAll('.host-card').length, 3);
    assert.equal(addDebian.textContent?.trim(), '已添加');
    assert.equal(addDebian.disabled, true);

    const doneBtn = Array.from(discoverDialog.querySelectorAll('.dialog-footer button'))
      .find((btn) => btn.textContent?.includes('完成'));
    assert.ok(doneBtn);
    await act(async () => { doneBtn.click(); });
    assert.equal(dom.document.querySelector('.hosts-discovery-dialog[open]'), null);

    // Open Add Host modal: omit 默认工作目录 / 备注 / 清除已保存的密码, and verify password visibility toggle.
    const addHostBtn = Array.from(dom.document.querySelectorAll('.hosts-actions button'))
      .find((btn) => btn.textContent?.includes('添加主机'));
    assert.ok(addHostBtn);
    await act(async () => { addHostBtn.click(); });

    const formDialog = dom.document.querySelector('.model-form-dialog[open]');
    assert.ok(formDialog);
    assert.doesNotMatch(formDialog.textContent ?? '', /默认工作目录/);
    assert.doesNotMatch(formDialog.textContent ?? '', /备注/);

    const authTrigger = formDialog.querySelector('.select-field-trigger');
    assert.ok(authTrigger);
    await act(async () => { authTrigger.click(); });
    const passwordOption = Array.from(formDialog.querySelectorAll('.select-field-popover button'))
      .find((btn) => btn.textContent?.includes('密码'));
    assert.ok(passwordOption);
    await act(async () => { passwordOption.click(); });

    const secretInput = formDialog.querySelector('.host-secret-wrap input');
    const secretToggle = formDialog.querySelector('.host-secret-toggle');
    assert.ok(secretInput);
    assert.ok(secretToggle);
    assert.equal(secretInput.getAttribute('type'), 'password');
    assert.equal(secretToggle.getAttribute('aria-label'), '显示密码');
    assert.equal(secretToggle.getAttribute('aria-pressed'), 'false');
    assert.doesNotMatch(formDialog.textContent ?? '', /清除已保存的密码/);

    await act(async () => { secretToggle.click(); });
    assert.equal(secretInput.getAttribute('type'), 'text');
    assert.equal(secretToggle.getAttribute('aria-label'), '隐藏密码');
    assert.equal(secretToggle.getAttribute('aria-pressed'), 'true');

    await act(async () => { secretToggle.click(); });
    assert.equal(secretInput.getAttribute('type'), 'password');
    assert.equal(secretToggle.getAttribute('aria-label'), '显示密码');

    // Fill required SSH fields and save a password-authenticated host, then reopen Edit.
    const nameInput = formDialog.querySelector('input[placeholder*="生产服务器"]');
    const hostInput = formDialog.querySelector('input[placeholder*="192.168"]');
    const formEl = formDialog.querySelector('form');
    assert.ok(nameInput && hostInput && formEl);
    await act(async () => {
      setInputValue(nameInput, '密码测试主机');
      setInputValue(hostInput, '10.0.0.8');
      setInputValue(secretInput, 's3cr3t!');
    });
    const formProps = Object.keys(formEl).find((key) => key.startsWith('__reactProps'));
    assert.ok(formProps);
    await act(async () => { await formEl[formProps].onSubmit({ preventDefault() {} }); });
    assert.equal(dom.document.querySelector('.model-form-dialog[open]'), null);
    assert.equal(dom.document.querySelectorAll('.host-card').length, 4);

    const editPasswordHostBtn = dom.document.querySelector('button[aria-label="编辑主机：密码测试主机"]');
    assert.ok(editPasswordHostBtn);
    await act(async () => { editPasswordHostBtn.click(); });
    const editDialog = dom.document.querySelector('.model-form-dialog[open]');
    assert.ok(editDialog);
    const editSecretInput = editDialog.querySelector('.host-secret-wrap input');
    const editSecretToggle = editDialog.querySelector('.host-secret-toggle');
    assert.ok(editSecretInput && editSecretToggle);
    assert.equal(editSecretInput.getAttribute('type'), 'password');
    assert.equal(editSecretInput.getAttribute('placeholder'), '已保存；留空保持不变');
    assert.doesNotMatch(editDialog.textContent ?? '', /清除已保存的密码/);
    assert.doesNotMatch(editDialog.textContent ?? '', /默认工作目录/);
    assert.doesNotMatch(editDialog.textContent ?? '', /备注/);
  } finally {
    await act(async () => { root.unmount(); });
    dom.restore();
  }
});
