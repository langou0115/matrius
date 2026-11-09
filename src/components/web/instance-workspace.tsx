import { useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { router, type Href } from '@/router';

import { ApiError } from '@/core/api/auth-session';
import { StorageErrorToast } from '@/components/web/storage-error-toast';
import { ChatProvider, useChat } from '@/features/chat/chat-state';
import { DraftProvider } from '@/features/chat/draft-state';
import { resumeHref } from '@/features/chat/conversation-route-state';
import { stripMessageImages, type LoadedWorkspace, type WorkspaceData } from '@/features/workspace/workspace-repository';
import { AppearanceProvider, useAppearance } from '@/theme/appearance';
import { PreviewContext } from '@/features/workspace/preview-context';
import { ModelProvider } from '@/features/models/model-state';
import { ChatRuntimeProvider } from '@/features/chat/chat-runtime';
import { PersonalizationProvider, usePersonalization } from '@/features/settings/personalization-state';
import { MemoryProvider, useMemory } from '@/features/memory/memory-state';
import { useAuth } from '@/features/auth/auth-state';
import { createCloudWorkspaceRepository } from '@/features/workspace/cloud-workspace-repository';
import { workspaceScope } from '@/features/workspace/workspace-mode';
import { InstanceLogin } from '@/features/auth/instance-login';
import { NetworkToolsProvider } from '@/features/auth/network-tools-state';
import { readLastConversation, readLastRouteId, writeLastConversation } from '@/features/chat/last-conversation';

const ERROR_MIN_VISIBLE_MS = 5000;
type ErrorTimers = { shownAt: number; timer: ReturnType<typeof setTimeout> | undefined };

/* A transient failure used to be cleared by the next successful save 1.5s later, before its text
   could be selected. Keep the toast up long enough to read and copy it. */
function showSaveError(timers: ErrorTimers, setError: (message: string) => void, message: string) {
  if (timers.timer) clearTimeout(timers.timer);
  timers.timer = undefined;
  timers.shownAt = Date.now();
  setError(message);
}
function clearSaveErrorSoon(timers: ErrorTimers, setError: (message: string | null) => void) {
  if (timers.timer) clearTimeout(timers.timer);
  if (!timers.shownAt) return;
  const wait = Math.max(0, ERROR_MIN_VISIBLE_MS - (Date.now() - timers.shownAt));
  const finish = () => {
    timers.timer = undefined;
    timers.shownAt = 0;
    setError(null);
  };
  timers.timer = setTimeout(finish, wait);
}

/** Name the cause: "sometimes while a reply runs" is not actionable, but 429 / 5xx / network is. */
function saveErrorMessage(reason: unknown): string {
  if (reason instanceof ApiError) {
    if (reason.status === 0) return '最新修改未能保存到云端：暂时无法连接服务器。请检查网络后重试。';
    if (reason.status === 401) return '最新修改未能保存到云端：登录已失效，请重新登录后重试。';
    if (reason.status === 429) return '最新修改未能保存到云端：写入过于频繁（429）。请先保留未保存内容，稍后刷新页面。';
    return `最新修改未能保存到云端：${reason.message}（${reason.status}${reason.code ? ` ${reason.code}` : ''}）。请先保留未保存内容，再刷新页面。`;
  }
  const detail = reason instanceof Error && reason.message ? `（${reason.message}）` : '';
  return `最新修改未能保存到云端。请检查网络后重试；若其他设备已修改，请保留内容后刷新。${detail}`;
}

function WorkspacePersistence({ initial, preview, cloud, children }: PropsWithChildren<{ initial: LoadedWorkspace; preview: boolean; cloud: ReturnType<typeof createCloudWorkspaceRepository> }>) {
  const { conversations, deletedConversationIds, activeId, sidebarOpen } = useChat();
  const { themeId, mode } = useAppearance();
  const { preferences: personalization } = usePersonalization();
  const { enabled: memoryEnabled, summary: memorySummary, updatedAt: memoryUpdatedAt } = useMemory();
  const data: WorkspaceData = useMemo(() => ({ schemaVersion: 1, chat: { conversations: stripMessageImages(conversations), ...(deletedConversationIds?.length ? { deletedConversationIds } : {}), activeId, sidebarOpen }, appearance: { themeId, mode }, personalization, memory: { enabled: memoryEnabled, summary: memorySummary, updatedAt: memoryUpdatedAt } }), [conversations, deletedConversationIds, activeId, sidebarOpen, themeId, mode, personalization, memoryEnabled, memorySummary, memoryUpdatedAt]);
  const saved = useRef(JSON.stringify(initial.data));
  const queue = useRef(Promise.resolve());
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<WorkspaceData | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const errorTimers = useRef<ErrorTimers>({ shownAt: 0, timer: undefined });
  const streaming = conversations.some((conversation) => conversation.messages.some((message) => message.status === 'streaming'));

  useEffect(() => {
    if (preview) return;
    pending.current = data;
    if (!streaming && saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = undefined; }
    if (saveTimer.current) return;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = undefined;
      // Queue writes so that slower ones cannot overwrite a newer action. Read the latest
      // snapshot when the write runs: a slow server used to leave a queue of stale snapshots,
      // each re-sending content the next one was about to replace.
      queue.current = queue.current.then(async () => {
        const snapshot = pending.current;
        if (!snapshot) return;
        const serialized = JSON.stringify(snapshot);
        if (saved.current === serialized) return;
        await cloud.save(snapshot);
        saved.current = serialized;
        clearSaveErrorSoon(errorTimers.current, setError);
      }).catch((reason: unknown) => {
        showSaveError(errorTimers.current, setError, saveErrorMessage(reason));
      });
    }, streaming ? 1500 : 0);
  }, [data, preview, streaming, cloud]);
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (errorTimers.current.timer) clearTimeout(errorTimers.current.timer);
    const snapshot = pending.current;
    if (!preview && snapshot) queue.current = queue.current.then(async () => {
      if (saved.current === JSON.stringify(snapshot)) return;
      await cloud.save(snapshot);
    }).catch(() => {});
  }, [cloud, preview]);

  return <>
    {error && <StorageErrorToast message={error} />}
    <div className="persisted-workspace">{children}</div>
  </>;
}

