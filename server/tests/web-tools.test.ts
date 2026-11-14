import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentTool } from '@mariozechner/pi-agent-core';

import type { FetchedPage, FetchService } from '../services/fetch';
import type { SearchService } from '../services/search';
import { toolRegistry } from '../agent/tools';
import type { ToolContext } from '../agent/tools/types';

const search: SearchService = {
  async searchMany() {
    return [{
      title: 'Example result',
      url: 'https://example.com/page',
      snippet: 'A snippet',
      domain: 'example.com',
      engine: 'test',
      rank: 1,
    }];
  },
};

const fetch: FetchService = {
  async fetch(url): Promise<FetchedPage> {
    return {
      title: 'Example page',
      url,
      text: '# Page\n\nBody text.',
      truncated: false,
      chars: 21,
    };
  },
};

const context: ToolContext = {
  instanceId: 1,
  features: new Set(),
  services: { search, fetch },
};

test('the registry exposes the web tools with prompt and activity adapters', () => {
  const tools = toolRegistry.createTools(context);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['web_fetch', 'web_search']);
  assert.ok(toolRegistry.prompts(context.features).some((prompt) => prompt.includes('Web tools are available')));
  assert.ok(toolRegistry.activityFor('web_search'));
  assert.ok(toolRegistry.activityFor('web_fetch'));
});

test('web_search returns source details and a completed activity row', async () => {
  const tool = toolRegistry.createTools(context).find((item) => item.name === 'web_search') as AgentTool;
  assert.ok(tool);
  const result = await tool.execute('call-search', { query: 'hello' });
  const details = result.details as {
    kind: string;
    query: string;
    results: Array<{ url: string }>;
    tookMs: number;
  };
  assert.equal(details.kind, 'search');
  assert.equal(details.query, 'hello');
  assert.equal(details.results[0].url, 'https://example.com/page');

  const adapter = toolRegistry.activityFor('web_search');
  const started = adapter?.start('call-search', { query: 'hello' });
  assert.equal(started?.kind, 'search');
  const ended = adapter?.end('call-search', result, false, started ?? undefined);
  assert.equal(ended?.status, 'complete');
  assert.equal(ended?.kind === 'search' ? ended.results?.[0].title : undefined, 'Example result');
});

test('web_fetch accepts one or a batch of URLs and reports content size', async () => {
  const tool = toolRegistry.createTools(context).find((item) => item.name === 'web_fetch') as AgentTool;
  assert.ok(tool);
  const result = await tool.execute('call-fetch', { urls: ['https://example.com/page'] });
  const details = result.details as {
    kind: string;
    url: string;
    urls: string[];
    contentChars: number;
    contentPreview: string;
  };
  assert.equal(details.kind, 'fetch');
  assert.equal(details.url, 'https://example.com/page');
  assert.deepEqual(details.urls, ['https://example.com/page']);
  assert.ok(details.contentChars > 0);
  assert.match(details.contentPreview, /Page/u);
});

test('web_fetch returns every page in full with no per-run or per-batch allowance', async () => {
  const longFetch: FetchService = {
    async fetch(url): Promise<FetchedPage> {
      return { title: 'Long page', url, text: 'x'.repeat(60_000), truncated: false, chars: 60_000 };
    },
  };
  const longContext: ToolContext = { ...context, services: { search, fetch: longFetch } };
  const makeTool = () => toolRegistry.createTools(longContext).find((item) => item.name === 'web_fetch') as AgentTool;
  const textOf = (result: Awaited<ReturnType<AgentTool['execute']>>) => result.content
    .filter((item) => item.type === 'text').map((item) => item.text).join('\n');

  const single = await makeTool().execute('long-single', { urls: ['https://example.com/long'] });
  assert.equal((single.details as { contentChars: number }).contentChars, 60_000);
  assert.doesNotMatch(textOf(single), /Warning: the page text is truncated/u);

  const batch = await makeTool().execute('long-batch', {
    urls: ['https://example.com/a', 'https://example.com/b'],
  });
  // A batch keeps each page whole instead of dividing one per-run allowance across it.
  assert.equal((batch.details as { contentChars: number }).contentChars, 120_000);

  // Later calls in the same reply are not cut off by a per-run budget.
  const spent = makeTool();
  await spent.execute('spend', { urls: ['https://example.com/first'] });
  const second = await spent.execute('over', { urls: ['https://example.com/second'] });
  assert.equal((second.details as { contentChars: number }).contentChars, 60_000);
});
