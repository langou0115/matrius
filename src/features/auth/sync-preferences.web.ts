import { LocalDataConflict, readLocalValue, writeLocalValue } from '@/core/database/browser-store.web';

/** Kept beside the account so the account page can explain the server contract in one place. */
export const syncCategories = [
  { id: 'conversations', title: '聊天记录', description: '所有对话的名字和消息内容，换台设备登录后能接着聊。' },
  { id: 'reading', title: '已读和未读', description: '哪些回复看过了、哪些还没看，换台设备后不会全变回未读。' },
  { id: 'personalization', title: '个人设置', description: '自定义指令、称呼、职业等资料，换台设备后助手照样记得。' },
  { id: 'appearance', title: '界面外观', description: '配色和浅色 / 深色模式，换台设备后看起来一样。' },
] as const;

export type SyncCategoryId = (typeof syncCategories)[number]['id'];
export type SyncPreferences = Record<SyncCategoryId, boolean>;

const STORAGE_KEY = 'account-sync-preferences';

export function defaultSyncPreferences(): SyncPreferences {
  return Object.fromEntries(syncCategories.map((category) => [category.id, true])) as SyncPreferences;
}

function normalize(value: unknown, userId: string): SyncPreferences {
  const preferences = (value as { users?: Record<string, unknown> } | null)?.users?.[userId];
  const result = defaultSyncPreferences();
  if (!preferences || typeof preferences !== 'object') return result;
  for (const category of syncCategories) {
    const selected = (preferences as Record<string, unknown>)[category.id];
    if (typeof selected === 'boolean') result[category.id] = selected;
  }
  return result;
}

/** The selection stays in this browser; keeping it per account prevents one user's choice
    from silently applying to the next login on the same machine. */
export async function loadSyncPreferences(userId: string): Promise<SyncPreferences> {
  try {
    const stored = await readLocalValue(STORAGE_KEY);
    return normalize(stored?.value, userId);
  } catch {
    return defaultSyncPreferences();
  }
}

export async function saveSyncPreferences(userId: string, preferences: SyncPreferences): Promise<void> {
  // Retry once on a stale revision: another tab may have saved a different account's choice.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stored = await readLocalValue(STORAGE_KEY);
    const users = (stored?.value as { users?: Record<string, unknown> } | null)?.users;
    try {
      await writeLocalValue(STORAGE_KEY, { users: { ...users, [userId]: preferences } }, stored?.revision ?? 0);
      return;
    } catch (reason) {
      if (!(reason instanceof LocalDataConflict) || attempt === 1) throw reason;
    }
  }
}
