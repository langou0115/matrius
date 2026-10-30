import { createContext, useCallback, useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react';

import { useAuth } from './auth-state.web';
import { loadNetworkToolsEnabled, saveNetworkToolsEnabled } from './network-tools-preference.web';

type NetworkToolsState = {
  /** True once the workspace's preference finished loading and web tools are enabled. */
  enabled: boolean;
  ready: boolean;
  saving: boolean;
  error: string | null;
  setEnabled: (enabled: boolean) => Promise<void>;
};

type Loaded = { scope: string; enabled: boolean };
type Failure = { scope: string; message: string };

const NetworkToolsContext = createContext<NetworkToolsState | null>(null);

/** Shared by the personalization page and the chat runtime, so flipping the switch applies
    to the very next reply without a reload. Anonymous local mode uses the `local` scope, so
    the same switch works without signing in. */
export function NetworkToolsProvider({ children }: PropsWithChildren) {
  const { user } = useAuth();
  const scope = user && !user.mustChangePassword ? user.id : 'local';
  // Keying the loaded value by scope means a sign-out or account switch is reflected by
  // derivation instead of a synchronous setState in the effect.
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [savingFor, setSavingFor] = useState<string | null>(null);
  // A late load must not overwrite the preference of a scope selected afterwards.
  const generation = useRef(0);

  useEffect(() => {
    const version = ++generation.current;
    loadNetworkToolsEnabled(scope).then((enabled) => {
      if (generation.current !== version) return;
      setLoaded({ scope, enabled });
      setSavingFor(null);
    }).catch(() => {
      if (generation.current !== version) return;
      setLoaded({ scope, enabled: false });
      setFailure({ scope, message: '无法读取网络工具设置，已暂时关闭。' });
      setSavingFor(null);
    });
  }, [scope]);

  const ready = loaded?.scope === scope;
  const enabled = ready && Boolean(loaded?.enabled);
  const error = failure && failure.scope === scope ? failure.message : null;
  const saving = savingFor === scope;

  const setEnabled = useCallback(async (next: boolean) => {
    // Only accept a toggle for the scope whose preference is already loaded; otherwise the
    // async load could land after this write and restore the old value.
    if (loaded?.scope !== scope) return;
    const version = generation.current;
    const previous = loaded.enabled;
    setLoaded({ scope, enabled: next });
    setSavingFor(scope);
    setFailure(null);
    try {
      await saveNetworkToolsEnabled(scope, next);
      if (generation.current !== version) return;
      setSavingFor(null);
    } catch {
      if (generation.current !== version) return;
      setLoaded({ scope, enabled: previous });
      setSavingFor(null);
      setFailure({ scope, message: '网络工具设置未能保存，请重试。' });
    }
  }, [loaded, scope]);

  return <NetworkToolsContext value={{ enabled, ready, saving, error, setEnabled }}>{children}</NetworkToolsContext>;
}

export function useNetworkTools() {
  const value = useContext(NetworkToolsContext);
  if (!value) throw new Error('NetworkToolsProvider is required');
  return value;
}
