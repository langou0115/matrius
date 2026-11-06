import { LocalDataConflict, readLocalValue, writeLocalValue } from '@/core/database/browser-store';

/** Web tools are a per-workspace preference: an account id for cloud mode and `local` for
    anonymous browsing. Keying by scope stops one workspace's choice from silently deciding
    whether another one can browse. */
const STORAGE_KEY = 'account-network-tools';

/** Web tools are on by default: they are the reason the assistant can answer with current
    information, and the server still enforces its own quota. */
export const DEFAULT_NETWORK_TOOLS_ENABLED = true;

export async function loadNetworkToolsEnabled(scope: string): Promise<boolean> {
  try {
    const stored = await readLocalValue(STORAGE_KEY);
    const scopes = (stored?.value as { users?: Record<string, unknown> } | null)?.users;
    const entry = scopes?.[scope];
    const enabled = (entry as { enabled?: unknown } | null)?.enabled;
    return typeof enabled === 'boolean' ? enabled : DEFAULT_NETWORK_TOOLS_ENABLED;
  } catch {
    return DEFAULT_NETWORK_TOOLS_ENABLED;
  }
}

export async function saveNetworkToolsEnabled(scope: string, enabled: boolean): Promise<void> {
  // Retry once on a stale revision: another tab may have saved a different scope's choice.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stored = await readLocalValue(STORAGE_KEY);
    const scopes = (stored?.value as { users?: Record<string, unknown> } | null)?.users;
    try {
      await writeLocalValue(STORAGE_KEY, { users: { ...scopes, [scope]: { enabled } } }, stored?.revision ?? 0);
      return;
    } catch (reason) {
      if (!(reason instanceof LocalDataConflict) || attempt === 1) throw reason;
    }
  }
}
