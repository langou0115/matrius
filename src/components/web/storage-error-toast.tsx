import { useEffect, useState } from 'react';

/**
 * The workspace save-failure toast. Extracted so the dev preview renders the real markup and
 * styles; the text stays selectable for copying.
 */
export function StorageErrorToast({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <SaveErrorToast key={message} message={message} onRetry={onRetry} />;
}

function SaveErrorToast({ message, onRetry }: { message: string; onRetry: () => void }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 5000);
    return () => clearTimeout(timer);
  }, [message]);

  if (!visible) return null;
  return <div className="storage-error" role="alert">
    <span>{message}</span>
    <button type="button" onClick={onRetry}>重试保存</button>
  </div>;
}
