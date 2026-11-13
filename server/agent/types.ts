import type { ReplyUpdate } from '../../contract/agent-protocol';

export type {
  Message,
  MessageFile,
  MessageImage,
  ProcessActivity,
  ReplyUpdate,
  ThinkingActivity,
  TokenUsage,
  WebActivity,
  WebSearchResult,
} from '../../contract/agent-protocol';

export type { ThinkingEffort } from './thinking-effort';

export type AgentProfile = {
  customInstructions: string;
  aboutName: string;
  occupation: string;
  aboutMore: string;
};

export type ReplyResult = {
  status: 'complete' | 'stopped' | 'error';
  error?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
};

export type RuntimeRun = { conversationId: string; replyId: string; startedAt: number };

export type RuntimeSnapshot = {
  runs: Record<string, RuntimeRun>;
  error: string | null;
  contexts?: Record<string, NonNullable<ReplyUpdate['contextTokens']>>;
};

/** `steered` joins the current run; `deferred` waits for the next turn; `false` has no run. */
export type SteerOutcome = 'steered' | 'deferred' | false;
