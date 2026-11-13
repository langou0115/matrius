import type { MessageFile, WebActivity } from '../../contract/agent-protocol';

/**
 * The agent loop only needs four operations from the tool layer:
 * start/end activity rows, generated-file collection and (later) prompt text.
 * Tool modules and the registry own the concrete implementation; the runner
 * stays independent of web/file-tool imports.
 */
export type ToolActivityResolver = {
  start(toolName: string, toolCallId: string, args: unknown): WebActivity | null;
  end(
    toolName: string,
    toolCallId: string,
    result: unknown,
    isError: boolean,
    previous?: WebActivity,
  ): WebActivity | null;
  files(result: unknown): MessageFile[];
};

/** A text-only run has no tools, so every hook is a no-op. */
export const emptyToolActivity: ToolActivityResolver = {
  start: () => null,
  end: () => null,
  files: () => [],
};

import type { ToolRegistry } from '../tools/registry';

/** Bind the registry's activity adapters to the runner's tool-agnostic hooks. */
export function createToolActivityResolver(registry: ToolRegistry): ToolActivityResolver {
  return {
    start: (toolName, toolCallId, args) => {
      const adapter = registry.activityFor(toolName);
      return adapter ? adapter.start(toolCallId, args) : null;
    },
    end: (toolName, toolCallId, result, isError, previous) => {
      const adapter = registry.activityFor(toolName);
      return adapter ? adapter.end(toolCallId, result, isError, previous) : null;
    },
    files: () => [],
  };
}
