import { useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';

import { LocalDataConflict, writeWorkspace } from '@/core/database/browser-store.web';
import { ChatProvider, useChat } from '@/features/chat/chat-state';
import { DraftProvider } from '@/features/chat/draft-state';
import { loadWorkspace, type LoadedWorkspace, type WorkspaceData } from '@/features/workspace/workspace-repository.web';
import { AppearanceProvider, useAppearance } from '@/theme/appearance';
import { PreviewContext } from '@/features/workspace/preview-context';
import { ModelProvider } from '@/features/models/model-state';
import { ChatRuntimeProvider } from '@/features/chat/chat-runtime';

function WorkspacePersistence({ initial, preview, children }: PropsWithChildren<{ initial: LoadedWorkspace; preview: boolean }>) {
  const { conversations, activeId, sidebarOpen, lastThinkingEffort } = useChat();
  const { themeId, mode } = useAppearance();
  const data: WorkspaceData = useMemo(() => ({ schemaVersion: 1, chat: { conversations, activeId, sidebarOpen, lastThinkingEffort }, appearance: { themeId, mode } }), [conversations, activeId, sidebarOpen, lastThinkingEffort, themeId, mode]);
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
        revision.current = await writeWorkspace(snapshot, revision.current);
        saved.current = serialized;
        setError(null);
      }).catch((reason: unknown) => {
        setError(reason instanceof LocalDataConflict
          ? '其他页面已更新本地数据。请先保留当前未保存的内容，再刷新页面。'
          : '最新修改未能保存到浏览器，关闭页面可能丢失这些修改。');
      });
    }, streaming ? 300 : 0);
  }, [data, retry, preview, streaming]);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  return <>
    {error && <div className="storage-error" role="alert"><span>{error}</span><button onClick={() => setRetry((current) => current + 1)}>重试保存</button></div>}
    <div className="persisted-workspace">{children}</div>
  </>;
}

export function LocalWorkspace({ children, preview }: PropsWithChildren<{ preview: boolean }>) {
  const [loaded, setLoaded] = useState<(LoadedWorkspace & { preview: boolean }) | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    async function load() {
      if (__DEV__ && preview) {
        const { createDemoWorkspace } = await import('../../../dev/fixtures/chat-workspace');
        return { data: createDemoWorkspace(), revision: 0, preview: true };
      }
      return { ...await loadWorkspace(), preview: false };
    }
    load().then((value) => { if (active) { setLoaded(value); setFailed(false); } }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [attempt, preview]);

  if (!loaded) return <div className="storage-screen" role={failed ? 'alert' : 'status'}>
    <strong>Matrius</strong>
    <p>{failed ? '无法读取浏览器中的本地数据，请检查网站存储权限后重试。已有数据不会被覆盖。' : '正在打开你的对话空间…'}</p>
    {failed && <button onClick={() => { setFailed(false); setAttempt((current) => current + 1); }}>重新打开</button>}
  </div>;

  return <AppearanceProvider initialPreferences={loaded.data.appearance}>
    <ChatProvider initialState={loaded.data.chat}><DraftProvider>
      <PreviewContext value={loaded.preview}><ModelProvider preview={loaded.preview}><ChatRuntimeProvider><WorkspacePersistence initial={loaded} preview={loaded.preview}>{children}</WorkspacePersistence></ChatRuntimeProvider></ModelProvider></PreviewContext>
    </DraftProvider></ChatProvider>
  </AppearanceProvider>;
}
