import { CircleAlert, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

export function ChatNotice({ message, onClose }: { message: string | null; onClose: () => void }) {
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => close.current(), 5000);
    return () => clearTimeout(timer);
  }, [message]);

  if (!message) return null;
  return <div className="chat-notice-anchor">
    <div className="chat-notice" role="alert">
      <CircleAlert size={18} strokeWidth={1.75} aria-hidden="true" />
      <p>{message}</p>
      <button type="button" aria-label="关闭提示" onClick={onClose}><X size={17} strokeWidth={1.75} aria-hidden="true" /></button>
    </div>
  </div>;
}
