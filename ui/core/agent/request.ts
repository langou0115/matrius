import type { ModelConfig } from '@/core/llm/model-config';
import type { ConversationSummary } from './compaction';
import type { ThinkingEffort } from './thinking-effort';
import type { Message } from './types';
export type AgentRequest = {
  conversationId: string;
  replyId: string;
  messages: Message[];
  config?: ModelConfig;
  apiKey: string;
  thinkingEffort?: ThinkingEffort;
  systemPrompt?: string;
  /** Long-term memory text travels in the trailing request context, not the cacheable system prompt. */
  memoryText?: string;
  /** Rolling summary persisted with the conversation; empty means no earlier history is summarized. */
  contextSummary?: ConversationSummary;
  /** Remote-runtime request flags; the server filters its registered tools by these. */
  enabledTools?: { web?: boolean; files?: boolean };
};

