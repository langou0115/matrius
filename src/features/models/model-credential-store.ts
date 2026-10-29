import * as SecureStore from 'expo-secure-store';

import type { CredentialVault } from '@/core/platform/model-credentials';

/** One SecureStore entry per provider keeps a project with many keys under the per-item
    value limit. The index only stores IDs, never key material. */
const INDEX_KEY = 'matrius.model-credentials.index';
const entryKey = (id: string) => `matrius.model-credential.${id}`;

function readIndex(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item) : [];
  } catch {
    return [];
  }
}

export function createStoredModelCredentials(): CredentialVault {
  const keys = new Map<string, string>();
  let loaded = false;

  async function writeIndex(ids: string[]) {
    await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify([...new Set(ids)]));
  }

  return {
    get: (id: string) => keys.get(id) ?? '',
    async set(id: string, key: string) {
      const trimmed = key.trim();
      if (trimmed) {
        keys.set(id, trimmed);
        await SecureStore.setItemAsync(entryKey(id), trimmed);
      } else {
        keys.delete(id);
        await SecureStore.deleteItemAsync(entryKey(id));
      }
      await writeIndex([...keys.keys()]);
    },
    async delete(id: string) {
      keys.delete(id);
      await SecureStore.deleteItemAsync(entryKey(id));
      await writeIndex([...keys.keys()]);
    },
    async load() {
      if (loaded) return;
      // SecureStore has no batch read; the index bounds the number of lookups.
      const ids = readIndex(await SecureStore.getItemAsync(INDEX_KEY));
      const entries = await Promise.all(ids.map(async (id) => [id, await SecureStore.getItemAsync(entryKey(id))] as const));
      for (const [id, key] of entries) if (key) keys.set(id, key);
      loaded = true;
    },
  };
}
