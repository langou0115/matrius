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
    ...(activity.query ? { query: activity.query.slice(0, 500) } : {}),
    ...(activity.results?.length ? {
      results: activity.results.filter(({ url }) => /^https?:\/\//.test(url) && url.length <= 2000).slice(0, 20)
        .map(({ title, url, domain, rank }) => ({ title: title.slice(0, 300), url, domain: domain.slice(0, 300), rank })),
    } : {}),
    ...(activity.url ? { url: activity.url } : {}),
    ...(activity.urls?.length ? { urls: activity.urls.slice(0, 10) } : {}),
    ...(activity.title ? { title: activity.title.slice(0, 300) } : {}),
    ...(activity.operation ? { operation: activity.operation } : {}),
    ...(activity.fileId ? { fileId: activity.fileId } : {}),
    ...(activity.savedFileId ? { savedFileId: activity.savedFileId } : {}),
    ...(activity.filename ? { filename: activity.filename.slice(0, 300) } : {}),
    ...(typeof activity.size === 'number' ? { size: activity.size } : {}),
    ...(activity.warning ? { warning: activity.warning.slice(0, 1000) } : {}),
    ...(typeof activity.tookMs === 'number' ? { tookMs: activity.tookMs } : {}),
    ...(activity.error ? { error: activity.error.slice(0, 1000) } : {}),
    ...(typeof activity.startedAt === 'number' ? { startedAt: activity.startedAt } : {}),
    ...(typeof activity.endedAt === 'number' ? { endedAt: activity.endedAt } : {}),
  }));
}
