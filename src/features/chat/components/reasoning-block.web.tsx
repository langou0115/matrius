import { Check, ChevronRight, CircleAlert, FileText, Globe2, Search, Sparkles, Square } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import type { ProcessActivity, WebActivity, WebSearchResult } from '@/core/agent/types';
import type { Message } from '../chat-state';
import { MessageContent } from './message-content.web';

export type ReasoningState = 'running' | 'complete' | 'stopped' | 'error';

export function getReasoningState(message: Pick<Message, 'status' | 'content' | 'reasoning' | 'reasoningActive' | 'activities'>): ReasoningState {
  // The header describes the whole reply, not just the current thinking token block.
  if (message.status === 'streaming') return 'running';
  if (message.status === 'stopped') return 'stopped';
  if (message.status === 'error') return 'error';
  return 'complete';
}

/** Seconds below a minute, then m:ss — a wait is read in seconds, not in minutes. */
function formatElapsed(seconds: number) {
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function hostname(url: string | undefined): string {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function formatTook(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function activityLabel(activity: WebActivity): string {
  if (activity.status === 'stopped') return activity.kind === 'search' ? '搜索已停止' : '读取已停止';
  if (activity.kind === 'search') {
    return activity.status === 'error' ? '搜索失败' : activity.status === 'running' ? '正在搜索' : '已搜索';
  }
  return activity.status === 'error' ? '读取失败' : activity.status === 'running' ? '正在读取' : '已读取';
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
    {results.map((result) => <a className="web-activity-result" key={`${result.rank}:${result.url}`}
      href={result.url} target="_blank" rel="noopener noreferrer">
      <SiteIcon url={result.url} />
      <span className="web-activity-result-copy">
      <span className="web-activity-result-title">{result.title}</span>
      <span className="web-activity-result-domain">{result.domain || hostname(result.url)}</span>
      </span>
    </a>)}
  </span>;
}

function WebActivityRow({ activity }: { activity: WebActivity }) {
  const running = activity.status === 'running';
  const failed = activity.status === 'error';
  const finished = !running;
  const [expansion, setExpansion] = useState<{ finished: boolean; open: boolean } | null>(null);
  const open = expansion?.finished === finished ? expansion.open : !finished;
  const bodyId = useId();
  const Glyph = failed ? CircleAlert : activity.kind === 'search' ? Search : FileText;
  const urls = activity.kind === 'fetch' ? activity.urls ?? (activity.url ? [activity.url] : []) : [];
  return <div className={`web-activity is-${activity.status}`}>
    <button type="button" className="web-activity-toggle" aria-expanded={open} aria-controls={bodyId}
      onClick={() => setExpansion({ finished, open: !open })}>
        <Glyph size={15} strokeWidth={1.75} className="web-activity-icon" aria-hidden="true" />
        <span className="web-activity-label">{activity.kind === 'search' ? '搜索资料' : '读取网页'}</span>
        <span className="web-activity-state">{activityLabel(activity)}</span>
        {activity.tookMs !== undefined && !running
          ? <span className="web-activity-time">{formatTook(activity.tookMs)}</span>
          : null}
        <ChevronRight size={14} className="web-activity-chevron" aria-hidden="true" />
    </button>
    <div className="web-activity-details" id={bodyId} hidden={!open}>
      {activity.kind === 'search'
        ? <span className="web-activity-subject">{activity.query}</span>
        : null}
      {activity.kind === 'search' && activity.results?.length ? <div className="web-activity-sources">
        <SearchResults results={activity.results} />
      </div> : null}
      {activity.kind === 'search' && activity.status === 'complete' && !activity.results?.length
        ? <span className="web-activity-empty">本次检索未找到可用结果。</span> : null}
      {activity.kind === 'fetch' && urls.length > 0
        ? <span className="web-activity-results">
          {urls.map((url) => <a className="web-activity-result" key={url} href={url}
            target="_blank" rel="noopener noreferrer">
            <SiteIcon url={url} size={15} />
            <span className="web-activity-result-copy">
              <span className="web-activity-result-title">{url === activity.url ? activity.title || hostname(url) : hostname(url)}</span>
              <span className="web-activity-result-domain">{url}</span>
            </span>
          </a>)}
        </span>
        : null}
      {activity.error ? <span className={failed ? 'web-activity-error' : 'web-activity-empty'}>{activity.error}</span> : null}
    </div>
  </div>;
}

function useElapsed(startedAt: number | null) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
}

type Props = {
  /** Reasoning text so far. Empty is the normal state before the model has emitted any. */
  reasoning?: string;
  state: ReasoningState;
  /** Total process duration, carried by the message so it survives the run ending. */
  elapsedMs?: number | null;
  /** Epoch ms for the round, shared by waiting, tools and answer streaming. */
  startedAt?: number | null;
  /** Web searches and page reads made for this reply, newest state per call. */
  activities?: WebActivity[];
  process?: ProcessActivity[];
  /** Key the caller's choice by reply id, including the wait before the message exists. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * The status line above an answer, covering both the wait before any output and the
 * reasoning the model produced. Sending and thinking share one row so the reply area
 * never swaps components mid-flight: the line simply grows an expandable body.
 */
export function ReasoningBlock({ reasoning = '', state, elapsedMs = null, startedAt = null, activities, process, open: controlledOpen, onOpenChange }: Props) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const bodyId = useId();
  const running = state === 'running';
  const text = reasoning.trim();
  // Legacy replies have no event ordering; new replies render the ordered runtime segments.
  const steps: ProcessActivity[] = process?.length ? process : [
    ...(text ? [{ id: 'legacy-thinking', kind: 'thinking' as const, content: text, status: 'complete' as const }] : []),
    ...(activities ?? []),
  ];
  const visibleSteps = steps.filter((step) => step.kind !== 'thinking' || step.content.trim());
  // Keep counting through reasoning, tools, the gap before the answer, and answer streaming.
  const live = running && startedAt !== null;
  const seconds = useElapsed(live ? startedAt : null);
  const elapsed = live ? Math.max(seconds, Math.floor((elapsedMs ?? 0) / 1000)) : Math.floor((elapsedMs ?? 0) / 1000);
  const showElapsed = elapsedMs !== null || startedAt !== null;
  function toggle() {
    const next = !open;
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }
  const label = '思考过程';
  const StatusIcon = state === 'stopped' ? Square : state === 'error' ? CircleAlert : running ? Sparkles : Check;
  const line = <>
    <StatusIcon size={17} strokeWidth={1.75} className={`reasoning-icon${running ? ' is-running' : ''}`} aria-hidden="true" />
    <span className={running ? 'reasoning-label is-running' : 'reasoning-label'}>{label}</span>
    {/* Hidden from assistive tech: the status line is a live region, so a once-a-second
        update would be re-announced once a second. The label carries the meaning. */}
    <span className="reasoning-meta">
      {showElapsed && <span className="reasoning-time" aria-hidden="true">{formatElapsed(elapsed)}</span>}
      <ChevronRight size={15} className="reasoning-chevron" aria-hidden="true" />
    </span>
  </>;
  return <div className={`reasoning${open ? ' is-open' : ''}`}>
    <span className="sr-only" role="status">{label}</span>
    <button type="button" className="reasoning-toggle" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>{line}</button>
    <div className="reasoning-body" id={bodyId} hidden={!open}>
      {open && visibleSteps.length ? <div className="reasoning-steps">{visibleSteps.map((step) => step.kind === 'thinking'
        ? <div className="reasoning-text reasoning-process-step" key={step.id}><MessageContent content={step.content} streaming={running && step.status === 'running'} /></div>
        : <div className="reasoning-process-step" key={step.id}><WebActivityRow activity={step} /></div>)}</div> : null}
    </div>
  </div>;
}
