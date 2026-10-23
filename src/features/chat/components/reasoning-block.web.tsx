import { CircleAlert, Globe2, Search } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import { Icon, type IconName } from '@/components/web/icon';
import type { WebActivity, WebSearchResult } from '@/core/agent/types';
import type { Message } from '../chat-state';
import { MessageContent } from './message-content.web';

export type ReasoningState = 'running' | 'complete' | 'stopped' | 'error';

export function getReasoningState(message: Pick<Message, 'status' | 'content' | 'reasoningActive' | 'activities'>): ReasoningState {
  // A tool call can run while earlier prose is already on screen, so the reply's own text
  // length is not enough to tell whether the model is still working.
  if (message.status === 'streaming' && message.activities?.some((activity) => activity.status === 'running')) return 'running';
  if (message.status === 'streaming') return (message.reasoningActive ?? !message.content.trim()) ? 'running' : 'complete';
  if (message.status === 'stopped') return 'stopped';
  if (message.status === 'error') return 'error';
  return 'complete';
}

const statusIcon: Record<ReasoningState, IconName> = { running: 'sparkle', complete: 'check', stopped: 'close', error: 'alert' };
const statusLabel: Record<ReasoningState, string> = { running: '思考中', complete: '已完成思考', stopped: '已停止思考', error: '思考中断' };

/** Seconds below a minute, then m:ss — a wait is read in seconds, not in minutes. */
function formatElapsed(seconds: number) {
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
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
  if (activity.kind === 'search') {
    return activity.status === 'error' ? '搜索失败' : activity.status === 'running' ? '正在搜索' : '已搜索';
  }
  return activity.status === 'error' ? '读取失败' : activity.status === 'running' ? '正在读取' : '已读取';
}

function SearchResults({ results }: { results: WebSearchResult[] }) {
  return <span className="web-activity-results">
    {results.slice(0, 5).map((result) => <a className="web-activity-result" key={`${result.rank}:${result.url}`}
      href={result.url} target="_blank" rel="noopener noreferrer">
      <span className="web-activity-result-title">{result.title}</span>
      <span className="web-activity-result-domain">{result.domain || hostname(result.url)}</span>
    </a>)}
  </span>;
}

function WebActivityRow({ activity }: { activity: WebActivity }) {
  const running = activity.status === 'running';
  const failed = activity.status === 'error';
  const Glyph = failed ? CircleAlert : activity.kind === 'search' ? Search : Globe2;
  const urls = activity.kind === 'fetch' ? activity.urls ?? (activity.url ? [activity.url] : []) : [];
  return <div className={`web-activity is-${activity.status}`}>
    <span className="web-activity-icon"><Glyph size={15} strokeWidth={1.8} aria-hidden="true" /></span>
    <span className="web-activity-copy">
      <span className="web-activity-kind">
        <span className={`web-activity-label ${running ? 'is-running' : ''}`}>{activityLabel(activity)}</span>
        {activity.tookMs !== undefined && !running
          ? <span className="web-activity-time">{formatTook(activity.tookMs)}</span>
          : null}
      </span>
      {activity.kind === 'search'
        ? <span className="web-activity-subject">{activity.query}</span>
        : activity.url
          ? <a className="web-activity-link" href={activity.url} target="_blank" rel="noopener noreferrer">
            {activity.title || hostname(activity.url)}
          </a>
          : null}
      {activity.kind === 'search' && activity.results?.length ? <SearchResults results={activity.results} /> : null}
      {activity.kind === 'fetch' && urls.length > 1
        ? <span className="web-activity-results">
          {urls.slice(1).map((url) => <a className="web-activity-result" key={url} href={url}
            target="_blank" rel="noopener noreferrer">
            <span className="web-activity-result-title">{hostname(url)}</span>
          </a>)}
        </span>
        : null}
      {failed && activity.error ? <span className="web-activity-error">{activity.error}</span> : null}
    </span>
  </div>;
}

