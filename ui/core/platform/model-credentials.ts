export type CredentialVault = {
  get(id: string): string;
  set(id: string, key: string): void | Promise<void>;
  delete(id: string): void | Promise<void>;
  /** Restores persisted keys into the synchronous read path. Session vaults have nothing to restore. */
  load(): Promise<void>;
};

/** Session-only vault. Two instances never share state and nothing is serialized. */
export function createModelCredentials(): CredentialVault & { clear(): void } {
  const keys = new Map<string, string>();
  return {
    get: (id: string) => keys.get(id) ?? '',
    set(id: string, key: string) { if (key.trim()) keys.set(id, key.trim()); else keys.delete(id); },
    delete(id: string) { keys.delete(id); },
    clear: () => keys.clear(),
    load: () => Promise.resolve(),
  };
}
