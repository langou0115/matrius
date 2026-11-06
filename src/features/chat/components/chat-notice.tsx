import { CircleAlert, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

export type ChatNoticeItem = { id: string; message: string };

function NoticeToast({ item, onClose }: { item: ChatNoticeItem; onClose: (id: string) => void }) {
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    const timer = setTimeout(() => close.current(item.id), 5000);
    return () => clearTimeout(timer);
  }, [item.id, item.message]);

  return <div className="chat-notice" role="alert">
    <CircleAlert size={18} strokeWidth={1.75} aria-hidden="true" />
    <p>{item.message}</p>
    <button type="button" aria-label="关闭提示" onClick={() => onClose(item.id)}><X size={17} strokeWidth={1.75} aria-hidden="true" /></button>
  </div>;
}

export function ChatNotice({ items, onClose }: { items: ChatNoticeItem[]; onClose: (id: string) => void }) {
  if (!items.length) return null;
  return <div className="chat-notice-anchor">
    {items.map((item) => <NoticeToast key={item.id} item={item} onClose={onClose} />)}
  </div>;
}
