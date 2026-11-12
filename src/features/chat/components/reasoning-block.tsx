import { Brain, Check, ChevronRight, ChevronUp, CircleAlert, FilePenLine, FilePlus2, FileText, Save, Square, Trash2 } from 'lucide-react';
import { memo, useEffect, useId, useRef, useState } from 'react';

import type { ProcessActivity, ThinkingActivity, WebActivity } from '@/core/agent/types';
import { fileContentUrl } from '@/features/files/files-api';
import type { Message } from '../chat-state';
import { formatFileSize } from './attachment-list';
import { MessageContent } from './message-content';
import { ResearchGroupRow, groupResearchSteps } from './research-group';

export type ReasoningState = 'running' | 'complete' | 'stopped' | 'error';

/** The footer control only earns its space once the expanded transcript is taller than this. */
const COLLAPSE_AFTER_HEIGHT = 420;

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

function formatTook(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

const FILE_OPERATION_NAMES: Record<string, string> = {
  list: '浏览文件',
  read: '读取文件',
  grep: '搜索文件',
  help: '查看文档帮助',
  inspect: '查看文档结构',
  create: '创建文档',
  edit: '编辑文档',
  save: '保存文件',
  delete: '删除文件',
};

function fileOperationName(operation: string | undefined): string {
  return FILE_OPERATION_NAMES[operation ?? ''] ?? '处理文件';
}

/** The row says what is happening; the filename sits beside it instead of in the label. */
function fileActivityLabel(activity: WebActivity): string {
  const name = fileOperationName(activity.operation);
  if (activity.status === 'running') return `正在${name}`;
  if (activity.status === 'error') return `${name}失败`;
  if (activity.status === 'stopped') return `${name}已停止`;
  return `已${name}`;
}

const FileActivityRow = memo(function FileActivityRow({ activity }: { activity: WebActivity }) {
  const running = activity.status === 'running';
  const failed = activity.status === 'error';
  const finished = !running;
  const [expansion, setExpansion] = useState<{ finished: boolean; open: boolean } | null>(null);
  const open = expansion?.finished === finished ? expansion.open : !finished;
  const bodyId = useId();
  const name = fileOperationName(activity.operation);
  const draft = !activity.savedFileId && activity.fileId?.startsWith('draft:') === true;
  const Glyph = failed ? CircleAlert
    : activity.operation === 'create' ? FilePlus2
      : activity.operation === 'edit' ? FilePenLine
        : activity.operation === 'save' ? Save
          : activity.operation === 'delete' ? Trash2 : FileText;
  return <div className={`web-activity file-activity is-${activity.status}`}>
    <button type="button" className="web-activity-toggle" aria-expanded={open} aria-controls={bodyId}
      onClick={() => setExpansion({ finished, open: !open })}>
      <Glyph size={15} strokeWidth={1.75} className="web-activity-icon" aria-hidden="true" />
      {activity.filename
        ? <span className="web-activity-label file-activity-name" title={activity.filename}>{activity.filename}</span>
        : <span className="web-activity-label">{name}</span>}
      <span className={`web-activity-state${failed ? ' is-error' : ''}`}>{fileActivityLabel(activity)}</span>
      {activity.tookMs !== undefined && !running
        ? <span className="web-activity-time">{formatTook(activity.tookMs)}</span>
        : null}
      <ChevronRight size={14} className="web-activity-chevron" aria-hidden="true" />
    </button>
    <div className="web-activity-details" id={bodyId} hidden={!open}>
      <span className="web-activity-subject">{name}{activity.filename ? ` · ${activity.filename}` : ''}</span>
      {activity.size !== undefined && <span className="web-activity-empty">{formatFileSize(activity.size)}</span>}
      {draft && <span className="web-activity-empty">草稿文件：保存后才会进入资料库。</span>}
      {activity.savedFileId && <a className="web-activity-result file-activity-download"
        href={fileContentUrl(activity.savedFileId)} download={activity.filename}>
        <Save size={15} strokeWidth={1.75} aria-hidden="true" />
        <span className="web-activity-result-copy">
          <span className="web-activity-result-title">下载已保存的文件</span>
          <span className="web-activity-result-domain">{activity.filename ?? activity.savedFileId}</span>
        </span>
      </a>}
      {activity.warning && <span className="web-activity-empty">{activity.warning}</span>}
      {activity.error && <span className={failed ? 'web-activity-error' : 'web-activity-empty'}>{activity.error}</span>}
    </div>
  </div>;
});

/** A snippet for the folded row: markdown syntax and newlines read as noise on one line. Bounded
    before cleaning, so re-rendering a folded transcript mid-stream stays cheap. */
function thinkingPreview(content: string): string {
  return content.slice(0, 240)
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One reasoning segment. It reads as a row like the tool calls around it: open only while it is
 * being written, folded as soon as the model stops writing it, so a long process stays a list
 * instead of a wall of text. `expanded` is that live default; the reader's own choice outranks it
 * until the segment starts or finishes streaming.
 *
 * The live segment renders as plain text on purpose: thought blocks of 10k+ characters arrive in
 * 50 ms batches, and re-parsing Markdown around an unclosed fence or table on every batch made the
 * tall block reflow — with the transcript pinned to the bottom, that reads as flickering. Markdown
 * is parsed once the segment stops streaming, when its text is final.
 */
const ThinkingRow = memo(function ThinkingRow({ activity, streaming, expanded }:
  { activity: ThinkingActivity; streaming: boolean; expanded: boolean }) {
  const failed = activity.status === 'error';
  const [expansion, setExpansion] = useState<{ key: string; open: boolean } | null>(null);
  const key = `${activity.status}:${expanded}`;
  const open = expansion?.key === key ? expansion.open : expanded;
  const bodyId = useId();
  // The folded row says what that thought was about; open, the text below already says it.
  const preview = open ? '' : thinkingPreview(activity.content);
  const Glyph = failed ? CircleAlert : Brain;
  return <div className={`thinking-step is-${activity.status}`}>
    <button type="button" className="thinking-toggle" aria-expanded={open} aria-controls={bodyId}
      onClick={() => setExpansion({ key, open: !open })}>
      <Glyph size={15} strokeWidth={1.75} className="thinking-icon" aria-hidden="true" />
      <span className="thinking-label">思考</span>
      {preview ? <span className="thinking-preview">{preview}</span> : null}
      <ChevronRight size={14} className="thinking-chevron" aria-hidden="true" />
    </button>
    <div className="thinking-body" id={bodyId} hidden={!open}>
      {open && (streaming
        ? <div className="thinking-text">{activity.content}</div>
        : <MessageContent content={activity.content} />)}
    </div>
  </div>;
});

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
  const header = useRef<HTMLButtonElement>(null);
  const running = state === 'running';
  const text = reasoning.trim();
  // Legacy replies have no event ordering; new replies render the ordered runtime segments.
  const steps: ProcessActivity[] = process?.length ? process : [
    ...(text ? [{ id: 'legacy-thinking', kind: 'thinking' as const, content: text, status: 'complete' as const }] : []),
    ...(activities ?? []),
  ];
  const visibleSteps = steps.filter((step) => step.kind !== 'thinking' || step.content.trim());
  // All search calls share one row and all page reads share one row; raw activities stay intact
  // in the message for storage and debugging.
  const renderSteps = groupResearchSteps(visibleSteps);
  const stepsRef = useRef<HTMLDivElement>(null);
  const [showCollapse, setShowCollapse] = useState(false);
  useEffect(() => {
    const element = stepsRef.current;
    if (!open || !element) { setShowCollapse(false); return; }
    const measure = () => setShowCollapse(element.scrollHeight > COLLAPSE_AFTER_HEIGHT);
    measure();
    // The transcript grows while the reply streams; keep the footer control in step with it.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, renderSteps.length]);
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
  // A long transcript leaves the header far above, so the footer control closes the block from
  // its end and returns focus to the header instead of dropping it on the page body.
  function collapse() {
    toggle();
    header.current?.focus({ preventScroll: true });
  }
  const label = '思考过程';
  const StatusIcon = state === 'stopped' ? Square : state === 'error' ? CircleAlert : running ? Brain : Check;
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
    <button ref={header} type="button" className="reasoning-toggle" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>{line}</button>
    <div className="reasoning-body" id={bodyId} hidden={!open}>
      {open && visibleSteps.length ? <>
        <div className="reasoning-steps" ref={stepsRef}>{renderSteps.map((entry) => <div
          key={entry.type === 'group' ? entry.group.id : entry.step.id}
          className={`reasoning-process-step${entry.type === 'step' && entry.step.kind === 'thinking' ? ' thinking-step' : ''}`}>
          {entry.type === 'group'
            ? <ResearchGroupRow group={entry.group} />
            : entry.step.kind === 'thinking'
              ? <ThinkingRow activity={entry.step} streaming={running && entry.step.status === 'running'}
                // Only the segment being written is open by default. When it ends and the next
                // tool or thought starts, this row folds back to its one-line preview; a manual
                // open/close on that segment still wins for as long as its status does not change.
                expanded={running && entry.step.status === 'running'} />
              : entry.step.kind === 'file' ? <FileActivityRow activity={entry.step} /> : null}
        </div>)}</div>
        {showCollapse && <button type="button" className="reasoning-collapse" onClick={collapse}>
          <ChevronUp size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>收起思考过程</span>
        </button>}
      </> : null}
    </div>
  </div>;
}
