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

    // Selecting the project row keeps it active without auto-expanding; explicit chevron toggle exists and no `...` button is shown.
    const selectBtn = projectItem.querySelector('.work-project-select');
    const toggleBtn = projectItem.querySelector('.work-project-toggle');
    assert.ok(selectBtn && toggleBtn);
    assert.equal(selectBtn.getAttribute('aria-current'), 'true');
    assert.equal(projectItem.querySelector('.work-project-more'), null);
    assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false');
    await act(async () => { selectBtn.click(); });
    assert.equal(selectBtn.getAttribute('aria-current'), 'true');
    assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false');

    // Right-clicking the project row opens the settings context menu right-aligned under the project row (not at cursor coords).
    projectItem.getBoundingClientRect = () => ({ left: 12, top: 108, bottom: 144, right: 248, width: 236, height: 36 });
    const originalGetRect = globalThis.HTMLElement.prototype.getBoundingClientRect;
    globalThis.HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.id === 'work-project-menu') {
        return { left: 0, top: 0, right: 146, bottom: 84, width: 146, height: 84 };
      }
      return originalGetRect ? originalGetRect.call(this) : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    };
    const projectItemKey = Object.keys(projectItem).find((key) => key.startsWith('__reactProps'));
    assert.ok(projectItemKey);
    try {
      await act(async () => {
        projectItem[projectItemKey].onContextMenu({
          clientX: 45,
          clientY: 127,
          currentTarget: projectItem,
          preventDefault() {},
        });
      });
    } finally {
      globalThis.HTMLElement.prototype.getBoundingClientRect = originalGetRect;
    }
    const projectMenu = dom.document.getElementById('work-project-menu');
    assert.ok(projectMenu);
    assert.equal(projectMenu.style.left, '102px');
    assert.equal(projectMenu.style.top, '150px');
    const settingsMenuItem = Array.from(projectMenu.querySelectorAll('[role="menuitem"]'))
      .find((item) => item.textContent?.includes('项目设置'));
    assert.ok(settingsMenuItem);
    await act(async () => { settingsMenuItem.click(); });

    const editDialog = dom.document.querySelector('.work-project-dialog[open]');
    assert.ok(editDialog);
    const editHeader = editDialog.querySelector('.dialog-header');
    const editBody = editDialog.querySelector('.work-project-form-body');
    const editFooter = editDialog.querySelector('.dialog-footer');
    assert.ok(editHeader && editBody && editFooter);
    assert.equal(editBody.contains(editHeader), false);
    assert.equal(editBody.contains(editFooter), false);
    const nameInput = editDialog.querySelector('input.text-field');
    const editHostTrigger = editDialog.querySelector('.select-field-trigger');
    const editDirBtn = editDialog.querySelector('.work-dir-picker');
    const editProxyToggle = editDialog.querySelector('.work-proxy-toggle');
    const editForm = editDialog.querySelector('form.provider-edit-form');
    assert.ok(nameInput && editHostTrigger && editDirBtn && editProxyToggle && editForm);
    assert.match(editProxyToggle.textContent ?? '', /AI 配置/);
    // Project name, host, and directory are locked after creation; only AI config (proxies/args) remains editable.
    assert.equal(nameInput.disabled, true);
    assert.equal(nameInput.value, 'matrius');
    assert.equal(editHostTrigger.disabled, true);
    await act(async () => { editHostTrigger.click(); });
    assert.equal(editDialog.querySelector('.select-field-popover'), null);
    assert.equal(editDialog.querySelector('.work-settings-link'), null);
    assert.equal(editDirBtn.disabled, true);
    await act(async () => { editDirBtn.click(); });
    assert.equal(dom.document.querySelector('.work-browser-dialog[open]'), null);
    assert.match(editDirBtn.textContent ?? '', /\/home\/dev\/projects\/matrius/);
    assert.equal(editProxyToggle.getAttribute('aria-expanded'), 'true');

    // Each CLI group under AI 配置 starts collapsed when empty and can be expanded/collapsed independently.
    const editCodexToggle = editDialog.querySelector('.work-ai-cli-group[data-cli-provider="codex"] .work-ai-cli-group-toggle');
    const editAgyToggle = editDialog.querySelector('.work-ai-cli-group[data-cli-provider="antigravity"] .work-ai-cli-group-toggle');
    const editClaudeToggle = editDialog.querySelector('.work-ai-cli-group[data-cli-provider="claude"] .work-ai-cli-group-toggle');
    assert.ok(editCodexToggle && editAgyToggle && editClaudeToggle);
    assert.equal(editCodexToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(editAgyToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(editClaudeToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(editDialog.querySelector('#work-project-proxy-codex'), null);

    await act(async () => { editCodexToggle.click(); });
    await act(async () => { editClaudeToggle.click(); });
    assert.equal(editCodexToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(editClaudeToggle.getAttribute('aria-expanded'), 'true');
    const editCodexProxyInput = editDialog.querySelector('#work-project-proxy-codex');
    const editClaudeArgsInput = editDialog.querySelector('#work-project-args-claude');
    assert.ok(editCodexProxyInput && editClaudeArgsInput);
    assert.equal(editCodexProxyInput.disabled, false);
    assert.equal(editClaudeArgsInput.disabled, false);

    // Collapsing a group hides its inputs again without discarding values, and re-expanding preserves them.
    const editCodexKey = Object.keys(editCodexProxyInput).find((key) => key.startsWith('__reactProps'));
    const editClaudeArgsKey = Object.keys(editClaudeArgsInput).find((key) => key.startsWith('__reactProps'));
    const editFormPropsKey = Object.keys(editForm).find((key) => key.startsWith('__reactProps'));
    assert.ok(editCodexKey && editClaudeArgsKey && editFormPropsKey);
    await act(async () => {
      editCodexProxyInput.value = 'http://127.0.0.1:7890';
      editCodexProxyInput[editCodexKey].onChange({ target: editCodexProxyInput });
      editClaudeArgsInput.value = '--dangerously-skip-permissions';
      editClaudeArgsInput[editClaudeArgsKey].onChange({ target: editClaudeArgsInput });
    });
    await act(async () => { editCodexToggle.click(); });
    assert.equal(editCodexToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(editDialog.querySelector('#work-project-proxy-codex'), null);
    assert.match(editCodexToggle.textContent ?? '', /已配置 1 项/);
    await act(async () => {
      await editForm[editFormPropsKey].onSubmit({ preventDefault() {} });
    });
    assert.equal(dom.document.querySelector('.work-project-dialog[open]'), null);
    assert.match(dom.document.querySelector('.work-project-item.is-active')?.textContent ?? '', /matrius/);

    // Re-opening project settings remembers each AI group's expanded/collapsed state (codex collapsed, claude expanded).
    const reopenItem = dom.document.querySelector('.work-project-item.is-active');
    const reopenKey = Object.keys(reopenItem).find((key) => key.startsWith('__reactProps'));
    await act(async () => {
      reopenItem[reopenKey].onContextMenu({
        clientX: 84,
        clientY: 120,
        currentTarget: reopenItem,
        preventDefault() {},
      });
    });
    const reopenSettingsBtn = Array.from(dom.document.querySelectorAll('#work-project-menu [role="menuitem"]'))
      .find((item) => item.textContent?.includes('项目设置'));
    assert.ok(reopenSettingsBtn);
    await act(async () => { reopenSettingsBtn.click(); });
    const reopenedDialog = dom.document.querySelector('.work-project-dialog[open]');
    assert.ok(reopenedDialog);
    assert.equal(
      reopenedDialog.querySelector('.work-ai-cli-group[data-cli-provider="codex"] .work-ai-cli-group-toggle')?.getAttribute('aria-expanded'),
      'false',
    );
    assert.equal(
      reopenedDialog.querySelector('.work-ai-cli-group[data-cli-provider="claude"] .work-ai-cli-group-toggle')?.getAttribute('aria-expanded'),
      'true',
    );
    assert.equal(reopenedDialog.querySelector('#work-project-args-claude')?.value, '--dangerously-skip-permissions');
    // Collapse Claude again before closing so the next dialog assertion verifies remembered collapsed state too.
    await act(async () => {
      reopenedDialog.querySelector('.work-ai-cli-group[data-cli-provider="claude"] .work-ai-cli-group-toggle')?.click();
    });
    await act(async () => {
      reopenedDialog.querySelector('.dialog-header .icon-button')?.click();
    });
    assert.equal(dom.document.querySelector('.work-project-dialog[open]'), null);

    const updatedProjectItem = dom.document.querySelector('.work-project-item.is-active');
    const updatedItemKey = Object.keys(updatedProjectItem).find((key) => key.startsWith('__reactProps'));
    assert.ok(updatedItemKey);
    await act(async () => {
      updatedProjectItem[updatedItemKey].onContextMenu({
        clientX: 84,
        clientY: 120,
        currentTarget: updatedProjectItem,
        preventDefault() {},
      });
    });
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

    // Expandable AI config section starts collapsed and configures proxy + launch args for Codex, Antigravity, Claude Code.
    const proxyToggle = secondDialog.querySelector('.work-proxy-toggle');
    assert.ok(proxyToggle);
    assert.match(proxyToggle.textContent ?? '', /AI 配置/);
    assert.equal(proxyToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(secondDialog.querySelector('#work-project-proxy-fields'), null);

    await act(async () => { proxyToggle.click(); });
    assert.equal(proxyToggle.getAttribute('aria-expanded'), 'true');
    const codexGroupToggle = secondDialog.querySelector('.work-ai-cli-group[data-cli-provider="codex"] .work-ai-cli-group-toggle');
    const agyGroupToggle = secondDialog.querySelector('.work-ai-cli-group[data-cli-provider="antigravity"] .work-ai-cli-group-toggle');
    const claudeGroupToggle = secondDialog.querySelector('.work-ai-cli-group[data-cli-provider="claude"] .work-ai-cli-group-toggle');
    assert.ok(codexGroupToggle && agyGroupToggle && claudeGroupToggle);
    assert.equal(codexGroupToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(agyGroupToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(claudeGroupToggle.getAttribute('aria-expanded'), 'false');
    await act(async () => { codexGroupToggle.click(); });
    await act(async () => { agyGroupToggle.click(); });
    await act(async () => { claudeGroupToggle.click(); });
    const codexProxyInput = secondDialog.querySelector('#work-project-proxy-codex');
    const agyProxyInput = secondDialog.querySelector('#work-project-proxy-antigravity');
    const claudeProxyInput = secondDialog.querySelector('#work-project-proxy-claude');
    const codexArgsInput = secondDialog.querySelector('#work-project-args-codex');
    const agyArgsInput = secondDialog.querySelector('#work-project-args-antigravity');
    const claudeArgsInput = secondDialog.querySelector('#work-project-args-claude');
    assert.ok(codexProxyInput && agyProxyInput && claudeProxyInput && codexArgsInput && agyArgsInput && claudeArgsInput);

    const codexKey = Object.keys(codexProxyInput).find((key) => key.startsWith('__reactProps'));
    const claudeKey = Object.keys(claudeProxyInput).find((key) => key.startsWith('__reactProps'));
    const claudeArgsKey = Object.keys(claudeArgsInput).find((key) => key.startsWith('__reactProps'));
    assert.ok(codexKey && claudeKey && claudeArgsKey);
    const createForm = secondDialog.querySelector('form');
    const createFormKey = Object.keys(createForm).find((key) => key.startsWith('__reactProps'));
    await act(async () => {
      codexProxyInput.value = 'ftp://bad.proxy:21';
      codexProxyInput[codexKey].onChange({ target: codexProxyInput });
    });
    await act(async () => { await createForm[createFormKey].onSubmit({ preventDefault() {} }); });
    const proxyErrorDialog = dom.document.querySelector('.work-project-error-dialog[open]');
    assert.ok(proxyErrorDialog);
    assert.match(proxyErrorDialog.textContent ?? '', /Codex 网络代理仅支持 http:\/\/、https:\/\/ 或 socks5:\/\//);
    await act(async () => { proxyErrorDialog.querySelector('.dialog-footer button').click(); });

    await act(async () => {
      codexProxyInput.value = 'http://127.0.0.1:7890';
      codexProxyInput[codexKey].onChange({ target: codexProxyInput });
      claudeProxyInput.value = 'socks5://127.0.0.1:1080';
      claudeProxyInput[claudeKey].onChange({ target: claudeProxyInput });
      claudeArgsInput.value = '--dangerously-skip-permissions';
      claudeArgsInput[claudeArgsKey].onChange({ target: claudeArgsInput });
    });
    assert.match(proxyToggle.textContent ?? '', /已配置 3 项/);
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
