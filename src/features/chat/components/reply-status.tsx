import type { Message } from '@agent/core/types';
import { RotateCcw } from 'lucide-react';

/** Cancellation is informational; only actual request failures are alerts. */
export function ReplyStatus({ message, onRetry }: { message: Pick<Message, 'status' | 'error'>; onRetry?: () => void }) {
  if (message.status === 'stopped') return <p className="reply-status is-stopped" role="status">
    {message.error ?? '已停止生成'}
  </p>;
  if (message.status === 'error') return <div className="reply-failure">
    <p className="reply-status" role="alert">{message.error ?? '回复未完成，已生成内容已保留。'}</p>
    {onRetry && <button type="button" className="reply-retry" onClick={onRetry}><RotateCcw size={14} aria-hidden="true" />重试</button>}
  </div>;
  if (message.status === 'complete' && message.error) return <p className="reply-status" role="status">{message.error}</p>;
  return null;
}
