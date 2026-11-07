import { RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import { getTokenUsage, backfillTokenUsage, USAGE_WINDOW_DAYS, type ApiRequest, type TokenUsageReport } from './usage-api';
import {
  buildHeatmap, buildWeekly, formatCompactTokens, formatDateLabel,
  formatTokenCount, summarizeUsage, type Heatmap,
  type UsageView, type WeeklyTotal,
} from './usage-stats';

const views: { id: UsageView; label: string }[] = [
  { id: 'day', label: '每日' },
  { id: 'week', label: '每周' },
];

// One column per Monday-first week in the trailing window; the grid stretches to the content
// width so the chart never needs a horizontal scrollbar on desktop. Narrow viewports keep a
// readable minimum.
const HEATMAP_MIN_WIDTH = 640;


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
          <span key={`${column}-${label}`} style={{ gridColumn: `${column + 1} / span ${Math.min(4, heatmap.columns.length - column)}` }}>{label}</span>
        ))}
      </div>
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
  const heatmap = useMemo(() => report ? buildHeatmap(report.items, now, USAGE_WINDOW_DAYS) : null, [report, now]);
  const weekly = useMemo(() => report ? buildWeekly(report.items, now) : null, [report, now]);
  const lifetime = report?.lifetime;
  const hasUsage = Boolean(lifetime && lifetime.total > 0);
  // Prompt-side tokens include cached prompt tokens, which pi-ai reports outside `input`.
  const promptTokens = lifetime ? lifetime.input + lifetime.cacheRead + lifetime.cacheWrite : 0;
  const promptRatio = lifetime && lifetime.total > 0 ? Math.round((promptTokens / lifetime.total) * 100) : 0;

  return <section className="settings-section" aria-label="用量统计">

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
    {enabled && report && hasUsage && lifetime && summary && heatmap && weekly && <>
      <dl className="usage-stats">
        <div className="usage-stat"><dt>今日</dt><dd title={formatTokenCount(summary.today)}>{formatCompactTokens(summary.today)}</dd></div>
        <div className="usage-stat"><dt>近 7 天</dt><dd title={formatTokenCount(summary.last7)}>{formatCompactTokens(summary.last7)}</dd></div>
        <div className="usage-stat"><dt>近 30 天</dt><dd title={formatTokenCount(summary.last30)}>{formatCompactTokens(summary.last30)}</dd></div>
      </dl>
      <div className="usage-breakdown">
        <div className="usage-split" role="img" aria-label={`输入占 ${promptRatio}%，输出占 ${100 - promptRatio}%`}>
          <span className="usage-split-prompt" style={{ width: `${promptRatio}%` }} />
          <span className="usage-split-output" style={{ width: `${100 - promptRatio}%` }} />
        </div>
        <dl className="usage-split-copy">
          <div><dt><i className="usage-dot is-prompt" />输入<span>含缓存</span></dt><dd>{formatTokenCount(promptTokens)}<span>{promptRatio}%</span></dd></div>
          <div><dt><i className="usage-dot is-output" />输出</dt><dd>{formatTokenCount(lifetime.output)}<span>{100 - promptRatio}%</span></dd></div>
        </dl>
      </div>

      <div className="usage-chart-section">
        <div className="usage-chart-head">
          <div><h3>用量趋势</h3><p>{view === 'week' ? '最近 12 周' : '最近 12 个月'} · {heatmap.activeDays} 个活跃日（近一年）</p></div>
          <div className="usage-tabs" role="group" aria-label="切换用量视图">
            {views.map(({ id, label }) => <button key={id} type="button"
              className={view === id ? 'is-active' : ''} aria-pressed={view === id}
              onClick={() => setView(id)}>{label}</button>)}
          </div>
        </div>
        {view === 'day' && <DayHeatmap heatmap={heatmap} />}
        {view === 'week' && <WeeklyChart weeks={weekly} />}

      </div>
    </>}
  </section>;
}
