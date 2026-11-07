import { useMobile } from '@/components/web/use-mobile';
import { Link, router, usePathname, type Href } from '@/router';
import { LinkAnchor } from '@/components/web/link-anchor';
import { memo, useCallback, useState } from 'react';
import { FolderOpen, SquarePen } from 'lucide-react';

import { BrandMark } from '@/components/web/brand-mark';
import { Dialog } from '@/components/web/dialog';
import { Icon } from '@/components/web/icon';
import { useAuth, useFeature } from '@/features/auth/auth-state';
import { useChat, type Conversation } from '../chat-state';
import { ConversationMenu } from './conversation-menu';
import { ConversationSelect } from './conversation-select';
import { useIsPreview } from '@/features/workspace/preview-context';
import { useChatRuntime } from '../chat-runtime';
import { conversationHref } from '../conversation-href';
import { writeLastRoute } from '../last-conversation';
import { forgetScrollPosition } from '../scroll-position';

type Props = { onSearch: () => void; collapsed: boolean };

export const Sidebar = memo(function Sidebar({ onSearch, collapsed: sidebarCollapsed }: Props) {
  const { conversations, activeId, dispatch } = useChat();
  const mobile = useMobile();
  const runtime = useChatRuntime();
  const preview = useIsPreview();
  const auth = useAuth();
  const filesEnabled = useFeature('files');
  // Removing the entry while the account check is unreachable makes the library look deleted
  // after a backend reload. Keep it; the library page owns the retry and the explanation.
  const showLibrary = preview || filesEnabled || auth.status === 'unavailable';
  const pathname = usePathname().replace(/\/$/, '');
  const libraryHref = preview ? '/mock/library' : '/library';
  const onLibrary = pathname === libraryHref;
  const homeHref = preview ? '/mock/chat' : '/';
  const [editing, setEditing] = useState<Conversation | null>(null);
  const [title, setTitle] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [menu, setMenu] = useState<{ conversation: Conversation; anchor: HTMLButtonElement } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  const groups = [
    { name: '置顶', items: sorted.filter((item) => item.pinned) },
    { name: '最近', items: sorted.filter((item) => !item.pinned) },
  ];
  function select(id: string | null) {
    // Record the choice before navigating; the workspace save is asynchronous and a quick
    // tab switch can happen before it lands.
    if (!preview) writeLastRoute(id);
    router.push(conversationHref(id, preview));
  }

  return (
    <aside className="sidebar" aria-label="对话导航" inert={sidebarCollapsed || undefined}>
      <div className="sidebar-header">
        <Link href={homeHref} asChild><LinkAnchor className="brand" onClick={() => { dispatch({ type: 'select', id: null }); if (!preview) writeLastRoute(null); }}><BrandMark size={30} />Matrius</LinkAnchor></Link>
        <div className="sidebar-header-actions">
          <button className="icon-button" onClick={onSearch} aria-label="搜索对话"><Icon name="search" size={19} /></button>
          <button className="icon-button" onClick={() => dispatch({ type: 'sidebar' })} aria-label="收起侧栏"><Icon name="sidebar" size={19} /></button>
        </div>
      </div>
      <nav className="sidebar-primary" aria-label="工作区">
        <button className={`new-conversation ${activeId === null && !onLibrary ? 'is-active' : ''}`} type="button" onClick={() => select(null)}><SquarePen size={19} strokeWidth={1.75} aria-hidden="true" /><span>新对话</span></button>
        {showLibrary && <Link href={libraryHref as Href} asChild>
          <LinkAnchor className={`new-conversation ${onLibrary ? 'is-active' : ''}`}
            aria-current={onLibrary ? 'page' : undefined} aria-label="打开资料库">
            <FolderOpen size={19} strokeWidth={1.75} aria-hidden="true" /><span>资料库</span>
          </LinkAnchor>
        </Link>}
      </nav>
      <nav className="conversation-list" aria-label="历史对话">
        {groups.map((group) => (
          <section className={`conversation-group${group.items.length === 0 ? ' is-empty' : ''}`} key={group.name}>
            <h2 className="sidebar-section-label"><button type="button" aria-expanded={!collapsed[group.name]} aria-controls={`sidebar-${group.name}`} onClick={() => setCollapsed((current) => ({ ...current, [group.name]: !current[group.name] }))}><span>{group.name}</span><Icon name="chevron" size={16} /></button></h2>
            <div id={`sidebar-${group.name}`} hidden={collapsed[group.name]}>
            {group.items.map((item) => {
              const last = item.messages.at(-1);
              // Status is only meaningful while the conversation is not the one on screen;
              // a background run wins over an older unread completion.
              const status = item.id !== activeId && runtime.isRunning(item.id) ? 'running' as const
                : item.id !== activeId && item.completedReadAt === null && last?.role === 'assistant' && last.status === 'complete' ? 'completed' as const
                  : undefined;
              return <div className={`conversation-item ${activeId === item.id ? 'is-active' : ''} ${menu?.conversation.id === item.id ? 'menu-open' : ''}`} key={item.id}>
                <ConversationSelect title={item.title} active={activeId === item.id}
                  hasUnreadError={item.errorReadAt == null && last?.role === 'assistant' && last.status === 'error'}
                  status={status}
                  onLongPress={mobile ? (anchor) => setMenu({ conversation: item, anchor }) : undefined}
                  onSelect={() => select(item.id)} />
                {(!mobile || activeId === item.id) && <button className="icon-button conversation-more" aria-label={`对话操作：${item.title}`} aria-haspopup="menu" aria-expanded={menu?.conversation.id === item.id} aria-controls={menu?.conversation.id === item.id ? 'conversation-menu' : undefined} onClick={(event) => { setMenu(menu?.conversation.id === item.id ? null : { conversation: item, anchor: event.currentTarget }); }}><Icon name="more" size={17} /></button>}
              </div>;
            })}
            </div>
          </section>
        ))}
      </nav>
      {preview
        ? <Link href="/mock/chat/settings" asChild><LinkAnchor className="user-entry" aria-label="打开设置">
          <span className="user-avatar"><Icon name="user" size={18} /></span>
          <span className="user-entry-text"><strong>本地模式</strong><span>数据保存在此浏览器</span></span>
        </LinkAnchor></Link>
        : <Link href={mobile ? "/settings" : "/settings/account"} asChild><LinkAnchor className="user-entry"
          aria-label={auth.user ? '打开账号设置' : '打开账号设置并登录'}>
          {auth.user
            ? <span className="user-avatar is-authenticated">{auth.user.username.slice(0, 1).toUpperCase()}</span>
            : <span className="user-avatar"><Icon name="user" size={18} /></span>}
          <span className="user-entry-text">
            <strong>{auth.user ? auth.user.username : '未登录'}</strong>
            <span>{auth.user
              ? auth.user.mustChangePassword ? '需要修改密码' : '已登录 · 账号设置'
              : auth.status === 'checking' ? '正在验证登录…'
                : auth.status === 'unavailable' ? '无法验证登录状态'
                  : '在设置中登录账号'}</span>
          </span>
        </LinkAnchor></Link>}
      {menu && <ConversationMenu conversation={menu.conversation} anchor={menu.anchor} onClose={closeMenu}
        onPin={() => { dispatch({ type: 'pin', id: menu.conversation.id }); closeMenu(); }}
        onRename={() => { menu.anchor.focus(); setEditing(menu.conversation); setTitle(menu.conversation.title); setConfirmDelete(false); closeMenu(); }}
        onDelete={() => { menu.anchor.focus(); setEditing(menu.conversation); setConfirmDelete(true); closeMenu(); }}
      />}
      {editing && <Dialog title={confirmDelete ? '删除这段对话？' : '重命名对话'} onClose={() => setEditing(null)} className="compact-dialog">
        {confirmDelete ? <>
          <p className="dialog-description">“{editing.title}”及其消息将被删除，此操作无法撤销。</p>
          <div className="dialog-footer"><button className="secondary-button" onClick={() => setEditing(null)}>取消</button><button className="danger-button" onClick={() => { dispatch({ type: 'delete', id: editing.id }); forgetScrollPosition(editing.id); if (activeId === editing.id) { if (!preview) writeLastRoute(null); router.replace(conversationHref(null, preview)); } setEditing(null); }}>删除对话</button></div>
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
