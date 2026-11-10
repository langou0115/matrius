import { useEffect, useRef, type CSSProperties } from 'react';
import { ArrowLeft } from 'lucide-react';

import type { ThinkingEffort } from '@agent/core/thinking-effort';

const options: { value: ThinkingEffort; label: string }[] = [
  { value: 'default', label: 'off' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
];

export function EffortPicker({ value, onChange, disabled, onBack }: {
  value: ThinkingEffort;
  onChange: (value: ThinkingEffort) => void;
  disabled: boolean;
  onBack: () => void;
}) {
  const slider = useRef<HTMLInputElement>(null);
  const index = Math.max(0, options.findIndex((option) => option.value === value));

  useEffect(() => {
    slider.current?.focus({ preventScroll: true });
  }, []);

  return <div className="model-effort" onKeyDown={(event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onBack();
  }}>
    <header className="model-effort-header">
      <button type="button" className="icon-button" aria-label="返回模型列表" onClick={onBack}><ArrowLeft size={17} aria-hidden="true" /></button>
      <output className="model-effort-current">{options[index].label}</output>
    </header>
    <div className="model-effort-slider">
      <div className="composer-effort-range" style={{ '--effort-progress': `${index / 3 * 100}%` } as CSSProperties}>
        <input ref={slider} type="range" min={0} max={3} step={1} value={index}
          aria-label="思考强度" aria-valuetext={options[index].label} disabled={disabled}
          onChange={(event) => onChange(options[Number(event.target.value)].value)} />
        <span className="composer-effort-ticks" aria-hidden="true">{options.map((option, tick) => <i key={option.value} style={{ visibility: tick === index ? 'hidden' : undefined }} />)}</span>
      </div>
    </div>
  </div>;
}
