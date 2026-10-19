/** Where the reader left each conversation. Kept in localStorage rather than the workspace
    snapshot: scrolling must not queue an IndexedDB write for every wheel tick. */

export type ChatScrollPosition = { top: number; atBottom: boolean };

const STORAGE_KEY = 'matrius.chat-scroll-positions';
const FLUSH_DELAY = 250;

let positions: Record<string, ChatScrollPosition> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Access can throw when storage is disabled (for example in private windows).
    return null;
  }
}

function validPosition(value: unknown): value is ChatScrollPosition {
  if (!value || typeof value !== 'object') return false;
  const { top, atBottom } = value as Partial<ChatScrollPosition>;
  return typeof top === 'number' && Number.isFinite(top) && top >= 0 && typeof atBottom === 'boolean';
}

function readAll(): Record<string, ChatScrollPosition> {
  if (positions) return positions;
  positions = {};
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return positions;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return positions;
    for (const [id, value] of Object.entries(parsed)) {
      if (validPosition(value)) positions[id] = { top: value.top, atBottom: value.atBottom };
    }
  } catch {
    // A corrupt record should behave like no saved positions.
    positions = {};
  }
  return positions;
}

export function readScrollPosition(conversationId: string): ChatScrollPosition | null {
  return readAll()[conversationId] ?? null;
}

export function rememberScrollPosition(conversationId: string, position: ChatScrollPosition) {
  const all = readAll();
  const previous = all[conversationId];
  if (previous && previous.atBottom === position.atBottom && Math.abs(previous.top - position.top) < 1) return;
  all[conversationId] = position;
  if (timer !== null) return;
  timer = setTimeout(flushScrollPositions, FLUSH_DELAY);
}

export function flushScrollPositions() {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  const target = storage();
  if (!target || !positions) return;
  try {
    target.setItem(STORAGE_KEY, JSON.stringify(positions));
  } catch {
    // Quota or disabled storage: keep the in-memory copy for this session.
  }
}

export function forgetScrollPosition(conversationId: string) {
  const all = readAll();
  if (!(conversationId in all)) return;
  delete all[conversationId];
  flushScrollPositions();
}

if (typeof window !== 'undefined') {
  // A pending debounce would otherwise be lost when the tab is closed or sent to the background.
  window.addEventListener('pagehide', flushScrollPositions);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushScrollPositions();
  });
}
