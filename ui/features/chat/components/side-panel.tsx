import { useEffect, useId, useRef, type ReactNode } from 'react';

import { Dialog } from '@/components/web/dialog';
import { Icon } from '@/components/web/icon';

type Props = {
  title: string;
  mode: 'side' | 'sheet';
  onClose: () => void;
  children: ReactNode;
};

/**
 * The shared shell for a source column beside the conversation and a bottom sheet on a narrow
 * viewport. Esc closes the non-modal column even when focus moved back to the transcript, and focus
 * enters the column on open so the reader's next Tab stays inside what they just opened.
 */
export function SidePanel({ title, mode, onClose, children }: Props) {
  const headingId = useId();
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (mode !== 'side') return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, onClose]);

  useEffect(() => {
    if (mode === 'side') panel.current?.focus({ preventScroll: true });
  }, [mode]);

  if (mode === 'sheet') {
    return <Dialog title={title} className="research-sheet" onClose={onClose}>
      <div className="research-panel-body">{children}</div>
    </Dialog>;
  }

  return <aside ref={panel} tabIndex={-1} className="research-panel" aria-labelledby={headingId}>
    <header className="research-panel-header">
      <h2 id={headingId}>{title}</h2>
      <button type="button" className="icon-button" aria-label="关闭面板" onClick={onClose}><Icon name="close" size={18} /></button>
    </header>
    <div className="research-panel-body">{children}</div>
  </aside>;
}
