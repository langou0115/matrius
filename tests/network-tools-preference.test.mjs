import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/core/api/instance-client.ts';
import { loadNetworkToolsEnabled, saveNetworkToolsEnabled } from '../src/features/instance/network-tools-preference.ts';

test('network preference uses only the instance profile field and revision protection', async () => {
  const calls = [];
  const request = async (path, init) => {
    calls.push({ path, init });
    return { value: 'false', revision: 7 };
  };
  assert.equal(await loadNetworkToolsEnabled(request), false);
  await saveNetworkToolsEnabled(request, true);
  assert(calls.every(({ path }) => path === '/api/profile/fields/network-tools'));
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { baseRevision: 7, value: 'true', source: 'manual' });
});

test('a missing preference defaults on; connection and authorization errors are not treated as missing', async () => {
  assert.equal(await loadNetworkToolsEnabled(async () => { throw new ApiError(404, 'not_found', 'missing'); }), true);
  for (const status of [0, 401, 500]) {
    await assert.rejects(loadNetworkToolsEnabled(async () => { throw new ApiError(status, 'error', 'failed'); }));
  }
});
