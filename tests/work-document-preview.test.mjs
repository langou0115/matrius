import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { InstanceProvider } from '../ui/features/instance/instance-state.tsx';
import { WorkFilePreview } from '../ui/features/work/work-file-preview.tsx';
import { resetWorkStateForTests } from '../ui/features/work/work-state.ts';
import { PreviewContext } from '../ui/features/workspace/preview-context.ts';

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
  };

  window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  window.HTMLElement.prototype.focus = function () {};
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

function wrap(children) {
  return createElement(
    InstanceProvider,
    { preview: false },
    createElement(PreviewContext.Provider, { value: false }, children),
  );
}

test('WorkFilePreview renders Markdown preview by default and toggles to source editor', async () => {
  const dom = setupDom();
  const root = createRoot(dom.document.getElementById('root'));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/hosts/local/fs/preview') {
      return Response.json({ text: '# 架构设计\n\n正文说明。', revision: 'rev1' });
    }
    return Response.json({});
  };

  try {
    await act(async () => {
      root.render(wrap(createElement(WorkFilePreview, {
        hostId: 'local',
        projectId: 'p1',
        file: { kind: 'file', name: 'GUIDE.md', path: 'D:\\repo\\GUIDE.md', accessible: true },
        draft: undefined,
        fontSize: 14,
      })));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    assert.ok(dom.document.querySelector('.work-doc-markdown'));
    assert.match(dom.document.querySelector('.work-doc-markdown')?.textContent ?? '', /架构设计/u);
    assert.equal(dom.document.querySelector('textarea'), null);

    const toEdit = dom.document.querySelector('button[aria-label="切换到编辑器"]');
    assert.ok(toEdit);
    await act(async () => { toEdit.click(); });
    const textarea = dom.document.querySelector('textarea[aria-label="编辑 GUIDE.md"]');
    assert.ok(textarea);
    assert.equal(dom.document.querySelector('.work-code-paint')?.textContent, '# 架构设计\n\n正文说明。');

    const toPreview = dom.document.querySelector('button[aria-label="切换到预览"]');
    assert.ok(toPreview);
    await act(async () => { toPreview.click(); });
    assert.ok(dom.document.querySelector('.work-doc-markdown'));
    assert.equal(dom.document.querySelector('textarea'), null);
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = previousFetch;
    resetWorkStateForTests();
    dom.restore();
  }
});

test('WorkFilePreview renders Word, Excel, PowerPoint, and PDF viewers', async () => {
  const dom = setupDom();
  const root = createRoot(dom.document.getElementById('root'));

  function wrapDemo(children) {
    return createElement(
      InstanceProvider,
      { preview: true },
      createElement(PreviewContext.Provider, { value: true }, children),
    );
  }

  try {
    // Word (SuperDoc editor shell in demo mode)
    await act(async () => {
      root.render(wrapDemo(createElement(WorkFilePreview, {
        key: 'docx',
        hostId: 'local',
        projectId: 'p1',
        file: { kind: 'file', name: 'plan.docx', path: 'D:\\repo\\plan.docx', accessible: true },
        draft: undefined,
        fontSize: 14,
      })));
    });
    assert.match(dom.document.querySelector('.work-doc-pdf-demo')?.textContent ?? '', /plan\.docx/u);
    assert.equal(dom.document.querySelector('textarea'), null);

    // Excel (Univer Sheets editor shell in demo mode)
    await act(async () => {
      root.render(wrapDemo(createElement(WorkFilePreview, {
        key: 'xlsx',
        hostId: 'local',
        projectId: 'p1',
        file: { kind: 'file', name: 'metrics.xlsx', path: 'D:\\repo\\metrics.xlsx', accessible: true },
        draft: undefined,
        fontSize: 14,
      })));
    });
    assert.match(dom.document.querySelector('.work-doc-pdf-demo')?.textContent ?? '', /metrics\.xlsx/u);

    // PowerPoint (pptx-preview shell in demo mode)
    await act(async () => {
      root.render(wrapDemo(createElement(WorkFilePreview, {
        key: 'pptx',
        hostId: 'local',
        projectId: 'p1',
        file: { kind: 'file', name: 'demo.pptx', path: 'D:\\repo\\demo.pptx', accessible: true },
        draft: undefined,
        fontSize: 14,
      })));
    });
    assert.match(dom.document.querySelector('.work-doc-pdf-demo')?.textContent ?? '', /demo\.pptx/u);

    // PDF (real iframe URL)
    await act(async () => {
      root.render(wrap(createElement(WorkFilePreview, {
        key: 'pdf',
        hostId: 'local',
        projectId: 'p1',
        file: { kind: 'file', name: 'spec.pdf', path: 'D:\\repo\\spec.pdf', accessible: true },
        draft: undefined,
        fontSize: 14,
      })));
    });
    const iframe = dom.document.querySelector('iframe.work-doc-pdf-frame');
    assert.ok(iframe);
    assert.match(iframe.getAttribute('src') ?? '', /\/api\/hosts\/local\/fs\/raw\?path=/u);
  } finally {
    await act(async () => { root.unmount(); });
    resetWorkStateForTests();
    dom.restore();
  }
});

test('WorkFilePreview allows editing SSH and WSL project files while keeping readOnly files read-only', async () => {
  const dom = setupDom();
  const root = createRoot(dom.document.getElementById('root'));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/hosts/ssh-host/fs/preview') {
      return Response.json({ text: 'const remote = 1;\n', revision: 'rev-remote' });
    }
    return Response.json({});
  };

  try {
    await act(async () => {
      root.render(wrap(createElement(WorkFilePreview, {
        key: 'ssh-edit',
        hostId: 'ssh-host',
        projectId: 'p-remote',
        file: { kind: 'file', name: 'index.ts', path: '/srv/app/index.ts', accessible: true },
        draft: undefined,
        fontSize: 14,
      })));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.ok(dom.document.querySelector('textarea[aria-label="编辑 index.ts"]'));

    await act(async () => {
      root.render(wrap(createElement(WorkFilePreview, {
        key: 'ssh-ro',
        hostId: 'ssh-host',
        projectId: 'p-remote',
        file: { kind: 'file', name: 'index.ts', path: '/srv/app/index.ts', accessible: true },
        draft: undefined,
        fontSize: 14,
        readOnly: true,
      })));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(dom.document.querySelector('textarea'), null);
    assert.ok(dom.document.querySelector('.work-code-view'));
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = previousFetch;
    resetWorkStateForTests();
    dom.restore();
  }
});
