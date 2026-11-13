import { useEffect, useId, useRef, type PropsWithChildren } from 'react';

import { Icon } from './icon';

type Props = PropsWithChildren<{
  title: string;
  onClose: () => void;
  className?: string;
  /** Keep the accessible name but let the panel draw its own header. */
  hideHeader?: boolean;
}>;

export function Dialog({ title, onClose, className = '', hideHeader = false, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
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
      // Close only when the press both starts and ends on the backdrop. A click event
      // fires on the common ancestor of pointer-down and pointer-up, so selecting text
      // in a field and releasing outside would otherwise close the dialog mid-selection.
      onPointerDown={(event) => { backdropPress.current = event.target === event.currentTarget; }}
      onPointerUp={(event) => {
        const closes = backdropPress.current && event.target === event.currentTarget;
        backdropPress.current = false;
        if (closes) onClose();
      }}
      onPointerCancel={() => { backdropPress.current = false; }}>
      <div className="dialog-panel">
        {hideHeader
          ? <h2 id={titleId} className="sr-only">{title}</h2>
          : <header className="dialog-header">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="icon-button" aria-label="关闭弹窗" onClick={onClose}><Icon name="close" /></button>
          </header>}
        {children}
      </div>
    </dialog>
  );
}
