import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentTool } from '@mariozechner/pi-agent-core';

import type { FetchedPage, FetchService } from '../services/fetch';
import type { SearchService } from '../services/search';
import { toolRegistry } from '../tools';
import type { ToolContext } from '../tools/types';

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

test('web_fetch accepts one or a batch of URLs and reports content budget', async () => {
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
