import { useEffect, useId, useRef, useState } from 'react';

import type { ContextUsage } from '../context-usage';

const PARTS = [
  { key: 'uncachedInput', label: '未缓存输入', tone: 'context-uncached' },
  { key: 'cachedInput', label: '缓存输入', tone: 'context-cached' },
  { key: 'output', label: '输出', tone: 'context-output' },
] as const;

export function ContextMeter({ usage }: { usage: ContextUsage }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const format = (value: number) => {
    if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
    if (value >= 1000) return `${Number((value / 1000).toFixed(1))}k`;
    return `${Math.round(value)}`;
  };
  const over = usage.total > usage.limit;
  const scale = Math.max(usage.window, usage.total);

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return <div className="context-meter" ref={root}>
    <button ref={trigger} type="button" className={`composer-usage${over ? ' is-over' : ''}`}
      aria-expanded={open} aria-controls={open ? id : undefined}
      aria-label={`上下文已用 ${usage.percent}%，查看用量详情`}
      onClick={() => setOpen((value) => !value)}>
      <svg className="composer-usage-ring" viewBox="0 0 20 20" aria-hidden="true">
        <circle className="composer-usage-track" cx="10" cy="10" r="7.5" />
        <circle className="composer-usage-progress" cx="10" cy="10" r="7.5"
          pathLength={100} strokeDasharray={`${usage.percent} ${100 - usage.percent}`}
          transform="rotate(-90 10 10)" />
      </svg>
      <span>上下文</span><span className="composer-usage-percent">{usage.percent}%</span>
    </button>
    {open && <section id={id} className={`context-details${over ? ' is-over' : ''}`} aria-label="上下文用量详情">
      <header><strong>上下文窗口</strong><span className="context-percent">{usage.percent}%</span></header>
      <div className="context-composition" role="img" aria-label={`上下文占用 ${usage.percent}%`}>
        {PARTS.map((part) => <span key={part.key} className={part.tone}
          style={{ width: `${Math.min(100, usage[part.key] / scale * 100)}%` }} />)}
      </div>
      <div className="context-capacity">{format(usage.total)} / {format(usage.window)} tokens</div>
      <div className="context-legend">
        {PARTS.map((part) => <span key={part.key}>
          <i className={part.tone} aria-hidden="true" />{part.label} <b>{format(usage[part.key])}</b>
        </span>)}
      </div>
    </section>}
  </div>;
}
