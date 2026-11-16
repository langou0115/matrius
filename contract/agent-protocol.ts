/**
 * Agent protocol contract.
 *
 * This file is the single source of truth for the browser <-> server agent wire
 * format. Keep it free of Node, DOM, React and database imports; both `ui/` and
 * `server/` may import its types, and the compiler erases them from the browser
 * bundle.
 *
 * The sibling `contract/agent-*.ts` modules hold the pure logic both sides share
 * (context assembly, token estimates, prompts, provider validation). They follow
 * the same dependency rule: no Node, DOM, React or database imports.
 */

import type { UiComponentArtifact, UiComponentChange } from './ui-component';

export type ProviderProtocol = 'completion' | 'responses' | 'message';
export type ThinkingEffort = 'default' | 'low' | 'medium' | 'high';

export type ModelConfig = {
  id: string;
  name: string;
  modelId: string;
  providerId: string;
  providerName: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  requiresApiKey: boolean;
  supportsImage: boolean;
  contextWindow: number;
  maxOutput: number;
  thinkingEffort?: ThinkingEffort;
};

export type MessageImage = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  size?: number;
  fileId?: string;
};

export type MessageFile = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  revision?: number;
  operation?: string;
};

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  engine: string;
  rank: number;
};

export type WebActivity = {
  id: string;
  kind: 'search' | 'fetch' | 'file';
  status: 'running' | 'complete' | 'stopped' | 'error';
  query?: string;
  queries?: string[];
  results?: WebSearchResult[];
  url?: string;
  urls?: string[];
  title?: string;
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

/**
 * Search rows persisted in a message drop `snippet` and `engine`; those are
 * transient display data and must not be uploaded to the instance database.
 */
export type StoredWebSearchResult = Pick<WebSearchResult, 'url'> &
  Partial<Pick<WebSearchResult, 'title' | 'domain' | 'rank'>>;

export type StoredWebActivity = Omit<WebActivity, 'results'> & {
  results?: StoredWebSearchResult[];
};

export type ThinkingActivity = {
  id: string;
  kind: 'thinking';
  content: string;
  status: 'running' | 'complete' | 'stopped' | 'error';
  startedAt?: number;
  endedAt?: number;
};

export type ProcessActivity = ThinkingActivity | WebActivity;
export type StoredProcessActivity = ThinkingActivity | StoredWebActivity;

export type ContextSummary = {
  coveredUntilMessageId: string;
  summary: string;
};

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  quote?: string;
  feedback?: 'good' | 'bad';
  steering?: true;
  images?: MessageImage[];
  fileIds?: string[];
  files?: MessageFile[];
  reasoning?: string;
  reasoningActive?: boolean;
  activities?: WebActivity[];
  process?: ProcessActivity[];
  thinkingMs?: number;
  status?: 'streaming' | 'complete' | 'stopped' | 'error';
  error?: string;
  /** Components this reply rendered. Persisted so a reload restores the cards. */
  uiComponents?: UiComponentArtifact[];
  /** Transient during a workshop run: the AI wrote a new component version. */
  uiComponentChange?: UiComponentChange;
};

export type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type ReplyUpdate = {
  contextTokens?: {
    input: number;
    cacheRead?: number;
    cacheWrite?: number;
    output: number;
    modelId: string;
    contextWindow: number;
  };
  content: string;
  reasoning: string;
  reasoningActive: boolean;
  activities?: WebActivity[];
  process?: ProcessActivity[];
  files?: MessageFile[];
  uiComponents?: UiComponentArtifact[];
  uiComponentChange?: UiComponentChange;
};

export type AgentRunRequest = {
  conversationId: string;
  replyId: string;
  model: ModelConfig;
  /** Sent by the browser for this run only; never persisted or logged by the server. */
  apiKey?: string;
  thinkingEffort?: ThinkingEffort;
  /** Frozen history snapshot. The client remains the message writer in this phase. */
  messages: Message[];
  systemPrompt?: string;
  memoryText?: string;
  contextSummary?: ContextSummary;
  /** `chat` renders published components; `workshop` also lets the model write versions. */
  scope?: 'chat' | 'workshop';
  /** Workshop editing target. The server validates that the component belongs to the instance. */
  uiComponentId?: string;
  tools?: {
    web?: boolean;
    files?: boolean;
    ui?: boolean;
  };
};

export type AgentRunEnd = {
  status: 'complete' | 'stopped' | 'error';
  error?: string;
  usage?: TokenUsage;
};

export type AgentRunEvent =
  | { type: 'run'; runId: string; conversationId: string; replyId: string }
  | { type: 'update'; update: ReplyUpdate }
  | { type: 'summary'; contextSummary: ContextSummary }
  | { type: 'end'; result: AgentRunEnd };
