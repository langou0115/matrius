import { useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { router, type Href } from 'expo-router';

import { ApiError } from '@/core/api/auth-session';
import { LocalDataConflict, writeWorkspace } from '@/core/database/browser-store.web';
import { StorageErrorToast } from '@/components/web/storage-error-toast.web';
import { ChatProvider, useChat } from '@/features/chat/chat-state';
import { DraftProvider } from '@/features/chat/draft-state';
import { resumeHref } from '@/features/chat/conversation-route-state';
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
import { readLastConversation, readLastRouteId, writeLastConversation } from '@/features/chat/last-conversation.web';

const ERROR_MIN_VISIBLE_MS = 6000;
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
    // Never pull the text out from under an active selection inside the toast.
    const node = document.querySelector('.storage-error');
    const selection = globalThis.getSelection?.();
    if (node && selection && !selection.isCollapsed && selection.anchorNode && node.contains(selection.anchorNode)) {
      timers.timer = setTimeout(finish, 2000);
      return;
    }
    timers.timer = undefined;
    timers.shownAt = 0;
    setError(null);
  };
  timers.timer = setTimeout(finish, wait);
}

/** Name the cause: "sometimes while a reply runs" is not actionable, but 429 / 5xx / network is. */
function saveErrorMessage(reason: unknown, cloud: unknown): string {
  if (reason instanceof LocalDataConflict) return '其他页面已更新本地数据。请先保留当前未保存的内容，再刷新页面。';
  if (!cloud) return '最新修改未能保存到浏览器，关闭页面可能丢失这些修改。';
  if (reason instanceof ApiError) {
    if (reason.status === 0) return '最新修改未能保存到云端：暂时无法连接服务器。请检查网络后重试。';
    if (reason.status === 401) return '最新修改未能保存到云端：登录已失效，请重新登录后重试。';
    if (reason.status === 429) return '最新修改未能保存到云端：写入过于频繁（429），请稍等片刻再点“重试保存”。';
    return `最新修改未能保存到云端：${reason.message}（${reason.status}${reason.code ? ` ${reason.code}` : ''}）。内容已保留，可重试保存。`;
  }
  const detail = reason instanceof Error && reason.message ? `（${reason.message}）` : '';
  return `最新修改未能保存到云端。请检查网络后重试；若其他设备已修改，请保留内容后刷新。${detail}`;
}

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
        if (cloud) await cloud.save(snapshot);
        else revision.current = await writeWorkspace(snapshot, revision.current);
        saved.current = serialized;
        clearSaveErrorSoon(errorTimers.current, setError);
      }).catch((reason: unknown) => {
        showSaveError(errorTimers.current, setError, saveErrorMessage(reason, cloud));
      });
    }, streaming ? (cloud ? 1500 : 300) : 0);
  }, [data, retry, preview, streaming, cloud]);
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (errorTimers.current.timer) clearTimeout(errorTimers.current.timer);
    const snapshot = pending.current;
    if (!preview && snapshot) queue.current = queue.current.then(async () => {
      if (saved.current === JSON.stringify(snapshot)) return;
      if (cloud) await cloud.save(snapshot);
      else await writeWorkspace(snapshot, revision.current);
    }).catch(() => {});
  }, [cloud, preview]);

  return <>
    {error && <StorageErrorToast message={error} onRetry={() => setRetry((current) => current + 1)} />}
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

export function LocalWorkspace({ children, preview }: PropsWithChildren<{ preview: boolean }>) {
  const auth = useAuth();
  const resolved = workspaceScope(auth, preview);
  // Coming back to the tab re-checks the session. An anonymous workspace used to turn into
  // `pending` for that moment, which unmounted the whole app: the URL was reset to `/`, the
  // selected conversation was cleared and local mode landed on the new-conversation screen.
  // Keep the last resolved workspace mounted while the check runs; a real sign-in/out still
  // switches scope as soon as the new state resolves.
  const lastResolved = useRef<string | null>(null);
  if (resolved !== 'pending') lastResolved.current = resolved;
  const scope = resolved === 'pending' && lastResolved.current ? lastResolved.current : resolved;
  // Models and credentials belong to this browser, independent of the workspace/account.
  return <ModelProvider preview={preview}><ScopedWorkspace key={scope} scope={scope} preview={preview}>{children}</ScopedWorkspace></ModelProvider>;
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
      const workspace = { ...await (cloud ? cloud.load() : loadWorkspace()), preview: false };
      // The cloud workspace has no activeId of its own; restore the one this device left off in.
      const last = cloud ? readLastConversation(scope) : null;
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
    <p>{scope === 'pending' && auth.status === 'unavailable' ? '无法验证账号，请联网后重试。也可以退出登录，继续使用本机数据。' : failed ? (cloud ? '无法读取云端数据，请检查网络后重试。' : '无法读取浏览器中的本地数据，请检查网站存储权限后重试。已有数据不会被覆盖。') : '正在打开你的对话空间…'}</p>
    {scope === 'pending' && auth.status === 'unavailable' && <>
      <button onClick={() => void auth.refresh()}>重新验证</button>
      <button onClick={() => { void auth.logout().catch(() => {}); }}>退出登录并使用本地数据</button>
    </>}
    {failed && <button onClick={() => { setFailed(false); setAttempt((current) => current + 1); }}>重新打开</button>}
  </div>;

  return <AppearanceProvider initialPreferences={loaded.data.appearance}>
    <PersonalizationProvider initialPreferences={loaded.data.personalization}><ChatProvider initialState={loaded.data.chat}><DraftProvider>
      {cloud && <RememberLastConversation scope={scope} />}
      <PreviewContext value={loaded.preview}><NetworkToolsProvider><ChatRuntimeProvider><WorkspacePersistence initial={loaded} preview={loaded.preview} cloud={cloud}>{children}</WorkspacePersistence></ChatRuntimeProvider></NetworkToolsProvider></PreviewContext>
    </DraftProvider></ChatProvider></PersonalizationProvider>
  </AppearanceProvider>;
}
