import { useMemo, useRef, useState, type PointerEvent } from 'react';

import type { MapData, MapPlace } from './types';

function projectPlace(place: MapPlace, center: { lat: number; lng: number }): { x: number; y: number } {
  if (place.x !== undefined && place.y !== undefined) {
    return { x: place.x, y: place.y };
  }
  const dx = (place.lng - center.lng) * 900;
  const dy = (center.lat - place.lat) * 1100;
  return {
    x: Math.max(10, Math.min(90, 50 + dx)),
    y: Math.max(14, Math.min(82, 50 + dy)),
  };
}

function routeModeLabel(mode: 'walk' | 'drive' | 'transit'): string {
  switch (mode) {
    case 'walk':
      return '步行';
    case 'drive':
      return '驾车';
    case 'transit':
      return '公交';
  }
}

export type MapCardProps = {
  data?: MapData | null;
  loading?: boolean;
  onSelectPlace?: (place: MapPlace) => void;
};

export function MapCard({ data, loading = false, onSelectPlace }: MapCardProps) {
  const [selectedId, setSelectedId] = useState<string>(data?.places[0]?.id ?? '');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);

  const projectedPlaces = useMemo(
    () => (data ? data.places.map((place) => ({ place, pos: projectPlace(place, data.center) })) : []),
    [data],
  );

  if (loading || !data) {
    return (
      <section className="iui-card iui-map-card iui-skeleton-card" aria-busy={loading} aria-label="地图数据加载中">
        <div className="iui-skeleton-line w-45" />
        <div className="iui-skeleton-map" />
        <p className="iui-empty-hint">{loading ? '正在获取地图与地点数据...' : '等待地图数据填充'}</p>
      </section>
    );
  }

  const selected = data.places.find((p) => p.id === selectedId) ?? data.places[0] ?? null;

  const selectPlace = (place: MapPlace) => {
    setSelectedId(place.id);
    onSelectPlace?.(place);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button, a')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y,
      moved: false,
    };
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
    setPan({
      x: Math.max(-140, Math.min(140, drag.originX + dx)),
      y: Math.max(-100, Math.min(100, drag.originY + dy)),
    });
  };

  const handlePointerUp = () => {
    dragRef.current = null;
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const copyCoords = async (place: MapPlace) => {
    const text = `${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}`;
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      // Clipboard may be unavailable in restricted contexts; visual confirmation still helps.
    }
    setCopiedId(place.id);
    window.setTimeout(() => setCopiedId((prev) => (prev === place.id ? null : prev)), 1600);
  };

  const routePath = data.route?.points.length
    ? data.route.points.map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${pt.x * 4} ${pt.y * 2.4}`).join(' ')
    : null;

  return (
    <section className="iui-card iui-map-card" aria-label={`${data.title} 地图卡片`}>
      <header className="iui-map-header">
        <div className="iui-map-heading">
          <div className="iui-map-title-row">
            <strong>{data.title}</strong>
            {data.route && (
              <span className="iui-map-route-pill">
                {routeModeLabel(data.route.mode)} {data.route.durationText} · {data.route.distanceText}
              </span>
            )}
          </div>
          {data.subtitle && <span className="iui-map-subtitle">{data.subtitle}</span>}
        </div>
        <span className="iui-map-coords">
          {data.center.lat.toFixed(3)}°N, {data.center.lng.toFixed(3)}°E
        </span>
      </header>

      <div
        className="iui-map-viewport"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div
          className="iui-map-canvas"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >
          <svg
            className="iui-map-svg"
            viewBox="0 0 400 240"
            preserveAspectRatio="xMidYMid slice"
            aria-hidden="true"
          >
            {/* Parks & green zones */}
            <rect x="24" y="22" width="96" height="58" rx="12" className="iui-map-park" />
            <rect x="278" y="138" width="98" height="74" rx="14" className="iui-map-park" />
            {/* River / water feature */}
            <path
              d="M -10 185 Q 95 162 185 182 T 415 165"
              className="iui-map-water"
              fill="none"
            />
            {/* Secondary street grid */}
            <g className="iui-map-streets-minor">
              <path d="M 0 48 H 400 M 0 96 H 400 M 0 144 H 400 M 0 202 H 400" />
              <path d="M 65 0 V 240 M 135 0 V 240 M 215 0 V 240 M 295 0 V 240 M 355 0 V 240" />
            </g>
            {/* Primary avenues */}
            <g className="iui-map-streets-major">
              <path d="M 0 120 Q 190 112 400 128" />
              <path d="M 178 0 Q 186 120 172 240" />
            </g>
            {/* Subtle building blocks */}
            <g className="iui-map-blocks">
              <rect x="148" y="56" width="20" height="28" rx="3" />
              <rect x="192" y="62" width="16" height="22" rx="3" />
              <rect x="228" y="54" width="38" height="30" rx="4" />
              <rect x="78" y="102" width="34" height="14" rx="3" />
              <rect x="230" y="132" width="32" height="24" rx="4" />
            </g>
            {/* Optional route */}
            {routePath && (
              <>
                <path d={routePath} className="iui-map-route-casing" fill="none" />
                <path d={routePath} className="iui-map-route-line" fill="none" />
              </>
            )}
          </svg>

          {projectedPlaces.map(({ place, pos }, index) => {
            const active = selected?.id === place.id;
            return (
              <button
                key={place.id}
                type="button"
                className={`iui-map-pin${active ? ' is-active' : ''}`}
                style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
                onClick={() => selectPlace(place)}
                aria-label={`${index + 1}. ${place.name}`}
                aria-pressed={active}
              >
                <span className="iui-map-pin-badge">{index + 1}</span>
                <span className="iui-map-pin-label">{place.name}</span>
              </button>
            );
          })}
        </div>

        <div className="iui-map-controls" role="group" aria-label="地图缩放与复位">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(1.8, Number((z + 0.2).toFixed(2))))}
            aria-label="放大"
            title="放大"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.8, Number((z - 0.2).toFixed(2))))}
            aria-label="缩小"
            title="缩小"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M5 12h14" />
            </svg>
          </button>
          <button type="button" onClick={resetView} aria-label="重置视图" title="重置视图">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
            </svg>
          </button>
        </div>

        {selected && (
          <div className="iui-map-overlay-card" role="region" aria-label="选中地点详情">
            <div className="iui-map-overlay-main">
              <div className="iui-map-overlay-title">
                <strong>{selected.name}</strong>
                <span className="iui-map-category">{selected.category}</span>
                {selected.rating !== undefined && (
                  <span className="iui-map-rating">★ {selected.rating.toFixed(1)}</span>
                )}
              </div>
              <p className="iui-map-overlay-meta">
                {selected.address}
                {selected.distanceText ? ` · ${selected.distanceText}` : ''}
                {selected.openStatus ? ` · ${selected.openStatus}` : ''}
              </p>
            </div>
            <button
              type="button"
              className="iui-map-copy-btn"
              onClick={() => void copyCoords(selected)}
            >
              {copiedId === selected.id ? '已复制坐标' : '复制坐标'}
            </button>
          </div>
        )}
      </div>

      {data.places.length > 0 && (
        <div className="iui-map-place-list" role="list" aria-label="地点列表">
          {data.places.map((place, index) => {
            const active = selected?.id === place.id;
            return (
              <button
                key={place.id}
                type="button"
                role="listitem"
                className={`iui-map-place-item${active ? ' is-active' : ''}`}
                onClick={() => selectPlace(place)}
              >
                <span className="iui-map-place-index">{index + 1}</span>
                <span className="iui-map-place-info">
                  <strong>{place.name}</strong>
                  <span>
                    {place.category}
                    {place.distanceText ? ` · ${place.distanceText}` : ''}
                  </span>
                </span>
                {place.rating !== undefined && (
                  <span className="iui-map-place-rating">★ {place.rating.toFixed(1)}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
