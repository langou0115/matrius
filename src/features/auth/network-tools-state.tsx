import { createContext, useCallback, useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react';

import { useAuth } from './auth-state';
import { loadNetworkToolsEnabled, saveNetworkToolsEnabled } from './network-tools-preference';

type NetworkToolsState = {
  /** Only true for a signed-in account that has finished loading its preference. */
  enabled: boolean;
  ready: boolean;
  saving: boolean;
  error: string | null;
  setEnabled: (enabled: boolean) => Promise<void>;
};

type Loaded = { userId: string; enabled: boolean };
type Failure = { userId: string; message: string };

const NetworkToolsContext = createContext<NetworkToolsState | null>(null);

/** Shared by the account page and the chat runtime, so flipping the switch applies to the
    very next reply without a reload. */
export function NetworkToolsProvider({ children }: PropsWithChildren) {
  const { user } = useAuth();
  const userId = user && !user.mustChangePassword ? user.id : null;
  // Keying the loaded value by account means a sign-out or account switch is reflected by
  // derivation instead of a synchronous setState in the effect.
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [savingFor, setSavingFor] = useState<string | null>(null);
  // A late load must not overwrite the preference of an account selected afterwards.
  const generation = useRef(0);

  useEffect(() => {
    if (!userId) return;
    const version = ++generation.current;
    loadNetworkToolsEnabled(userId).then((enabled) => {
      if (generation.current !== version) return;
      setLoaded({ userId, enabled });
      setSavingFor(null);
    }).catch(() => {
      if (generation.current !== version) return;
      setLoaded({ userId, enabled: false });
      setFailure({ userId, message: '无法读取网络工具设置，已暂时关闭。' });
      setSavingFor(null);
    });
  }, [userId]);

  const ready = !userId || loaded?.userId === userId;
  const enabled = Boolean(userId && ready && loaded?.enabled);
  const error = failure && failure.userId === userId ? failure.message : null;
  const saving = Boolean(userId && savingFor === userId);

  const setEnabled = useCallback(async (next: boolean) => {
    if (!userId) return;
    // Only accept a toggle for the account whose preference is already loaded; otherwise the
    // async load could land after this write and restore the old value.
    if (loaded?.userId !== userId) return;
    const version = generation.current;
    const previous = loaded.enabled;
    setLoaded({ userId, enabled: next });
    setSavingFor(userId);
    setFailure(null);
    try {
      await saveNetworkToolsEnabled(userId, next);
      if (generation.current !== version) return;
      setSavingFor(null);
    } catch {
      if (generation.current !== version) return;
      setLoaded({ userId, enabled: previous });
      setSavingFor(null);
      setFailure({ userId, message: '网络工具设置未能保存，请重试。' });
    }
  }, [loaded, userId]);

  return <NetworkToolsContext value={{ enabled, ready, saving, error, setEnabled }}>{children}</NetworkToolsContext>;
}

export function useNetworkTools() {
  const value = useContext(NetworkToolsContext);
  if (!value) throw new Error('NetworkToolsProvider is required');
  return value;
}