function useElapsed(startedAt: number | null) {
  const [seconds, setSeconds] = useState(() => startedAt === null ? 0 : Math.floor((Date.now() - startedAt) / 1000));
  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return seconds;
}

type Props = {
  /** Reasoning text so far. Empty is the normal state before the model has emitted any. */
  reasoning?: string;
  state: ReasoningState;
  /** Measured thinking duration, carried by the message so it survives the run ending. */
  elapsedMs?: number | null;
  /** Epoch ms to count from when no duration is measured yet — the wait before the first output. */
  startedAt?: number | null;
  /** Wording for the running line: waiting on a model that was not asked to think is not "thinking". */
  runningLabel?: string;
  /** Web searches and page reads made for this reply, newest state per call. */
  activities?: WebActivity[];
  /** Controlled disclosure. A caller that renders the same reasoning across two positions
      (the wait line before the reply exists, then the reply itself) owns the state so
      expanding early stays expanded once the first token arrives. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * The status line above an answer, covering both the wait before any output and the
 * reasoning the model produced. Sending and thinking share one row so the reply area
 * never swaps components mid-flight: the line simply grows an expandable body.
 */
export function ReasoningBlock({ reasoning = '', state, elapsedMs = null, startedAt = null, runningLabel, activities, open: controlledOpen, onOpenChange }: Props) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const bodyId = useId();
  const running = state === 'running';
  // Whitespace-only reasoning is no reasoning: an empty disclosure would read as "已完成思考"
  // with nothing inside it, and the outer wait indicator keys off the same trim.
  const text = reasoning.trim();
  // A measured duration wins over counting: it stops when thinking stops, so the number does
  // not jump backwards as the reply settles. Only the pre-output wait has nothing to measure.
  const live = running && elapsedMs === null;
  const seconds = useElapsed(live ? startedAt : null);
  const elapsed = elapsedMs === null ? seconds : Math.floor(elapsedMs / 1000);
  const showElapsed = elapsedMs !== null || (live && startedAt !== null);
  function toggle() {
    const next = !open;
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }
  // While a tool is running, the line names the tool instead of the generic "thinking":
  // the user can tell a search from a page read without opening the disclosure.
  const currentActivity = running ? activities?.filter((activity) => activity.status === 'running').at(-1) : undefined;
  const activityRunningLabel = currentActivity?.kind === 'fetch' ? '正在查看网页'
    : currentActivity?.kind === 'search' ? '正在搜索资料' : undefined;
  const runningText = activityRunningLabel ?? runningLabel ?? statusLabel.running;
  const line = <>
    <Icon name={statusIcon[state]} size={17} className={running ? 'reasoning-icon is-running' : 'reasoning-icon'} />
    <span className={running ? 'reasoning-label is-running' : 'reasoning-label'}>{running ? runningText : statusLabel[state]}</span>
    {/* Hidden from assistive tech: the status line is a live region, so a once-a-second
        update would be re-announced once a second. The label carries the meaning. */}
    <span className="reasoning-meta">
      {showElapsed && <span className="reasoning-time" aria-hidden="true">{formatElapsed(elapsed)}</span>}
      <Icon name="chevron" size={15} className="reasoning-chevron" />
    </span>
  </>;
  // The row is a disclosure from the first moment, even before any reasoning has arrived:
  // expanding it then means the streamed thinking is visible as it is written instead of
  // being folded away until the user notices it and opens it afterwards.
  return <div className="reasoning">
    <span className="sr-only" role="status">{running ? runningText : statusLabel[state]}</span>
    <button type="button" className="reasoning-toggle" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>{line}</button>
    <div className="reasoning-body" id={bodyId} hidden={!open}>
      {activities?.length ? <div className="web-activities">
        {activities.map((activity) => <WebActivityRow activity={activity} key={activity.id} />)}
      </div> : null}
      {text ? <MessageContent content={text} streaming={running} />
        : running || !activities?.length ? <span className="reasoning-cursor" aria-hidden="true" /> : null}
    </div>
  </div>;
}
