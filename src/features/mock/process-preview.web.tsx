import { useState } from 'react';

import { processActivities, processAnswer, processReasoning } from '../../../dev/fixtures/process-preview';
import type { Message, ProcessActivity, WebActivity } from '@/core/agent/types';
import { MessageContent } from '@/features/chat/components/message-content.web';
import { ReasoningBlock, type ReasoningState } from '@/features/chat/components/reasoning-block.web';
import { ReplyStatus } from '@/features/chat/components/reply-status.web';

const phases = [
  ['waiting', '等待响应'], ['thinking', '思考中'], ['search', '搜索中'], ['fetch', '读取网页'],
  ['rethink', '再次思考'], ['answer', '回答中'],
  ['complete', '已完成'], ['stopped', '主动停止'], ['error', '连接中断'],
] as const;
type Phase = typeof phases[number][0];

export default function ProcessPreview() {
  const [phase, setPhase] = useState<Phase>('thinking');
  const [startedAt, setStartedAt] = useState(Date.now);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(8400);
  const running = !['complete', 'stopped', 'error'].includes(phase);
  const state: ReasoningState = running ? 'running' : phase as ReasoningState;
  const activities: WebActivity[] = phase === 'search' ? [{ ...processActivities[0], status: 'running', results: [] }]
    : phase === 'fetch' ? [processActivities[0], { ...processActivities[1], status: 'running' }]
      : ['rethink', 'answer', 'complete', 'stopped', 'error'].includes(phase) ? processActivities : [];
  const process: ProcessActivity[] = phase === 'waiting' ? [] : [
    { id: 'first-thought', kind: 'thinking', content: processReasoning, status: phase === 'thinking' ? 'running' : 'complete' },
    ...activities,
    ...(['rethink', 'answer', 'complete', 'stopped', 'error'].includes(phase) ? [{ id: 'second-thought', kind: 'thinking' as const,
      content: '已经找到并读完官方文档，接下来核对任务失败时的取消行为，再整理回答。',
      status: phase === 'rethink' ? 'running' as const : phase === 'stopped' ? 'stopped' as const : phase === 'error' ? 'error' as const : 'complete' as const }] : []),
  ];
  const message: Message = { id: 'preview', role: 'assistant', content: phase === 'answer' ? processAnswer.slice(0, 68) : running ? '' : processAnswer,
    status: running ? 'streaming' : phase as Message['status'],
    ...(phase === 'error' ? { error: '连接已中断，已生成内容已保留。' } : {}) };
  return <div className="chat-screen"><main className="chat-main has-messages" id="main-content">
    <header className="chat-topbar"><strong>回复过程预览</strong></header>
    <div className="messages-scroll"><div className="messages-content">
      <p className="process-preview-intro">使用真实回复组件预览各阶段，不发送模型请求。</p>
      <div className="process-preview-controls" role="group" aria-label="回复阶段">
        {phases.map(([value, label]) => <button type="button" key={value} data-phase={value} aria-pressed={phase === value}
          onClick={() => { setPhase(value); if (value === 'waiting') setStartedAt(Date.now());
            if (['complete', 'stopped', 'error'].includes(value)) setElapsedMs(Math.max(0, Date.now() - startedAt)); }}>{label}</button>)}
      </div>
      <article className="assistant-message" aria-label="回复过程示例">
        <ReasoningBlock state={state} reasoning={phase === 'waiting' ? '' : processReasoning}
          open={reasoningOpen} onOpenChange={setReasoningOpen}
          activities={activities} process={process} startedAt={running ? startedAt : null} elapsedMs={running ? null : elapsedMs} />
        <MessageContent content={message.content} />
        <ReplyStatus message={message} />
      </article>
    </div></div>
  </main></div>;
}
