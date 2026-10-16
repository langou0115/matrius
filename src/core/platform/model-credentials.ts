/** Session-only adapter. Never serialize keys or share them across workspaces. */
export function createModelCredentials() {
  const keys = new Map<string, string>();
  return {
    get: (id: string) => keys.get(id) ?? '',
    set(id: string, key: string) { if (key.trim()) keys.set(id, key.trim()); else keys.delete(id); },
    delete: (id: string) => keys.delete(id),
    clear: () => keys.clear(),
  };
}
