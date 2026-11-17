import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type CSSProperties,
} from 'react';
import { Calendar, ChevronDown, ChevronLeft, ChevronRight, Clock } from 'lucide-react';

import { Dialog } from '@/components/web/dialog';
import type { ScheduledTask, ScheduledTaskKind } from './tasks-api';

type RepeatKey = 'once' | 'hourly' | 'daily' | 'weekly' | 'n-minutes' | 'n-hours' | 'n-days' | 'n-weeks';

type RepeatOption = {
  key: RepeatKey;
  label: string;
  minutes?: number;
  unit?: '分钟' | '小时' | '天' | '周';
  multiplier?: number;
  max?: number;
  defaultValue?: number;
};

const REPEAT_OPTIONS: readonly RepeatOption[] = [
  { key: 'once', label: '仅一次' },
  { key: 'hourly', label: '每小时', minutes: 60 },
  { key: 'daily', label: '每天', minutes: 1440 },
  { key: 'weekly', label: '每周', minutes: 10_080 },
  { key: 'n-minutes', label: '每 N 分钟', unit: '分钟', multiplier: 1, max: 525_600, defaultValue: 30 },
  { key: 'n-hours', label: '每 N 小时', unit: '小时', multiplier: 60, max: 8_760, defaultValue: 2 },
  { key: 'n-days', label: '每 N 天', unit: '天', multiplier: 1440, max: 365, defaultValue: 2 },
  { key: 'n-weeks', label: '每 N 周', unit: '周', multiplier: 10_080, max: 52, defaultValue: 2 },
];

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] as const;
const HOURS = Array.from({ length: 24 }, (_, index) => index);
const MINUTES_SECONDS = Array.from({ length: 60 }, (_, index) => index);

type TimezoneOption = {
  id: string;
  offsetMinutes: number;
  label: string;
};

