import { createContext, useContext, useEffect, useState, useSyncExternalStore, type PropsWithChildren } from 'react';
import { createInstanceClient } from '@/core/api/instance-client';
import { hasFeature } from '@/core/features/capabilities';
import { createInstanceRetry } from './instance-retry';

const InstanceContext = createContext<(ReturnType<typeof createInstanceClient> & { isPreview: boolean }) | null>(null);

export function InstanceProvider({ children, preview }: PropsWithChildren<{ preview: boolean }>) {
  const [client] = useState(() => Object.assign(createInstanceClient(), { isPreview: preview }));
  useEffect(() => {
    if (preview) return;
    void client.refresh();
    const refresh = () => { if (document.visibilityState === 'visible') void client.refresh(); };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', refresh);
    const retry = createInstanceRetry({ getStatus: () => client.getSnapshot().status, refresh: client.refresh, subscribe: client.subscribe,
      isVisible: () => document.visibilityState === 'visible' });
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('online', refresh);
      retry.dispose();
    };
  }, [client, preview]);
  return <InstanceContext value={client}>{children}</InstanceContext>;
}

export function useInstance() {
  const client = useContext(InstanceContext);
  if (!client) throw new Error('InstanceProvider is required.');
  return { ...useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot), ...client };
}

export function useFeature(feature: string) {
  const instance = useInstance();
  return hasFeature(instance.info, feature);
}

export function FeatureGate({ name, children }: PropsWithChildren<{ name: string }>) {
  return useFeature(name) ? children : null;
}
