import assert from 'node:assert/strict';
import test from 'node:test';
import { fileTool } from '../agent/tools/file';
import type { ToolContext } from '../agent/tools/types';

test('file list defaults to the whole Library and preserves an explicit conversation filter', async () => {
  const requests: unknown[] = [];
  const context = {
    instanceId: 1, conversationId: 'active-conversation', features: new Set(['files']),
    services: { files: { run: async (_instance: number, request: unknown) => {
      requests.push(request);
      return { operation: 'list', files: [] };
    } } },
  } as unknown as ToolContext;
  const tool = fileTool.create(context);
  await tool.execute('all', { operation: 'list' });
  await tool.execute('filtered', { operation: 'list', conversationId: 'another-conversation' });
  assert.deepEqual(requests, [
    { operation: 'list' },
    { operation: 'list', conversationId: 'another-conversation' },
  ]);
});

