import { AbstractAgent } from '@ag-ui/client';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { Observable } from 'rxjs';

import { createReplyRun } from '@/core/agent/runner';
import type { AgentToolset, Message, ReplyUpdate } from '@/core/agent/types';
import type { ThinkingEffort } from '@/core/agent/thinking-effort';
import type { ModelConfig } from '@/core/llm/model-config';
import { buildTools } from './tools';

/**
 * CopilotKit asks the runtime for an agent per request. The browser sends the model
 * selection, the user's key and the tool intent in one header, so the service never keeps
 * per-visitor state between requests.
 */
export type CopilotRunContext = {
  config: ModelConfig;
  apiKey: string;
  systemPrompt?: string;
  thinkingEffort?: ThinkingEffort;
  toolset?: AgentToolset;
  conversationId?: string;
};

const CONTEXT_HEADER = 'x-matrius-agent-context';

/** Missing context is expected on discovery routes such as `/info`, which never run. */
export function readRunContext(request: Request): CopilotRunContext | null {
  const raw = request.headers.get(CONTEXT_HEADER);
  if (!raw) return null;
  const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as CopilotRunContext;
  if (!parsed?.config?.modelId) return null;
  return parsed;
}

/** CopilotKit forwards `properties` to the run as AG-UI `forwardedProps`. */
export function readForwardedContext(input: RunAgentInput): CopilotRunContext | null {
  const props = (input.forwardedProps ?? {}) as Record<string, unknown>;
  const value = props.matrius;
  if (!value || typeof value !== 'object') return null;
  const context = value as CopilotRunContext;
  return context.config?.modelId ? context : null;
}

/** AG-UI history is the source of truth for one thread; map the parts we can replay. */
function toMessages(input: RunAgentInput): Message[] {
  const messages: Message[] = [];
  for (const item of input.messages) {
    if (item.role !== 'user' && item.role !== 'assistant') continue;
    const content = typeof item.content === 'string' ? item.content : '';
    if (!content.trim()) continue;
    messages.push({ id: item.id, role: item.role, content, status: 'complete' });
  }
  return messages;
}

/**
 * AG-UI adapter over the same pi-agent loop the chat route uses. Text is streamed as
 * CopilotKit message deltas; tool activity stays in the service because CopilotKit renders
 * tools through components the browser registers.
 */
export class MatriusCopilotAgent extends AbstractAgent {
  constructor(private readonly context: CopilotRunContext | null) {
    super({ agentId: 'default', description: 'Matrius' });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const context = this.context ?? readForwardedContext(input);
      if (!context) {
        subscriber.next({
          type: EventType.RUN_ERROR, threadId: input.threadId, runId: input.runId,
          message: '缺少 Agent 上下文：请先在设置中配置模型。',
        } as BaseEvent);
        subscriber.complete();
        return;
      }
      const conversationId = context.conversationId ?? input.threadId;
      const messageId = `${input.runId}-assistant`;
      const base = { threadId: input.threadId, runId: input.runId };
      const { tools, prompts } = buildTools(context.toolset, conversationId);
      let textStarted = false;
      let sentLength = 0;

      const emit = (event: BaseEvent) => {
        if (!subscriber.closed) subscriber.next(event);
      };

      emit({ type: EventType.RUN_STARTED, ...base } as BaseEvent);

      const run = createReplyRun({
        messages: toMessages(input),
        config: context.config,
        apiKey: context.apiKey,
        ...(context.thinkingEffort ? { thinkingEffort: context.thinkingEffort } : {}),
        systemPrompt: [context.systemPrompt ?? '你是 Matrius 的助手，用中文简洁地回答。', ...prompts].join('\n\n'),
        ...(tools.length ? { tools } : {}),
        onUpdate(update: ReplyUpdate) {
          if (!textStarted) {
            textStarted = true;
            emit({ type: EventType.TEXT_MESSAGE_START, ...base, messageId, role: 'assistant' } as BaseEvent);
          }
          const text = update.content;
          if (text.length < sentLength) return;
          const delta = text.slice(sentLength);
          if (!delta) return;
          sentLength = text.length;
          emit({ type: EventType.TEXT_MESSAGE_CONTENT, ...base, messageId, delta } as BaseEvent);
        },
      });

      run.start().then((result) => {
        if (textStarted) emit({ type: EventType.TEXT_MESSAGE_END, ...base, messageId } as BaseEvent);
        if (result.status === 'error') {
          emit({ type: EventType.RUN_ERROR, ...base, message: result.error ?? 'Agent 运行失败。' } as BaseEvent);
        } else {
          emit({ type: EventType.RUN_FINISHED, ...base } as BaseEvent);
        }
        subscriber.complete();
      }).catch((error: unknown) => {
        if (textStarted) emit({ type: EventType.TEXT_MESSAGE_END, ...base, messageId } as BaseEvent);
        emit({
          type: EventType.RUN_ERROR, ...base,
          message: error instanceof Error ? error.message : 'Agent 运行失败。',
        } as BaseEvent);
        subscriber.complete();
      });

      return () => { run.abort(); };
    });
  }
}
