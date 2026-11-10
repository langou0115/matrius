import type { AgentTool } from '@mariozechner/pi-agent-core';

import { createFileTool, fileToolsSystemPrompt } from '@agent/core/file-tools';
import type { MessageFile } from '@agent/core/types';
import { createWebTools, webToolsSystemPrompt } from '@agent/core/web-tools';

import { createUiTools, uiPrompt } from './ui-tools';
import { config } from './env';
import { createUpstreamRequest } from './upstream';

/** Which server tools this run may use. The browser cannot hand over tool code, only intent. */
export type Toolset = {
  ui?: boolean;
  web?: boolean;
  files?: boolean;
  /** Files referenced by the conversation, newest last; the file tool rebuilds its own list. */
  availableFiles?: MessageFile[];
};

export function buildTools(toolset: Toolset | undefined, conversationId: string): { tools: AgentTool[]; prompts: string[] } {
  const request = createUpstreamRequest(config.apiBaseUrl);
  const tools: AgentTool[] = [];
  const prompts: string[] = [];
  if (toolset?.ui) { tools.push(...createUiTools()); prompts.push(uiPrompt); }
  if (toolset?.web) {
    tools.push(...createWebTools(request));
    prompts.push(webToolsSystemPrompt());
  }
  if (toolset?.files) {
    tools.push(createFileTool({
      request,
      conversationId,
      availableFiles: toolset.availableFiles ?? [],
    }).tool);
    prompts.push(fileToolsSystemPrompt());
  }
  return { tools, prompts };
}