function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, '0');
  const mins = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${mins}`;
}

function getSystemTimezoneOption(): TimezoneOption {
  const offsetMinutes = -new Date().getTimezoneOffset();
  const tzId = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local';
  const isChina = tzId === 'Asia/Shanghai' || tzId === 'Asia/Chongqing' || tzId === 'Asia/Harbin' || offsetMinutes === 480;
  const displayName = isChina ? '中国标准时间' : tzId;
  return {
    id: 'system',
    offsetMinutes,
    label: `${formatUtcOffset(offsetMinutes)} · ${displayName}（系统）`,
  };
}

function buildTimezoneOptions(systemOption: TimezoneOption): TimezoneOption[] {
  const presets: TimezoneOption[] = [
    systemOption,
    { id: 'utc+8', offsetMinutes: 480, label: 'UTC+08:00 · 中国标准时间' },
    { id: 'utc+0', offsetMinutes: 0, label: 'UTC+00:00 · 协调世界时' },
    { id: 'utc+9', offsetMinutes: 540, label: 'UTC+09:00 · 日本标准时间' },
    { id: 'utc-5', offsetMinutes: -300, label: 'UTC-05:00 · 美国东部时间' },
    { id: 'utc-8', offsetMinutes: -480, label: 'UTC-08:00 · 美国太平洋时间' },
  ];
  const seen = new Set<string>();
  return presets.filter((item) => {
    if (item.id !== 'system' && item.offsetMinutes === systemOption.offsetMinutes) return false;
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function toRepeatState(
  kind: ScheduledTaskKind,
  intervalMinutes: number | null,
): { repeatKey: RepeatKey; intervalValue: number } {
  if (kind === 'once') return { repeatKey: 'once', intervalValue: 30 };
  const mins = intervalMinutes ?? 30;
  if (mins === 60) return { repeatKey: 'hourly', intervalValue: 1 };
  if (mins === 1440) return { repeatKey: 'daily', intervalValue: 1 };
  if (mins === 10_080) return { repeatKey: 'weekly', intervalValue: 1 };
  if (mins > 10_080 && mins % 10_080 === 0) return { repeatKey: 'n-weeks', intervalValue: mins / 10_080 };
  if (mins > 1440 && mins % 1440 === 0) return { repeatKey: 'n-days', intervalValue: mins / 1440 };
  if (mins > 60 && mins % 60 === 0) return { repeatKey: 'n-hours', intervalValue: mins / 60 };
  return { repeatKey: 'n-minutes', intervalValue: mins };
}

function extractWallClock(ms: number, offsetMinutes: number) {
  const shifted = new Date(ms + offsetMinutes * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

function toEpochMs(
  date: { year: number; month: number; day: number },
  time: { hour: number; minute: number; second: number },
  offsetMinutes: number,
): number {
  return Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute, time.second) - offsetMinutes * 60_000;
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function getMondayFirstOffset(year: number, month: number): number {
  const jsDay = new Date(year, month - 1, 1).getDay();
  return (jsDay + 6) % 7;
}

type PopoverKind = 'repeat' | 'date' | 'time' | 'timezone' | null;

type PopoverPosition = {
  top?: number;
  bottom?: number;
  right: number;
};

function computePopoverPosition(anchor: HTMLElement | null, estimatedHeight: number): PopoverPosition {
  if (!anchor) return { top: 120, right: 24 };
  const rect = anchor.getBoundingClientRect();
  const right = Math.max(12, window.innerWidth - rect.right);
  const spaceBelow = window.innerHeight - rect.bottom - 12;
  if (spaceBelow >= estimatedHeight || spaceBelow >= rect.top - 12) {
    return { top: rect.bottom + 8, right };
  }
  return { bottom: window.innerHeight - rect.top + 8, right };
}

export type TaskModalSubmitPayload = {
  title?: string;
  prompt: string;
  kind: ScheduledTaskKind;
  intervalMinutes: number | null;
  runAtMs: number | null;
};

type TaskModalProps = {
  mode: 'create' | 'edit';
  initialTask?: ScheduledTask | null;
  initialTitle?: string;
  initialPrompt?: string;
  onClose: () => void;
  onSubmit: (payload: TaskModalSubmitPayload) => Promise<void>;
};

export function TaskModal({
  mode,
  initialTask,
  initialTitle = '',
  initialPrompt = '',
  onClose,
  onSubmit,
}: TaskModalProps) {
  const systemTimezone = useMemo(() => getSystemTimezoneOption(), []);
  const timezoneOptions = useMemo(() => buildTimezoneOptions(systemTimezone), [systemTimezone]);

  const defaultRunAtMs = useMemo(() => {
    if (initialTask?.runAtMs) return initialTask.runAtMs;
    const base = Date.now() + 10 * 60_000;
    return Math.ceil(base / 60_000) * 60_000;
  }, [initialTask?.runAtMs]);

  const initialWall = useMemo(
    () => extractWallClock(defaultRunAtMs, systemTimezone.offsetMinutes),
    [defaultRunAtMs, systemTimezone.offsetMinutes],
  );

  const initialRepeat = useMemo(
    () => (initialTask ? toRepeatState(initialTask.kind, initialTask.intervalMinutes) : { repeatKey: 'once' as RepeatKey, intervalValue: 30 }),
    [initialTask],
  );

  const [title, setTitle] = useState(() => initialTask?.title ?? initialTitle);
  const [prompt, setPrompt] = useState(() => initialTask?.prompt ?? initialPrompt);
  const [repeatKey, setRepeatKey] = useState<RepeatKey>(initialRepeat.repeatKey);
  const [intervalValue, setIntervalValue] = useState<number>(initialRepeat.intervalValue);
  const [selectedDate, setSelectedDate] = useState(() => ({
    year: initialWall.year,
    month: initialWall.month,
    day: initialWall.day,
  }));
  const [viewMonth, setViewMonth] = useState(() => ({
    year: initialWall.year,
    month: initialWall.month,
  }));
  const [selectedTime, setSelectedTime] = useState(() => ({
    hour: initialWall.hour,
    minute: initialWall.minute,
    second: initialWall.second,
  }));
  const [timezoneId, setTimezoneId] = useState<string>(systemTimezone.id);

  const [openPopover, setOpenPopover] = useState<PopoverKind>(null);
  const [popoverPos, setPopoverPos] = useState<PopoverPosition>({ top: 0, right: 24 });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const repeatTriggerRef = useRef<HTMLButtonElement>(null);
  const dateTriggerRef = useRef<HTMLButtonElement>(null);
  const timeTriggerRef = useRef<HTMLButtonElement>(null);
  const timezoneTriggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const hourColRef = useRef<HTMLDivElement>(null);
  const minuteColRef = useRef<HTMLDivElement>(null);
  const secondColRef = useRef<HTMLDivElement>(null);

  const currentTimezone = useMemo(
    () => timezoneOptions.find((item) => item.id === timezoneId) ?? systemTimezone,
    [timezoneId, timezoneOptions, systemTimezone],
  );

  const selectedRepeat = useMemo(
    () => REPEAT_OPTIONS.find((item) => item.key === repeatKey) ?? REPEAT_OPTIONS[0],
    [repeatKey],
  );
  const repeatLabel = selectedRepeat.label;

  const todayWall = useMemo(
    () => extractWallClock(Date.now(), currentTimezone.offsetMinutes),
    [currentTimezone.offsetMinutes],
  );

  const togglePopover = useCallback((kind: Exclude<PopoverKind, null>, anchor: HTMLElement | null, height: number) => {
    setOpenPopover((current) => {
      if (current === kind) return null;
      setPopoverPos(computePopoverPosition(anchor, height));
      if (kind === 'date') {
        setViewMonth({ year: selectedDate.year, month: selectedDate.month });
      }
      return kind;
    });
  }, [selectedDate.month, selectedDate.year]);

  useLayoutEffect(() => {
    const element = promptRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(220, Math.max(100, element.scrollHeight))}px`;
  }, [prompt]);

  useEffect(() => {
    const element = promptRef.current;
    if (!element) return;
    let width = element.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = element.getBoundingClientRect().width;
      if (nextWidth === width) return;
      width = nextWidth;
      element.style.height = 'auto';
      element.style.height = `${Math.min(220, Math.max(100, element.scrollHeight))}px`;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!openPopover) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (
        repeatTriggerRef.current?.contains(target)
        || dateTriggerRef.current?.contains(target)
        || timeTriggerRef.current?.contains(target)
        || timezoneTriggerRef.current?.contains(target)
      ) {
        return;
      }
      setOpenPopover(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpenPopover(null);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [openPopover]);

  useEffect(() => {
    if (openPopover !== 'time') return;
    const scrollColumn = (col: HTMLDivElement | null, index: number) => {
      if (!col) return;
      const item = col.children[index] as HTMLElement | undefined;
      if (!item) return;
      col.scrollTop = Math.max(0, item.offsetTop - col.clientHeight / 2 + item.clientHeight / 2);
    };
    requestAnimationFrame(() => {
      scrollColumn(hourColRef.current, selectedTime.hour);
      scrollColumn(minuteColRef.current, selectedTime.minute);
      scrollColumn(secondColRef.current, selectedTime.second);
    });
  }, [openPopover, selectedTime.hour, selectedTime.minute, selectedTime.second]);

  function stepMonth(delta: number) {
    setViewMonth((current) => {
      const next = new Date(current.year, current.month - 1 + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() + 1 };
    });
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setFormError('请输入自动化任务内容。');
      return;
    }

    const isOnce = repeatKey === 'once';
    const kind: ScheduledTaskKind = isOnce ? 'once' : 'recurring';
    let finalInterval: number | null = null;
    let finalRunAtMs: number | null = null;

    if (isOnce) {
      finalRunAtMs = toEpochMs(selectedDate, selectedTime, currentTimezone.offsetMinutes);
      if (!Number.isFinite(finalRunAtMs) || finalRunAtMs <= 0) {
        setFormError('请选择有效的运行日期与时间。');
        return;
      }
    } else {
      if (selectedRepeat.minutes) {
        finalInterval = selectedRepeat.minutes;
      } else if (selectedRepeat.multiplier && selectedRepeat.max && selectedRepeat.unit) {
        if (!Number.isInteger(intervalValue) || intervalValue < 1 || intervalValue > selectedRepeat.max) {
          setFormError(`间隔${selectedRepeat.unit}数需为 1 至 ${selectedRepeat.max} 之间的整数。`);
          return;
        }
        finalInterval = intervalValue * selectedRepeat.multiplier;
      }
    }

    setSaving(true);
    setFormError(null);
    try {
      await onSubmit({
        title: title.trim() || undefined,
        prompt: trimmedPrompt,
        kind,
        intervalMinutes: finalInterval,
        runAtMs: finalRunAtMs,
      });
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : '保存定时任务失败。');
    } finally {
      setSaving(false);
    }
  }

  const daysInMonth = getDaysInMonth(viewMonth.year, viewMonth.month);
  const leadingBlanks = getMondayFirstOffset(viewMonth.year, viewMonth.month);

  const popoverStyle: CSSProperties = {
    position: 'fixed',
    right: popoverPos.right,
    ...(popoverPos.top !== undefined ? { top: popoverPos.top } : {}),
    ...(popoverPos.bottom !== undefined ? { bottom: popoverPos.bottom } : {}),
  };

  return (
    <Dialog
      title={mode === 'create' ? '新建定时任务' : '编辑定时任务'}
      onClose={onClose}
      className="task-dialog"
    >
      <form className="task-form" onSubmit={(event) => { void handleSubmit(event); }}>
        <div className="task-form-field">
          <label className="task-modal-label" htmlFor="task-title">自动化任务名称</label>
          <input
            id="task-title"
            className="text-field task-modal-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：每日阅读摘要"
            maxLength={200}
          />
        </div>

        <div className="task-form-field">
          <label className="task-modal-label" htmlFor="task-prompt">自动化任务内容</label>
          <div className="text-field task-modal-textarea-frame">
            <textarea
              ref={promptRef}
              id="task-prompt"
              className="task-modal-textarea"
              rows={4}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={'说明任务内容和预期结果\n例如：汇总阅读清单中的新文章，并附原文链接'}
              required
            />
          </div>
        </div>

        <div className="task-form-field">
          <span className="task-modal-label">运行时间</span>
          <div className="task-runtime-card">
            <div className="task-runtime-row">
              <span className="task-runtime-key">重复</span>
              <button
                ref={repeatTriggerRef}
                type="button"
                className="task-repeat-pill"
                aria-haspopup="listbox"
                aria-expanded={openPopover === 'repeat'}
                onClick={() => togglePopover('repeat', repeatTriggerRef.current, 320)}
              >
                <span>{repeatLabel}</span>
                <ChevronDown size={14} aria-hidden="true" />
              </button>
            </div>

            {repeatKey === 'once' && (
              <>
                <div className="task-runtime-row">
                  <span className="task-runtime-key">日期</span>
                  <button
                    ref={dateTriggerRef}
                    type="button"
                    className="task-runtime-trigger"
                    aria-haspopup="dialog"
                    aria-expanded={openPopover === 'date'}
                    onClick={() => togglePopover('date', dateTriggerRef.current, 290)}
                  >
                    <span>{`${selectedDate.year}/${pad2(selectedDate.month)}/${pad2(selectedDate.day)}`}</span>
                    <Calendar size={15} aria-hidden="true" />
                  </button>
                </div>

                <div className="task-runtime-row">
                  <span className="task-runtime-key">时间</span>
                  <button
                    ref={timeTriggerRef}
                    type="button"
                    className="task-runtime-trigger"
                    aria-haspopup="dialog"
                    aria-expanded={openPopover === 'time'}
                    onClick={() => togglePopover('time', timeTriggerRef.current, 236)}
                  >
                    <span>{`${pad2(selectedTime.hour)}:${pad2(selectedTime.minute)}:${pad2(selectedTime.second)}`}</span>
                    <Clock size={15} aria-hidden="true" />
                  </button>
                </div>
              </>
            )}

            {selectedRepeat.unit && selectedRepeat.max && (
              <div className="task-runtime-row">
                <label className="task-runtime-key" htmlFor="task-interval-value">间隔</label>
                <div className="task-runtime-interval">
                  <span>每</span>
                  <input
                    id="task-interval-value"
                    type="number"
                    min={1}
                    max={selectedRepeat.max}
                    className="text-field task-interval-input"
                    value={intervalValue}
                    onChange={(event) => setIntervalValue(Number(event.target.value))}
                  />
                  <span>{selectedRepeat.unit}</span>
                </div>
              </div>
            )}

            <div className="task-runtime-row">
              <span className="task-runtime-key">时区</span>
              <button
                ref={timezoneTriggerRef}
                type="button"
                className="task-runtime-trigger"
                aria-haspopup="listbox"
                aria-expanded={openPopover === 'timezone'}
                onClick={() => togglePopover('timezone', timezoneTriggerRef.current, 220)}
              >
                <span>{currentTimezone.label}</span>
                <ChevronDown size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        {formError && <p className="settings-message is-error" role="alert">{formError}</p>}

        <div className="dialog-footer">
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary-button" disabled={saving}>
            {saving
              ? (mode === 'create' ? '创建中…' : '保存中…')
              : (mode === 'create' ? '创建任务' : '保存修改')}
          </button>
        </div>

        {openPopover === 'repeat' && (
          <div ref={popoverRef} className="task-popover task-popover-menu" style={popoverStyle} role="listbox" aria-label="选择重复频率">
            {REPEAT_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                role="option"
                aria-selected={repeatKey === option.key}
                className={`task-popover-option${repeatKey === option.key ? ' is-selected' : ''}`}
                onClick={() => {
                  const prevKey = repeatKey;
                  setRepeatKey(option.key);
                  if (option.unit && option.max && prevKey !== option.key) {
                    const hadUnit = Boolean(selectedRepeat.unit);
                    setIntervalValue(
                      hadUnit
                        ? Math.min(option.max, Math.max(1, intervalValue))
                        : (option.defaultValue ?? 2),
                    );
                  }
                  setOpenPopover(null);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}

        {openPopover === 'date' && (
          <div ref={popoverRef} className="task-popover task-calendar-popover" style={popoverStyle} role="dialog" aria-label="选择日期">
            <div className="task-calendar-header">
              <button type="button" className="task-calendar-nav" aria-label="上个月" onClick={() => stepMonth(-1)}>
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
              <span className="task-calendar-title">{`${viewMonth.year}年${viewMonth.month}月`}</span>
              <button type="button" className="task-calendar-nav" aria-label="下个月" onClick={() => stepMonth(1)}>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="task-calendar-weekdays" aria-hidden="true">
              {WEEKDAYS.map((day) => <span key={day}>{day}</span>)}
            </div>
            <div className="task-calendar-grid">
              {Array.from({ length: leadingBlanks }, (_, index) => (
                <span key={`blank-${index}`} className="task-calendar-blank" aria-hidden="true" />
              ))}
              {Array.from({ length: daysInMonth }, (_, index) => {
                const day = index + 1;
                const isToday = viewMonth.year === todayWall.year
                  && viewMonth.month === todayWall.month
                  && day === todayWall.day;
                const isSelected = viewMonth.year === selectedDate.year
                  && viewMonth.month === selectedDate.month
                  && day === selectedDate.day;
                return (
                  <button
                    key={day}
                    type="button"
                    className={`task-calendar-day${isToday ? ' is-today' : ''}${isSelected ? ' is-selected' : ''}`}
                    aria-pressed={isSelected}
                    onClick={() => {
                      setSelectedDate({ year: viewMonth.year, month: viewMonth.month, day });
                      setOpenPopover(null);
                    }}
                  >
                    {day}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {openPopover === 'time' && (
          <div ref={popoverRef} className="task-popover task-time-popover" style={popoverStyle} role="dialog" aria-label="选择时间">
            <div ref={hourColRef} className="task-time-column" aria-label="小时">
              {HOURS.map((hour) => (
                <button
                  key={hour}
                  type="button"
                  className={`task-time-cell${selectedTime.hour === hour ? ' is-selected' : ''}`}
                  onClick={() => setSelectedTime((current) => ({ ...current, hour }))}
                >
                  {pad2(hour)}
                </button>
              ))}
            </div>
            <div ref={minuteColRef} className="task-time-column" aria-label="分钟">
              {MINUTES_SECONDS.map((minute) => (
                <button
                  key={minute}
                  type="button"
                  className={`task-time-cell${selectedTime.minute === minute ? ' is-selected' : ''}`}
                  onClick={() => setSelectedTime((current) => ({ ...current, minute }))}
                >
                  {pad2(minute)}
                </button>
              ))}
            </div>
            <div ref={secondColRef} className="task-time-column" aria-label="秒">
              {MINUTES_SECONDS.map((second) => (
                <button
                  key={second}
                  type="button"
                  className={`task-time-cell${selectedTime.second === second ? ' is-selected' : ''}`}
                  onClick={() => setSelectedTime((current) => ({ ...current, second }))}
                >
                  {pad2(second)}
                </button>
              ))}
            </div>
          </div>
        )}

        {openPopover === 'timezone' && (
          <div ref={popoverRef} className="task-popover task-popover-menu" style={popoverStyle} role="listbox" aria-label="选择时区">
            {timezoneOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={timezoneId === option.id}
                className={`task-popover-option${timezoneId === option.id ? ' is-selected' : ''}`}
                onClick={() => {
                  setTimezoneId(option.id);
                  setOpenPopover(null);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </form>
    </Dialog>
  );
}
