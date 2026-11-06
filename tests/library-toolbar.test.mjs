import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { LibraryToolbar } from '../src/features/files/library-toolbar.tsx';

const noop = () => undefined;

function props(total) {
  return {
    query: '', onQueryChange: noop, kind: 'all', onKindChange: noop,
    sort: 'created', onSortChange: noop, order: 'desc', onToggleOrder: noop,
    total, selectedCount: 0, selectingAll: false,
    onToggleSelectAll: noop, onDownloadSelected: noop, onDeleteSelected: noop,
  };
}

async function inspectToolbar(total) {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => root.render(createElement(LibraryToolbar, props(total))));
    const input = document.querySelector('.library-select-all-input');
    return { hasSelectAll: Boolean(document.querySelector('.library-select-all')), disabled: input?.hasAttribute('disabled') ?? null };
  } finally {
    await act(async () => root.unmount());
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
}

test('the header select-all box only exists when the library has rows', async () => {
  assert.deepEqual(await inspectToolbar(0), { hasSelectAll: false, disabled: null });
  assert.deepEqual(await inspectToolbar(3), { hasSelectAll: true, disabled: false });
});
