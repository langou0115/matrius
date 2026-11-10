import type { TokenUsage } from '@agent/core/types';

import { localDateKey } from './usage-stats';

/** Same shape the storage screen receives from the instance connection. */
export type ApiRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export type UsageDay = {
  date: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  requests: number;
  /** True when this day also contains estimated history. */
  estimated?: boolean;
};

export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
  total: number;
};

/**
 * Window items plus lifetime counters; the panel derives its own local-date summaries.
 * `lifetime` includes `estimated` history; reported usage is never mixed in storage.
 */
export type TokenUsageReport = {
  items: UsageDay[];
  lifetime: UsageTotals;
  estimated: UsageTotals;
  /** True once the one-time history estimate ran for this instance (even with no history). */
  backfilled: boolean;
};

/** How many days of activity the heatmap and the cumulative chart ask for. */
export const USAGE_WINDOW_DAYS = 366;

export async function getTokenUsage(
  request: ApiRequest, days: number = USAGE_WINDOW_DAYS, signal?: AbortSignal,
): Promise<TokenUsageReport> {
  return request<TokenUsageReport>(`/api/usage?days=${days}`, { signal });
}

/**
 * Estimates usage for conversations that predate recording. Runs once per instance; the server
 * keeps the result separate from reported usage and the panel labels it as an estimate.
 */
export async function backfillTokenUsage(request: ApiRequest, utcOffsetMinutes: number): Promise<void> {
  await request('/api/usage/backfill', {
    method: 'POST',
    body: JSON.stringify({ utcOffsetMinutes }),
  });
}

/**
 * Reports one finished reply. The model request is relayed by the stateless Web container, so
 * the browser is the only place that sees provider usage. Statistics are best-effort and never
 * interrupt the reply, and the local date keeps the panel aligned with the reader's calendar.
 */
export async function recordTokenUsage(request: ApiRequest, usage: TokenUsage): Promise<void> {
  const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  if (total <= 0) return;
  await request('/api/usage', {
    method: 'POST',
    body: JSON.stringify({
      date: localDateKey(new Date()),
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
    }),
  });
}
