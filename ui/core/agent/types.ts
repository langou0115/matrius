import type { ReplyUpdate, TokenUsage } from '../../../contract/agent-protocol';

/**
 * UI-side agent contracts.
 *
 * Wire/message types live in `contract/agent-protocol.ts` so the future remote
 * runtime and the current browser runtime cannot drift. Only UI-runtime state
 * (runs, snapshots) is declared here.
 */
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
} from '../../../contract/agent-protocol';

export type MessageFeedback = 'good' | 'bad';
export type AgentProfile = { customInstructions: string; aboutName: string; occupation: string; aboutMore: string };
export type ReplyResult = { status: 'complete' | 'stopped' | 'error'; error?: string; usage?: TokenUsage };
export type RuntimeRun = { conversationId: string; replyId: string; startedAt: number };
/** `steered` joins the current run; `deferred` waits for the next turn; `false` has no run. */
export type SteerOutcome = 'steered' | 'deferred' | false;
/** Requests are tracked per conversation so independent chats can generate at the same time. */
export type RuntimeSnapshot = {
  runs: Record<string, RuntimeRun>;
  error: string | null;
  contexts?: Record<string, NonNullable<ReplyUpdate['contextTokens']>>;
};
