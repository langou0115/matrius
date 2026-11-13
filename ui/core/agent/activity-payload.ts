import type { ProcessActivity, WebActivity, WebSearchResult } from './types';

const maxResults = 20;
const maxUrls = 10;
const maxProcess = 100;

function compactResult(result: WebSearchResult): { title: string; url: string; domain: string; rank: number } | null {
  const url = typeof result.url === 'string' ? result.url : '';
  if (!/^https?:\/\//.test(url) || url.length > 2000) return null;
  return {
    title: (result.title ?? '').slice(0, 300),
    url,
    domain: (result.domain ?? '').slice(0, 300),
    rank: typeof result.rank === 'number' && result.rank >= 0 ? result.rank : 0,
  };
}

function compactUrl(url: string | undefined): string | undefined {
  return typeof url === 'string' && /^https?:\/\//.test(url) && url.length <= 2000 ? url : undefined;
}

/** Server-bound copy of one tool step. Every field is clamped to the server's validation limits:
    a value the API rejects makes the whole workspace save fail with 422, so the client never sends
    more than the record schema accepts. */
export function compactActivity(activity: WebActivity): Record<string, unknown> {
  const results = (activity.results ?? []).map(compactResult).filter((result): result is NonNullable<typeof result> => result !== null);
  const urls = (activity.urls ?? []).map(compactUrl).filter((url): url is string => url !== undefined).slice(0, maxUrls);
  const url = compactUrl(activity.url);
  return {
    id: activity.id.slice(0, 128),
    kind: activity.kind,
    status: activity.status,
    ...(activity.query ? { query: activity.query.slice(0, 500) } : {}),
    ...(activity.queries?.length ? { queries: activity.queries.slice(0, 4).map((query) => query.slice(0, 500)) } : {}),
    ...(results.length ? { results: results.slice(0, maxResults) } : {}),
    ...(url ? { url } : {}),
    ...(urls.length ? { urls } : {}),
    ...(activity.title ? { title: activity.title.slice(0, 300) } : {}),
    ...(activity.operation ? { operation: activity.operation } : {}),
    ...(activity.fileId ? { fileId: activity.fileId.slice(0, 80) } : {}),
    ...(activity.savedFileId ? { savedFileId: activity.savedFileId.slice(0, 80) } : {}),
    ...(activity.filename ? { filename: activity.filename.slice(0, 300) } : {}),
    ...(typeof activity.size === 'number' ? { size: activity.size } : {}),
    ...(activity.warning ? { warning: activity.warning.slice(0, 1000) } : {}),
    ...(typeof activity.tookMs === 'number' ? { tookMs: activity.tookMs } : {}),
    ...(activity.error ? { error: activity.error.slice(0, 1000) } : {}),
    ...(typeof activity.startedAt === 'number' ? { startedAt: activity.startedAt } : {}),
    ...(typeof activity.endedAt === 'number' ? { endedAt: activity.endedAt } : {}),
  };
}

/** Server-bound copy of a reply's web tools.
 *
 *  Search snippets and engines are display-only and can dominate the payload, and the server
 *  re-validates every entry, so only the fields the panel renders are uploaded. */
export function compactActivities(activities: WebActivity[] | undefined): unknown[] | undefined {
  if (!activities?.length) return undefined;
  return activities.slice(-50).map(compactActivity);
}

/** Server-bound copy of the ordered process (thinking segments and tool calls interleaved).
 *
 *  The process carries the same tool entries as `activities`, so it goes through the same
 *  compaction: a raw entry can hold more results than the server allows (a multi-query search
 *  merges every keyword's hits) and one rejected step fails the whole save with 422. */
export function compactProcess(process: ProcessActivity[] | undefined): unknown[] | undefined {
  if (!process?.length) return undefined;
  return process.slice(-maxProcess).map((step) => step.kind === 'thinking'
    ? {
      id: step.id.slice(0, 128),
      kind: 'thinking',
      content: step.content.slice(0, 1_000_000),
      status: step.status,
      ...(typeof step.startedAt === 'number' ? { startedAt: step.startedAt } : {}),
      ...(typeof step.endedAt === 'number' ? { endedAt: step.endedAt } : {}),
    }
    : compactActivity(step));
}
