import { AlertCircle } from 'lucide-react';

import { Dialog } from '@/components/web/dialog';

/** Compact alert modal shared by work project and directory browser dialogs. */
export function WorkErrorDialog({
  title,
  message,
  className = '',
  onClose,
}: {
  title: string;
  message: string;
  className?: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      className={`compact-dialog work-browser-error-dialog${className ? ` ${className}` : ''}`}
    >
      <div className="work-browser-error-row" role="alert">
        <AlertCircle size={18} strokeWidth={1.75} aria-hidden="true" />
        <p className="dialog-description">{message}</p>
      </div>
      <div className="dialog-footer">
        <button type="button" className="primary-button" data-autofocus onClick={onClose}>
          知道了
        </button>
      </div>
    </Dialog>
  );
}
