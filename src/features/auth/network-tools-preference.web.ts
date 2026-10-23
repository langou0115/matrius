import { LocalDataConflict, readLocalValue, writeLocalValue } from '@/core/database/browser-store.web';

/** Web tools are a per-account capability. Keeping the choice per user stops one account's
    preference from silently deciding whether the next login can browse. */
const STORAGE_KEY = 'account-network-tools';

/** Web tools are on by default: they are the reason a logged-in account can answer with
    current information, and the server still enforces its own quota. */
export const DEFAULT_NETWORK_TOOLS_ENABLED = true;

export async function loadNetworkToolsEnabled(userId: string): Promise<boolean> {
  try {
    const stored = await readLocalValue(STORAGE_KEY);
    const users = (stored?.value as { users?: Record<string, unknown> } | null)?.users;
    const entry = users?.[userId];
    const enabled = (entry as { enabled?: unknown } | null)?.enabled;
    return typeof enabled === 'boolean' ? enabled : DEFAULT_NETWORK_TOOLS_ENABLED;
  } catch {
    return DEFAULT_NETWORK_TOOLS_ENABLED;
  }
}

export async function saveNetworkToolsEnabled(userId: string, enabled: boolean): Promise<void> {
  // Retry once on a stale revision: another tab may have saved a different account's choice.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stored = await readLocalValue(STORAGE_KEY);
    const users = (stored?.value as { users?: Record<string, unknown> } | null)?.users;
    try {
      await writeLocalValue(STORAGE_KEY, { users: { ...users, [userId]: { enabled } } }, stored?.revision ?? 0);
      return;
    } catch (reason) {
      if (!(reason instanceof LocalDataConflict) || attempt === 1) throw reason;
    }
  }
}
