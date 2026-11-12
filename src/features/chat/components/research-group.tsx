import { ChevronRight, CircleAlert, FileText, Globe2, Search } from 'lucide-react';
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
 * Merge every search call into one row and every fetch call into one row, keeping the row at
 * the first occurrence. Raw activities stay untouched for storage and debugging; only the
 * reasoning panel is aggregated, so the header can say "found N pages" instead of "searched N
 * times".
 */
export function groupResearchSteps(steps: ProcessActivity[]): ResearchRenderStep[] {
  const groups = new Map<ResearchKind, WebActivity[]>();
  const firstIndex = new Map<ResearchKind, number>();
  steps.forEach((step, index) => {
    if (step.kind !== 'search' && step.kind !== 'fetch') return;
    if (!groups.has(step.kind)) {
      groups.set(step.kind, []);
      firstIndex.set(step.kind, index);
    }
    groups.get(step.kind)!.push(step);
  });

  const result: ResearchRenderStep[] = [];
  steps.forEach((step, index) => {
    if (step.kind === 'search' || step.kind === 'fetch') {
      if (firstIndex.get(step.kind) === index) {
        result.push({
          type: 'group',
          group: { id: `research:${step.kind}`, kind: step.kind, activities: groups.get(step.kind)! },
        });
      }
      return;
    }
    result.push({ type: 'step', step });
  });
  return result;
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

function hostname(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function formatTook(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function uniqueSearchResults(activities: WebActivity[]): WebSearchResult[] {
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

type FetchedPage = { url: string; title?: string };

function uniqueFetchedPages(activities: WebActivity[]): FetchedPage[] {
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

type GroupStatus = 'running' | 'complete' | 'stopped' | 'error';

function groupStatus(activities: WebActivity[]): GroupStatus {
  if (activities.some((activity) => activity.status === 'running')) return 'running';
  if (activities.every((activity) => activity.status === 'error')) return 'error';
  if (activities.every((activity) => activity.status === 'stopped')) return 'stopped';
  return 'complete';
}

/** The site's own root favicon keeps requests on the result's domain; a 404 or a broken
    response falls back to the neutral globe instead of leaving a broken image. */
function SiteIcon({ url, size = 14 }: { url: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  let source: string | null = null;
  try { source = `https://${new URL(url).hostname}/favicon.ico`; } catch { /* unusable URL */ }
  if (!source || failed) return <Globe2 size={size} aria-hidden="true" />;
  return <img className="web-activity-result-icon" src={source} width={size} height={size} alt=""
    loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

function SearchResults({ results }: { results: WebSearchResult[] }) {
  return <span className="web-activity-results">
    {results.map((result) => <a className="web-activity-result" key={result.url}
      href={result.url} target="_blank" rel="noopener noreferrer">
      <SiteIcon url={result.url} />
      <span className="web-activity-result-copy">
        <span className="web-activity-result-title">{result.title}</span>
        <span className="web-activity-result-domain">{result.domain || hostname(result.url)}</span>
      </span>
    </a>)}
  </span>;
}

export const ResearchGroupRow = memo(function ResearchGroupRow({ group }: { group: ResearchGroup }) {
  const status = groupStatus(group.activities);
  const running = status === 'running';
  const failed = status === 'error';
  const stopped = status === 'stopped';
  const partialFailure = !failed && group.activities.some((activity) => activity.status === 'error');
  const finished = !running;
  const [expansion, setExpansion] = useState<{ finished: boolean; open: boolean } | null>(null);
  const open = expansion?.finished === finished ? expansion.open : !finished;
  const bodyId = useId();
  const results = group.kind === 'search' ? uniqueSearchResults(group.activities) : [];
  const pages = group.kind === 'fetch' ? uniqueFetchedPages(group.activities) : [];
  const tookMs = group.activities.reduce((sum, activity) => sum + (activity.tookMs ?? 0), 0);
  const Glyph = failed ? CircleAlert : group.kind === 'search' ? Search : FileText;
  const state = group.kind === 'search'
    ? running ? '正在搜索'
      : failed ? '搜索失败'
        : stopped ? '搜索已停止'
          : results.length ? `搜索到 ${results.length} 个网页${partialFailure ? '（部分失败）' : ''}` : '未找到网页'
    : running ? '正在读取'
      : failed ? '读取失败'
        : stopped ? '读取已停止'
          : pages.length ? `浏览了 ${pages.length} 个页面${partialFailure ? '（部分失败）' : ''}` : '没有读取到页面';

  return <div className={`web-activity research-group is-${status}`}>
    <button type="button" className="web-activity-toggle" aria-expanded={open} aria-controls={bodyId}
      onClick={() => setExpansion({ finished, open: !open })}>
      <Glyph size={15} strokeWidth={1.75} className="web-activity-icon" aria-hidden="true" />
      <span className="web-activity-label">{group.kind === 'search' ? '搜索资料' : '读取网页'}</span>
      <span className={`web-activity-state${failed ? ' is-error' : ''}`}>{state}</span>
      {tookMs > 0 && !running
        ? <span className="web-activity-time">{formatTook(tookMs)}</span>
        : null}
      <ChevronRight size={14} className="web-activity-chevron" aria-hidden="true" />
    </button>
    <div className="web-activity-details" id={bodyId} hidden={!open}>
      {group.kind === 'search' && results.length
        ? <div className="web-activity-sources"><SearchResults results={results} /></div>
        : null}
      {group.kind === 'search' && !results.length && status === 'complete'
        ? <span className="web-activity-empty">本次检索未找到可用结果。</span> : null}
      {group.kind === 'fetch' && pages.length > 0
        ? <span className="web-activity-results">
          {pages.map((page) => <a className="web-activity-result" key={page.url} href={page.url}
            target="_blank" rel="noopener noreferrer">
            <SiteIcon url={page.url} size={15} />
            <span className="web-activity-result-copy">
              <span className="web-activity-result-title">{page.title || hostname(page.url)}</span>
              <span className="web-activity-result-domain">{page.url}</span>
            </span>
          </a>)}
        </span>
        : null}
      {group.kind === 'fetch' && !pages.length && status === 'complete'
        ? <span className="web-activity-empty">没有读取到可用页面。</span> : null}
      {group.activities.map((activity) => activity.error
        ? <span className="web-activity-error" key={`error:${activity.id}`}>{activity.error}</span> : null)}
      {group.activities.map((activity) => activity.warning
        ? <span className="web-activity-empty" key={`warning:${activity.id}`}>{activity.warning}</span> : null)}
    </div>
  </div>;
});
