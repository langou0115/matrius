import { randomUUID } from 'node:crypto';

import { fromDbUuid, toDbTimestamp, toDbUuid } from '../codecs';
import type { AppDatabase } from '../client';
import type { MessageRow } from './conversations';
import { estimateConversation } from '../../services/usage-estimate';

export type TokenUsageDailyRow = {
  id: string;
  instance_id: number;
  day: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  requests: number;
  created_at: string;
  updated_at: string;
};

export type TokenUsageEstimateDailyRow = {
  id: string;
  instance_id: number;
  day: string;
  input_tokens: number;
  output_tokens: number;
  requests: number;
  created_at: string;
  updated_at: string;
};

export type UsageCounts = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(day: string, delta: number): string {
  const date = new Date(dayMs(day));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

export function daysBetween(left: string, right: string): number {
  return Math.round((dayMs(left) - dayMs(right)) / 86_400_000);
}

/**
 * Upsert one day's counters. The `requests` column counts finished reply runs,
 * not model rounds; the caller reports once per run.
 */
export function reportUsage(
  db: AppDatabase,
  instanceId: number,
  day: string,
  counts: UsageCounts,
): void {
  const total = counts.inputTokens + counts.outputTokens
    + counts.cacheReadTokens + counts.cacheWriteTokens;
  if (total <= 0) return;
  const now = toDbTimestamp();
  db.prepare(
    `INSERT INTO token_usage_daily
     (id, instance_id, day, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      requests, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(instance_id, day) DO UPDATE SET
       input_tokens = token_usage_daily.input_tokens + excluded.input_tokens,
       output_tokens = token_usage_daily.output_tokens + excluded.output_tokens,
       cache_read_tokens = token_usage_daily.cache_read_tokens + excluded.cache_read_tokens,
       cache_write_tokens = token_usage_daily.cache_write_tokens + excluded.cache_write_tokens,
       requests = token_usage_daily.requests + 1,
       updated_at = excluded.updated_at`,
  ).run(
    toDbUuid(randomUUID()),
    instanceId,
    day,
    counts.inputTokens,
    counts.outputTokens,
    counts.cacheReadTokens,
    counts.cacheWriteTokens,
    now,
    now,
  );
}

export type UsageWindow = {
  items: Array<{
    date: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    requests: number;
    total: number;
    estimated: boolean;
  }>;
  lifetime: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    requests: number;
    total: number;
  };
  estimated: { input: number; output: number; requests: number; total: number };
  backfilled: boolean;
};

export function getUsage(db: AppDatabase, instanceId: number, days: number): UsageWindow {
  const today = utcToday();
  const start = addDays(today, -(days - 1));
  const end = addDays(today, 1);

  const actual = db
    .prepare(
      `SELECT * FROM token_usage_daily
       WHERE instance_id = ? AND day >= ? AND day <= ? ORDER BY day`,
    )
    .all(instanceId, start, end) as TokenUsageDailyRow[];
  const estimates = db
    .prepare(
      `SELECT * FROM token_usage_estimate_daily
       WHERE instance_id = ? AND day >= ? AND day <= ? ORDER BY day`,
    )
    .all(instanceId, start, end) as TokenUsageEstimateDailyRow[];

  const merged = new Map<string, {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    requests: number;
    estimated: boolean;
  }>();
  for (const row of actual) {
    merged.set(row.day, {
      input: row.input_tokens,
      output: row.output_tokens,
      cacheRead: row.cache_read_tokens,
      cacheWrite: row.cache_write_tokens,
      requests: row.requests,
      estimated: false,
    });
  }
  for (const row of estimates) {
    const item = merged.get(row.day) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      requests: 0,
      estimated: false,
    };
    item.input += row.input_tokens;
    item.output += row.output_tokens;
    item.requests += row.requests;
    item.estimated = true;
    merged.set(row.day, item);
  }

  const items = [...merged.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, values]) => ({
      date,
      ...values,
      total: values.input + values.output + values.cacheRead + values.cacheWrite,
    }));

  const actualTotals = db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) AS input,
              COALESCE(SUM(output_tokens), 0) AS output,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
              COALESCE(SUM(cache_write_tokens), 0) AS cache_write,
              COALESCE(SUM(requests), 0) AS requests
       FROM token_usage_daily WHERE instance_id = ?`,
    )
    .get(instanceId) as { input: number; output: number; cache_read: number; cache_write: number; requests: number };
  const estimateTotals = db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) AS input,
              COALESCE(SUM(output_tokens), 0) AS output,
              COALESCE(SUM(requests), 0) AS requests
       FROM token_usage_estimate_daily WHERE instance_id = ?`,
    )
    .get(instanceId) as { input: number; output: number; requests: number };

  const lifetime = {
    input: actualTotals.input + estimateTotals.input,
    output: actualTotals.output + estimateTotals.output,
    cacheRead: actualTotals.cache_read,
    cacheWrite: actualTotals.cache_write,
    requests: actualTotals.requests + estimateTotals.requests,
  };
  return {
    items,
    lifetime: {
      ...lifetime,
      total: lifetime.input + lifetime.output + lifetime.cacheRead + lifetime.cacheWrite,
    },
    estimated: {
      input: estimateTotals.input,
      output: estimateTotals.output,
      requests: estimateTotals.requests,
      total: estimateTotals.input + estimateTotals.output,
    },
    backfilled: Boolean(
      db.prepare('SELECT instance_id FROM usage_backfills WHERE instance_id = ?').get(instanceId),
    ),
  };
}

