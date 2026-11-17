import { useState } from 'react';

import type { WeatherCondition, WeatherData } from './types';

function toFahrenheit(celsius: number): number {
  return Math.round((celsius * 9) / 5 + 32);
}

function formatTemp(celsius: number, unit: 'C' | 'F'): string {
  const value = unit === 'C' ? Math.round(celsius) : toFahrenheit(celsius);
  return `${value}°`;
}

function WeatherGlyph({ condition, size = 28 }: { condition: WeatherCondition; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  };

  switch (condition) {
    case 'sunny':
      return (
        <svg {...common} className="iui-weather-glyph is-sunny">
          <circle cx="12" cy="12" r="4.2" fill="currentColor" fillOpacity="0.18" />
          <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" />
        </svg>
      );
    case 'partly-cloudy':
      return (
        <svg {...common} className="iui-weather-glyph is-partly-cloudy">
          <circle cx="9.5" cy="9" r="3.2" fill="currentColor" fillOpacity="0.18" />
          <path d="M9.5 3.5v1.3M4 9h1.3M5.6 5.1l.9.9M13.4 5.1l-.9.9" />
          <path d="M8.5 18.5h8.2a3.3 3.3 0 0 0 .3-6.6 4.7 4.7 0 0 0-9-1.1 3.8 3.8 0 0 0 .5 7.7Z" fill="var(--background)" />
        </svg>
      );
    case 'cloudy':
      return (
        <svg {...common} className="iui-weather-glyph is-cloudy">
          <path d="M7.5 18h9.2a3.6 3.6 0 0 0 .4-7.2 5.2 5.2 0 0 0-10-1.2A4.2 4.2 0 0 0 7.5 18Z" fill="currentColor" fillOpacity="0.12" />
        </svg>
      );
    case 'rain':
      return (
        <svg {...common} className="iui-weather-glyph is-rain">
          <path d="M7.2 14.5h9.5a3.3 3.3 0 0 0 .3-6.6 4.8 4.8 0 0 0-9.2-1.1 3.8 3.8 0 0 0-.6 7.7Z" fill="currentColor" fillOpacity="0.12" />
          <path d="M8.5 17.5l-1 3M12.5 17.5l-1 3M16.5 17.5l-1 3" />
        </svg>
      );
    case 'storm':
      return (
        <svg {...common} className="iui-weather-glyph is-storm">
          <path d="M7.2 14h9.5a3.3 3.3 0 0 0 .3-6.6 4.8 4.8 0 0 0-9.2-1.1A3.8 3.8 0 0 0 7.2 14Z" fill="currentColor" fillOpacity="0.14" />
          <path d="M13 14.5 10.5 18h3l-1.5 3.5" />
        </svg>
      );
    case 'snow':
      return (
        <svg {...common} className="iui-weather-glyph is-snow">
          <path d="M7.2 14h9.5a3.3 3.3 0 0 0 .3-6.6 4.8 4.8 0 0 0-9.2-1.1A3.8 3.8 0 0 0 7.2 14Z" fill="currentColor" fillOpacity="0.12" />
          <path d="M8.5 17.5h.01M12 18.8h.01M15.5 17.5h.01M10.2 20.5h.01M13.8 20.5h.01" strokeWidth="2.4" />
        </svg>
      );
    case 'fog':
      return (
        <svg {...common} className="iui-weather-glyph is-fog">
          <path d="M4 9h16M6 13h12M3 17h15M7 21h10" />
        </svg>
      );
  }
}

function conditionShortLabel(condition: WeatherCondition): string {
  switch (condition) {
    case 'sunny':
      return '晴';
    case 'partly-cloudy':
      return '多云';
    case 'cloudy':
      return '阴';
    case 'rain':
      return '雨';
    case 'storm':
      return '雷雨';
    case 'snow':
      return '雪';
    case 'fog':
      return '雾';
  }
}

export type WeatherCardProps = {
  data?: WeatherData | null;
  loading?: boolean;
  defaultUnit?: 'C' | 'F';
};

