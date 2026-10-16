import { useEffect, useId, useState } from 'react';

import { Icon, type IconName } from '@/components/web/icon';
import { MessageContent } from './message-content.web';

export type ReasoningState = 'running' | 'complete' | 'stopped' | 'error';

const statusIcon: Record<ReasoningState, IconName> = { running: 'sparkle', complete: 'check', stopped: 'close', error: 'alert' };
const statusLabel: Record<ReasoningState, string> = { running: '思考中', complete: '已完成思考', stopped: '已停止思考', error: '思考中断' };

/** Seconds below a minute, then m:ss — a wait is read in seconds, not in minutes. */
function formatElapsed(seconds: number) {
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
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
};

/**
 * The status line above an answer, covering both the wait before any output and the
 * reasoning the model produced. Sending and thinking share one row so the reply area
 * never swaps components mid-flight: the line simply grows an expandable body.
 */
export function ReasoningBlock({ reasoning = '', state, elapsedMs = null, startedAt = null, runningLabel }: Props) {
  const [open, setOpen] = useState(false);
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
  const line = <>
    <Icon name={statusIcon[state]} size={15} className={running ? 'reasoning-icon is-running' : 'reasoning-icon'} />
    <span className={running ? 'reasoning-label is-running' : 'reasoning-label'}>{running ? runningLabel ?? statusLabel.running : statusLabel[state]}</span>
    {/* Hidden from assistive tech: the status line is a live region, so a once-a-second
        update would be re-announced once a second. The label carries the meaning. */}
    {showElapsed && <span className="reasoning-time" aria-hidden="true">{formatElapsed(elapsed)}</span>}
    {text && <Icon name="chevron" size={15} className="reasoning-chevron" />}
  </>;
  // Nothing to reveal yet, so the line is plain text rather than an empty disclosure.
  if (!text) return <div className="reasoning"><p className="reasoning-line" role="status">{line}</p></div>;
  return <div className="reasoning">
    <button type="button" className="reasoning-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((value) => !value)}>{line}</button>
    <div className="reasoning-body" id={bodyId} hidden={!open}><MessageContent content={text} /></div>
  </div>;
}
