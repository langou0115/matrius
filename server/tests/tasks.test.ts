import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp } from '../app';
import { loadSettings } from '../config';

async function withApp(
  fn: (app: Awaited<ReturnType<typeof buildApp>>['app']) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-tasks-'));
  const settings = loadSettings({
    APP_ENV: 'test',
    DATA_DIR: directory,
    LOG_LEVEL: 'silent',
  });
  const { app } = await buildApp({ settings });
  try {
    await fn(app);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('scheduled tasks support create, list, patch, trigger (recurring & once) and delete', async () => {
  await withApp(async (app) => {
    const empty = await app.inject({ method: 'GET', url: '/api/tasks' });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json(), { items: [] });

    const createdRecurring = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        prompt: '每天检查一次 AI 行业动态并总结重点',
        kind: 'recurring',
        intervalMinutes: 30,
      },
    });
    assert.equal(createdRecurring.statusCode, 201);
    const recurring = createdRecurring.json() as {
      id: string;
      title: string;
      kind: string;
      intervalMinutes: number;
      nextRunAtMs: number;
      status: string;
      revision: number;
    };
    assert.equal(recurring.kind, 'recurring');
    assert.equal(recurring.intervalMinutes, 30);
    assert.equal(recurring.status, 'active');
    assert.ok(recurring.nextRunAtMs > 0);
    assert.equal(recurring.revision, 1);

    const triggeredAt = 1_760_000_000_000;
    const triggered = await app.inject({
      method: 'POST',
      url: `/api/tasks/${recurring.id}/trigger`,
      payload: { conversationClientId: 'conv-1', triggeredAtMs: triggeredAt },
    });
    assert.equal(triggered.statusCode, 200);
    const afterTrigger = triggered.json() as {
      conversationClientId: string;
      lastRunAtMs: number;
      nextRunAtMs: number;
      runCount: number;
      status: string;
    };
    assert.equal(afterTrigger.conversationClientId, 'conv-1');
    assert.equal(afterTrigger.lastRunAtMs, triggeredAt);
    assert.equal(afterTrigger.nextRunAtMs, triggeredAt + 30 * 60_000);
    assert.equal(afterTrigger.runCount, 1);
    assert.equal(afterTrigger.status, 'active');

    const paused = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${recurring.id}`,
      payload: { enabled: false },
    });
    assert.equal(paused.statusCode, 200);
    assert.equal((paused.json() as { status: string; nextRunAtMs: number | null }).status, 'paused');
    assert.equal((paused.json() as { nextRunAtMs: number | null }).nextRunAtMs, null);

    const createdOnce = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        title: '单次提醒',
        prompt: '总结一下今天的会议要点',
        kind: 'once',
        runAtMs: triggeredAt + 60_000,
      },
    });
    assert.equal(createdOnce.statusCode, 201);
    const onceTask = createdOnce.json() as { id: string };

    const onceTriggered = await app.inject({
      method: 'POST',
      url: `/api/tasks/${onceTask.id}/trigger`,
      payload: { conversationClientId: 'conv-2', triggeredAtMs: triggeredAt + 60_000 },
    });
    assert.equal(onceTriggered.statusCode, 200);
    const onceAfter = onceTriggered.json() as {
      enabled: boolean;
      status: string;
      nextRunAtMs: number | null;
      runCount: number;
    };
    assert.equal(onceAfter.enabled, false);
    assert.equal(onceAfter.status, 'completed');
    assert.equal(onceAfter.nextRunAtMs, null);
    assert.equal(onceAfter.runCount, 1);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/tasks/${onceTask.id}` });
    assert.equal(deleted.statusCode, 204);

    const list = await app.inject({ method: 'GET', url: '/api/tasks' });
    assert.equal((list.json() as { items: unknown[] }).items.length, 1);
  });
});

test('scheduled task keeps bound conversation across recurring triggers', async () => {
  await withApp(async (app) => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        title: '每日早报',
        prompt: '总结今日 AI 开源更新',
        kind: 'recurring',
        intervalMinutes: 1440,
      },
    });
    assert.equal(created.statusCode, 201);
    const task = created.json() as { id: string; conversationClientId: string | null };
    assert.equal(task.conversationClientId, null);

    const firstTrigger = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/trigger`,
      payload: { conversationClientId: 'conv-bound-123', triggeredAtMs: 1_760_000_000_000 },
    });
    assert.equal(firstTrigger.statusCode, 200);
    assert.equal((firstTrigger.json() as { conversationClientId: string }).conversationClientId, 'conv-bound-123');

    const secondTrigger = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/trigger`,
      payload: { conversationClientId: 'conv-bound-123', triggeredAtMs: 1_760_086_400_000 },
    });
    assert.equal(secondTrigger.statusCode, 200);
    assert.equal((secondTrigger.json() as { conversationClientId: string }).conversationClientId, 'conv-bound-123');
    assert.equal((secondTrigger.json() as { runCount: number }).runCount, 2);
  });
});
