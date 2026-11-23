import { useMobile } from '@/components/web/use-mobile';
import { Link, router, usePathname, type Href } from '@/router';
import { LinkAnchor } from '@/components/web/link-anchor';
import { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Clock, FolderOpen, SquarePen } from 'lucide-react';

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

export const Sidebar = memo(function Sidebar({ onSearch, collapsed: sidebarCollapsed }: Props) {
  const { conversations, activeId, dispatch } = useChat();
  const mobile = useMobile();
  const showModeSwitch = isDesktopTarget() && !mobile;
  const storedTab = useSidebarTab(showModeSwitch);
  const routeTab = useSidebarRouteTab();
  const activeTab = showModeSwitch ? (routeTab ?? storedTab) : 'chat';
  const workTabRef = useRef<HTMLButtonElement>(null);
  const chatTabRef = useRef<HTMLButtonElement>(null);
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
  const onLibrary = pathname === libraryHref;
  const onTasks = pathname === tasksHref;
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
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => {
    const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    return [
      { name: '置顶', items: sorted.filter((item) => item.pinned), keepWhenEmpty: false },
      { name: '最近', items: sorted.filter((item) => !item.pinned), keepWhenEmpty: true },
    ];
  }, [conversations]);
  // An empty 置顶 is just a label that pushes the list down, so it renders nothing. 最近 is the
  // fixed history section and keeps its heading even with no conversations, so the sidebar does
  // not lose that anchor on a fresh instance.
  const visibleGroups = groups.filter((group) => group.items.length > 0 || group.keepWhenEmpty);
  // A folded group must not stay folded while it has nothing to show, and must not come back
  // folded around its first conversation either: 置顶 is hidden while empty, and the empty 最近
  // heading has nothing to hide. Clear the leftover state on both edges of the empty transition.
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
      return next;
    });
  }, [groups]);
  function select(id: string | null) {
    // Record the choice before navigating; the workspace save is asynchronous and a quick
    // tab switch can happen before it lands.
    if (!preview) writeLastRoute(id);
    router.push(conversationHref(id, preview));
  }
  /** Deletes the conversation, and optionally the Library files only it still references. */
  function removeConversation(conversation: Conversation, fileIds: string[]) {
    // Cleanup happens beside the deletion: a failed request leaves the files in the Library.
    if (fileIds.length && !preview) {
      // Bulk delete takes at most 100 ids, so an attachment-heavy conversation is split up.
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
  function switchTab(next: SidebarTab, focus = false) {
    if (next !== activeTab) {
      if (next === 'work') setMenu(null);
      writeSidebarTab(next);
      const targetHref = next === 'work'
        ? workHref(readActiveProjectId(), preview)
        : conversationHref(activeId, preview);
      if ((pathname || '/') !== targetHref) router.push(targetHref);
    }
    if (!focus) return;
    const target = next === 'work' ? workTabRef.current : chatTabRef.current;
    target?.focus();
  }
  function handleTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      switchTab(activeTab === 'work' ? 'chat' : 'work', true);
    } else if (event.key === 'Home') {
      event.preventDefault();
      switchTab('work', true);
    } else if (event.key === 'End') {
      event.preventDefault();
      switchTab('chat', true);
    }
  }

  const chatNavigation = (
    <>
      <nav className="sidebar-primary" aria-label="工作区">
        <button className={`new-conversation ${activeId === null && !onLibrary && !onTasks ? 'is-active' : ''}`} type="button" onClick={() => select(null)}><SquarePen size={19} strokeWidth={1.75} aria-hidden="true" /><span>新对话</span></button>
        {showLibrary && <Link href={libraryHref as Href} asChild>
          <LinkAnchor className={`new-conversation ${onLibrary ? 'is-active' : ''}`}
            aria-current={onLibrary ? 'page' : undefined} aria-label="打开资料库">
            <FolderOpen size={19} strokeWidth={1.75} aria-hidden="true" /><span>资料库</span>
          </LinkAnchor>
        </Link>}
        {showTasks && <Link href={tasksHref as Href} asChild>
          <LinkAnchor className={`new-conversation ${onTasks ? 'is-active' : ''}`}
            aria-current={onTasks ? 'page' : undefined} aria-label="打开定时任务">
            <Clock size={19} strokeWidth={1.75} aria-hidden="true" /><span>定时任务</span>
          </LinkAnchor>
        </Link>}
      </nav>
      <nav className="conversation-list" aria-label="历史对话">
        {visibleGroups.map((group) => (
          <section className="conversation-group" key={group.name}>
            <h2 className="sidebar-section-label"><button type="button" aria-expanded={!collapsed[group.name]} aria-controls={`sidebar-${group.name}`} onClick={() => setCollapsed((current) => ({ ...current, [group.name]: !current[group.name] }))}><span>{group.name}</span><Icon name="chevron" size={16} /></button></h2>
            <div id={`sidebar-${group.name}`} hidden={collapsed[group.name]}>
            {group.items.map((item) => {
              const last = item.messages.at(-1);
              // Status is only meaningful while the conversation is not the one on screen;
              // a background run wins over an older unread completion.
              const status = item.id !== activeId && runtime.isRunning(item.id) ? 'running' as const
                : item.id !== activeId && item.completedReadAt === null && last?.role === 'assistant' && last.status === 'complete' ? 'completed' as const
                  : undefined;
              return <div className={`conversation-item ${activeId === item.id ? 'is-active' : ''} ${menuConversation?.id === item.id ? 'menu-open' : ''}`} key={item.id}>
                <ConversationSelect title={item.title} active={activeId === item.id}
                  hasUnreadError={item.errorReadAt == null && last?.role === 'assistant' && last.status === 'error'}
                  status={status}
                  onLongPress={mobile ? (anchor) => setMenu({ conversationId: item.id, anchor }) : undefined}
                  onSelect={() => select(item.id)} />
                {(!mobile || activeId === item.id) && <button className="icon-button conversation-more" aria-label={`对话操作：${item.title}`} aria-haspopup="menu" aria-expanded={menuConversation?.id === item.id} aria-controls={menuConversation?.id === item.id ? 'conversation-menu' : undefined} onClick={(event) => { setMenu(menuConversation?.id === item.id ? null : { conversationId: item.id, anchor: event.currentTarget }); }}><Icon name="more" size={17} /></button>}
              </div>;
            })}
            </div>
          </section>
        ))}
      </nav>
    </>
  );

  const settingsHref = preview ? '/mock/chat/settings' : '/settings';
  const onSettings = pathname === settingsHref || pathname.startsWith(`${settingsHref}/`);
  const onChatNew = activeId === null && !onLibrary && !onTasks && !onSettings;

  function handleSearch() {
    if (activeTab === 'work') {
      if (!canSearchWorkFiles || !activeWorkProjectId) return;
      openWorkFileSearch(activeWorkProjectId);
      return;
    }
    onSearch();
  }

  if (sidebarCollapsed && !mobile) {
    return (
      <aside className="sidebar is-collapsed" aria-label={activeTab === 'work' ? '工作导航' : '对话导航'}>
        <div className="sidebar-rail-header">
          <button
            type="button"
            className="sidebar-rail-btn"
            aria-label="展开侧栏"
            aria-expanded={false}
            onClick={() => dispatch({ type: 'sidebar' })}
          >
            <Icon name="sidebar" size={20} />
          </button>
        </div>
        <div className="sidebar-rail-divider" aria-hidden="true" />
        <div className="sidebar-rail-top">
          {activeTab === 'work' ? (
            <>
              <Suspense fallback={null}>
                <WorkSidebarPanel collapsed />
              </Suspense>
              <button
                type="button"
                className="sidebar-rail-btn"
                aria-label="查找本机文件"
                disabled={searchDisabled}
                onClick={handleSearch}
              >
                <Icon name="search" size={20} />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={`sidebar-rail-btn ${onChatNew ? 'is-active' : ''}`}
                aria-label="新对话"
                onClick={() => select(null)}
              >
                <SquarePen size={20} strokeWidth={1.75} aria-hidden="true" />
              </button>
              {showLibrary && (
                <Link href={libraryHref as Href} asChild>
                  <LinkAnchor
                    className={`sidebar-rail-btn ${onLibrary ? 'is-active' : ''}`}
                    aria-current={onLibrary ? 'page' : undefined}
                    aria-label="打开资料库"
                  >
                    <FolderOpen size={20} strokeWidth={1.75} aria-hidden="true" />
                  </LinkAnchor>
                </Link>
              )}
              {showTasks && (
                <Link href={tasksHref as Href} asChild>
                  <LinkAnchor
                    className={`sidebar-rail-btn ${onTasks ? 'is-active' : ''}`}
                    aria-current={onTasks ? 'page' : undefined}
                    aria-label="打开定时任务"
                  >
                    <Clock size={20} strokeWidth={1.75} aria-hidden="true" />
                  </LinkAnchor>
                </Link>
              )}
              <button
                type="button"
                className="sidebar-rail-btn"
                aria-label="搜索对话"
                onClick={handleSearch}
              >
                <Icon name="search" size={20} />
              </button>
            </>
          )}
        </div>
        <div className="sidebar-rail-bottom">
          <Link href={settingsHref as Href} asChild>
            <LinkAnchor
              className={`sidebar-rail-btn ${onSettings ? 'is-active' : ''}`}
              aria-current={onSettings ? 'page' : undefined}
              aria-label="打开设置"
            >
              <Icon name="settings" size={20} />
            </LinkAnchor>
          </Link>
        </div>
      </aside>
    );
  }

  return (
    <aside className="sidebar" aria-label={activeTab === 'work' ? '工作导航' : '对话导航'}>
      <div className="sidebar-header">
        <Link href={homeHref} asChild><LinkAnchor className="brand" onClick={() => { writeSidebarTab('chat'); dispatch({ type: 'select', id: null }); if (!preview) writeLastRoute(null); }}><BrandMark size={30} />Matrius</LinkAnchor></Link>
        <div className="sidebar-header-actions">
          <button
            type="button"
            className="icon-button"
            onClick={handleSearch}
            disabled={searchDisabled}
            aria-label={searchAriaLabel}
          >
            <Icon name="search" size={19} />
          </button>
          <button type="button" className="icon-button" onClick={() => dispatch({ type: 'sidebar' })} aria-label="收起侧栏"><Icon name="sidebar" size={19} /></button>
        </div>
      </div>
      {showModeSwitch ? <>
        <div className="sidebar-mode-switch" role="tablist" aria-label="侧栏切换" onKeyDown={handleTabKeyDown}>
          <button
            ref={workTabRef}
            type="button"
            role="tab"
            id="sidebar-tab-work"
            className={`sidebar-mode-tab ${activeTab === 'work' ? 'is-active' : ''}`}
            aria-selected={activeTab === 'work'}
            aria-controls="sidebar-panel-work"
            tabIndex={activeTab === 'work' ? 0 : -1}
            onClick={() => switchTab('work')}
          >
            工作
          </button>
          <button
            ref={chatTabRef}
            type="button"
            role="tab"
            id="sidebar-tab-chat"
            className={`sidebar-mode-tab ${activeTab === 'chat' ? 'is-active' : ''}`}
            aria-selected={activeTab === 'chat'}
            aria-controls="sidebar-panel-chat"
            tabIndex={activeTab === 'chat' ? 0 : -1}
            onClick={() => switchTab('chat')}
          >
            对话
          </button>
        </div>
        {activeTab === 'work' ? (
          <div
            className="sidebar-work-panel"
            id="sidebar-panel-work"
            role="tabpanel"
            aria-labelledby="sidebar-tab-work"
          >
            <Suspense fallback={null}>
              <WorkSidebarPanel />
            </Suspense>
          </div>
        ) : (
          <div
            className="sidebar-chat-panel"
            id="sidebar-panel-chat"
            role="tabpanel"
            aria-labelledby="sidebar-tab-chat"
          >
            {chatNavigation}
          </div>
        )}
      </> : chatNavigation}
      <Link href={preview ? '/mock/chat/settings' : '/settings'} asChild><LinkAnchor className="sidebar-settings-entry" aria-label="打开设置">
        <span className="sidebar-settings-icon"><Icon name="settings" size={18} /></span>
        <span className="sidebar-settings-entry-text">设置</span>
      </LinkAnchor></Link>
      {menu && menuConversation && <ConversationMenu conversation={menuConversation} anchor={menu.anchor} onClose={closeMenu}
        onPin={() => { dispatch({ type: 'pin', id: menuConversation.id }); closeMenu(); }}
        onRename={() => { menu.anchor.focus(); setEditing(menuConversation); setTitle(menuConversation.title); setConfirmDelete(false); setDeleteAttachedFiles(false); closeMenu(); }}
        onDelete={() => { menu.anchor.focus(); openDeleteDialog(menuConversation); closeMenu(); }}
      />}
      {editing && <Dialog title={confirmDelete ? '删除这段对话？' : '重命名对话'}
        onClose={() => { setEditing(null); setDeleteAttachedFiles(false); }} className="compact-dialog">
        {confirmDelete ? <>
          <p className="dialog-description">“{editing.title}”及其消息将被删除，此操作无法撤销。</p>
          {attachedFiles.length > 0 && <label className="model-key-toggle dialog-checkbox">
            <input className="model-checkbox-input" type="checkbox" checked={deleteAttachedFiles}
              onChange={(event) => setDeleteAttachedFiles(event.target.checked)} />
            <span className="model-checkbox" aria-hidden="true" />
            同时删除在此聊天中上传或创建的文件
          </label>}
          <div className="dialog-footer">
            <button type="button" className="secondary-button" data-autofocus onClick={() => setEditing(null)}>取消</button>
            <button type="button" className="danger-button" onClick={() => removeConversation(editing, deleteAttachedFiles ? deletableFiles : [])}>删除对话</button>
          </div>
        </> : <>
          <form onSubmit={(event) => { event.preventDefault(); if (title.trim()) { dispatch({ type: 'rename', id: editing.id, title }); setEditing(null); } }}>
            <label className="field-label" htmlFor="conversation-title">对话标题</label>
            <input id="conversation-title" className="text-field" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required />
            <div className="dialog-footer"><button className="primary-button" disabled={!title.trim()}>保存名称</button></div>
          </form>
        </>}
      </Dialog>}
    </aside>
  );
});
