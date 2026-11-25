import { useMobile } from '@/components/web/use-mobile';
import { Link, router, usePathname, type Href } from '@/router';
import { LinkAnchor } from '@/components/web/link-anchor';
import { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Clock, FolderKanban, FolderOpen, MessageSquare, SquarePen } from 'lucide-react';

import { BrandMark } from '@/components/web/brand-mark';
import { Dialog } from '@/components/web/dialog';
import { Icon } from '@/components/web/icon';
import { useInstance, useFeature } from '@/features/instance/instance-state';
import { bulkDeleteFiles, isServerFileId } from '@/features/files/files-api';
import { useChat, type Conversation } from '../chat-state';
import { conversationFileIds } from '../conversation-files';
import { ConversationMenu } from './conversation-menu';
import { ConversationSelect } from './conversation-select';
import { useIsPreview } from '@/features/workspace/preview-context';
import { isDesktopTarget } from '@/core/platform/target';
import { workHref } from '@/features/work/work-href';
import { openWorkFileSearch, readActiveProjectId, useWorkState } from '@/features/work/work-state';
import { useSidebarRouteTab, useSidebarTab, writeSidebarTab, type SidebarTab } from '../sidebar-mode';

const WorkSidebarPanel = lazy(() =>
  import('@/features/work/work-sidebar-panel').then((module) => ({ default: module.WorkSidebarPanel })),
);
import { useChatRuntime } from '../chat-runtime';
import { conversationHref } from '../conversation-href';
import { writeLastRoute } from '../last-conversation';
import { forgetScrollPosition } from '../scroll-position';

type Props = { onSearch: () => void; collapsed: boolean };

const CHAT_COLLAPSED_GROUPS_KEY = 'matrius:chat-sidebar-collapsed-groups';
const LAST_COLLAPSED_DRAWER_KEY = 'matrius:last-collapsed-drawer';
const DRAWER_WIDTH_KEY = 'matrius:sidebar-drawer-width';
const DEFAULT_DRAWER_WIDTH = 260;
const MIN_DRAWER_WIDTH = 200;
const MAX_DRAWER_WIDTH = 480;
const DRAWER_AUTO_COLLAPSE_WIDTH = 140;
let lastCollapsedDrawerTab: SidebarTab | null = null;

function clampDrawerWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_DRAWER_WIDTH;
  return Math.round(Math.min(MAX_DRAWER_WIDTH, Math.max(MIN_DRAWER_WIDTH, width)));
}

function readStoredDrawerWidth(): number {
  try {
    const raw = globalThis.localStorage?.getItem(DRAWER_WIDTH_KEY);
    if (!raw) return DEFAULT_DRAWER_WIDTH;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? clampDrawerWidth(parsed) : DEFAULT_DRAWER_WIDTH;
  } catch {
    return DEFAULT_DRAWER_WIDTH;
  }
}

function writeStoredDrawerWidth(width: number): void {
  try {
    globalThis.localStorage?.setItem(DRAWER_WIDTH_KEY, String(clampDrawerWidth(width)));
  } catch {
    // Ignore storage restrictions.
  }
}

function readLastCollapsedDrawerTab(): SidebarTab | null {
  if (lastCollapsedDrawerTab) return lastCollapsedDrawerTab;
  try {
    const value = globalThis.sessionStorage?.getItem(LAST_COLLAPSED_DRAWER_KEY);
    return value === 'work' || value === 'chat' ? value : null;
  } catch {
    return null;
  }
}

function writeLastCollapsedDrawerTab(tab: SidebarTab): void {
  lastCollapsedDrawerTab = tab;
  try {
    globalThis.sessionStorage?.setItem(LAST_COLLAPSED_DRAWER_KEY, tab);
  } catch {
    // Ignore storage restrictions.
  }
}

function readStoredCollapsedGroups(): Record<string, boolean> {
  try {
    const raw = globalThis.localStorage?.getItem(CHAT_COLLAPSED_GROUPS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const next: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value === true) next[key] = true;
    }
    return next;
  } catch {
    return {};
  }
}

function writeStoredCollapsedGroups(map: Record<string, boolean>): void {
  try {
    const active = Object.fromEntries(Object.entries(map).filter(([, value]) => value === true));
    if (Object.keys(active).length > 0) {
      globalThis.localStorage?.setItem(CHAT_COLLAPSED_GROUPS_KEY, JSON.stringify(active));
    } else {
      globalThis.localStorage?.removeItem(CHAT_COLLAPSED_GROUPS_KEY);
    }
  } catch {
    // Ignore storage restrictions.
  }
}

