import { readLocalValue, writeLocalValue, LocalDataConflict } from '@/core/database/browser-store.web';
import type { CredentialVault } from '@/core/platform/model-credentials';

/** Own record so the model metadata record — the one a future sync uploads — never carries keys. */
const STORAGE_KEY = 'model-credentials';

function readKeys(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || !('keys' in value)) throw new Error('Invalid stored model credentials');
  const stored = (value as { keys: unknown }).keys;
  if (!stored || typeof stored !== 'object') throw new Error('Invalid stored model credentials');
  const keys: Record<string, string> = {};
  for (const [id, key] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof key === 'string' && key.trim()) keys[id] = key.trim();
  }
  return keys;
}

/**
 * Browser vault. Keys live in IndexedDB next to the rest of the workspace data and
 * survive a reload. They are not encrypted: any script running on this origin, or
 * anyone using this browser profile, can read them.
 */
export function createStoredModelCredentials(): CredentialVault {
  const keys = new Map<string, string>();
  let revision = 0;

  async function persist(): Promise<void> {
    try {
      revision = await writeLocalValue(STORAGE_KEY, { keys: Object.fromEntries(keys) }, revision);
    } catch (reason) {
      // The record is replaced whole, so a stale writer would drop other pages' keys.
      // Surface the conflict instead of merging, matching the workspace convention.
      if (reason instanceof LocalDataConflict) throw new Error('API key 已在其他页面被修改，请刷新后重试。');
      throw new Error('API key 未能保存到本机浏览器，请重试。');
    }
  }

  return {
    get: (id: string) => keys.get(id) ?? '',
    set(id: string, key: string) {
      const trimmed = key.trim();
      if (trimmed) keys.set(id, trimmed); else keys.delete(id);
      return persist();
    },
    delete(id: string) { keys.delete(id); return persist(); },
    async load() {
      const stored = await readLocalValue(STORAGE_KEY);
      revision = stored?.revision ?? 0;
      if (stored) for (const [id, key] of Object.entries(readKeys(stored.value))) keys.set(id, key);
    },
  };
}
