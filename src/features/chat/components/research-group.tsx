import { CircleAlert, FileText, Search } from 'lucide-react';
import { memo, useId, useState } from 'react';

import type { ProcessActivity, WebActivity, WebSearchResult } from '@/core/agent/types';

type ResearchKind = 'search' | 'fetch';

export type ResearchGroup = {
  id: string;
  kind: ResearchKind;
  activities: WebActivity[];
};

export type ResearchRenderStep =
  | { type: 'step'; step: ProcessActivity }
  | { type: 'group'; group: ResearchGroup };

/**
 * Merge only adjacent search calls into one row and adjacent fetch calls into another. A thinking
 * segment, file operation or the other tool kind breaks the run, so `search → think → search`
 * stays two rows instead of being falsely combined. Raw activities are untouched for storage and
 * debugging; the grouped header can say "found N pages" instead of "searched N times".
 */
export function groupResearchSteps(steps: ProcessActivity[]): ResearchRenderStep[] {
  const result: ResearchRenderStep[] = [];
  let index = 0;
  while (index < steps.length) {
    const step = steps[index];
    if (step.kind !== 'search' && step.kind !== 'fetch') {
      result.push({ type: 'step', step });
      index++;
      continue;
    }
    const kind = step.kind;
    const activities: WebActivity[] = [];
    while (index < steps.length) {
      const next = steps[index];
      if (next.kind !== kind) break;
      activities.push(next);
      index++;
    }
    result.push({
      type: 'group',
      group: { id: `research:${kind}:${activities[0].id}`, kind, activities },
    });
  }
  return result;
}

/** The row a results panel belongs to, found again after a live update so the open panel keeps
    showing results that arrived while the reply was still running. */
export function findResearchGroup(steps: ProcessActivity[], id: string): ResearchGroup | null {
  for (const entry of groupResearchSteps(steps)) {
    if (entry.type === 'group' && entry.group.id === id) return entry.group;
  }
  return null;
}

export function researchPanelTitle(kind: ResearchKind): string {
  return kind === 'search' ? '搜索结果' : '读取的网页';
}

function normalizedUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

export function hostname(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function formatTook(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function uniqueSearchResults(activities: WebActivity[]): WebSearchResult[] {
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  for (const activity of activities) {
    for (const result of activity.results ?? []) {
      const key = normalizedUrl(result.url);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(result);
    }
  }
  return results;
}

export type FetchedPage = { url: string; title?: string };

export function uniqueFetchedPages(activities: WebActivity[]): FetchedPage[] {
  const titles = new Map<string, string>();
  const order: string[] = [];
  const seen = new Set<string>();
  for (const activity of activities) {
    const urls = activity.urls ?? (activity.url ? [activity.url] : []);
    for (const value of urls) {
      const key = normalizedUrl(value);
      if (activity.title && activity.url && normalizedUrl(activity.url) === key) titles.set(key, activity.title);
      if (seen.has(key)) continue;
      seen.add(key);
      order.push(key);
    }
  }
  return order.map((url) => ({ url, title: titles.get(url) }));
}

/** Only pages whose read actually finished are sources. A failed or interrupted call still carries
    the URLs it tried, and those must not be listed (or counted) as readable pages. */
export function readPages(activities: WebActivity[]): FetchedPage[] {
  return uniqueFetchedPages(activities.filter((activity) => activity.status === 'complete'));
}

type GroupStatus = 'running' | 'complete' | 'stopped' | 'error';

function groupStatus(activities: WebActivity[]): GroupStatus {
  if (activities.some((activity) => activity.status === 'running')) return 'running';
  if (activities.every((activity) => activity.status === 'error')) return 'error';
  if (activities.every((activity) => activity.status === 'stopped')) return 'stopped';
  return 'complete';
}

/** Warnings and partial failures arrive as an `error` or `warning` on a call that may still have
    usable sources. */
export type ResearchNote = { id: string; text: string; error: boolean };

export function researchNotes(activities: WebActivity[]): ResearchNote[] {
  return activities.flatMap((activity) => [
    ...(activity.error ? [{ id: `error:${activity.id}`, text: activity.error, error: true }] : []),
    ...(activity.warning ? [{ id: `warning:${activity.id}`, text: activity.warning, error: false }] : []),
  ]);
}

/**
 * One aggregated research row. A batch with at least one usable source is a button that opens its
 * results in the panel beside the conversation (a bottom sheet on a narrow viewport), so a long
 * result list never pushes the answer down. A batch where nothing could be read keeps its failure
 * lines folded under the row instead — there is nothing to show in the panel, so the row explains
 * itself.
 */
export const ResearchGroupRow = memo(function ResearchGroupRow({ group, open = false, onOpen }: {
  group: ResearchGroup;
  open?: boolean;
  onOpen?: (opener: HTMLElement) => void;
}) {
  const status = groupStatus(group.activities);
  const running = status === 'running';
  const failed = status === 'error';
  const stopped = status === 'stopped';
  const results = group.kind === 'search' ? uniqueSearchResults(group.activities) : [];
  const pages = group.kind === 'fetch' ? uniqueFetchedPages(group.activities) : [];
  const readable = group.kind === 'fetch' ? readPages(group.activities) : [];
  const tookMs = group.activities.reduce((sum, activity) => sum + (activity.tookMs ?? 0), 0);
  const Glyph = failed ? CircleAlert : group.kind === 'search' ? Search : FileText;
  const state = group.kind === 'search'
    ? running ? '正在搜索'
      : failed ? '搜索失败'
        : stopped ? '搜索已停止'
          : results.length ? `搜索到 ${results.length} 个网页` : '未找到网页'
    : running ? '正在读取'
      : failed ? '读取失败'
        : stopped ? '读取已停止'
          : pages.length ? `浏览了 ${pages.length} 个页面` : '没有读取到页面';
  // A batch with a readable page still opens its panel; only an all-failed batch folds the reason
  // under the row, because there is nothing else the click could show.
  const available = group.kind === 'search' ? results.length > 0 : readable.length > 0;
  const notes = researchNotes(group.activities);
  const inlineNotes = !available && notes.length > 0;
  const [notesOpen, setNotesOpen] = useState(false);
  const notesId = useId();

  return <div className={`web-activity research-group is-${status}`}>
    <button type="button" className="web-activity-toggle" aria-expanded={inlineNotes ? notesOpen : open}
      {...(inlineNotes ? { 'aria-controls': notesId } : { 'aria-haspopup': 'dialog' as const })}
      onClick={(event) => {
        if (inlineNotes) { setNotesOpen((value) => !value); return; }
        onOpen?.(event.currentTarget);
      }}>
      <Glyph size={15} strokeWidth={1.75} className="web-activity-icon" aria-hidden="true" />
      <span className="web-activity-label">{group.kind === 'search' ? '搜索资料' : '读取网页'}</span>
      <span className={`web-activity-state${failed ? ' is-error' : ''}`}>{state}</span>
      {tookMs > 0 && !running
        ? <span className="web-activity-time">{formatTook(tookMs)}</span>
        : null}
    </button>
    {inlineNotes && <div className="web-activity-notes" id={notesId} hidden={!notesOpen}>
      {notes.map((note) => <span key={note.id} className={note.error ? 'web-activity-error' : 'web-activity-empty'}>{note.text}</span>)}
    </div>}
  </div>;
});
