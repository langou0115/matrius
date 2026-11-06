import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { TokenUsageSection } from '../src/features/usage/token-usage-section.tsx';
import { createAgentRuntime } from '../src/core/agent/runtime.ts';
import {
  addDays, buildCumulative, buildHeatmap, buildWeekly, formatCompactTokens, formatMonthYear,
  localDateKey, summarizeUsage,
} from '../src/features/usage/usage-stats.ts';

const END = new Date(2026, 10, 6); // Friday, 6 November 2026, local time.

function day(date, total, extra = {}) {
  return {
    date: localDateKey(date), input: total, output: 0, cacheRead: 0, cacheWrite: 0,
    total, requests: 1, ...extra,
  };
}

test('heatmap covers the trailing year and hides days outside the window and in the future', () => {
  const items = [day(addDays(END, -1), 100), day(addDays(END, -3), 50), day(addDays(END, -10), 10)];
  const heatmap = buildHeatmap(items, END);

  assert.equal(heatmap.columns.length, 53);
  const cells = heatmap.columns.flatMap((column) => column.cells);
  assert.equal(cells.length, 53 * 7);
  // The window starts Thursday 6 November 2025; earlier days in that first week stay blank
  // instead of being painted as zero usage, so the left edge is partial like the right one.
  assert.deepEqual(heatmap.columns[0].cells.slice(0, 3), [null, null, null]);
  assert.equal(heatmap.columns[0].cells[3].date, '2025-11-06');
  // Friday is the fifth slot; the weekend after END is still in the future.
  const currentWeek = heatmap.columns.at(-1).cells;
  assert.deepEqual(currentWeek.slice(5), [null, null]);
  assert.equal(currentWeek[4].date, localDateKey(END));
  assert.equal(currentWeek[4].value, 0);
  // Thursday holds the busiest day and defines the darkest step; smaller days scale down.
  assert.equal(currentWeek[3].date, localDateKey(addDays(END, -1)));
  assert.equal(currentWeek[3].value, 100);
  assert.equal(currentWeek[3].level, 4);
  assert.equal(currentWeek[1].level, 2);
  assert.equal(heatmap.activeDays, 3);
  assert.ok(heatmap.monthLabels.length >= 12);
  assert.deepEqual(heatmap.monthLabels[0].label, '12月');
});

test('a window that starts mid-week keeps its first day instead of folding it away', () => {
  const monday = new Date(2026, 10, 2); // Monday 2 November 2026.
  const heatmap = buildHeatmap([], monday);

  // The window starts Sunday 2 November 2025, so the grid needs a 54th column rather than
  // dropping that first day to keep a fixed 53-column year.
  assert.equal(heatmap.columns.length, 54);
  assert.deepEqual(heatmap.columns[0].cells.slice(0, 6), [null, null, null, null, null, null]);
  assert.equal(heatmap.columns[0].cells[6].date, '2025-11-02');
});

test('summary, weekly buckets and cumulative totals follow local days', () => {
  const items = [day(END, 30), day(addDays(END, -1), 20), day(addDays(END, -100), 99)];
  assert.deepEqual(summarizeUsage(items, END), { today: 30, last7: 50, last30: 50 });

  const weeks = buildWeekly(items, END, 12);
  assert.equal(weeks.length, 12);
  assert.equal(weeks.at(-1).label, '本周');
  assert.equal(weeks.at(-1).total, 50);
  assert.equal(weeks.at(-1).key, localDateKey(new Date(2026, 10, 2)));
  assert.equal(weeks.reduce((total, week) => total + week.total, 0), 50);

  const cumulative = buildCumulative(items, END, 365);
  assert.equal(cumulative.points.length, 365);
  assert.equal(cumulative.points.at(-1).date, localDateKey(END));
  assert.equal(cumulative.max, 149);
  assert.equal(cumulative.points[0].total, 0);
});

test('token formatting stays readable in Chinese units', () => {
  assert.equal(formatCompactTokens(999), '999');
  assert.equal(formatCompactTokens(12_345), '1.2万');
  assert.equal(formatCompactTokens(1_000_000), '100万');
  assert.equal(formatCompactTokens(123_456_789), '1.2亿');
  assert.equal(formatMonthYear('2026-11-06'), '2026年11月');
});

