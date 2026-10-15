import { Link, router } from 'expo-router';
import { memo, useCallback, useState } from 'react';

import { Dialog } from '@/components/web/dialog';
import { Icon } from '@/components/web/icon';
import { useChat, type Conversation } from '../chat-state';
import { ConversationMenu } from './conversation-menu.web';
import { useIsPreview } from '@/features/workspace/preview-context';

type Props = { onSearch: () => void };

export const Sidebar = memo(function Sidebar({ onSearch }: Props) {
  const { conversations, activeId, dispatch } = useChat();
  const preview = useIsPreview();
  const homeHref = preview ? '/mock/chat' : '/';
  const [editing, setEditing] = useState<Conversation | null>(null);
  const [title, setTitle] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [menu, setMenu] = useState<{ conversation: Conversation; anchor: HTMLButtonElement } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  const groups = [
    { name: '已置顶', items: sorted.filter((item) => item.pinned) },
    { name: '对话', items: sorted.filter((item) => !item.pinned) },
  ];
  function select(id: string | null) {
    dispatch({ type: 'select', id });
    router.navigate(homeHref);
  }

  return (
    <aside className="sidebar" aria-label="对话导航">
      <div className="sidebar-header">
        <Link href={homeHref} asChild><a className="brand" onClick={() => dispatch({ type: 'select', id: null })}>Matrius<span className="brand-dot" /></a></Link>
        <div className="sidebar-header-actions">
          <button className="icon-button" onClick={onSearch} aria-label="搜索对话"><Icon name="search" size={19} /></button>
          <button className="icon-button" onClick={() => dispatch({ type: 'sidebar' })} aria-label="收起侧栏"><Icon name="sidebar" size={19} /></button>
        </div>
      </div>
      <button className="new-conversation" onClick={() => select(null)}><Icon name="plus" size={18} /><span>新对话</span></button>
      <nav className={`conversation-list ${conversations.length === 0 ? 'is-empty' : ''}`} aria-label="历史对话">
        {conversations.length === 0 && <div className="sidebar-empty-state">
          <Icon name="chat" size={20} />
          <p>暂无历史对话</p>
        </div>}
        {groups.map((group) => group.items.length > 0 && (
          <section className="conversation-group" key={group.name}>
            <h2 className="sidebar-section-label">{group.name}</h2>
            {group.items.map((item) => (
              <div className={`conversation-item ${activeId === item.id ? 'is-active' : ''} ${menu?.conversation.id === item.id ? 'menu-open' : ''}`} key={item.id}>
                <button className="conversation-select" aria-current={activeId === item.id ? 'page' : undefined} onClick={() => select(item.id)}>
                  <span>{item.title}</span>
                </button>
                <button className="icon-button conversation-more" aria-label={`对话操作：${item.title}`} aria-haspopup="menu" aria-expanded={menu?.conversation.id === item.id} aria-controls={menu?.conversation.id === item.id ? 'conversation-menu' : undefined} onClick={(event) => { setMenu(menu?.conversation.id === item.id ? null : { conversation: item, anchor: event.currentTarget }); }}><Icon name="more" size={17} /></button>
              </div>
            ))}
          </section>
        ))}
      </nav>
      <Link href={preview ? '/mock/settings' : '/settings'} asChild><a className="user-entry">
        <span className="user-avatar"><Icon name="user" size={18} /></span>
        <span className="user-entry-text"><strong>本地模式</strong><span>你的空间，自由对话</span></span>
      </a></Link>
      {menu && <ConversationMenu conversation={menu.conversation} anchor={menu.anchor} onClose={closeMenu}
        onPin={() => { dispatch({ type: 'pin', id: menu.conversation.id }); closeMenu(); }}
        onRename={() => { menu.anchor.focus(); setEditing(menu.conversation); setTitle(menu.conversation.title); setConfirmDelete(false); closeMenu(); }}
        onDelete={() => { menu.anchor.focus(); setEditing(menu.conversation); setConfirmDelete(true); closeMenu(); }}
      />}
      {editing && <Dialog title={confirmDelete ? '删除这段对话？' : '重命名对话'} onClose={() => setEditing(null)} className="compact-dialog">
        {confirmDelete ? <>
          <p className="dialog-description">“{editing.title}”及其消息将被删除，此操作无法撤销。</p>
          <div className="dialog-footer"><button className="secondary-button" onClick={() => setEditing(null)}>取消</button><button className="danger-button" onClick={() => { dispatch({ type: 'delete', id: editing.id }); setEditing(null); }}>删除对话</button></div>
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
