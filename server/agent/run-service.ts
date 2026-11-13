import { randomUUID } from 'node:crypto';

import type {
  AgentRunEvent,
  AgentRunRequest,
  Message,
  ReplyUpdate,
  TokenUsage,
} from '../../contract/agent-protocol';
import { featureIds } from '../features/registry';
import { toolRegistry } from '../tools';
import type { ToolServices } from '../tools/types';
import { createAgentRuntime } from './runtime';
import type { ModelConfig } from './llm/model-config';
import { isThinkingEffort, type ThinkingEffort } from './thinking-effort';
import { createToolActivityResolver } from './tool-activity';

export type AgentRunSink = (event: AgentRunEvent) => void;

export type AgentRunStartResult = {
  accepted: boolean;
  runId: string;
  error?: string;
};

export type AgentRunService = {
  start(request: AgentRunRequest, sink: AgentRunSink): AgentRunStartResult;
  steer(conversationId: string, message: Message): 'steered' | 'deferred' | false;
  stop(conversationId: string): void;
  isRunning(conversationId: string): boolean;
  dispose(): void;
};

type RuntimeOptions = NonNullable<Parameters<typeof createAgentRuntime>[0]>;
type RunEntry = {
  conversationId: string;
  runId: string;
  sink: AgentRunSink;
  usage?: TokenUsage;
};

function normalizeModel(model: AgentRunRequest['model']): ModelConfig {
  return {
    ...model,
    thinkingEffort: isThinkingEffort(model.thinkingEffort) ? model.thinkingEffort : 'low',
  };
}

function normalizeEffort(value: AgentRunRequest['thinkingEffort']): ThinkingEffort {
  return isThinkingEffort(value) ? value : 'low';
}

/**
 * Bridges the platform-independent agent runtime to SSE subscribers.
 *
 * Runs are process-local and one-per-conversation. The service never touches
 * the database or the request object; the route owns transport and the client
 * remains the message writer in this phase.
 */
export function createAgentRunService(options: {
  services?: ToolServices;
  loadRunner?: RuntimeOptions['loadRunner'];
  loadCompactor?: RuntimeOptions['loadCompactor'];
} = {}): AgentRunService {
  const entries = new Map<string, RunEntry>();

  const runtime = createAgentRuntime({
    onReply(conversationId, message) {
      const entry = entries.get(conversationId);
      if (!entry) return;
      const contextTokens = runtime.getSnapshot().contexts?.[conversationId];
      const update: ReplyUpdate = {
        content: message.content,
        reasoning: message.reasoning ?? '',
        reasoningActive: message.reasoningActive ?? false,
        ...(message.activities ? { activities: message.activities } : {}),
        ...(message.process ? { process: message.process } : {}),
        ...(message.files ? { files: message.files } : {}),
        ...(contextTokens ? { contextTokens } : {}),
      };
      emit(entry, { type: 'update', update });
      if (message.status && message.status !== 'streaming') {
        entries.delete(conversationId);
        emit(entry, {
          type: 'end',
          result: {
            status: message.status,
            ...(message.error ? { error: message.error } : {}),
            ...(entry.usage ? { usage: entry.usage } : {}),
          },
        });
      }
    },
    onSummary(conversationId, summary) {
      if (!summary) return;
      const entry = entries.get(conversationId);
      if (entry) emit(entry, { type: 'summary', contextSummary: summary });
    },
    onUsage(conversationId, usage) {
      const entry = entries.get(conversationId);
      if (entry) entry.usage = usage;
    },
    ...(options.loadRunner ? { loadRunner: options.loadRunner } : {}),
    ...(options.loadCompactor ? { loadCompactor: options.loadCompactor } : {}),
  });

  function emit(entry: RunEntry, event: AgentRunEvent): void {
    try {
      entry.sink(event);
    } catch {
      // A closed SSE socket must not leave a model request running.
      runtime.stop(entry.conversationId);
    }
  }

  return {
    start(request, sink) {
      if (runtime.getSnapshot().runs[request.conversationId]) {
        return { accepted: false, runId: randomUUID(), error: '当前会话正在生成回复。' };
      }
      const runId = randomUUID();
      const entry: RunEntry = {
        conversationId: request.conversationId,
        runId,
        sink,
      };
      entries.set(request.conversationId, entry);
      emit(entry, {
        type: 'run',
        runId,
        conversationId: request.conversationId,
        replyId: request.replyId,
      });

      const features = new Set(featureIds());
      const modules = options.services
        ? toolRegistry.enabled(features).filter((module) => {
          if (module.id === 'web_search' || module.id === 'web_fetch') return request.tools?.web !== false;
          if (module.id === 'file') return request.tools?.files !== false;
          return true;
        })
        : [];
      const tools = modules.map((module) => module.create({
        instanceId: 1,
        conversationId: request.conversationId,
        features,
        services: options.services!,
      }));
      const prompts = modules
        .map((module) => module.prompt?.trim())
        .filter((prompt): prompt is string => Boolean(prompt));
      const systemPrompt = [request.systemPrompt, ...prompts].filter(Boolean).join('\n\n');

      let accepted = false;
      try {
        accepted = runtime.start({
          conversationId: request.conversationId,
          replyId: request.replyId,
          messages: request.messages,
          config: normalizeModel(request.model),
          apiKey: request.apiKey ?? '',
          thinkingEffort: normalizeEffort(request.thinkingEffort),
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(request.memoryText ? { memoryText: request.memoryText } : {}),
          ...(request.contextSummary ? { contextSummary: request.contextSummary } : {}),
          ...(tools.length ? { tools, toolActivity: createToolActivityResolver(toolRegistry) } : {}),
        });
      } catch (error) {
        accepted = false;
      }
      if (!accepted) {
        entries.delete(request.conversationId);
        emit(entry, {
          type: 'end',
          result: {
            status: 'error',
            error: runtime.getSnapshot().error ?? '无法启动回复。',
          },
        });
      }
      return { accepted, runId, ...(accepted ? {} : { error: runtime.getSnapshot().error ?? '无法启动回复。' }) };
    },

    steer(conversationId, message) {
      return runtime.steer(conversationId, message);
    },

    stop(conversationId) {
      runtime.stop(conversationId);
    },

    isRunning(conversationId) {
      return Boolean(runtime.getSnapshot().runs[conversationId]);
    },

    dispose() {
      entries.clear();
      runtime.dispose();
    },
  };
}
