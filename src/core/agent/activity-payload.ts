import type { WebActivity } from './types';

/** Server-bound copy of a reply's web tools.
 *
 *  Search snippets and engines are display-only and can dominate the payload, and the server
 *  re-validates every entry, so only the fields the panel renders are uploaded. `process`
 *  never leaves the device: cloud history rebuilds it from `reasoning` plus these entries. */
export function compactActivities(activities: WebActivity[] | undefined): unknown[] | undefined {
  if (!activities?.length) return undefined;
  return activities.slice(-50).map((activity) => ({
    id: activity.id,
    kind: activity.kind,
    status: activity.status,
    ...(activity.query ? { query: activity.query } : {}),
    ...(activity.results?.length ? {
      results: activity.results.slice(0, 20).map(({ title, url, domain, rank }) => ({ title, url, domain, rank })),
    } : {}),
    ...(activity.url ? { url: activity.url } : {}),
    ...(activity.urls?.length ? { urls: activity.urls.slice(0, 4) } : {}),
    ...(activity.title ? { title: activity.title } : {}),
    ...(typeof activity.tookMs === 'number' ? { tookMs: activity.tookMs } : {}),
    ...(activity.error ? { error: activity.error } : {}),
    ...(typeof activity.startedAt === 'number' ? { startedAt: activity.startedAt } : {}),
    ...(typeof activity.endedAt === 'number' ? { endedAt: activity.endedAt } : {}),
  }));
}
