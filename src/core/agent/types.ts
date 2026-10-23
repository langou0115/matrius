/** Shared request and reply contracts for Web and native clients. */
export type MessageImage = { id: string; name: string; mimeType: string; dataUrl: string; size?: number };
export type MessageFeedback = 'good' | 'bad';

/** One normalized search hit, as returned by the server's tool API. */
export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  engine: string;
  rank: number;
};

/** A single web search or page read, rendered inside the reasoning disclosure. */
export type WebActivity = {
  id: string;
  kind: 'search' | 'fetch';
  status: 'running' | 'complete' | 'error';
  query?: string;
  results?: WebSearchResult[];
  url?: string;
  urls?: string[];
  title?: string;
  tookMs?: number;
  error?: string;
  startedAt?: number;
  endedAt?: number;
};

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  quote?: string;
  feedback?: MessageFeedback;
  images?: MessageImage[];
  reasoning?: string;
  reasoningActive?: boolean;
  /** Web tool calls made while composing this reply. Local-only: not part of account sync. */
  activities?: WebActivity[];
  /** Time to the last reasoning token or tool call, excluding answer generation. */
  thinkingMs?: number;
  status?: 'streaming' | 'complete' | 'stopped' | 'error';
  error?: string;
};

export type AgentProfile = { customInstructions: string; aboutName: string; occupation: string; aboutMore: string };
export type ReplyUpdate = {
  content: string;
  reasoning: string;
  reasoningActive: boolean;
  /** A stable array that only changes when a tool call starts or finishes. */
  activities?: WebActivity[];
};
export type ReplyResult = { status: 'complete' | 'stopped' | 'error'; error?: string };
export type RuntimeRun = { conversationId: string; replyId: string; startedAt: number };
/** Requests are tracked per conversation so independent chats can generate at the same time. */
export type RuntimeSnapshot = { runs: Record<string, RuntimeRun>; error: string | null };
