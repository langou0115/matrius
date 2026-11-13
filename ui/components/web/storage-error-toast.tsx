import { useEffect, useState } from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';

/**
 * The workspace save-failure toast. Extracted so the dev preview renders the real markup and
 * styles; the text stays selectable for copying.
 */
export function StorageErrorToast({ message, onRefresh = () => window.location.reload() }: { message: string; onRefresh?: () => void }) {
  return <SaveErrorToast key={message} message={message} onRefresh={onRefresh} />;
}

function SaveErrorToast({ message, onRefresh }: { message: string; onRefresh: () => void }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 5000);
    return () => clearTimeout(timer);
  }, [message]);

  if (!visible) return null;
  return <div className="storage-error" role="alert">
    <TriangleAlert className="storage-error-icon" size={19} strokeWidth={1.75} aria-hidden="true" />
    <span>{message}</span>
    <button type="button" onClick={onRefresh} aria-label="刷新页面" title="刷新页面">
      <RefreshCw size={18} strokeWidth={1.75} aria-hidden="true" />
    </button>
  </div>;
}
