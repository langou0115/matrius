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
    assert.match(createDialog.textContent ?? '', /主机设置/);
    assert.doesNotMatch(createDialog.textContent ?? '', /或文件/);

    // Submitting without selecting a directory raises a modal alert instead of an inline form error.
    const emptySubmitForm = createDialog.querySelector('form');
    assert.ok(emptySubmitForm);
    const emptySubmitKey = Object.keys(emptySubmitForm).find((key) => key.startsWith('__reactProps'));
    assert.ok(emptySubmitKey);
    await act(async () => { await emptySubmitForm[emptySubmitKey].onSubmit({ preventDefault() {} }); });
    const missingDirDialog = dom.document.querySelector('.work-project-error-dialog[open]');
    assert.ok(missingDirDialog);
    assert.match(missingDirDialog.textContent ?? '', /请先选择项目目录。/);
    assert.equal(createDialog.querySelector('.model-form-error'), null);
    const missingDirAckBtn = Array.from(missingDirDialog.querySelectorAll('.dialog-footer button'))
      .find((btn) => btn.textContent?.includes('知道了'));
    assert.ok(missingDirAckBtn);
    await act(async () => { missingDirAckBtn.click(); });
    assert.equal(dom.document.querySelector('.work-project-error-dialog[open]'), null);

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

    // Selecting the project row keeps it active without an expand toggle or child terminal list.
    const selectBtn = projectItem.querySelector('.work-project-select');
    assert.ok(selectBtn);
    assert.equal(selectBtn.getAttribute('aria-current'), 'true');
    assert.equal(projectItem.querySelector('.work-project-chevron'), null);
    assert.equal(selectBtn.getAttribute('aria-controls'), null);
    await act(async () => { selectBtn.click(); });
    assert.equal(selectBtn.getAttribute('aria-current'), 'true');

    // Verify three-dots menu opens project settings (rename) and remove confirmation.
    const moreBtn = projectItem.querySelector('.work-project-more');
    assert.ok(moreBtn);
    await act(async () => { moreBtn.click(); });
    const projectMenu = dom.document.getElementById('work-project-menu');
    assert.ok(projectMenu);
    const settingsMenuItem = Array.from(projectMenu.querySelectorAll('[role="menuitem"]'))
      .find((item) => item.textContent?.includes('项目设置'));
    assert.ok(settingsMenuItem);
    await act(async () => { settingsMenuItem.click(); });

    const editDialog = dom.document.querySelector('.work-project-dialog[open]');
    assert.ok(editDialog);
    const nameInput = editDialog.querySelector('input.text-field');
    const editForm = editDialog.querySelector('form.provider-edit-form');
    assert.ok(nameInput && editForm);
    const namePropsKey = Object.keys(nameInput).find((key) => key.startsWith('__reactProps'));
    const editFormPropsKey = Object.keys(editForm).find((key) => key.startsWith('__reactProps'));
    assert.ok(namePropsKey && editFormPropsKey);
    await act(async () => {
      nameInput.value = 'matrius-core';
      nameInput[namePropsKey].onChange({ target: nameInput });
    });
    await act(async () => {
      await editForm[editFormPropsKey].onSubmit({ preventDefault() {} });
    });
    assert.equal(dom.document.querySelector('.work-project-dialog[open]'), null);
    assert.match(dom.document.querySelector('.work-project-item.is-active')?.textContent ?? '', /matrius-core/);

    const updatedMoreBtn = dom.document.querySelector('.work-project-item.is-active .work-project-more');
    assert.ok(updatedMoreBtn);
    await act(async () => { updatedMoreBtn.click(); });
    const removeMenuItem = Array.from(dom.document.querySelectorAll('#work-project-menu [role="menuitem"]'))
      .find((item) => item.textContent?.includes('移除项目'));
    assert.ok(removeMenuItem);
    await act(async () => { removeMenuItem.click(); });

    const removeDialog = dom.document.querySelector('.compact-dialog[open]');
    assert.ok(removeDialog);
    const confirmRemoveBtn = removeDialog.querySelector('.danger-button');
    assert.ok(confirmRemoveBtn);
    await act(async () => { confirmRemoveBtn.click(); });
    assert.equal(dom.document.querySelectorAll('.work-project-item').length, 0);

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
    const closeThirdBrowserBtn = thirdBrowser.querySelector('.dialog-header .icon-button');
    assert.ok(closeThirdBrowserBtn);
    await act(async () => { closeThirdBrowserBtn.click(); });

    // Switch host to 本机 (Windows) and verify the `此电脑` button jumps directly to drive selection.
    const secondHostTrigger = secondDialog.querySelector('.select-field-trigger');
    assert.ok(secondHostTrigger);
    await act(async () => { secondHostTrigger.click(); });
    const localOption = Array.from(secondDialog.querySelectorAll('.select-field-popover button'))
      .find((btn) => btn.textContent?.includes('本机'));
    assert.ok(localOption);
    await act(async () => { localOption.click(); });

    await act(async () => { secondDialog.querySelector('.work-dir-picker').click(); });
    const winBrowser = dom.document.querySelector('.work-browser-dialog[open]');
    assert.ok(winBrowser);
    const pcBtn = winBrowser.querySelector('button[aria-label="此电脑"]');
    assert.ok(pcBtn);
    await act(async () => { pcBtn.click(); });
    assert.match(winBrowser.textContent ?? '', /D:\\/);
    const dDriveBtn = Array.from(winBrowser.querySelectorAll('.work-browser-item'))
      .find((btn) => btn.textContent?.includes('D:\\'));
    assert.ok(dDriveBtn);
    await act(async () => { dDriveBtn.click(); });
    assert.match(winBrowser.textContent ?? '', /Engineer/);
    const selectDriveDirBtn = Array.from(winBrowser.querySelectorAll('.dialog-footer button'))
      .find((btn) => btn.textContent?.includes('选择当前目录'));
    assert.ok(selectDriveDirBtn);
    await act(async () => { selectDriveDirBtn.click(); });

    // Optional network proxy input validates invalid schemes and stores valid proxyUrl on the created project.
    const proxyInput = secondDialog.querySelector('#work-project-proxy-input');
    assert.ok(proxyInput);
    const proxyKey = Object.keys(proxyInput).find((key) => key.startsWith('__reactProps'));
    assert.ok(proxyKey);
    const createForm = secondDialog.querySelector('form');
    const createFormKey = Object.keys(createForm).find((key) => key.startsWith('__reactProps'));
    await act(async () => {
      proxyInput.value = 'ftp://bad.proxy:21';
      proxyInput[proxyKey].onChange({ target: proxyInput });
    });
    await act(async () => { await createForm[createFormKey].onSubmit({ preventDefault() {} }); });
    const proxyErrorDialog = dom.document.querySelector('.work-project-error-dialog[open]');
    assert.ok(proxyErrorDialog);
    assert.match(proxyErrorDialog.textContent ?? '', /仅支持 http:\/\/、https:\/\/ 或 socks5:\/\//);
    await act(async () => { proxyErrorDialog.querySelector('.dialog-footer button').click(); });

    await act(async () => {
      proxyInput.value = 'http://127.0.0.1:7890';
      proxyInput[proxyKey].onChange({ target: proxyInput });
    });
    await act(async () => { await createForm[createFormKey].onSubmit({ preventDefault() {} }); });
    const createdItem = dom.document.querySelector('.work-project-item.is-active');
    assert.ok(createdItem);
    assert.match(createdItem.querySelector('.work-project-name')?.textContent ?? '', /D:/);
    assert.match(createdItem.querySelector('.work-project-select')?.getAttribute('title') ?? '', /D:\\/);
  } finally {
    await act(async () => { root.unmount(); });
    resetWorkStateForTests();
    dom.restore();
  }
});
