import { Check, ChevronDown, Cloud, GitBranch, Layers } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

const NAVIGATION_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End'];

export function GitBranchSelect({
  value,
  localBranches,
  remoteBranches = [],
  allOptionLabel,
  placeholder = '选择分支',
  ariaLabel,
  className = '',
  disabled = false,
  onChange,
}: {
  value: string | null;
  localBranches: readonly string[];
  remoteBranches?: readonly string[];
  allOptionLabel?: string;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  onChange: (branch: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const showSearch = localBranches.length + remoteBranches.length > 6;

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      if (!(event.target instanceof Node)) return;
      if (rootRef.current?.contains(event.target)) return;
      setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const filteredLocal = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? localBranches.filter((b) => b.toLowerCase().includes(q)) : localBranches;
  }, [localBranches, query]);

  const filteredRemote = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? remoteBranches.filter((b) => b.toLowerCase().includes(q)) : remoteBranches;
  }, [query, remoteBranches]);

  function selectBranch(next: string | null) {
    setOpen(false);
    setQuery('');
    triggerRef.current?.focus({ preventScroll: true });
    if (next !== value) onChange(next);
  }

  function moveFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!NAVIGATION_KEYS.includes(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-branch-option]'),
    );
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (index + 1 + items.length) % items.length
          : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  const displayLabel = value ?? allOptionLabel ?? placeholder;

  return (
    <div ref={rootRef} className={`work-git-branch-select ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        className="work-git-branch-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={displayLabel}
        disabled={disabled}
        onClick={() => {
          setQuery('');
          setOpen((previous) => !previous);
        }}
        onKeyDown={(event) => {
          if (open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
          event.preventDefault();
          setQuery('');
          setOpen(true);
        }}
      >
        <GitBranch size={13} strokeWidth={1.75} className="work-git-branch-trigger-icon" aria-hidden="true" />
        <span className="work-git-branch-name">{displayLabel}</span>
        <ChevronDown size={13} strokeWidth={1.75} className="work-git-branch-chevron" aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="work-git-branch-popover"
          role="listbox"
          aria-label={ariaLabel}
          onKeyDown={moveFocus}
        >
          {showSearch && (
            <div className="work-git-branch-search">
              <input
                type="search"
                aria-label="搜索分支"
                placeholder="筛选分支…"
                value={query}
                autoFocus
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          )}

          <div className="work-git-branch-options">
            {allOptionLabel && (!query.trim() || allOptionLabel.toLowerCase().includes(query.trim().toLowerCase())) && (
              <button
                type="button"
                role="option"
                data-branch-option
                aria-selected={value === null}
                className={`work-git-branch-option${value === null ? ' is-current' : ''}`}
                onClick={() => selectBranch(null)}
              >
                <Layers size={13} strokeWidth={1.75} aria-hidden="true" />
                <span>{allOptionLabel}</span>
                {value === null && <Check size={13} strokeWidth={2} aria-hidden="true" />}
              </button>
            )}

            {filteredLocal.length > 0 && (
              <div className="work-git-branch-group">
                <span className="work-git-branch-group-title">本地分支</span>
                {filteredLocal.map((branch) => {
                  const isCurrent = branch === value;
                  return (
                    <button
                      key={`local:${branch}`}
                      type="button"
                      role="option"
                      data-branch-option
                      aria-selected={isCurrent}
                      className={`work-git-branch-option${isCurrent ? ' is-current' : ''}`}
                      onClick={() => selectBranch(branch)}
                    >
                      <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" />
                      <span>{branch}</span>
                      {isCurrent && <Check size={13} strokeWidth={2} aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
            )}

            {filteredRemote.length > 0 && (
              <div className="work-git-branch-group">
                <span className="work-git-branch-group-title">远程分支</span>
                {filteredRemote.map((branch) => {
                  const isCurrent = branch === value;
                  return (
                    <button
                      key={`remote:${branch}`}
                      type="button"
                      role="option"
                      data-branch-option
                      aria-selected={isCurrent}
                      className={`work-git-branch-option${isCurrent ? ' is-current' : ''}`}
                      onClick={() => selectBranch(branch)}
                    >
                      <Cloud size={13} strokeWidth={1.75} aria-hidden="true" />
                      <span>{branch}</span>
                      {isCurrent && <Check size={13} strokeWidth={2} aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
            )}

            {!allOptionLabel && !filteredLocal.length && !filteredRemote.length && (
              <p className="work-git-branch-empty">没有匹配的分支</p>
            )}
            {allOptionLabel && query.trim() && !filteredLocal.length && !filteredRemote.length
              && !allOptionLabel.toLowerCase().includes(query.trim().toLowerCase()) && (
              <p className="work-git-branch-empty">没有匹配的分支</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