/** The cloud workspace keeps conversations on the server but carries no activeId, so remember
    the conversation this device had open and let the next launch reopen it in place. */
function RememberLastConversation({ scope }: { scope: string }) {
  const { activeId } = useChat();
  useEffect(() => { writeLastConversation(scope, activeId); }, [scope, activeId]);
  return null;
}

export function InstanceWorkspace({ children, preview }: PropsWithChildren<{ preview: boolean }>) {
  const auth = useAuth();
  const resolved = workspaceScope(auth, preview);
  if (resolved === 'locked') return <InstanceLogin />;
  if (resolved === 'pending') return <div className="storage-screen" role="status">
    <strong>Matrius</strong>
    <p>{auth.status === 'unavailable' ? '无法连接实例，请检查网络后重试。' : '正在验证实例访问权限…'}</p>
    {auth.status === 'unavailable' && <button onClick={() => void auth.refresh()}>重新连接</button>}
  </div>;
  return <ModelProvider preview={preview}><ScopedWorkspace key={resolved} scope={resolved} preview={preview}>{children}</ScopedWorkspace></ModelProvider>;
}

/** The router updates the address bar asynchronously; keep the loading screen up until the
    conversation URL is in place so the chat screen never mounts on `/` first. */
async function waitForPath(path: string) {
  for (let attempt = 0; attempt < 60 && globalThis.location?.pathname !== path; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}

function ScopedWorkspace({ children, preview, scope }: PropsWithChildren<{ preview: boolean; scope: string }>) {
  const auth = useAuth();
  const [cloud] = useState(() => createCloudWorkspaceRepository(async <T,>(path: string, init?: RequestInit) => {
    const matches = () => {
      const current = auth.getSnapshot();
      return Boolean(current.user && !current.user.mustChangePassword);
    };
    if (!matches()) throw new Error('实例登录已失效，请重新登录。');
    const result = await auth.request<T>(path, init);
    if (!matches()) throw new Error('实例登录已失效，请重新登录。');
    return result;
  }));
  const [loaded, setLoaded] = useState<(LoadedWorkspace & { preview: boolean }) | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    async function load() {
      if (import.meta.env.DEV && preview) {
        const { createDemoWorkspace } = await import('../../../dev/fixtures/chat-workspace');
        return { data: createDemoWorkspace(), revision: 0, preview: true };
      }
      const workspace = { ...await cloud.load(), preview: false };
      // The cloud workspace has no activeId of its own; restore the one this device left off in.
      const last = readLastConversation(scope);
      if (last && workspace.data.chat.conversations.some((conversation) => conversation.id === last)) {
        workspace.data = { ...workspace.data, chat: { ...workspace.data.chat, activeId: last } };
      }
      // The page mirror is written synchronously before navigation, so it survives a quick tab
      // switch and IndexedDB revision conflicts between tabs. Prefer it over the saved activeId.
      const conversations = workspace.data.chat.conversations;
      const remembered = [last, readLastRouteId(), workspace.data.chat.activeId]
        .find((candidate) => candidate && conversations.some((conversation) => conversation.id === candidate)) ?? null;
      // A PWA relaunch, a bookmark or a reload of `/` should open the conversation the workspace
      // left off in at its own URL. Navigating before the workspace renders keeps the first paint
      // on `/c/<id>`; rendering it on `/` and redirecting afterwards visibly flickers.
      const href = preview ? null : resumeHref(globalThis.location?.pathname ?? '', remembered, conversations);
      if (href) {
        router.replace(href as Href);
        await waitForPath(href);
      }
      return workspace;
    }
    load().then((value) => { if (active) { setLoaded(value); setFailed(false); } }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [attempt, preview, scope, cloud]);

  if (!loaded) return <div className="storage-screen" role={failed ? 'alert' : 'status'}>
    <strong>Matrius</strong>
    <p>{failed ? '无法读取实例数据，请检查网络后重试。' : '正在打开你的对话空间…'}</p>
    {failed && <button onClick={() => { setFailed(false); setAttempt((current) => current + 1); }}>重新打开</button>}
  </div>;

  return <AppearanceProvider initialPreferences={loaded.data.appearance}>
    <PersonalizationProvider initialPreferences={loaded.data.personalization}><MemoryProvider initialPreferences={loaded.data.memory}><ChatProvider initialState={loaded.data.chat}><DraftProvider>
      <RememberLastConversation scope={scope} />
      <PreviewContext value={loaded.preview}><NetworkToolsProvider><ChatRuntimeProvider><WorkspacePersistence initial={loaded} preview={loaded.preview} cloud={cloud}>{children}</WorkspacePersistence></ChatRuntimeProvider></NetworkToolsProvider></PreviewContext>
    </DraftProvider></ChatProvider></MemoryProvider></PersonalizationProvider>
  </AppearanceProvider>;
}
