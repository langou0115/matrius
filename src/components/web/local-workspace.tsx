import { useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';

import { LocalDataConflict, writeWorkspace } from '@/core/database/browser-store.web';
import { ChatProvider, useChat } from '@/features/chat/chat-state';
import { DraftProvider } from '@/features/chat/draft-state';
import { loadWorkspace, stripMessageImages, type LoadedWorkspace, type WorkspaceData } from '@/features/workspace/workspace-repository.web';
import { AppearanceProvider, useAppearance } from '@/theme/appearance';
import { PreviewContext } from '@/features/workspace/preview-context';
import { ModelProvider } from '@/features/models/model-state';
import { ChatRuntimeProvider } from '@/features/chat/chat-runtime';
import { PersonalizationProvider, usePersonalization } from '@/features/settings/personalization-state';
import { useAuth } from '@/features/auth/auth-state.web';
import { createCloudWorkspaceRepository } from '@/features/workspace/cloud-workspace-repository';
import { workspaceScope } from '@/features/workspace/workspace-mode';
import { NetworkToolsProvider } from '@/features/auth/network-tools-state.web';

function WorkspacePersistence({ initial, preview, cloud, children }: PropsWithChildren<{ initial: LoadedWorkspace; preview: boolean; cloud?: ReturnType<typeof createCloudWorkspaceRepository> }>) {
  const { conversations, deletedConversationIds, activeId, sidebarOpen } = useChat();
  const { themeId, mode } = useAppearance();
  const { preferences: personalization } = usePersonalization();
  const data: WorkspaceData = useMemo(() => ({ schemaVersion: 1, chat: { conversations: stripMessageImages(conversations), ...(deletedConversationIds?.length ? { deletedConversationIds } : {}), activeId, sidebarOpen }, appearance: { themeId, mode }, personalization }), [conversations, deletedConversationIds, activeId, sidebarOpen, themeId, mode, personalization]);
  const revision = useRef(initial.revision);
  const saved = useRef(JSON.stringify(initial.data));
  const queue = useRef(Promise.resolve());
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const pending = useRef<WorkspaceData | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const streaming = conversations.some((conversation) => conversation.messages.some((message) => message.status === 'streaming'));

  useEffect(() => {
    if (preview) return;
    pending.current = data;
    if (!streaming && saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = undefined; }
    if (saveTimer.current) return;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = undefined;
      const snapshot = pending.current;
      if (!snapshot) return;
      const serialized = JSON.stringify(snapshot);
      // Queue snapshots so that slower writes cannot overwrite a newer action.
      queue.current = queue.current.then(async () => {
        if (saved.current === serialized) return;
        if (cloud) await cloud.save(snapshot);
        else revision.current = await writeWorkspace(snapshot, revision.current);
        saved.current = serialized;
        setError(null);
      }).catch((reason: unknown) => {
        setError(reason instanceof LocalDataConflict
          ? '其他页面已更新本地数据。请先保留当前未保存的内容，再刷新页面。'
          : cloud ? '最新修改未能保存到云端。请检查网络后重试；若其他设备已修改，请保留内容后刷新。'
          : '最新修改未能保存到浏览器，关闭页面可能丢失这些修改。');
      });
    }, streaming ? (cloud ? 1500 : 300) : 0);
  }, [data, retry, preview, streaming, cloud]);
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const snapshot = pending.current;
    if (!preview && snapshot) queue.current = queue.current.then(async () => {
      if (saved.current === JSON.stringify(snapshot)) return;
      if (cloud) await cloud.save(snapshot);
      else await writeWorkspace(snapshot, revision.current);
    }).catch(() => {});
  }, [cloud, preview]);

  return <>
    {error && <div className="storage-error" role="alert"><span>{error}</span><button onClick={() => setRetry((current) => current + 1)}>重试保存</button></div>}
    <div className="persisted-workspace">{children}</div>
  </>;
}

export function LocalWorkspace({ children, preview }: PropsWithChildren<{ preview: boolean }>) {
  const auth = useAuth();
  const scope = workspaceScope(auth, preview);
  // Models and credentials belong to this browser, independent of the workspace/account.
  return <ModelProvider preview={preview}><ScopedWorkspace key={scope} scope={scope} preview={preview}>{children}</ScopedWorkspace></ModelProvider>;
}

function ScopedWorkspace({ children, preview, scope }: PropsWithChildren<{ preview: boolean; scope: string }>) {
  const auth = useAuth();
  const [cloud] = useState(() => scope.startsWith('cloud:') ? createCloudWorkspaceRepository(async <T,>(path: string, init?: RequestInit) => {
    const matches = () => {
      const current = auth.getSnapshot();
      return current.user?.id === scope.slice(6) && !current.user.mustChangePassword;
    };
    if (!matches()) throw new Error('账号已切换，请重新打开对话空间。');
    const result = await auth.request<T>(path, init);
    if (!matches()) throw new Error('账号已切换，请重新打开对话空间。');
    return result;
  }) : undefined);
  const [loaded, setLoaded] = useState<(LoadedWorkspace & { preview: boolean }) | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    if (scope === 'pending') return;
    async function load() {
      if (__DEV__ && preview) {
        const { createDemoWorkspace } = await import('../../../dev/fixtures/chat-workspace');
        return { data: createDemoWorkspace(), revision: 0, preview: true };
      }
      return { ...await (cloud ? cloud.load() : loadWorkspace()), preview: false };
    }
    load().then((value) => { if (active) { setLoaded(value); setFailed(false); } }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [attempt, preview, scope, cloud]);

  if (!loaded) return <div className="storage-screen" role={failed ? 'alert' : 'status'}>
    <strong>Matrius</strong>
    <p>{scope === 'pending' && auth.status === 'unavailable' ? '无法验证账号，请联网后重试。也可以退出登录，继续使用本机数据。' : failed ? (cloud ? '无法读取云端数据，请检查网络后重试。' : '无法读取浏览器中的本地数据，请检查网站存储权限后重试。已有数据不会被覆盖。') : '正在打开你的对话空间…'}</p>
    {scope === 'pending' && auth.status === 'unavailable' && <>
      <button onClick={() => void auth.refresh()}>重新验证</button>
      <button onClick={() => { void auth.logout().catch(() => {}); }}>退出登录并使用本地数据</button>
    </>}
    {failed && <button onClick={() => { setFailed(false); setAttempt((current) => current + 1); }}>重新打开</button>}
  </div>;

  return <AppearanceProvider initialPreferences={loaded.data.appearance}>
    <PersonalizationProvider initialPreferences={loaded.data.personalization}><ChatProvider initialState={loaded.data.chat}><DraftProvider>
      <PreviewContext value={loaded.preview}><NetworkToolsProvider><ChatRuntimeProvider><WorkspacePersistence initial={loaded} preview={loaded.preview} cloud={cloud}>{children}</WorkspacePersistence></ChatRuntimeProvider></NetworkToolsProvider></PreviewContext>
    </DraftProvider></ChatProvider></PersonalizationProvider>
  </AppearanceProvider>;
}
