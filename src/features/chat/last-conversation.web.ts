/** Which conversation this device had open. Navigation state, not content: the cloud
    workspace deliberately carries no `activeId`, but reopening the app should still land
    on the conversation the device left off in. Kept per workspace scope so switching
    accounts never reopens another account's conversation. */

const STORAGE_PREFIX = 'matrius.last-conversation:';
/** The last `/c/<id>` page this device rendered, independent of the persisted workspace.
    IndexedDB writes can lag behind a quick tab switch or lose a revision race between
    tabs; this synchronous mirror is what makes "come back to the site" reliable. */
const ROUTE_KEY = 'matrius.last-route';
const CONVERSATION_PATH = /^\/c\/([^/]+)$/;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Access can throw when storage is disabled (for example in private windows).
    return null;
  }
}

export function readLastConversation(scope: string): string | null {
  try {
    return storage()?.getItem(`${STORAGE_PREFIX}${scope}`) || null;
  } catch {
    return null;
  }
}

export function writeLastConversation(scope: string, conversationId: string | null) {
  try {
    const target = storage();
    if (!target) return;
    const key = `${STORAGE_PREFIX}${scope}`;
    if (conversationId) target.setItem(key, conversationId);
    else target.removeItem(key);
  } catch {
    // Quota or disabled storage: the next page load simply starts a new conversation.
  }
}

/** The conversation id in the remembered `/c/<id>` path, if one is stored. */
export function readLastRouteId(): string | null {
  try {
    const path = storage()?.getItem(ROUTE_KEY);
    const match = path ? CONVERSATION_PATH.exec(path) : null;
    if (!match) return null;
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** Remember the conversation page on screen. Pass null when the user deliberately starts a
    new conversation (or deletes the one they were reading), so the next launch respects it. */
export function writeLastRoute(conversationId: string | null) {
  try {
    const target = storage();
    if (!target) return;
    if (conversationId) target.setItem(ROUTE_KEY, `/c/${encodeURIComponent(conversationId)}`);
    else target.removeItem(ROUTE_KEY);
  } catch {
    // Quota or disabled storage: fall back to the persisted activeId.
  }
}
