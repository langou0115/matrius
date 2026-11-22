import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

import { Icon } from './icon';

export type SelectFieldOption = {
  id: string;
  label: string;
  /** Optional leading mark, for example a model brand icon. */
  icon?: ReactNode;
};

type SelectFieldProps = {
  label: string;
  value: string;
  options: readonly SelectFieldOption[];
  onChange: (id: string) => void;
  disabled?: boolean;
  hideLabel?: boolean;
  /** Render the popover with fixed viewport coords so scrollable dialogs never clip it. */
  fixedPopover?: boolean;
};

const NAVIGATION_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End'];

/**
 * A dropdown that stays inside the theme. A native <select> hands its popup and
 * its arrow to the OS, so it cannot follow the palette, the type or the corner
 * radius the rest of the form uses; this rebuilds it: a text-field-shaped
 * trigger, and a list of plain option names.
 */
export function SelectField({
  disabled = false,
  fixedPopover = false,
  hideLabel = false,
  label,
  onChange,
  options,
  value,
}: SelectFieldProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const valueId = useId();
  const current = options.find((option) => option.id === value) ?? options[0];

  useLayoutEffect(() => {
    if (!open || !fixedPopover) return;
    function updatePosition() {
      const triggerEl = trigger.current;
      const popEl = popover.current;
      if (!triggerEl || !popEl || typeof triggerEl.getBoundingClientRect !== 'function') return;
      const rect = triggerEl.getBoundingClientRect();
      if (rect.width <= 0) return;
      const viewportH = window.innerHeight || 768;
      const spaceBelow = viewportH - rect.bottom - 12;
      const spaceAbove = rect.top - 12;
      const maxH = Math.min(320, Math.floor(viewportH * 0.5));
      const popH = Math.min(popEl.scrollHeight || maxH, maxH);
      const openUpward = spaceBelow < popH && spaceAbove > spaceBelow;
      popEl.style.position = 'fixed';
      popEl.style.zIndex = '20';
      popEl.style.left = `${rect.left}px`;
      popEl.style.width = `${rect.width}px`;
      popEl.style.right = 'auto';
      popEl.style.maxHeight = `${Math.max(120, Math.min(maxH, openUpward ? spaceAbove : spaceBelow))}px`;
      if (openUpward) {
        popEl.style.top = 'auto';
        popEl.style.bottom = `${viewportH - rect.top + 6}px`;
      } else {
        popEl.style.bottom = 'auto';
        popEl.style.top = `${rect.bottom + 6}px`;
      }
    }
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [fixedPopover, open, options.length]);

  useEffect(() => {
    if (!open) return;
    const element = popover.current;
    if (!element) return;
    // Land on the current value, so arrow keys start from where the reader is. The list
    // scrolls once it grows past its max height, so bring that option into view.
    const selected = element.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    selected?.focus({ preventScroll: true });
    selected?.scrollIntoView({ block: 'nearest' });

    function dismissOnOutsidePointer(event: PointerEvent) {
      if (!(event.target instanceof Node)) return;
      if (trigger.current?.contains(event.target) || popover.current?.contains(event.target)) return;
      setOpen(false);
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      // Also keeps the surrounding native <dialog> from treating this Esc as its own.
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    }
    document.addEventListener('pointerdown', dismissOnOutsidePointer);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissOnOutsidePointer);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [open]);

  function choose(id: string) {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
    if (id !== value) onChange(id);
  }

  function moveSelection(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!NAVIGATION_KEYS.includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-select-option]'));
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (index + 1 + items.length) % items.length
          : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  return <div className="select-field">
    <span id={labelId} className={hideLabel ? 'sr-only' : undefined}>{label}</span>
    <button
      ref={trigger}
      type="button"
      className="select-field-trigger"
      disabled={disabled}
      aria-expanded={open}
      aria-labelledby={`${labelId} ${valueId}`}
      onClick={() => setOpen((previous) => !previous)}
      onKeyDown={(event) => {
        if (open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
        event.preventDefault();
        setOpen(true);
      }}
    >
      {current?.icon && <span className="select-field-icon" aria-hidden="true">{current.icon}</span>}
      <span id={valueId} className="select-field-value">{current?.label ?? ''}</span>
      <Icon name="chevron" size={16} className="select-field-chevron" />
    </button>
    {open && <div ref={popover} className="select-field-popover" role="group" aria-label={label} onKeyDown={moveSelection}>
      {options.map((option) => <button
        key={option.id}
        type="button"
        data-select-option
        className="select-field-option"
        aria-pressed={option.id === value}
        onClick={() => choose(option.id)}
      >
        {option.icon && <span className="select-field-icon" aria-hidden="true">{option.icon}</span>}
        <span className="select-field-option-label">{option.label}</span>
        {option.id === value && <Icon name="check" size={15} />}
      </button>)}
    </div>}
  </div>;
}
