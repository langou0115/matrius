import { useEffect, useRef, useState } from 'react';

import { Dialog } from '@/components/web/dialog';
import { Icon } from '@/components/web/icon';

type Props = { value: string; onChange: (value: string) => void; onSend: () => void };

export function Composer({ value, onChange, onSend }: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [showModels, setShowModels] = useState(false);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(192, Math.max(58, element.scrollHeight))}px`;
  }, [value]);

  function submit() {
    if (!value.trim()) return;
    onSend();
    input.current?.focus();
  }

  return <>
    <form className="composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <textarea
        ref={input}
        aria-label="消息内容"
        placeholder="发消息，探索更多可能…"
        value={value}
        rows={2}
        onChange={(event) => onChange(event.target.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-toolbar">
        <button type="button" className="model-picker" onClick={() => setShowModels(true)} aria-haspopup="dialog"><span className="model-status-dot" />选择模型<Icon name="chevron" size={14} /></button>
        <button type="submit" className="send-button" disabled={!value.trim()} aria-label="发送消息"><Icon name="arrow" size={21} /></button>
      </div>
    </form>
    {showModels && <Dialog title="选择模型" onClose={() => setShowModels(false)} className="compact-dialog">
      <div className="model-empty"><span className="empty-icon"><Icon name="sparkle" size={25} /></span><h3>还没有可用模型</h3><p>模型连接功能尚未开放。你可以先体验界面、整理对话，当前不会发送任何模型请求。</p></div>
      <div className="dialog-footer"><button className="primary-button" onClick={() => setShowModels(false)}>知道了</button></div>
    </Dialog>}
  </>;
}