export function WeatherCard({ data, loading = false, defaultUnit = 'C' }: WeatherCardProps) {
  const [unit, setUnit] = useState<'C' | 'F'>(defaultUnit);
  const [forecastTab, setForecastTab] = useState<'hourly' | 'daily'>(
    data?.hourly?.length ? 'hourly' : 'daily',
  );

  if (loading || !data) {
    return (
      <section className="iui-card iui-weather-card iui-skeleton-card" aria-busy={loading} aria-label="天气数据加载中">
        <div className="iui-skeleton-line w-40" />
        <div className="iui-skeleton-line h-lg w-55" />
        <div className="iui-weather-metrics">
          <div className="iui-skeleton-box" />
          <div className="iui-skeleton-box" />
          <div className="iui-skeleton-box" />
        </div>
        <p className="iui-empty-hint">{loading ? '正在获取天气数据...' : '等待天气数据填充'}</p>
      </section>
    );
  }

  const visibleDaily = (data.daily ?? []).slice(0, 14);
  const dailyTitle = visibleDaily.length === 1 ? '今日预报' : `未来 ${visibleDaily.length} 天预报`;

  const minWeekTemp = visibleDaily.length ? Math.min(...visibleDaily.map((d) => d.lowC)) : data.lowC;
  const maxWeekTemp = visibleDaily.length ? Math.max(...visibleDaily.map((d) => d.highC)) : data.highC;
  const weekSpan = Math.max(1, maxWeekTemp - minWeekTemp);

  return (
    <section
      className={`iui-card iui-weather-card is-${data.condition}`}
      aria-label={`${data.location} 天气卡片`}
    >
      <header className="iui-weather-header">
        <div className="iui-weather-location">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 21s-6.5-5.8-6.5-11a6.5 6.5 0 1 1 13 0c0 5.2-6.5 11-6.5 11Z" />
            <circle cx="12" cy="10" r="2.2" />
          </svg>
          <strong>{data.location}</strong>
          {data.observedAt && <span className="iui-weather-observed">{data.observedAt}</span>}
        </div>
        <div className="iui-unit-toggle" role="group" aria-label="温度单位">
          <button
            type="button"
            aria-pressed={unit === 'C'}
            onClick={() => setUnit('C')}
          >
            °C
          </button>
          <button
            type="button"
            aria-pressed={unit === 'F'}
            onClick={() => setUnit('F')}
          >
            °F
          </button>
        </div>
      </header>

      <div className="iui-weather-hero">
        <div className="iui-weather-temp-group">
          <WeatherGlyph condition={data.condition} size={44} />
          <span className="iui-weather-temp">{formatTemp(data.temperatureC, unit)}</span>
        </div>
        <div className="iui-weather-summary">
          <span className="iui-weather-condition">{data.conditionLabel}</span>
          <span className="iui-weather-range">
            最高 {formatTemp(data.highC, unit)} · 最低 {formatTemp(data.lowC, unit)}
            {data.feelsLikeC !== undefined && ` · 体感 ${formatTemp(data.feelsLikeC, unit)}`}
          </span>
        </div>
      </div>

      {(data.humidity !== undefined || data.windSpeedKmh !== undefined || data.aqi) && (
        <div className="iui-weather-metrics">
          {data.humidity !== undefined && (
            <div className="iui-weather-metric">
              <span>湿度</span>
              <strong>{data.humidity}%</strong>
            </div>
          )}
          {data.windSpeedKmh !== undefined && (
            <div className="iui-weather-metric">
              <span>风力</span>
              <strong>
                {data.windDir ? `${data.windDir} ` : ''}
                {data.windSpeedKmh} km/h
              </strong>
            </div>
          )}
          {data.aqi && (
            <div className="iui-weather-metric">
              <span>空气质量</span>
              <strong>
                {data.aqi.value} {data.aqi.label}
              </strong>
            </div>
          )}
        </div>
      )}

      {(data.hourly?.length || visibleDaily.length > 0) && (
        <div className="iui-weather-forecast">
          <div className="iui-weather-forecast-bar">
            {data.hourly?.length && visibleDaily.length > 0 ? (
              <div className="iui-weather-tabs" role="tablist" aria-label="天气预报视图">
                <button
                  type="button"
                  role="tab"
                  aria-selected={forecastTab === 'hourly'}
                  onClick={() => setForecastTab('hourly')}
                >
                  逐小时
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={forecastTab === 'daily'}
                  onClick={() => setForecastTab('daily')}
                >
                  {dailyTitle}
                </button>
              </div>
            ) : visibleDaily.length > 0 ? (
              <span className="iui-weather-forecast-title">
                {dailyTitle}
              </span>
            ) : null}
          </div>

          {forecastTab === 'hourly' && data.hourly?.length ? (
            <div className="iui-hourly-strip" role="list">
              {data.hourly.map((point) => (
                <div key={point.time} className="iui-hourly-item" role="listitem">
                  <span className="iui-hourly-time">{point.time}</span>
                  <WeatherGlyph condition={point.condition} size={20} />
                  <strong className="iui-hourly-temp">{formatTemp(point.tempC, unit)}</strong>
                </div>
              ))}
            </div>
          ) : visibleDaily.length > 0 ? (
            <div className="iui-daily-list" role="list">
              {visibleDaily.map((day) => {
                const leftPct = ((day.lowC - minWeekTemp) / weekSpan) * 100;
                const widthPct = Math.max(12, ((day.highC - day.lowC) / weekSpan) * 100);
                return (
                  <div key={day.day} className="iui-daily-row" role="listitem">
                    <span className="iui-daily-day">{day.day}</span>
                    <span className="iui-daily-cond">
                      <WeatherGlyph condition={day.condition} size={18} />
                      <span>{conditionShortLabel(day.condition)}</span>
                    </span>
                    <div className="iui-daily-temps">
                      <span className="iui-daily-low">{formatTemp(day.lowC, unit)}</span>
                      <div className="iui-daily-bar-track" aria-hidden="true">
                        <div
                          className="iui-daily-bar-fill"
                          style={{ left: `${leftPct}%`, width: `${Math.min(100 - leftPct, widthPct)}%` }}
                        />
                      </div>
                      <strong className="iui-daily-high">{formatTemp(day.highC, unit)}</strong>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
