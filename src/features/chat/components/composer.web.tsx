import { useEffect, useRef, useState } from 'react';

import { Dialog } from '@/components/web/dialog';
import { Icon } from '@/components/web/icon';
import { Link, type Href } from 'expo-router';
import { LinkAnchor } from '@/components/web/link-anchor';
import { useModels } from '@/features/models/model-state';
import { useSettingsRoot } from '@/features/settings/settings-page.web';
import { useChatRuntime } from '../chat-runtime';
import { useChat } from '../chat-state';

type Props = { value: string; onChange: (value: string) => void; onSend: () => void };

export function Composer({ value, onChange, onSend }: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [showModels, setShowModels] = useState(false);
  const models = useModels();
  const runtime = useChatRuntime();
  const { activeId } = useChat();
  const running = runtime.runningId !== null && runtime.runningId === activeId;
  const blocked = runtime.runningId !== null;
  const settingsHref: Href = `${useSettingsRoot()}/models`;
  const [modelError, setModelError] = useState<string | null>(null);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(192, Math.max(58, element.scrollHeight))}px`;
  }, [value]);

  function submit() {
    if (!value.trim() || blocked) return;
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
          if (event.key === 'Enter' && !event.shiftKey && window.matchMedia('(pointer: fine)').matches && !composing.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-toolbar">
        <button type="button" className="model-picker" onClick={() => setShowModels(true)} aria-haspopup="dialog"><span className="model-status-dot" />{models.selected?.name ?? '选择模型'}<Icon name="chevron" size={14} /></button>
        {running ? <button type="button" className="send-button" onClick={runtime.stop} aria-label="停止生成"><span className="stop-generation-icon" /></button>
          : <button type="submit" className="send-button" disabled={!value.trim() || blocked} aria-label="发送消息"><Icon name="arrow" size={21} /></button>}
      </div>
    </form>
    {showModels && <Dialog title="选择模型" onClose={() => setShowModels(false)} className="compact-dialog">
      {models.models.length ? <div className="model-choice-list">{models.models.map((model) => <button key={model.id} className="model-choice" disabled={blocked} aria-pressed={models.selectedId === model.id} onClick={() => {
        void models.select(model.id).then(() => setShowModels(false)).catch(() => setModelError('切换模型失败，请刷新后重试。'));
      }}><span><strong>{model.name}</strong><small>{model.modelId} · 本地直连</small></span>{models.selectedId === model.id && <Icon name="check" size={18} />}</button>)}</div>
        : <div className="model-empty"><span className="empty-icon"><Icon name="sparkle" size={25} /></span><h3>还没有可用模型</h3><p>添加服务商地址、API key 和模型 ID 后即可开始对话。</p></div>}
      {modelError && <p role="alert" className="model-form-error">{modelError}</p>}
      {models.error && <p role="alert" className="model-form-error">{models.error}</p>}
      <div className="dialog-footer"><Link href={settingsHref} asChild><LinkAnchor className="primary-button" onClick={() => setShowModels(false)}>管理模型</LinkAnchor></Link></div>
    </Dialog>}
  </>;
}
