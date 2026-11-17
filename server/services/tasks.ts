import { randomUUID } from 'node:crypto';

import type { AppDatabase } from '../db/client';
import { fromDbBool, fromDbUuid, toDbBool, toDbTimestamp, toDbUuid, toMs } from '../db/codecs';
import { conflict, invalid, notFound } from '../errors';

const INSTANCE_ID = 1;

export type ScheduledTaskRow = {
  id: string;
  instance_id: number;
  title: string;
  prompt: string;
  kind: 'recurring' | 'once';
  interval_minutes: number | null;
  run_at_ms: number | null;
  next_run_at_ms: number | null;
  last_run_at_ms: number | null;
  conversation_client_id: string | null;
  enabled: number | boolean;
  status: 'active' | 'paused' | 'completed';
  run_count: number;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type ScheduledTaskDto = {
  id: string;
  title: string;
  prompt: string;
  kind: 'recurring' | 'once';
  intervalMinutes: number | null;
  runAtMs: number | null;
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  conversationClientId: string | null;
  enabled: boolean;
  status: 'active' | 'paused' | 'completed';
  runCount: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

export type CreateTaskInput = {
  title?: string;
  prompt: string;
  kind: 'recurring' | 'once';
  intervalMinutes?: number | null;
  runAtMs?: number | null;
  conversationClientId?: string | null;
};

export type PatchTaskInput = {
  title?: string;
  prompt?: string;
  kind?: 'recurring' | 'once';
  intervalMinutes?: number | null;
  runAtMs?: number | null;
  enabled?: boolean;
  baseRevision?: number;
};

export type ScheduledTaskService = {
  list(): ScheduledTaskDto[];
  create(input: CreateTaskInput): ScheduledTaskDto;
  patch(taskId: string, input: PatchTaskInput): ScheduledTaskDto;
  trigger(taskId: string, conversationClientId: string, triggeredAtMs?: number): ScheduledTaskDto;
  remove(taskId: string): void;
};

function serializeTask(row: ScheduledTaskRow): ScheduledTaskDto {
  return {
    id: fromDbUuid(row.id),
    title: row.title,
    prompt: row.prompt,
    kind: row.kind,
    intervalMinutes: row.interval_minutes,
    runAtMs: row.run_at_ms,
    nextRunAtMs: row.next_run_at_ms,
    lastRunAtMs: row.last_run_at_ms,
    conversationClientId: row.conversation_client_id,
    enabled: fromDbBool(row.enabled),
    status: row.status,
    runCount: row.run_count,
    revision: row.revision,
    createdAt: toMs(row.created_at) ?? Date.now(),
    updatedAt: toMs(row.updated_at) ?? Date.now(),
  };
}

function deriveTitle(title: string | undefined, prompt: string): string {
  const cleaned = title?.replace(/\s+/gu, ' ').trim();
  if (cleaned) return cleaned.slice(0, 200);
  const firstLine = prompt.trim().split(/\r?\n/u)[0]?.replace(/\s+/gu, ' ').trim() ?? '';
  if (!firstLine) return '定时任务';
  return firstLine.length > 36 ? `${firstLine.slice(0, 36).trimEnd()}…` : firstLine;
}

function parseTaskId(raw: string): string {
  try {
    return toDbUuid(raw);
  } catch {
    throw notFound('定时任务不存在。');
  }
}

function findTask(db: AppDatabase, dbId: string): ScheduledTaskRow | undefined {
  return db
    .prepare('SELECT * FROM scheduled_tasks WHERE id = ? AND instance_id = ?')
    .get(dbId, INSTANCE_ID) as ScheduledTaskRow | undefined;
}

export function createScheduledTaskService(db: AppDatabase): ScheduledTaskService {
  return {
    list() {
      const rows = db
        .prepare('SELECT * FROM scheduled_tasks WHERE instance_id = ? ORDER BY created_at DESC')
        .all(INSTANCE_ID) as ScheduledTaskRow[];
      return rows.map(serializeTask);
    },

    create(input) {
      const now = Date.now();
      let intervalMinutes: number | null = null;
      let runAtMs: number | null = null;
      let nextRunAtMs: number | null = null;

      if (input.kind === 'recurring') {
        if (!input.intervalMinutes || input.intervalMinutes < 1) {
          throw invalid('循环任务需要设置执行间隔（分钟）。');
        }
        intervalMinutes = input.intervalMinutes;
        nextRunAtMs = now + intervalMinutes * 60_000;
      } else {
        if (!input.runAtMs || input.runAtMs <= 0) {
          throw invalid('单次任务需要设置执行时间。');
        }
        runAtMs = input.runAtMs;
        nextRunAtMs = input.runAtMs;
      }

      const id = toDbUuid(randomUUID());
      const timestamp = toDbTimestamp(new Date(now));
      const title = deriveTitle(input.title, input.prompt);
      const conversationClientId = input.conversationClientId?.trim() || null;

      db.prepare(`
        INSERT INTO scheduled_tasks (
          id, instance_id, title, prompt, kind, interval_minutes, run_at_ms,
          next_run_at_ms, last_run_at_ms, conversation_client_id, enabled, status,
          run_count, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, 1, ?, ?)
      `).run(
        id,
        INSTANCE_ID,
        title,
        input.prompt,
        input.kind,
        intervalMinutes,
        runAtMs,
        nextRunAtMs,
        conversationClientId,
        toDbBool(true),
        'active',
        timestamp,
        timestamp,
      );

      const created = findTask(db, id);
      if (!created) throw notFound('定时任务不存在。');
      return serializeTask(created);
    },

    patch(taskId, input) {
      const dbId = parseTaskId(taskId);
      const current = findTask(db, dbId);
      if (!current) throw notFound('定时任务不存在。');
      if (input.baseRevision !== undefined && input.baseRevision !== current.revision) {
        throw conflict('定时任务已被更新，请刷新后重试。', { current: serializeTask(current) });
      }

      const now = Date.now();
      const nextKind = input.kind ?? current.kind;
      const nextPrompt = input.prompt ?? current.prompt;
      const nextTitle = input.title !== undefined
        ? deriveTitle(input.title, nextPrompt)
        : current.title;

      let nextInterval = input.intervalMinutes !== undefined ? input.intervalMinutes : current.interval_minutes;
      let nextRunAt = input.runAtMs !== undefined ? input.runAtMs : current.run_at_ms;
      const nextEnabled = input.enabled !== undefined ? input.enabled : fromDbBool(current.enabled);
      let nextStatus: 'active' | 'paused' | 'completed' = current.status;
      let nextScheduledMs = current.next_run_at_ms;

      if (nextKind === 'recurring') {
        if (!nextInterval) throw invalid('循环任务需要设置执行间隔（分钟）。');
        nextRunAt = null;
        if (nextEnabled) {
          nextStatus = 'active';
          if (
            input.kind !== undefined
            || input.intervalMinutes !== undefined
            || (input.enabled === true && current.status !== 'active')
            || nextScheduledMs === null
          ) {
            nextScheduledMs = now + nextInterval * 60_000;
          }
        } else {
          nextStatus = 'paused';
          nextScheduledMs = null;
        }
      } else {
        if (!nextRunAt) throw invalid('单次任务需要设置执行时间。');
        nextInterval = null;
        if (nextEnabled) {
          nextStatus = 'active';
          nextScheduledMs = nextRunAt;
        } else if (current.status === 'completed' && input.runAtMs === undefined && input.enabled === undefined) {
          nextStatus = 'completed';
          nextScheduledMs = null;
        } else {
          nextStatus = 'paused';
          nextScheduledMs = null;
        }
      }

      const updated = db.prepare(`
        UPDATE scheduled_tasks
        SET title = ?, prompt = ?, kind = ?, interval_minutes = ?, run_at_ms = ?,
            next_run_at_ms = ?, enabled = ?, status = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND instance_id = ? AND revision = ?
      `).run(
        nextTitle,
        nextPrompt,
        nextKind,
        nextInterval,
        nextRunAt,
        nextScheduledMs,
        toDbBool(nextEnabled),
        nextStatus,
        toDbTimestamp(new Date(now)),
        dbId,
        INSTANCE_ID,
        current.revision,
      );

      if (updated.changes === 0) {
        const latest = findTask(db, dbId);
        throw conflict('定时任务已被更新，请刷新后重试。', latest ? { current: serializeTask(latest) } : undefined);
      }
      const row = findTask(db, dbId);
      if (!row) throw notFound('定时任务不存在。');
      return serializeTask(row);
    },

    trigger(taskId, conversationClientId, triggeredAtMs = Date.now()) {
      const dbId = parseTaskId(taskId);
      const current = findTask(db, dbId);
      if (!current) throw notFound('定时任务不存在。');

      const isRecurring = current.kind === 'recurring';
      const nextRunAtMs = isRecurring && current.interval_minutes
        ? triggeredAtMs + current.interval_minutes * 60_000
        : null;
      const nextEnabled = isRecurring ? fromDbBool(current.enabled) : false;
      const nextStatus = isRecurring
        ? (nextEnabled ? 'active' : 'paused')
        : 'completed';

      db.prepare(`
        UPDATE scheduled_tasks
        SET last_run_at_ms = ?, next_run_at_ms = ?, conversation_client_id = ?,
            enabled = ?, status = ?, run_count = run_count + 1,
            revision = revision + 1, updated_at = ?
        WHERE id = ? AND instance_id = ?
      `).run(
        triggeredAtMs,
        nextRunAtMs,
        conversationClientId,
        toDbBool(nextEnabled),
        nextStatus,
        toDbTimestamp(new Date()),
        dbId,
        INSTANCE_ID,
      );

      const updated = findTask(db, dbId);
      if (!updated) throw notFound('定时任务不存在。');
      return serializeTask(updated);
    },

    remove(taskId) {
      const dbId = parseTaskId(taskId);
      const result = db
        .prepare('DELETE FROM scheduled_tasks WHERE id = ? AND instance_id = ?')
        .run(dbId, INSTANCE_ID);
      if (result.changes === 0) throw notFound('定时任务不存在。');
    },
  };
}
