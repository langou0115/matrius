import type { UsageDay } from './usage-api';

/** The three granularities of the activity panel, in tab order. */
export type UsageView = 'day' | 'week';
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export type HeatCell = { date: string; value: number; level: HeatLevel; estimated: boolean };
/** `cells[0]` is Monday; a null slot is outside the trailing window or still in the future. */
export type HeatColumn = { key: string; cells: (HeatCell | null)[] };
export type Heatmap = {
  columns: HeatColumn[];
  monthLabels: { column: number; label: string }[];
  activeDays: number;
};
export type UsageSummary = { today: number; last7: number; last30: number };
export type WeeklyTotal = { key: string; label: string; total: number };
export type CumulativePoint = { date: string; total: number };

export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseDateKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Normalises to local midnight so month/day arithmetic ignores time and DST offsets. */
export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

/** Monday-first weeks, matching the Chinese weekday labels the heatmap shows. */
export function startOfWeek(date: Date): Date {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return addDays(copy, -((copy.getDay() + 6) % 7));
}

function usageByDate(items: UsageDay[]): Map<string, UsageDay> {
  const map = new Map<string, UsageDay>();
  for (const item of items) map.set(item.date, item);
  return map;
}

/** Four filled steps, relative to the busiest cell. Zero stays visually empty. */
export function heatLevel(value: number, max: number): HeatLevel {
  if (value <= 0) return 0;
  if (max <= 0) return 1;
  const ratio = value / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

/** A GitHub-style grid covering the `days`-day window ending on `end`, one column per week.
    The grid is anchored to the Monday of the window's first week, so both edges stay partial
    instead of painting days outside the window as zero usage; a week that only partly overlaps
    the window adds a 54th column rather than dropping the window's first day. */
export function buildHeatmap(items: UsageDay[], end: Date, days = 366): Heatmap {
  const byDate = usageByDate(items);
  const lastDay = localDateKey(end);
  const firstDay = addDays(end, -(days - 1));
  const firstDayKey = localDateKey(firstDay);
  const firstWeek = startOfWeek(firstDay);
  const lastWeek = startOfWeek(end);
  let weeks = 1;
  for (let cursor = addDays(firstWeek, 7); cursor <= lastWeek; cursor = addDays(cursor, 7)) weeks += 1;
  const columns: HeatColumn[] = [];
  const monthLabels: { column: number; label: string }[] = [];
  let max = 0;
  let activeDays = 0;

  for (let week = 0; week < weeks; week++) {
    const start = addDays(firstWeek, week * 7);
    const cells: (HeatCell | null)[] = [];
    for (let offset = 0; offset < 7; offset++) {
      const date = addDays(start, offset);
      const key = localDateKey(date);
      // ISO date keys sort chronologically: the same comparison hides the days that predate
      // the window and the rest of the current week.
      if (key < firstDayKey || key > lastDay) { cells.push(null); continue; }
      const item = byDate.get(key);
      const value = item?.total ?? 0;
      if (value > 0) activeDays += 1;
      if (value > max) max = value;
      cells.push({ date: key, value, level: 0, estimated: Boolean(item?.estimated) });
    }
    columns.push({ key: localDateKey(start), cells });

    // Label the column that contains the first of a month, like the reference graph.
    const first = cells.find((cell) => cell && cell.date.endsWith('-01'));
    if (first) {
      const date = parseDateKey(first.date);
      if (date) monthLabels.push({ column: week, label: `${date.getMonth() + 1}月` });
    }
  }

  if (max > 0) {
    for (const column of columns) {
      for (const cell of column.cells) {
        if (cell) cell.level = heatLevel(cell.value, max);
      }
    }
  }
  return { columns, monthLabels, activeDays };
}

/** Today, the last seven local days and the last thirty, ending at `end` (inclusive). */
export function summarizeUsage(items: UsageDay[], end: Date): UsageSummary {
  const byDate = usageByDate(items);
  const sum = (days: number) => {
    let total = 0;
    for (let offset = days - 1; offset >= 0; offset--) {
      total += byDate.get(localDateKey(addDays(end, -offset)))?.total ?? 0;
    }
    return total;
  };
  return { today: byDate.get(localDateKey(end))?.total ?? 0, last7: sum(7), last30: sum(30) };
}

/** Weekly buckets ending with the current (possibly partial) week. */
export function buildWeekly(items: UsageDay[], end: Date, weeks = 12): WeeklyTotal[] {
  const byDate = usageByDate(items);
  const currentWeek = startOfWeek(end);
  const lastDay = localDateKey(end);
  return Array.from({ length: weeks }, (_, index) => {
    const start = addDays(currentWeek, -(weeks - 1 - index) * 7);
    let total = 0;
    for (let offset = 0; offset < 7; offset++) {
      const key = localDateKey(addDays(start, offset));
      if (key > lastDay) break;
      total += byDate.get(key)?.total ?? 0;
    }
    return {
      key: localDateKey(start),
      label: index === weeks - 1 ? '本周' : `${start.getMonth() + 1}/${start.getDate()}`,
      total,
    };
  });
}

/** Running total for each of the last `days` local days, ending at `end` (inclusive). */
export function buildCumulative(items: UsageDay[], end: Date, days = 365): { points: CumulativePoint[]; max: number } {
  const byDate = usageByDate(items);
  const points: CumulativePoint[] = [];
  let running = 0;
  for (let offset = days - 1; offset >= 0; offset--) {
    const key = localDateKey(addDays(end, -offset));
    running += byDate.get(key)?.total ?? 0;
    points.push({ date: key, total: running });
  }
  return { points, max: running };
}

export function formatTokenCount(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString('zh-CN');
}

/** Compact form for captions: 12,345 → 1.2万; 123,456,789 → 1.2亿. */
export function formatCompactTokens(value: number): string {
  const count = Math.max(0, value);
  if (count >= 100_000_000) return `${(count / 100_000_000).toFixed(1).replace(/\.0$/u, '')}亿`;
  if (count >= 10_000) return `${(count / 10_000).toFixed(1).replace(/\.0$/u, '')}万`;
  return formatTokenCount(count);
}

/** "11月6日" for tooltips. */
export function formatDateLabel(key: string): string {
  const date = parseDateKey(key);
  return date ? `${date.getMonth() + 1}月${date.getDate()}日` : key;
}

/** "2026年11月" for a year-long axis, where a bare month repeats. */
export function formatMonthYear(key: string): string {
  const date = parseDateKey(key);
  return date ? `${date.getFullYear()}年${date.getMonth() + 1}月` : key;
}