export function resetLastCollapsedDrawerTabForTests(): void {
  lastCollapsedDrawerTab = null;
  try {
    globalThis.sessionStorage?.removeItem(LAST_COLLAPSED_DRAWER_KEY);
  } catch {
    // Ignore storage restrictions.
  }
}

export const Sidebar = memo(function Sidebar({ onSearch, collapsed: sidebarCollapsed }: Props) {
  const { conversations, activeId, dispatch } = useChat();
  const mobile = useMobile();
  const showWorkNav = isDesktopTarget() && !mobile;
  const storedTab = useSidebarTab(showWorkNav);
  const routeTab = useSidebarRouteTab();
  const activeTab = showWorkNav ? (routeTab ?? storedTab) : 'chat';
  const runtime = useChatRuntime();
  const preview = useIsPreview();
  const instance = useInstance();
  const filesEnabled = useFeature('files');
  const tasksEnabled = useFeature('tasks');
  const workFileSearchEnabled = useFeature('work-file-search');
  const canSearchWorkFiles = workFileSearchEnabled && !preview;
  const { projects: workProjects, activeProjectId: workActiveProjectId } = useWorkState();
  const activeWorkProjectId = workActiveProjectId ?? workProjects[0]?.id ?? null;
  const searchAriaLabel = activeTab === 'work' ? '查找本机文件' : '搜索对话';
  const searchDisabled = activeTab === 'work' && (!canSearchWorkFiles || !activeWorkProjectId);
  // Removing the entry while the instance check is unreachable makes the library look deleted
  // after a backend reload. Keep it; the library page owns the retry and the explanation.
  const showLibrary = preview || filesEnabled || instance.status === 'unavailable';
  const showTasks = preview || tasksEnabled || instance.status === 'unavailable';
  const pathname = usePathname().replace(/\/$/, '');
  const libraryHref = preview ? '/mock/library' : '/library';
  const tasksHref = preview ? '/mock/tasks' : '/tasks';
  const settingsHref = preview ? '/mock/chat/settings' : '/settings';
  const onLibrary = pathname === libraryHref;
  const onTasks = pathname === tasksHref;
  const onSettings = pathname === settingsHref || pathname.startsWith(`${settingsHref}/`);
  const homeHref = preview ? '/mock/chat' : '/';
  const [editing, setEditing] = useState<Conversation | null>(null);
  const [title, setTitle] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The delete dialog offers the Library cleanup as an extra step, never by default.
  const [deleteAttachedFiles, setDeleteAttachedFiles] = useState(false);
  // The dialog's conversation can keep receiving messages, so read its live copy. Mock and
  // legacy ids still offer the option; only ids the server knows are sent to bulk delete.
  const attachedFiles = useMemo(() => {
    if (!editing) return [];
    const current = conversations.find((item) => item.id === editing.id) ?? editing;
    return conversationFileIds(current, conversations);
  }, [conversations, editing]);
  const deletableFiles = useMemo(() => attachedFiles.filter(isServerFileId), [attachedFiles]);
  const [menu, setMenu] = useState<{ conversationId: string; anchor: HTMLButtonElement } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const menuConversation = menu ? conversations.find((item) => item.id === menu.conversationId) ?? null : null;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => readStoredCollapsedGroups());
  const [drawerWidth, setDrawerWidth] = useState<number>(() => readStoredDrawerWidth());
  const [resizingDrawer, setResizingDrawer] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerDragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    drawerDragCleanupRef.current?.();
  }, []);
  const groups = useMemo(() => {
    const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    return [
      { name: '置顶', items: sorted.filter((item) => item.pinned), keepWhenEmpty: false },
      { name: '最近', items: sorted.filter((item) => !item.pinned), keepWhenEmpty: true },
    ];
  }, [conversations]);
  const visibleGroups = groups.filter((group) => group.items.length > 0 || group.keepWhenEmpty);
  const emptyGroups = useRef<Set<string>>(new Set());
  useEffect(() => {
    const empty = new Set(groups.filter((group) => group.items.length === 0).map((group) => group.name));
    const restored = [...emptyGroups.current].filter((name) => !empty.has(name));
    emptyGroups.current = empty;
    if (empty.size === 0 && restored.length === 0) return;
    setCollapsed((current) => {
      const stale = [...empty, ...restored].filter((name) => current[name]);
      if (stale.length === 0) return current;
      const next = { ...current };
      for (const name of stale) delete next[name];
      writeStoredCollapsedGroups(next);
      return next;
    });
  }, [groups]);

  function select(id: string | null) {
    if (!preview) writeLastRoute(id);
    router.push(conversationHref(id, preview));
  }

  function removeConversation(conversation: Conversation, fileIds: string[]) {
    if (fileIds.length && !preview) {
      for (let index = 0; index < fileIds.length; index += 100) {
        void bulkDeleteFiles(instance.request, fileIds.slice(index, index + 100)).catch(() => {});
      }
    }
    dispatch({ type: 'delete', id: conversation.id });
    forgetScrollPosition(conversation.id);
    if (activeId === conversation.id) {
      if (!preview) writeLastRoute(null);
      router.replace(conversationHref(null, preview));
    }
    setEditing(null);
    setDeleteAttachedFiles(false);
  }

  function openDeleteDialog(conversation: Conversation) {
    setEditing(conversation);
    setConfirmDelete(true);
    setDeleteAttachedFiles(false);
  }

  function handleSearch() {
    if (activeTab === 'work') {
      if (!canSearchWorkFiles || !activeWorkProjectId) return;
      openWorkFileSearch(activeWorkProjectId);
      return;
    }
    onSearch();
  }

  const onChatSection = activeTab === 'chat' && !onLibrary && !onTasks && !onSettings;
  const onProjectSection = showWorkNav && activeTab === 'work' && !onLibrary && !onTasks && !onSettings;
  const hasSecondaryDrawer = !onLibrary && !onTasks && !onSettings;
  const drawerOpen = hasSecondaryDrawer && !sidebarCollapsed;

  function collapseDrawer(tab: SidebarTab) {
    writeLastCollapsedDrawerTab(tab);
    if (!sidebarCollapsed) dispatch({ type: 'sidebar' });
  }

  function handleRailChatClick() {
    if (onChatSection) {
      if (drawerOpen) collapseDrawer('chat');
      else dispatch({ type: 'sidebar' });
      return;
    }
    writeSidebarTab('chat');
    const targetHref = conversationHref(activeId, preview);
    if ((pathname || '/') !== targetHref) router.push(targetHref);
    if (sidebarCollapsed) dispatch({ type: 'sidebar' });
  }

  function handleRailProjectClick() {
    if (!showWorkNav) return;
    if (onProjectSection) {
      if (drawerOpen) collapseDrawer('work');
      else dispatch({ type: 'sidebar' });
      return;
    }
    setMenu(null);
    writeSidebarTab('work');
    const targetHref = workHref(readActiveProjectId(), preview);
    if ((pathname || '/') !== targetHref) router.push(targetHref);
    if (sidebarCollapsed) dispatch({ type: 'sidebar' });
  }

  function handleRailLogoClick() {
    if (drawerOpen) {
      collapseDrawer(onProjectSection ? 'work' : 'chat');
      return;
    }
    const targetTab: SidebarTab = readLastCollapsedDrawerTab() === 'work' && showWorkNav ? 'work' : 'chat';
    if (targetTab === 'work') {
      setMenu(null);
      writeSidebarTab('work');
      const targetHref = workHref(readActiveProjectId(), preview);
      if ((pathname || '/') !== targetHref) router.push(targetHref);
    } else {
      writeSidebarTab('chat');
      const targetHref = conversationHref(activeId, preview);
      if ((pathname || '/') !== targetHref) router.push(targetHref);
    }
    if (sidebarCollapsed) dispatch({ type: 'sidebar' });
  }

  const conversationList = (
    <nav className="conversation-list" aria-label="历史对话">
      {visibleGroups.map((group) => (
        <section className="conversation-group" key={group.name}>
          <h2 className="sidebar-section-label">
            <button
              type="button"
              aria-expanded={!collapsed[group.name]}
              aria-controls={`sidebar-${group.name}`}
              onClick={() => setCollapsed((current) => {
                const next = { ...current, [group.name]: !current[group.name] };
                writeStoredCollapsedGroups(next);
                return next;
              })}
            >
              <span>{group.name}</span>
              <Icon name="chevron" size={16} />
            </button>
          </h2>
          <div id={`sidebar-${group.name}`} hidden={collapsed[group.name]}>
            {group.items.map((item) => {
              const last = item.messages.at(-1);
              const status = item.id !== activeId && runtime.isRunning(item.id) ? 'running' as const
                : item.id !== activeId && item.completedReadAt === null && last?.role === 'assistant' && last.status === 'complete' ? 'completed' as const
                  : undefined;
              return (
                <div className={`conversation-item ${activeId === item.id ? 'is-active' : ''} ${menuConversation?.id === item.id ? 'menu-open' : ''}`} key={item.id}>
                  <ConversationSelect
                    title={item.title}
                    active={activeId === item.id}
                    hasUnreadError={item.errorReadAt == null && last?.role === 'assistant' && last.status === 'error'}
                    status={status}
                    onLongPress={mobile ? (anchor) => setMenu({ conversationId: item.id, anchor }) : undefined}
                    onSelect={() => select(item.id)}
                  />
                  {(!mobile || activeId === item.id) && (
                    <button
                      className="icon-button conversation-more"
                      aria-label={`对话操作：${item.title}`}
                      aria-haspopup="menu"
                      aria-expanded={menuConversation?.id === item.id}
                      aria-controls={menuConversation?.id === item.id ? 'conversation-menu' : undefined}
                      onClick={(event) => { setMenu(menuConversation?.id === item.id ? null : { conversationId: item.id, anchor: event.currentTarget }); }}
                    >
                      <Icon name="more" size={17} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </nav>
  );

  const dialogs = (
    <>
      {menu && menuConversation && (
        <ConversationMenu
          conversation={menuConversation}
          anchor={menu.anchor}
          onClose={closeMenu}
          onPin={() => { dispatch({ type: 'pin', id: menuConversation.id }); closeMenu(); }}
          onRename={() => { menu.anchor.focus(); setEditing(menuConversation); setTitle(menuConversation.title); setConfirmDelete(false); setDeleteAttachedFiles(false); closeMenu(); }}
          onDelete={() => { menu.anchor.focus(); openDeleteDialog(menuConversation); closeMenu(); }}
        />
      )}
      {editing && (
        <Dialog
          title={confirmDelete ? '删除这段对话？' : '重命名对话'}
          onClose={() => { setEditing(null); setDeleteAttachedFiles(false); }}
          className="compact-dialog"
        >
          {confirmDelete ? (
            <>
              <p className="dialog-description">“{editing.title}”及其消息将被删除，此操作无法撤销。</p>
              {attachedFiles.length > 0 && (
                <label className="model-key-toggle dialog-checkbox">
                  <input
                    className="model-checkbox-input"
                    type="checkbox"
                    checked={deleteAttachedFiles}
                    onChange={(event) => setDeleteAttachedFiles(event.target.checked)}
                  />
                  <span className="model-checkbox" aria-hidden="true" />
                  同时删除在此聊天中上传或创建的文件
                </label>
              )}
              <div className="dialog-footer">
                <button type="button" className="secondary-button" data-autofocus onClick={() => setEditing(null)}>取消</button>
                <button type="button" className="danger-button" onClick={() => removeConversation(editing, deleteAttachedFiles ? deletableFiles : [])}>删除对话</button>
              </div>
            </>
          ) : (
            <form onSubmit={(event) => { event.preventDefault(); if (title.trim()) { dispatch({ type: 'rename', id: editing.id, title }); setEditing(null); } }}>
              <label className="field-label" htmlFor="conversation-title">对话标题</label>
              <input id="conversation-title" className="text-field" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required />
              <div className="dialog-footer"><button className="primary-button" disabled={!title.trim()}>保存名称</button></div>
            </form>
          )}
        </Dialog>
      )}
    </>
  );

  // Mobile keeps the original full-drawer layout unchanged.
  if (mobile) {
    return (
      <aside className="sidebar" aria-label="对话导航">
        <div className="sidebar-header">
          <Link href={homeHref} asChild>
            <LinkAnchor
              className="brand"
              onClick={() => { writeSidebarTab('chat'); dispatch({ type: 'select', id: null }); if (!preview) writeLastRoute(null); }}
            >
              <BrandMark size={30} />Matrius
            </LinkAnchor>
          </Link>
          <div className="sidebar-header-actions">
            <button type="button" className="icon-button" onClick={handleSearch} aria-label="搜索对话">
              <Icon name="search" size={19} />
            </button>
            <button type="button" className="icon-button" onClick={() => dispatch({ type: 'sidebar' })} aria-label="收起侧栏">
              <Icon name="sidebar" size={19} />
            </button>
          </div>
        </div>
        <nav className="sidebar-primary" aria-label="工作区">
          <button className={`new-conversation ${activeId === null && !onLibrary && !onTasks ? 'is-active' : ''}`} type="button" onClick={() => select(null)}>
            <SquarePen size={19} strokeWidth={1.75} aria-hidden="true" />
            <span>新对话</span>
          </button>
          {showLibrary && (
            <Link href={libraryHref as Href} asChild>
              <LinkAnchor className={`new-conversation ${onLibrary ? 'is-active' : ''}`} aria-current={onLibrary ? 'page' : undefined} aria-label="打开资料库">
                <FolderOpen size={19} strokeWidth={1.75} aria-hidden="true" />
                <span>资料库</span>
              </LinkAnchor>
            </Link>
          )}
          {showTasks && (
            <Link href={tasksHref as Href} asChild>
              <LinkAnchor className={`new-conversation ${onTasks ? 'is-active' : ''}`} aria-current={onTasks ? 'page' : undefined} aria-label="打开定时任务">
                <Clock size={19} strokeWidth={1.75} aria-hidden="true" />
                <span>定时任务</span>
              </LinkAnchor>
            </Link>
          )}
        </nav>
        {conversationList}
        <Link href={settingsHref as Href} asChild>
          <LinkAnchor className="sidebar-settings-entry" aria-label="打开设置">
            <span className="sidebar-settings-icon"><Icon name="settings" size={18} /></span>
            <span className="sidebar-settings-entry-text">设置</span>
          </LinkAnchor>
        </Link>
        {dialogs}
      </aside>
    );
  }

  // Desktop viewport (both dev:web and dev:desktop):
  // Persistent left Activity Rail + collapsible secondary drawer for Chat and Project.
  function startDrawerResize(startX: number) {
    drawerDragCleanupRef.current?.();
    const rectWidth = drawerRef.current?.getBoundingClientRect().width ?? 0;
    const startWidth = rectWidth > 0 ? rectWidth : drawerWidth;
    let collapsedDuringDrag = false;
    setResizingDrawer(true);

    function handleMove(moveEvent: PointerEvent) {
      const rawWidth = startWidth + (moveEvent.clientX - startX);
      if (rawWidth < DRAWER_AUTO_COLLAPSE_WIDTH) {
        if (!collapsedDuringDrag) {
          collapsedDuringDrag = true;
          collapseDrawer(onProjectSection ? 'work' : 'chat');
        }
        return;
      }
      if (collapsedDuringDrag) {
        collapsedDuringDrag = false;
        dispatch({ type: 'sidebar' });
      }
      const next = clampDrawerWidth(rawWidth);
      setDrawerWidth(next);
      writeStoredDrawerWidth(next);
    }

    function handleStop() {
      setResizingDrawer(false);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleStop);
      window.removeEventListener('pointercancel', handleStop);
      drawerDragCleanupRef.current = null;
    }

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleStop);
    window.addEventListener('pointercancel', handleStop);
    drawerDragCleanupRef.current = handleStop;
  }

  return (
    <div className={`sidebar-shell${drawerOpen ? ' is-drawer-open' : ' is-drawer-closed'}${resizingDrawer ? ' is-resizing' : ''}`}>
      <nav className="sidebar-rail" aria-label="主导航">
        <div className="sidebar-rail-header">
          <button
            type="button"
            className="sidebar-rail-brand"
            aria-label={drawerOpen ? '收起侧栏' : '展开侧栏'}
            aria-expanded={drawerOpen}
            title={drawerOpen ? '收起侧栏' : '展开侧栏'}
            onClick={handleRailLogoClick}
          >
            <span className="sidebar-rail-brand-logo" aria-hidden="true">
              <BrandMark size={26} />
            </span>
            <span className="sidebar-rail-brand-toggle" aria-hidden="true">
              <Icon name="sidebar" size={20} />
            </span>
          </button>
        </div>
        <div className="sidebar-rail-divider" aria-hidden="true" />
        <div className="sidebar-rail-top">
          <button
            type="button"
            className={`sidebar-rail-btn${onChatSection ? ' is-active' : ''}`}
            aria-label="对话"
            aria-pressed={onChatSection}
            aria-expanded={onChatSection ? drawerOpen : undefined}
            title="对话"
            onClick={handleRailChatClick}
          >
            <MessageSquare size={20} strokeWidth={1.75} aria-hidden="true" />
          </button>
          {showLibrary && (
            <Link href={libraryHref as Href} asChild>
              <LinkAnchor
                className={`sidebar-rail-btn${onLibrary ? ' is-active' : ''}`}
                aria-current={onLibrary ? 'page' : undefined}
                aria-label="打开资料库"
                title="资料库"
                onClick={() => writeSidebarTab('chat')}
              >
                <FolderOpen size={20} strokeWidth={1.75} aria-hidden="true" />
              </LinkAnchor>
            </Link>
          )}
          {showTasks && (
            <Link href={tasksHref as Href} asChild>
              <LinkAnchor
                className={`sidebar-rail-btn${onTasks ? ' is-active' : ''}`}
                aria-current={onTasks ? 'page' : undefined}
                aria-label="打开定时任务"
                title="定时任务"
                onClick={() => writeSidebarTab('chat')}
              >
                <Clock size={20} strokeWidth={1.75} aria-hidden="true" />
              </LinkAnchor>
            </Link>
          )}
          {showWorkNav && (
            <button
              type="button"
              className={`sidebar-rail-btn${onProjectSection ? ' is-active' : ''}`}
              aria-label="项目"
              aria-pressed={onProjectSection}
              aria-expanded={onProjectSection ? drawerOpen : undefined}
              title="项目"
              onClick={handleRailProjectClick}
            >
              <FolderKanban size={20} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="sidebar-rail-bottom">
          <Link href={settingsHref as Href} asChild>
            <LinkAnchor
              className={`sidebar-rail-btn${onSettings ? ' is-active' : ''}`}
              aria-current={onSettings ? 'page' : undefined}
              aria-label="打开设置"
              title="设置"
            >
              <Icon name="settings" size={20} />
            </LinkAnchor>
          </Link>
        </div>
      </nav>

      {drawerOpen && (
        <aside
          ref={drawerRef}
          className={`sidebar sidebar-drawer${resizingDrawer ? ' is-resizing' : ''}`}
          style={{ '--sidebar-drawer-width': `${drawerWidth}px` } as CSSProperties}
          aria-label={onProjectSection ? '项目导航' : '对话导航'}
        >
          <div
            className={`sidebar-drawer-resizer${resizingDrawer ? ' is-dragging' : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧边栏宽度"
            aria-valuemin={MIN_DRAWER_WIDTH}
            aria-valuemax={MAX_DRAWER_WIDTH}
            aria-valuenow={drawerWidth}
            tabIndex={0}
            onPointerDown={(event) => {
              if (event.button !== undefined && event.button !== 0) return;
              event.preventDefault();
              startDrawerResize(event.clientX);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              const step = event.shiftKey ? 32 : 16;
              const delta = event.key === 'ArrowRight' ? step : -step;
              const raw = drawerWidth + delta;
              if (raw < DRAWER_AUTO_COLLAPSE_WIDTH) {
                collapseDrawer(onProjectSection ? 'work' : 'chat');
                return;
              }
              const next = clampDrawerWidth(raw);
              setDrawerWidth(next);
              writeStoredDrawerWidth(next);
            }}
          />
          <div className="sidebar-header">
            <span className="sidebar-drawer-title">{onProjectSection ? '项目' : 'Matrius'}</span>
            <div className="sidebar-header-actions">
              {!onProjectSection && (
                <button
                  type="button"
                  className="icon-button"
                  onClick={handleSearch}
                  disabled={searchDisabled}
                  aria-label={searchAriaLabel}
                  title={searchAriaLabel}
                >
                  <Icon name="search" size={19} />
                </button>
              )}
              <button
                type="button"
                className="icon-button"
                onClick={() => collapseDrawer(onProjectSection ? 'work' : 'chat')}
                aria-label="收起侧栏"
                title="收起侧栏"
              >
                <Icon name="sidebar" size={19} />
              </button>
            </div>
          </div>

          {onProjectSection ? (
            <div className="sidebar-work-panel" id="sidebar-panel-work">
              <Suspense fallback={null}>
                <WorkSidebarPanel />
              </Suspense>
            </div>
          ) : (
            <div className="sidebar-chat-panel" id="sidebar-panel-chat">
              <nav className="sidebar-primary" aria-label="对话操作">
                <button
                  className={`new-conversation ${activeId === null && !onLibrary && !onTasks ? 'is-active' : ''}`}
                  type="button"
                  onClick={() => select(null)}
                >
                  <SquarePen size={19} strokeWidth={1.75} aria-hidden="true" />
                  <span>新对话</span>
                </button>
              </nav>
              {conversationList}
            </div>
          )}
        </aside>
      )}
      {dialogs}
    </div>
  );
});
