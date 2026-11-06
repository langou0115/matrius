import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';

import { useChat } from '@/features/chat/chat-state';
import { usePersonalization } from '@/features/settings/personalization-state';
import { useAppearance } from '@/theme/appearance';
import { loadLastSyncedAt, saveLastSyncedAt, syncAccount } from './account-sync';
import { useAuth } from './auth-state';
import { loadSyncPreferences } from './sync-preferences';

export type AccountSyncPhase = 'idle' | 'syncing' | 'done' | 'error';

export type AccountSyncState = {
  phase: AccountSyncPhase;
  lastSyncedAt: number | null;
  error: string | null;
  pulled: number;
  uploaded: number;
};

type AccountSyncContextValue = AccountSyncState & { syncNow: () => void };

/** Local changes are batched before uploading; a fixed visible-tab interval catches the rest. */
const AUTO_SYNC_INTERVAL_MS = 5 * 60_000;
const CHANGE_DEBOUNCE_MS = 60_000;
const FOCUS_SYNC_MIN_GAP_MS = 60_000;

const idleState: AccountSyncState = { phase: 'idle', lastSyncedAt: null, error: null, pulled: 0, uploaded: 0 };

const AccountSyncContext = createContext<AccountSyncContextValue | null>(null);

export function AccountSyncProvider({ children, preview }: PropsWithChildren<{ preview: boolean }>) {
  const auth = useAuth();
  const { conversations, deletedConversationIds, dispatch } = useChat();
  const { themeId, mode } = useAppearance();
  const { preferences: personalization } = usePersonalization();
  const [state, setState] = useState<AccountSyncState>(idleState);
  const latest = useRef({ auth, conversations, deletedConversationIds, appearance: { themeId, mode }, personalization });
  latest.current = { auth, conversations, deletedConversationIds, appearance: { themeId, mode }, personalization };
  const running = useRef(false);
  const rerun = useRef(false);
  const lastAttempt = useRef(0);

  const runSync = useCallback(async (): Promise<void> => {
    const current = latest.current;
    const session = current.auth;
    if (preview || session.status !== 'authenticated' || !session.user || session.user.mustChangePassword) return;
    if (running.current) { rerun.current = true; return; }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    running.current = true;
    lastAttempt.current = Date.now();
    setState((previous) => ({ ...previous, phase: 'syncing', error: null }));
    const isCurrentSession = () => session.getSnapshot().status === 'authenticated'
      && session.getSnapshot().user?.id === session.user?.id;
    try {
      const preferences = await loadSyncPreferences(session.user.id);
      const result = await syncAccount(async <T,>(path: string, init?: RequestInit): Promise<T> => {
        if (!isCurrentSession()) throw new Error('Account changed during sync');
        const result = await session.request<T>(path, init);
        if (!isCurrentSession()) throw new Error('Account changed during sync');
        return result;
      }, {
        chat: { conversations: current.conversations, deletedConversationIds: current.deletedConversationIds },
        appearance: current.appearance,
        personalization: current.personalization,
      }, preferences);
      if (!isCurrentSession()) return;
      dispatch({ type: 'merge-sync', conversations: result.pulled, deletedConversationIds: result.deletedConversationIds });
      const syncedAt = Date.now();
      await saveLastSyncedAt(session.user.id, syncedAt);
      if (!isCurrentSession()) return;
      setState({
        phase: 'done',
        lastSyncedAt: syncedAt,
        error: result.failed.length ? '部分内容未能同步，稍后会自动重试。' : null,
        pulled: result.pulled.length,
        uploaded: result.uploadedConversations + result.updatedConversations,
      });
    } catch (reason) {
      if (!isCurrentSession()) return;
      setState((previous) => ({
        ...previous,
        phase: 'error',
        error: reason instanceof Error ? reason.message : '同步失败，请稍后重试。',
      }));
    } finally {
      running.current = false;
      if (rerun.current) { rerun.current = false; void runSync(); }
    }
  }, [dispatch, preview]);

  const syncNow = useCallback(() => { void runSync(); }, [runSync]);

  // Deletion should reach the server promptly, even if an older upload is in flight.
  const previousDeletions = useRef(deletedConversationIds);
  useEffect(() => {
    const previous = previousDeletions.current;
    previousDeletions.current = deletedConversationIds;
    if (deletedConversationIds?.some((id) => !previous?.includes(id))) void runSync();
  }, [deletedConversationIds, runSync]);

  useEffect(() => {
    const userId = auth.user?.id;
    lastAttempt.current = 0;
    setState(idleState);
    if (!userId) return;
    let active = true;
    loadLastSyncedAt(userId).then((lastSyncedAt) => {
      if (active && lastSyncedAt !== null) setState((previous) => ({ ...previous, lastSyncedAt }));
    });
    return () => { active = false; };
  }, [auth.user?.id]);

  const authenticated = auth.status === 'authenticated' && Boolean(auth.user) && !auth.user?.mustChangePassword;

  useEffect(() => {
    if (preview || !authenticated) return;
    // A fresh page load or a restored session syncs once; later visibility changes are
    // throttled so token revalidation does not turn into a request storm.
    if (Date.now() - lastAttempt.current >= FOCUS_SYNC_MIN_GAP_MS) void runSync();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) void runSync();
    }, AUTO_SYNC_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine
        && Date.now() - lastAttempt.current >= FOCUS_SYNC_MIN_GAP_MS) void runSync();
    };
    const onOnline = () => { void runSync(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [authenticated, auth.user?.id, preview, runSync]);

  useEffect(() => {
    if (preview || !authenticated) return;
    // Conversations and preferences change in bursts (streaming, editing), so only the quiet
    // period after the last edit is uploaded instead of sending every intermediate snapshot.
    const timer = window.setTimeout(() => { void runSync(); }, CHANGE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [authenticated, preview, runSync, conversations, themeId, mode, personalization]);

  const value = useMemo(() => ({ ...state, syncNow }), [state, syncNow]);
  return <AccountSyncContext value={value}>{children}</AccountSyncContext>;
}

export function useAccountSync() {
  const value = useContext(AccountSyncContext);
  if (!value) throw new Error('AccountSyncProvider is required');
  return value;
}
