import { ArrowDown, ArrowUp } from 'lucide-react';

import type { ContextUsage } from '../context-usage';

/** Compact enough for the toolbar; the title keeps the exact counts. */
function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, '')}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/u, '')}k`;
  return String(value);
}

export function ContextMeter({ usage }: { usage: ContextUsage }) {
  const label = `上下文约 ${usage.total.toLocaleString('zh-CN')} / ${usage.window.toLocaleString('zh-CN')} tokens（估算）`
    + ` · 输入 ${usage.input.toLocaleString('zh-CN')} · 输出 ${usage.output.toLocaleString('zh-CN')}`
    + ' · 按消息长度估算';
  return <div className={`composer-usage${usage.total > usage.limit ? ' is-over' : ''}`}
    role="img" aria-label={label} title={label}>
    <svg className="composer-usage-ring" viewBox="0 0 20 20" aria-hidden="true">
      <circle className="composer-usage-track" cx="10" cy="10" r="7.5" />
      <circle className="composer-usage-progress" cx="10" cy="10" r="7.5"
        pathLength={100} strokeDasharray={`${usage.percent} ${100 - usage.percent}`}
        transform="rotate(-90 10 10)" />
    </svg>
    <span className="composer-usage-percent">{usage.percent}%</span>
    <span className="composer-usage-tokens" aria-hidden="true">
      <span className="composer-usage-token"><ArrowUp size={11} strokeWidth={2.1} />{compactTokens(usage.input)}</span>
      <span className="composer-usage-token"><ArrowDown size={11} strokeWidth={2.1} />{compactTokens(usage.output)}</span>
    </span>
  </div>;
}
