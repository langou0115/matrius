import type { AgentTool } from '@mariozechner/pi-agent-core';

import type { FeatureId } from '../../features/types';
import type { WebActivity } from '../../../contract/agent-protocol';
import type { DocumentToolService } from '../../services/documents/service';
import type { FetchService } from '../../services/fetch';
import type { SearchService } from '../../services/search';

export type { FeatureId } from '../../features/types';

export type ToolServices = {
  search: SearchService;
  fetch: FetchService;
  files?: DocumentToolService;
};

/**
 * Per-run context. Tools must not read browser state or call the HTTP API; add
 * what they need here and pass explicit services from the agent runtime.
 */
export type ToolContext = {
  instanceId: number;
  conversationId?: string;
  signal?: AbortSignal;
  features: ReadonlySet<FeatureId>;
  /** Provided by the agent run service; tools fail clearly when omitted. */
  services?: ToolServices;
};

/** Maps a tool execution event to the thinking/research row rendered by the UI. */
export type ToolActivityAdapter = {
  start(toolCallId: string, args: unknown): WebActivity | null;
  end(toolCallId: string, result: unknown, isError: boolean, previous?: WebActivity): WebActivity | null;
};

/**
 * One tool module. `id` must equal the AgentTool `name`; the registry uses it
 * for activity lookup and diagnostics.
 */
export type ToolModule = {
  readonly id: string;
  readonly feature?: FeatureId;
  /** Appended to the system prompt only while this tool is enabled. */
  readonly prompt?: string;
  readonly activity?: ToolActivityAdapter;
  create(context: ToolContext): AgentTool;
};
