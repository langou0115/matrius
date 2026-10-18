/** Shared request and reply contracts for Web and native clients. */
export type MessageImage = { id: string; name: string; mimeType: string; dataUrl: string };
export type MessageFeedback = 'good' | 'bad';

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  quote?: string;
  feedback?: MessageFeedback;
  images?: MessageImage[];
  reasoning?: string;
  reasoningActive?: boolean;
  /** Time to the last reasoning token, excluding answer generation. */
  thinkingMs?: number;
  status?: 'streaming' | 'complete' | 'stopped' | 'error';
  error?: string;
};

export type AgentProfile = { customInstructions: string; aboutName: string; occupation: string; aboutMore: string };
export type ReplyUpdate = { content: string; reasoning: string; reasoningActive: boolean };
export type ReplyResult = { status: 'complete' | 'stopped' | 'error'; error?: string };
export type RuntimeSnapshot = { runningId: string | null; startedAt: number | null; error: string | null };
