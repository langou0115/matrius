import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { ChatProvider } from '../ui/features/chat/chat-state.tsx';
import { InstanceProvider } from '../ui/features/instance/instance-state.tsx';
import { PreviewContext } from '../ui/features/workspace/preview-context.ts';
import { WorkSidebarPanel } from '../ui/features/work/work-sidebar-panel.tsx';
import { resetWorkStateForTests } from '../ui/features/work/work-state.ts';

function setupDom() {
  resetWorkStateForTests();
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

  window.matchMedia = () => ({
    matches: false,
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
  globalThis.__MATRIUS_TARGET__ = 'desktop';

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

test('work sidebar creates projects by selecting host and browsing directories/files', async () => {
  const dom = setupDom();
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
              createElement(WorkSidebarPanel),
            ),
          ),
        ),
      );
    });

    assert.equal(dom.document.querySelector('.work-projects-empty'), null);
    assert.equal(dom.document.querySelectorAll('.work-project-item').length, 0);
    const projectRegion = dom.document.querySelector('#sidebar-work-projects');
    assert.ok(projectRegion);
    assert.equal(projectRegion.hasAttribute('hidden'), false);
    assert.equal(projectRegion.textContent?.trim(), '');

    const openCreateBtn = Array.from(dom.document.querySelectorAll('button'))
      .find((btn) => btn.textContent?.includes('创建项目'));
    assert.ok(openCreateBtn);
    await act(async () => { openCreateBtn.click(); });

    const createDialog = dom.document.querySelector('.work-project-dialog[open]');
    assert.ok(createDialog);
    assert.match(createDialog.textContent ?? '', /设置 → 工作 → 主机/);
    assert.doesNotMatch(createDialog.textContent ?? '', /或文件/);

    // Check host options include local host + configured hosts from 设置 -> 工作 -> 主机.
    const hostTrigger = createDialog.querySelector('.select-field-trigger');
    assert.ok(hostTrigger);
    await act(async () => { hostTrigger.click(); });
    const hostOptionsText = Array.from(createDialog.querySelectorAll('.select-field-popover button'))
      .map((btn) => btn.textContent?.trim() ?? '');
    assert.ok(hostOptionsText.some((text) => text.includes('本机')));
    assert.ok(hostOptionsText.some((text) => text.includes('Ubuntu-24.04')));
    assert.ok(hostOptionsText.some((text) => text.includes('开发服务器')));

    const sshOption = Array.from(createDialog.querySelectorAll('.select-field-popover button'))
      .find((btn) => btn.textContent?.includes('开发服务器'));
    assert.ok(sshOption);
    await act(async () => { sshOption.click(); });

    // Open directory & file browser modal by clicking 项目目录.
    const dirPickerBtn = createDialog.querySelector('.work-dir-picker');
    assert.ok(dirPickerBtn);
    await act(async () => { dirPickerBtn.click(); });

    const browserDialog = dom.document.querySelector('.work-browser-dialog[open]');
    assert.ok(browserDialog);
    assert.match(browserDialog.textContent ?? '', /SSH · 开发服务器/);
    assert.match(browserDialog.textContent ?? '', /projects/);
    assert.match(browserDialog.textContent ?? '', /notes\.md/);
    assert.equal(browserDialog.querySelector('.work-browser-filter')?.getAttribute('placeholder'), '筛选当前目录中的文件夹…');
    assert.equal(browserDialog.querySelector('.work-browser-pick-btn'), null);

    // Verify inaccessible directory cannot be selected and preserves the current listing + parent navigation.
    const restrictedRowBtn = Array.from(browserDialog.querySelectorAll('.work-browser-item'))
      .find((btn) => btn.textContent?.includes('restricted'));
    assert.ok(restrictedRowBtn);
    assert.match(restrictedRowBtn.textContent ?? '', /无权限/);
    await act(async () => { restrictedRowBtn.click(); });
    const permDialog = dom.document.querySelector('.work-browser-error-dialog[open]');
    assert.ok(permDialog);
    assert.match(permDialog.textContent ?? '', /没有权限访问：\/home\/dev\/restricted/);
    const permAckBtn = Array.from(permDialog.querySelectorAll('.dialog-footer button'))
      .find((btn) => btn.textContent?.includes('知道了'));
    assert.ok(permAckBtn);
    await act(async () => { permAckBtn.click(); });
    assert.equal(dom.document.querySelector('.work-browser-error-dialog[open]'), null);
    assert.equal(browserDialog.querySelector('.work-browser-up')?.disabled, false);

    // Enter `projects` directory, then navigate into `matrius` and select current directory.
    const projectsEntryBtn = Array.from(browserDialog.querySelectorAll('.work-browser-item'))
      .find((btn) => btn.textContent?.includes('projects'));
    assert.ok(projectsEntryBtn);
    await act(async () => { projectsEntryBtn.click(); });
    assert.match(browserDialog.textContent ?? '', /matrius/);
    assert.match(browserDialog.textContent ?? '', /workspace\.code-workspace/);

    const matriusEntryBtn = Array.from(browserDialog.querySelectorAll('.work-browser-item'))
      .find((btn) => btn.textContent?.includes('matrius'));
    assert.ok(matriusEntryBtn);
    await act(async () => { matriusEntryBtn.click(); });
    assert.match(browserDialog.textContent ?? '', /package\.json/);

    const chooseCurrentBtn = Array.from(browserDialog.querySelectorAll('.dialog-footer button'))
      .find((btn) => btn.textContent?.includes('选择当前目录'));
    assert.ok(chooseCurrentBtn);
    await act(async () => { chooseCurrentBtn.click(); });
    assert.equal(dom.document.querySelector('.work-browser-dialog[open]'), null);
    assert.match(dirPickerBtn.textContent ?? '', /\/home\/dev\/projects\/matrius/);

    // Create the project and verify it is listed & active in the sidebar.
    const formEl = createDialog.querySelector('form');
    assert.ok(formEl);
    const formProps = Object.keys(formEl).find((key) => key.startsWith('__reactProps'));
    assert.ok(formProps);
    await act(async () => { await formEl[formProps].onSubmit({ preventDefault() {} }); });

    assert.equal(dom.document.querySelector('.work-project-dialog[open]'), null);
    const projectItem = dom.document.querySelector('.work-project-item.is-active');
    assert.ok(projectItem);
    assert.match(projectItem.textContent ?? '', /matrius/);
    assert.match(projectItem.textContent ?? '', /开发服务器/);

    // Re-open create dialog and verify selecting a file directly inside directory browser works too.
    await act(async () => { openCreateBtn.click(); });
    const secondDialog = dom.document.querySelector('.work-project-dialog[open]');
    assert.ok(secondDialog);
    await act(async () => { secondDialog.querySelector('.work-dir-picker').click(); });
    const secondBrowser = dom.document.querySelector('.work-browser-dialog[open]');
    assert.ok(secondBrowser);
    const fileBtn = Array.from(secondBrowser.querySelectorAll('.work-browser-item'))
      .find((btn) => btn.textContent?.includes('notes.md'));
    assert.ok(fileBtn);
    await act(async () => { fileBtn.click(); });
    assert.ok(secondBrowser.querySelector('.work-browser-item.is-selected'));
    const confirmBtn = Array.from(secondBrowser.querySelectorAll('.dialog-footer button'))
      .find((btn) => btn.textContent?.includes('确认选择'));
    assert.ok(confirmBtn);
    await act(async () => { confirmBtn.click(); });
    assert.match(secondDialog.querySelector('.work-dir-picker').textContent ?? '', /\/home\/dev\/notes\.md/);

    // Verify invalid directory navigation opens a dedicated error modal dialog instead of inline alert.
    await act(async () => { secondDialog.querySelector('.work-dir-picker').click(); });
    const thirdBrowser = dom.document.querySelector('.work-browser-dialog[open]');
    assert.ok(thirdBrowser);
    const pathInput = thirdBrowser.querySelector('.work-browser-path-input');
    const navForm = thirdBrowser.querySelector('.work-browser-nav');
    assert.ok(pathInput && navForm);
    const inputPropsKey = Object.keys(pathInput).find((key) => key.startsWith('__reactProps'));
    const navPropsKey = Object.keys(navForm).find((key) => key.startsWith('__reactProps'));
    assert.ok(inputPropsKey && navPropsKey);
    await act(async () => {
      pathInput.value = '/home/chris_hsu';
      pathInput[inputPropsKey].onChange({ target: pathInput });
    });
    await act(async () => {
      await navForm[navPropsKey].onSubmit({ preventDefault() {} });
    });
    const errorDialog = dom.document.querySelector('.work-browser-error-dialog[open]');
    assert.ok(errorDialog);
    assert.match(errorDialog.textContent ?? '', /无法访问目录：\/home\/chris_hsu/);
    assert.doesNotMatch(errorDialog.textContent ?? '', /检查主机连接/);
    const footerButtons = Array.from(errorDialog.querySelectorAll('.dialog-footer button'));
    assert.equal(footerButtons.length, 1);
    assert.equal(footerButtons[0].textContent?.trim(), '知道了');
    await act(async () => { footerButtons[0].click(); });
    assert.equal(dom.document.querySelector('.work-browser-error-dialog[open]'), null);
  } finally {
    await act(async () => { root.unmount(); });
    resetWorkStateForTests();
    dom.restore();
  }
});
