import { fileTool } from './file';
import { ToolRegistry } from './registry';
import { webFetchTool, webSearchTool } from './web';

/**
 * Built-in tool modules.
 *
 * Add a module here only after its service exists and its behavior is covered by
 * a test. Keep the registration order intentional: it is the order the model sees.
 *
 * Planned modules:
 *   - web_search  (server/services/search.ts)
 *   - web_fetch   (server/services/fetch/index.ts)
 *   - file        (server/services/documents/*)
 *   - memory      (server/agent/memory.ts)
 */
export const toolRegistry = new ToolRegistry([
  webSearchTool,
  webFetchTool,
  fileTool,
]);

export { ToolRegistry } from './registry';
export type { FeatureId, ToolActivityAdapter, ToolContext, ToolModule } from './types';
