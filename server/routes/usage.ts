import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import {
  backfillUsage,
  daysBetween,
  getUsage,
  reportUsage,
  utcToday,
} from '../db/repositories/usage';
import { AppError, invalid } from '../errors';
import { hasFeature } from '../features/registry';

const MAX_REPORT_TOKENS = 100_000_000;
const MAX_DAY_OFFSET = 2;
const MAX_WINDOW_DAYS = 1_095;
const MAX_UTC_OFFSET_MINUTES = 840;

const usageReportSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  inputTokens: z.number().int().min(0).max(MAX_REPORT_TOKENS).default(0),
  outputTokens: z.number().int().min(0).max(MAX_REPORT_TOKENS).default(0),
  cacheReadTokens: z.number().int().min(0).max(MAX_REPORT_TOKENS).default(0),
  cacheWriteTokens: z.number().int().min(0).max(MAX_REPORT_TOKENS).default(0),
});

const backfillSchema = z.object({
  utcOffsetMinutes: z.number().int()
    .min(-MAX_UTC_OFFSET_MINUTES)
    .max(MAX_UTC_OFFSET_MINUTES)
    .default(0),
});

const usageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(MAX_WINDOW_DAYS).default(366),
});

export type UsageRouteDeps = { db: AppDatabase };

const INSTANCE_ID = 1;

function requireUsage(): void {
  if (!hasFeature('usage')) {
    throw new AppError(403, 'feature_unavailable', '当前实例尚未开放此功能。');
  }
}

function reportDay(value: string | undefined): string {
  const today = utcToday();
  if (!value) return today;
  if (Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw invalid('用量日期超出允许范围。');
  }
  if (Math.abs(daysBetween(value, today)) > MAX_DAY_OFFSET) {
    throw invalid('用量日期超出允许范围。');
  }
  return value;
}

export function registerUsageRoutes(app: FastifyInstance, deps: UsageRouteDeps): void {
  const { db } = deps;

  app.post('/api/usage', async (request) => {
    requireUsage();
    const payload = usageReportSchema.parse(request.body);
    reportUsage(db, INSTANCE_ID, reportDay(payload.date), payload);
    return { ok: true };
  });

  app.post('/api/usage/backfill', async (request) => {
    requireUsage();
    const payload = backfillSchema.parse(request.body);
    return backfillUsage(db, INSTANCE_ID, payload.utcOffsetMinutes);
  });

  app.get('/api/usage', async (request) => {
    requireUsage();
    const query = usageQuerySchema.parse(request.query);
    return getUsage(db, INSTANCE_ID, query.days);
  });
}
