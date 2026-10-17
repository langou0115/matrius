import { useEffect, useId, useRef, type PropsWithChildren } from 'react';

import { Icon } from './icon';

type Props = PropsWithChildren<{ title: string; onClose: () => void; className?: string }>;

export function Dialog({ title, onClose, className = '', children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLInputElement>('input, textarea')?.focus();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={`dialog ${className}`}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="dialog-panel">
        <header className="dialog-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-button" aria-label="关闭弹窗" onClick={onClose}><Icon name="close" /></button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
