import type { ReplyUpdate, TokenUsage } from './agent-protocol';

/**
 * Shared agent contracts that are neither wire messages nor provider settings.
 *
 * `ui/` and `server/` both import from this file so the browser client and the
 * server runtime cannot drift. Type-only: it must stay free of Node, DOM, React
 * and database imports so the browser bundle can erase it.
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
} from './agent-protocol';

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