export type BackfillResult = {
  backfilled: true;
  skipped: boolean;
  days?: number;
  requests?: number;
  total?: number;
};

export function backfillUsage(
  db: AppDatabase,
  instanceId: number,
  utcOffsetMinutes: number,
): BackfillResult {
  if (db.prepare('SELECT instance_id FROM usage_backfills WHERE instance_id = ?').get(instanceId)) {
    return { backfilled: true, skipped: true };
  }

  const conversationIds = (
    db.prepare('SELECT id FROM conversations WHERE instance_id = ?').all(instanceId) as Array<{ id: string }>
  ).map((row) => row.id);
  const imageIds = new Set(
    (
      db
        .prepare("SELECT id FROM files WHERE instance_id = ? AND content_type LIKE 'image/%'")
        .all(instanceId) as Array<{ id: string }>
    ).map((row) => fromDbUuid(row.id)),
  );

  const buckets = new Map<string, [number, number, number]>();
  for (const conversationId of conversationIds) {
    const messages = db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND instance_id = ? ORDER BY position')
      .all(conversationId, instanceId) as MessageRow[];
    for (const [day, values] of estimateConversation(messages, { utcOffsetMinutes, imageIds })) {
      const bucket = buckets.get(day) ?? [0, 0, 0];
      bucket[0] += values[0];
      bucket[1] += values[1];
      bucket[2] += values[2];
      buckets.set(day, bucket);
    }
  }

  const now = toDbTimestamp();
  try {
    db.transaction(() => {
      db.prepare('DELETE FROM token_usage_estimate_daily WHERE instance_id = ?').run(instanceId);
      for (const [day, [input, output, requests]] of buckets) {
        db.prepare(
          `INSERT INTO token_usage_estimate_daily
           (id, instance_id, day, input_tokens, output_tokens, requests, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(toDbUuid(randomUUID()), instanceId, day, input, output, requests, now, now);
      }
      db.prepare(
        'INSERT INTO usage_backfills (instance_id, created_at, updated_at) VALUES (?, ?, ?)',
      ).run(instanceId, now, now);
    });
  } catch {
    // Another tab finished the one-time estimate first; its rows are equivalent.
    return { backfilled: true, skipped: true };
  }

  return {
    backfilled: true,
    skipped: false,
    days: buckets.size,
    requests: [...buckets.values()].reduce((sum, bucket) => sum + bucket[2], 0),
    total: [...buckets.values()].reduce((sum, bucket) => sum + bucket[0] + bucket[1], 0),
  };
}
