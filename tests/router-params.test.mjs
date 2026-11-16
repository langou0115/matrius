import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { parseHTML } from 'linkedom';

test('useLocalSearchParams merges path parameters with the query string', async () => {
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter, Route, Routes } = await import('react-router-dom');
  const { useLocalSearchParams } = await import('../ui/router/index.tsx');

  function Probe() {
    return createElement('div', null, JSON.stringify(useLocalSearchParams()));
  }

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(
        MemoryRouter,
        { initialEntries: ['/ui/abc-123?draft=hello'] },
        createElement(Routes, null,
          createElement(Route, { path: 'ui/:componentId', element: createElement(Probe) })),
      ));
    });
    const text = container.textContent ?? '';
    assert.match(text, /"componentId":"abc-123"/u);
    assert.match(text, /"draft":"hello"/u);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
