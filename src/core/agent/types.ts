/** Shared request and reply contracts for Web and native clients. */
export type MessageImage = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  size?: number;
  /** Cloud copy created after login; the model still receives the data URL. */
  fileId?: string;
};
export type MessageFeedback = 'good' | 'bad';

/** Metadata for a file stored in the instance's Library. */
export type MessageFile = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  revision?: number;
  /** The file tool operation that produced this file; absent on files loaded from history. */
  operation?: string;
};

/** One normalized search hit, as returned by the server's tool API. */
export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  engine: string;
  rank: number;
};

/** A single web search, page read or document operation, rendered inside the reasoning disclosure. */
export type WebActivity = {
  id: string;
  kind: 'search' | 'fetch' | 'file';
  status: 'running' | 'complete' | 'stopped' | 'error';
  query?: string;
  /** All queries sent in one web_search call; retained for debugging. */
  queries?: string[];
  results?: WebSearchResult[];
  url?: string;
  urls?: string[];
  title?: string;
  /** Document operations. `fileId` may be a draft handle; `savedFileId` is a Library file. */
  operation?: string;
  fileId?: string;
  savedFileId?: string;
  filename?: string;
  size?: number;
  warning?: string;
  tookMs?: number;
  error?: string;
  startedAt?: number;
  endedAt?: number;
};

export type ThinkingActivity = {
  id: string;
  kind: 'thinking';
  content: string;
  status: 'running' | 'complete' | 'stopped' | 'error';
  startedAt?: number;
  endedAt?: number;
};
/** Append in runtime event order; separate thinking segments may surround tool calls. */
export type ProcessActivity = ThinkingActivity | WebActivity;

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  quote?: string;
  feedback?: MessageFeedback;
  /** Injected into the still-running reply. Messages queued after its answer text starts keep
      no flag: they are sent later as an ordinary turn. */
  steering?: true;
  images?: MessageImage[];
  /** Cloud file ids referenced by this message. Order follows the attachment list. */
  fileIds?: string[];
  /** Resolved metadata for `fileIds`, supplied by the conversation API. */
  files?: MessageFile[];
  reasoning?: string;
  reasoningActive?: boolean;
  /** Web tool calls made while composing this reply. Synced without snippets; `process`
      is rebuilt from these plus `reasoning` when cloud history is loaded. */
  activities?: WebActivity[];
  /** Ordered thinking and tool segments, retained in the local workspace. */
  process?: ProcessActivity[];
  /** Total elapsed time for this reply, including reasoning, tools and answer generation. */
  thinkingMs?: number;
  status?: 'streaming' | 'complete' | 'stopped' | 'error';
  error?: string;
};

export type AgentProfile = { customInstructions: string; aboutName: string; occupation: string; aboutMore: string };
export type ReplyUpdate = {
  /** Latest provider-reported call; held until the next call reports usage, never an estimate. */
  contextTokens?: {
    /** Prompt-side total including cached tokens. */
    input: number;
    /** Prompt tokens read from the provider cache. */
    cacheRead?: number;
    /** Prompt tokens written to the provider cache. */
    cacheWrite?: number;
    output: number;
    modelId: string;
    contextWindow: number;
  };
  content: string;
  reasoning: string;
  reasoningActive: boolean;
  /** A stable array that only changes when a tool call starts or finishes. */
  activities?: WebActivity[];
  process?: ProcessActivity[];
  /** Files saved to the Library during this reply, deduplicated by id. */
  files?: MessageFile[];
};
/** Tokens billed for one reply run, summed over every model round it made. */
export type TokenUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type ReplyResult = { status: 'complete' | 'stopped' | 'error'; error?: string; usage?: TokenUsage };
export type RuntimeRun = { conversationId: string; replyId: string; startedAt: number };
/** `steered` joins the current run; `deferred` waits for the next turn; `false` has no run. */
export type SteerOutcome = 'steered' | 'deferred' | false;
/** Requests are tracked per conversation so independent chats can generate at the same time. */
export type RuntimeSnapshot = { runs: Record<string, RuntimeRun>; error: string | null;
  contexts?: Record<string, NonNullable<ReplyUpdate['contextTokens']>> };
