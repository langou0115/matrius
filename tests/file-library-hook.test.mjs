import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { useFileLibrary } from '../src/features/files/use-file-library.ts';

const file = (id, extras = {}) => ({
  id, filename: `${id}.pdf`, contentType: 'application/pdf', size: 10, revision: 1, ...extras,
});

function setup() {
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
  return {
    root,
    cleanup: async () => {
      await act(async () => root.unmount());
      globalThis.window = previous.window;
      globalThis.document = previous.document;
      globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
    },
  };
}

function harness(request, enabled = true) {
  let latest;
  function Probe() {
    latest = useFileLibrary({ request, enabled });
    return null;
  }
  return { Probe, get: () => latest };
}

async function render(root, Probe) {
  await act(async () => root.render(createElement(Probe)));
  await act(async () => {});
}

test('loads the first page', async () => {
  const { root, cleanup } = setup();
  const paths = [];
  const request = async (path) => {
    paths.push(path);
    return { items: [file('a'), file('b')], nextCursor: null };
  };
  const { Probe, get } = harness(request);
  try {
    await render(root, Probe);
    assert.deepEqual(get().items.map((item) => item.id), ['a', 'b']);
    assert.equal(get().loading, false);
    assert.equal(get().refreshing, false);
    assert.ok(paths.includes('/api/files?sort=created&order=desc&limit=50'));
  } finally {
    await cleanup();
  }
});

test('disabled libraries never call the API', async () => {
  const { root, cleanup } = setup();
  let calls = 0;
  const request = async () => {
    calls += 1;
    return { items: [], nextCursor: null };
  };
  const { Probe, get } = harness(request, false);
  try {
    await render(root, Probe);
    assert.equal(calls, 0);
    assert.deepEqual(get().items, []);
    assert.equal(get().refreshing, false);
    assert.equal(get().loading, false);
  } finally {
    await cleanup();
  }
});

test('cursor pagination appends without duplicating rows', async () => {
  const { root, cleanup } = setup();
  const request = async (path) => {
    if (path.includes('cursor=cursor-1')) return { items: [file('b'), file('c')], nextCursor: null };
    return { items: [file('a'), file('b')], nextCursor: 'cursor-1' };
  };
  const { Probe, get } = harness(request);
  try {
    await render(root, Probe);
    assert.equal(get().nextCursor, 'cursor-1');
    await act(async () => get().loadMore());
    await act(async () => {});
    assert.deepEqual(get().items.map((item) => item.id), ['a', 'b', 'c']);
    assert.equal(get().nextCursor, null);
    assert.equal(get().loadingMore, false);
  } finally {
    await cleanup();
  }
});

test('a slow response from an earlier filter cannot overwrite the current list', async () => {
  const { root, cleanup } = setup();
  let resolveImage;
  const request = (path) => {
    if (path.includes('kind=image')) {
      return new Promise((resolve) => { resolveImage = resolve; });
    }
    if (path.includes('kind=text')) return Promise.resolve({ items: [file('text-1')], nextCursor: null });
    return Promise.resolve({ items: [file('all-1')], nextCursor: null });
  };
  const { Probe, get } = harness(request);
  try {
    await render(root, Probe);
    await act(async () => { get().setKind('image'); });
    await act(async () => { get().setKind('text'); });
    await act(async () => { resolveImage({ items: [file('image-1')], nextCursor: null }); });
    await act(async () => {});
    assert.deepEqual(get().items.map((item) => item.id), ['text-1']);
  } finally {
    await cleanup();
  }
});

test('rename updates the row and delete removes it from the list and selection', async () => {
  const { root, cleanup } = setup();
  const request = async (path, init) => {
    if (path === '/api/files/bulk-delete') return { deleted: init.body ? JSON.parse(init.body).ids.length : 0 };
    if (init?.method === 'PATCH') {
      return file('a', { filename: 'renamed.pdf', revision: 2 });
    }
    return { items: [file('a'), file('b')], nextCursor: null };
  };
  const { Probe, get } = harness(request);
  try {
    await render(root, Probe);
    await act(async () => { get().toggleSelected(get().items[0]); });
    assert.deepEqual([...get().selected], ['a']);

    await act(async () => { await get().rename('a', 'renamed.pdf'); });
    assert.equal(get().items[0].filename, 'renamed.pdf');
    assert.equal(get().items[0].revision, 2);

    await act(async () => { await get().remove(['a', 'b']); });
    assert.deepEqual(get().items, []);
    assert.ok(!get().selected.has('a'));
  } finally {
    await cleanup();
  }
});

test('keeps the previous page visible until a new filter finishes loading', async () => {
  const { root, cleanup } = setup();
  let resolveImage;
  const request = (path) => {
    if (path.includes('kind=image')) return new Promise((resolve) => { resolveImage = resolve; });
    return Promise.resolve({ items: [file('all-1')], nextCursor: null });
  };
  const { Probe, get } = harness(request);
  try {
    await render(root, Probe);
    assert.deepEqual(get().items.map((item) => item.id), ['all-1']);
    assert.equal(get().refreshing, false);

    await act(async () => { get().setKind('image'); });
    assert.deepEqual(get().items.map((item) => item.id), ['all-1'],
      'the old page stays on screen instead of flashing the skeleton');
    assert.equal(get().refreshing, true);
    assert.equal(get().loading, true);

    await act(async () => { resolveImage({ items: [file('image-1')], nextCursor: null }); });
    await act(async () => {});
    assert.deepEqual(get().items.map((item) => item.id), ['image-1']);
    assert.equal(get().refreshing, false);
    assert.equal(get().loading, false);
  } finally {
    await cleanup();
  }
});

test('selection does not leak across filters', async () => {
  const { root, cleanup } = setup();
  const request = async () => ({ items: [file('a')], nextCursor: null });
  const { Probe, get } = harness(request);
  try {
    await render(root, Probe);
    await act(async () => { get().toggleSelected(get().items[0]); });
    assert.equal(get().selected.size, 1);
    await act(async () => { get().setKind('document'); });
    assert.equal(get().selected.size, 0);
    await act(async () => { await get().selectAll(); });
    assert.deepEqual([...get().selected].sort(), ['a']);
    await act(async () => { get().clearSelection(); });
    assert.equal(get().selected.size, 0);
  } finally {
    await cleanup();
  }
});

test('select all reaches pages that were never loaded', async () => {
  const { root, cleanup } = setup();
  const request = async (path) => {
    if (path.includes('cursor=page-2')) return { items: [file('c'), file('d')], nextCursor: null };
    return { items: [file('a'), file('b')], nextCursor: 'page-2' };
  };
  const { Probe, get } = harness(request);
  try {
    await render(root, Probe);
    assert.deepEqual(get().items.map((item) => item.id), ['a', 'b']);
    await act(async () => { await get().selectAll(); });
    assert.deepEqual([...get().selected].sort(), ['a', 'b', 'c', 'd']);
    assert.deepEqual(get().selectedFiles.map((item) => item.id).sort(), ['a', 'b', 'c', 'd']);
    assert.equal(get().selectingAll, false);
  } finally {
    await cleanup();
  }
});
