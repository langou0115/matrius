import { AlertCircle, LoaderCircle, Trash2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';

import { MEMORY_SUMMARY_LIMIT, createMemoryTool, memoryChatSystemPrompt } from '@/core/agent/memory';
import { createReplyRun } from '@/core/agent/runner';
import type { Message } from '@/core/agent/types';
import { Dialog } from '@/components/web/dialog';
import { Icon } from '@/components/web/icon';
import { useChat } from '@/features/chat/chat-state';
import { MessageContent } from '@/features/chat/components/message-content';
import { useModels } from '@/features/models/model-state';

import { pickMemoryModel } from './memory-model';
import { useMemory } from './memory-state';

const COMPOSER_MAX_HEIGHT = 128;

function formatUpdatedAt(updatedAt: number | null): string {
  if (!updatedAt) return '尚未更新';
  const diff = Math.max(0, Date.now() - updatedAt);
  if (diff < 60_000) return '刚刚更新';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前更新`;
  const date = new Date(updatedAt);
  const now = new Date();
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) {
    return `${time} 更新`;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** The only editor for the memory summary. The assistant applies the user's instruction
    through the `memory` tool; its chat text is intentionally not shown. */
export function MemoryDialog({ onClose }: { onClose: () => void }) {
  const { summary, updatedAt, replaceSummary, clearSummary } = useMemory();
  const models = useModels();
  const { conversations, activeId } = useChat();
  const activeConversation = conversations.find((conversation) => conversation.id === activeId);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const runRef = useRef<ReturnType<typeof createReplyRun> | null>(null);
  const summaryRef = useRef(summary);
  const mountedRef = useRef(true);

  useEffect(() => { summaryRef.current = summary; }, [summary]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runRef.current?.abort();
      runRef.current = null;
    };
  }, []);
  // Match the chat composer, but with a lower growth cap for this compact editor.
  useLayoutEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(COMPOSER_MAX_HEIGHT, Math.max(54, element.scrollHeight))}px`;
  }, [input]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const config = pickMemoryModel(models, activeConversation?.modelId);
    if (!config) {
      setError('请先在设置 → 模型服务中添加并选择模型。');
      return;
    }
    setInput('');
    setError(null);
    setBusy(true);
    let updated = false;
    const tool = createMemoryTool({
      getSummary: () => summaryRef.current,
      onUpdate: (value) => {
        updated = true;
        replaceSummary(value);
      },
    });
    const run = createReplyRun({
      config,
      apiKey: config.requiresApiKey ? models.getKey(config.providerId) : '',
      systemPrompt: memoryChatSystemPrompt(summaryRef.current),
      messages: [{ id: 'memory-request', role: 'user', content: text } satisfies Message],
      tools: [tool],
      // The assistant's chat text is not shown: the visible result is the updated summary.
      onUpdate: () => {},
    });
    runRef.current = run;
    try {
      const result = await run.start();
      if (!mountedRef.current) return;
      if (!updated) {
        setError(result.status === 'error'
          ? result.error ?? '记忆更新失败，请重试。'
          : '没有识别到需要更新的内容。');
      }
    } catch {
      if (mountedRef.current) setError('记忆更新失败，请稍后重试。');
    } finally {
      if (mountedRef.current) setBusy(false);
      if (runRef.current === run) runRef.current = null;
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void send();
  }

  function confirmClearSummary() {
    // A tool call from the current turn must not recreate memory immediately after the clear.
    runRef.current?.abort();
    runRef.current = null;
    setBusy(false);
    clearSummary();
    setInput('');
    setError(null);
    setConfirmClear(false);
  }

  return <>
    <Dialog title="记忆摘要" hideHeader onClose={onClose} className="memory-dialog">
      <header className="memory-dialog-header">
        <div className="memory-dialog-title">
          <h2>记忆摘要</h2>
          {summary.trim() && <span className="memory-updated-at">{formatUpdatedAt(updatedAt)}</span>}
          <button type="button" className="icon-button danger-icon" aria-label="删除记忆摘要" disabled={!summary.trim()} onClick={() => setConfirmClear(true)}>
            <Trash2 size={17} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        <button type="button" className="icon-button" aria-label="关闭记忆摘要" onClick={onClose}>
          <X size={17} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </header>
      <div className="memory-dialog-body">
        <section className="memory-summary-card" aria-label="记忆摘要">
          {summary.trim()
            ? <div className="memory-summary-content"><MessageContent content={summary} /></div>
            : <p className="memory-summary-empty">当前还没有记忆摘要</p>}
        </section>
        {error && <p className="memory-dialog-error" role="alert">
          <AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>{error}</span>
        </p>}
      </div>
      <form className="composer memory-dialog-composer" onSubmit={submit}>
        <textarea
          ref={inputRef}
          aria-label="记忆修改指令"
          rows={2}
          maxLength={MEMORY_SUMMARY_LIMIT}
          placeholder="输入要记住或修改的内容"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-toolbar">
          <button type="submit" className="send-button" aria-label="发送" disabled={!input.trim() || busy || !models.ready}>
            {busy ? <LoaderCircle className="loading-spinner" size={17} strokeWidth={2} aria-hidden="true" /> : <Icon name="arrow" size={21} />}
          </button>
        </div>
      </form>
    </Dialog>
    {confirmClear && <Dialog title="删除记忆摘要？" className="compact-dialog" onClose={() => setConfirmClear(false)}>
      <p className="dialog-description">删除后无法恢复。</p>
      <div className="dialog-footer">
        <button type="button" className="secondary-button" onClick={() => setConfirmClear(false)}>取消</button>
        <button type="button" className="danger-button" onClick={confirmClearSummary}>删除</button>
      </div>
    </Dialog>}
  </>;
}
