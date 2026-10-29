import { readWorkspace } from '@/core/database/local-store';
import { parseWorkspace, type LoadedWorkspace } from './workspace-schema';

export type { LoadedWorkspace, WorkspaceData } from './workspace-schema';
export { parseWorkspace, readActivities, stripMessageImages } from './workspace-schema';

/** The native store keeps the whole workspace in one revisioned record. */
export async function loadWorkspace(): Promise<LoadedWorkspace> {
  const stored = await readWorkspace();
  if (!stored) return { revision: 0, data: { schemaVersion: 1, chat: { conversations: [], activeId: null, sidebarOpen: true }, appearance: { themeId: 'twitter', mode: 'system' } } };
  return parseWorkspace(stored.value, stored.revision);
}
