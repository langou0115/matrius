import { RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import { getTokenUsage, backfillTokenUsage, USAGE_WINDOW_DAYS, type ApiRequest, type TokenUsageReport } from './usage-api';
import {
  buildCumulative, buildHeatmap, buildWeekly, formatCompactTokens, formatDateLabel,
  formatMonthYear, formatTokenCount, summarizeUsage, type CumulativePoint, type Heatmap,
  type UsageView, type WeeklyTotal,
} from './usage-stats';

const views: { id: UsageView; label: string }[] = [
  { id: 'day', label: '每天' },
  { id: 'week', label: '每周' },
  { id: 'total', label: '累计总量' },
];

// 53 Monday-first week columns; the grid stretches to the content width so the chart never
// needs a horizontal scrollbar on desktop. Narrow viewports keep a readable minimum.
const HEATMAP_MIN_WIDTH = 640;

const CHART_WIDTH = 720;
const CHART_HEIGHT = 150;

function columnStyle(columns: number): CSSProperties {
  return {
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    minWidth: HEATMAP_MIN_WIDTH,
  };
}

function DayHeatmap({ heatmap }: { heatmap: Heatmap }) {
  return <div className="usage-heatmap">
    <div className="usage-heatmap-scroll">
      <div className="usage-grid" style={columnStyle(heatmap.columns.length)}
        role="img" aria-label={`最近 12 个月 Token 活动，${heatmap.activeDays} 天有使用记录`}>
        {heatmap.columns.flatMap((column) => column.cells.map((cell, row) => cell
          ? <span key={`${column.key}-${row}`} className={`usage-cell level-${cell.level}`}
            title={`${formatDateLabel(cell.date)} · ${formatTokenCount(cell.value)} tokens${cell.estimated ? ' · 含估算' : ''}`} />
          : <span key={`${column.key}-${row}`} className="usage-cell is-empty" />))}
      </div>
      <div className="usage-months" style={columnStyle(heatmap.columns.length)} aria-hidden="true">
        {heatmap.monthLabels.map(({ column, label }) => (
          <span key={`${column}-${label}`} style={{ gridColumn: column + 1 }}>{label}</span>
        ))}
      </div>
    </div>
    <div className="usage-legend" aria-hidden="true">
      <span>少</span>
      {[0, 1, 2, 3, 4].map((level) => <span key={level} className={`usage-cell level-${level}`} />)}
      <span>多</span>
    </div>
  </div>;
}

function WeeklyChart({ weeks }: { weeks: WeeklyTotal[] }) {
  const max = Math.max(0, ...weeks.map((week) => week.total));
  return <div className="usage-bars" role="img" aria-label="最近 12 周每周 Token 用量">
    {weeks.map((week, index) => <div className="usage-bar" key={week.key}>
      <div className="usage-bar-track" title={`${formatDateLabel(week.key)} 起的一周 · ${formatTokenCount(week.total)} tokens`}>
        <span className={`usage-bar-fill ${index === weeks.length - 1 ? 'is-current' : ''}`}
          style={{ height: max > 0 ? `${Math.max(week.total > 0 ? 3 : 0, (week.total / max) * 100)}%` : '0%' }} />
      </div>
      <span className="usage-bar-label">{week.label}</span>
    </div>)}
  </div>;
}

function CumulativeChart({ points }: { points: CumulativePoint[] }) {
  const first = points[0];
  const last = points[points.length - 1];
  const max = last?.total ?? 0;
  const x = (index: number) => (index / Math.max(1, points.length - 1)) * CHART_WIDTH;
  const y = (value: number) => max > 0 ? CHART_HEIGHT - 4 - (value / max) * (CHART_HEIGHT - 18) : CHART_HEIGHT - 4;
  const line = points.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)} ${y(point.total).toFixed(1)}`).join(' ');
  const area = `${line} L${CHART_WIDTH} ${CHART_HEIGHT} L0 ${CHART_HEIGHT} Z`;
  return <div className="usage-area">
    <svg className="usage-area-chart" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      preserveAspectRatio="none" role="img"
      aria-label={`累计 Token 用量，${formatDateLabel(first?.date ?? '')} 至 ${formatDateLabel(last?.date ?? '')}`}>
      <defs>
        <linearGradient id="usage-cumulative-fill" x1="0" y1="0" x2="0" y2="1">
          <stop className="usage-area-stop-top" offset="0%" />
          <stop className="usage-area-stop-bottom" offset="100%" />
        </linearGradient>
      </defs>
      <path className="usage-area-fill" d={area} />
      <path className="usage-area-line" d={line} />
    </svg>
    <div className="usage-axis">
      <span>{formatMonthYear(first?.date ?? '')}</span>
      <span>{formatMonthYear(last?.date ?? '')}</span>
    </div>
  </div>;
}

/** The activity panel on the standalone Usage settings page. */
export function TokenUsageSection({ request, enabled }: { request: ApiRequest; enabled: boolean }) {
  const [report, setReport] = useState<TokenUsageReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [view, setView] = useState<UsageView>('day');
  // Frozen with each load so the "today" bucket and the charts agree.
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        let value = await getTokenUsage(request, USAGE_WINDOW_DAYS, controller.signal);
        if (controller.signal.aborted) return;
        if (!value.backfilled) {
          // Conversations from before usage recording have no real counters; estimate them
          // once on the server and reload the merged view.
          setBackfilling(true);
          try {
            await backfillTokenUsage(request, new Date().getTimezoneOffset());
            if (controller.signal.aborted) return;
            value = await getTokenUsage(request, USAGE_WINDOW_DAYS, controller.signal);
          } catch {
            // Keep the reported usage; the next visit retries the one-time estimate.
          } finally {
            if (!controller.signal.aborted) setBackfilling(false);
          }
        }
        if (controller.signal.aborted) return;
        setReport(value);
        setFailed(false);
        setNow(new Date());
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    };
    void load();
    return () => controller.abort();
  }, [enabled, request, reloadKey]);

  const summary = useMemo(() => report ? summarizeUsage(report.items, now) : null, [report, now]);
  const heatmap = useMemo(() => report ? buildHeatmap(report.items, now) : null, [report, now]);
  const weekly = useMemo(() => report ? buildWeekly(report.items, now) : null, [report, now]);
  const cumulative = useMemo(() => report ? buildCumulative(report.items, now) : null, [report, now]);
  const lifetime = report?.lifetime;
  const hasUsage = Boolean(lifetime && lifetime.total > 0);
  const estimatedTotal = report?.estimated.total ?? 0;
  // Prompt-side tokens include cached prompt tokens, which pi-ai reports outside `input`.
  const promptTokens = lifetime ? lifetime.input + lifetime.cacheRead + lifetime.cacheWrite : 0;
  const promptRatio = lifetime && lifetime.total > 0 ? Math.round((promptTokens / lifetime.total) * 100) : 0;

  return <section className="settings-section" aria-labelledby="usage-heading">
    <div className="usage-section-head">
      <div>
        <h2 id="usage-heading">Token 活动</h2>
        <p className="usage-section-caption">{hasUsage && lifetime && heatmap
          ? `累计 ${formatCompactTokens(lifetime.total)} tokens${estimatedTotal > 0 ? '（含历史估算）' : ''} · ${heatmap.activeDays} 天有使用记录`
          : '统计每次回复消耗的模型 token，按本机时间每天累计。'}</p>
      </div>
      {hasUsage && <div className="usage-tabs" role="group" aria-label="切换用量视图">
        {views.map(({ id, label }) => <button key={id} type="button"
          className={view === id ? 'is-active' : ''} aria-pressed={view === id}
          onClick={() => setView(id)}>{label}</button>)}
      </div>}
    </div>

    {!enabled && <p className="settings-footnote">登录后可查看账号的 Token 用量。</p>}
    {enabled && !report && !failed && <p className="settings-footnote" role="status">
      {backfilling ? '正在估算历史用量…' : '正在获取用量…'}
    </p>}
    {enabled && failed && <div className="storage-retry" role="alert">
      <span>暂时无法获取用量。</span>
      <button type="button" className="secondary-button" onClick={() => setReloadKey((value) => value + 1)}>
        <RefreshCw size={15} strokeWidth={1.75} aria-hidden="true" />重试
      </button>
    </div>}
    {enabled && report && !hasUsage && <div className="usage-empty">
      <strong>还没有 Token 记录</strong>
      <p>发送一条对话后，这里会按天显示模型的输入与输出 token；已有的历史对话会在首次打开时按消息长度估算。</p>
    </div>}
    {enabled && report && hasUsage && lifetime && summary && heatmap && weekly && cumulative && <>
      <dl className="usage-stats">
        <div className="usage-stat is-total"><dt>累计用量</dt><dd>{formatTokenCount(lifetime.total)}</dd></div>
        <div className="usage-stat"><dt>今日</dt><dd>{formatTokenCount(summary.today)}</dd></div>
        <div className="usage-stat"><dt>近 7 天</dt><dd>{formatTokenCount(summary.last7)}</dd></div>
        <div className="usage-stat"><dt>近 30 天</dt><dd>{formatTokenCount(summary.last30)}</dd></div>
      </dl>
      <div className="usage-split" role="img" aria-label={`输入占 ${promptRatio}%，输出占 ${100 - promptRatio}%`}>
        <span className="usage-split-prompt" style={{ width: `${promptRatio}%` }} />
        <span className="usage-split-output" style={{ width: `${100 - promptRatio}%` }} />
      </div>
      <p className="usage-split-copy">
        输入 {formatCompactTokens(promptTokens)} · 输出 {formatCompactTokens(lifetime.output)} · 共 {formatTokenCount(lifetime.requests)} 次回复
        {estimatedTotal > 0 ? ` · 历史估算 ${formatCompactTokens(estimatedTotal)}` : ''}
      </p>

      {view === 'day' && <DayHeatmap heatmap={heatmap} />}
      {view === 'week' && <WeeklyChart weeks={weekly} />}
      {view === 'total' && <CumulativeChart points={cumulative.points} />}

      <p className="usage-note">
        {estimatedTotal > 0 && '历史对话按消息长度估算。'}
        {view === 'day' ? '最近 12 个月每天的使用量，颜色越深表示当天消耗越多。'
          : view === 'week' ? '最近 12 周每周的使用量。'
            : '最近 12 个月的累计使用量。'}
      </p>
    </>}
  </section>;
}