test('the shared runtime forwards one summed usage report per finished run', async () => {
  let finishRun;
  const completed = new Promise((resolve) => { finishRun = resolve; });
  let finishedResolve;
  const settled = new Promise((resolve) => { finishedResolve = resolve; });
  const usage = [];
  const runtime = createAgentRuntime({
    onReply(_conversationId, message) { if (message.status !== 'streaming') finishedResolve(); },
    onUsage(value) { usage.push(value); },
    loadRunner: async () => ({ createReplyRun() {
      return { abort() {}, steer: () => false, start: () => completed };
    } }),
    loadCompactor: async () => ({
      prepareHistory: async ({ messages, systemPrompt }) => ({ messages, systemPrompt, compacted: false }),
    }),
  });
  const config = { id: 'test', name: 'Test model', protocol: 'completion', baseUrl: 'https://test.invalid/v1',
    modelId: 'test-model', contextWindow: 128000, maxOutput: 4096, requiresApiKey: true };
  try {
    assert.equal(runtime.start({
      conversationId: 'c1', replyId: 'r1', config, apiKey: 'key',
      messages: [{ id: 'u1', role: 'user', content: '你好' }],
    }), true);
    // The runtime loads the runner and compactor before it starts the run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishRun({ status: 'complete', usage: { input: 7, output: 3, cacheRead: 2, cacheWrite: 0 } });
    await settled;
    assert.deepEqual(usage, [{ input: 7, output: 3, cacheRead: 2, cacheWrite: 0 }]);
  } finally {
    runtime.dispose();
  }
});

function report(overrides = {}) {
  const today = new Date();
  return {
    items: [day(today, 150), day(addDays(today, -1), 90), day(addDays(today, -3), 30)],
    lifetime: { input: 260, output: 10, cacheRead: 0, cacheWrite: 0, requests: 3, total: 270 },
    estimated: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, total: 0 },
    backfilled: true,
    ...overrides,
  };
}

async function renderSection() {
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
  const request = async (path) => {
    assert.match(path, /^\/api\/usage\?days=366$/);
    return report();
  };
  const cleanup = async () => {
    await act(async () => root.unmount());
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  };
  try {
    await act(async () => {
      root.render(createElement(TokenUsageSection, { request, enabled: true }));
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { document, root, cleanup };
}

test('usage panel renders stats, heatmap and switches chart granularity', async () => {
  const { document, cleanup } = await renderSection();
  try {
    const total = document.querySelector('.usage-stat.is-total dd');
    assert.ok(total, 'the lifetime stat card is rendered');
    assert.match(total.textContent, /270/);
    const caption = document.querySelector('.usage-section-caption').textContent;
    assert.match(caption, /tokens/);
    assert.match(caption, /3 天有使用记录/);

    const cells = document.querySelectorAll('.usage-grid .usage-cell');
    // The trailing window spans 53 or 54 Monday-first columns depending on today's weekday.
    assert.ok(cells.length === 53 * 7 || cells.length === 54 * 7);
    assert.ok(document.querySelector('.usage-grid .usage-cell.level-4'));

    const tabs = document.querySelectorAll('.usage-tabs button');
    assert.equal(tabs.length, 3);
    assert.equal(tabs[0].getAttribute('aria-pressed'), 'true');

    await act(async () => { tabs[1].click(); });
    assert.equal(document.querySelectorAll('.usage-bars .usage-bar').length, 12);

    await act(async () => { tabs[2].click(); });
    assert.ok(document.querySelector('.usage-area-chart'));
    assert.equal(document.querySelectorAll('.usage-bars').length, 0);
  } finally {
    await cleanup();
  }
});

test('an account without activity gets an empty state and no chart tabs', async () => {
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
    await act(async () => {
      root.render(createElement(TokenUsageSection, {
        enabled: true,
        request: async () => ({
          items: [],
          lifetime: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, total: 0 },
          estimated: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, total: 0 },
          backfilled: true,
        }),
      }));
    });
    assert.ok(document.querySelector('.usage-empty'));
    assert.equal(document.querySelectorAll('.usage-tabs button').length, 0);
    assert.equal(document.querySelectorAll('.usage-grid').length, 0);
  } finally {
    await act(async () => root.unmount());
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('an account that was never estimated backfills once and labels the history as approximate', async () => {
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
  const calls = [];
  let gets = 0;
  const request = async (path) => {
    calls.push(path);
    if (path === '/api/usage/backfill') return { backfilled: true };
    assert.match(path, /^\/api\/usage\?days=366$/);
    gets += 1;
    return gets === 1 ? report({ backfilled: false }) : report({
      backfilled: true,
      estimated: { input: 200, output: 40, cacheRead: 0, cacheWrite: 0, requests: 2, total: 240 },
    });
  };
  try {
    await act(async () => {
      root.render(createElement(TokenUsageSection, { request, enabled: true }));
    });
    assert.deepEqual(calls, ['/api/usage?days=366', '/api/usage/backfill', '/api/usage?days=366']);
    assert.match(document.querySelector('.usage-section-caption').textContent, /含历史估算/);
    assert.match(document.querySelector('.usage-note').textContent, /按消息长度估算/);
    assert.equal(document.querySelectorAll('.usage-tabs button').length, 3);
  } finally {
    await act(async () => root.unmount());
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});
