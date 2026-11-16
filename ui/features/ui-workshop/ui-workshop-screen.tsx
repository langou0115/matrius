import { useEffect, useState } from 'react';
import { ChevronRight, LayoutTemplate, Plus, Search, Sparkles } from 'lucide-react';

import type { UiComponentSummary } from '@contract/ui-component';
import { Dialog } from '@/components/web/dialog';
import { Icon } from '@/components/web/icon';
import { LinkAnchor } from '@/components/web/link-anchor';
import { useInstance } from '@/features/instance/instance-state';
import { useChat } from '@/features/chat/chat-state';
import { hasFeature } from '@/core/features/capabilities';
import { createUiComponent, listUiComponents } from '@/core/api/ui-components';
import { Link, router } from '@/router';

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  return '请求失败，请重试。';
}

function statusLabel(item: UiComponentSummary): string {
  if (item.status === 'archived') return '已归档';
  if (item.publishedVersion === null) return '草稿';
  return item.currentVersion > item.publishedVersion ? '有修改待发布' : '已发布';
}

function statusClass(item: UiComponentSummary): string {
  if (item.status === 'archived') return 'is-archived';
  if (item.publishedVersion === null) return 'is-draft';
  return item.currentVersion > item.publishedVersion ? 'is-pending' : 'is-published';
}

function formatTime(value: number): string {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function UiWorkshopScreen() {
  const instance = useInstance();
  const { sidebarOpen, dispatch } = useChat();
  const enabled = instance.status === 'ready' && hasFeature(instance.info, 'ui_workshop');
  const [items, setItems] = useState<UiComponentSummary[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newStateful, setNewStateful] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      void listUiComponents(instance.request, query)
        .then(({ items: next }) => {
          if (cancelled) return;
          setItems(next);
          setListLoaded(true);
        })
        .catch((reason) => { if (!cancelled) setError(errorMessage(reason)); });
    }, query.trim() ? 250 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [enabled, instance.request, query]);

  async function create() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    try {
      const { component } = await createUiComponent(instance.request, { name, stateful: newStateful });
      setCreateOpen(false);
      setNewName('');
      setNewStateful(false);
      router.push(`/ui/${component.id}`);
    } catch (reason) {
      setError(errorMessage(reason));
      setCreating(false);
    }
  }

  function openCreate() {
    setNewName('');
    setNewStateful(false);
    setError(null);
    setCreateOpen(true);
  }

  const topbar = <header className="ui-gallery-topbar">
    {!sidebarOpen && <button className="sidebar-expand" type="button" onClick={() => dispatch({ type: 'sidebar' })} aria-label="展开侧栏" aria-expanded={false}>
      <Icon name="sidebar" size={22} />
    </button>}
  </header>;

  if (instance.status === 'checking') {
    return <main className="ui-gallery" id="main-content" tabIndex={-1}>
      {topbar}
      <div className="ui-gallery-state"><p role="status">正在连接实例…</p></div>
    </main>;
  }

  if (!enabled) {
    return <main className="ui-gallery" id="main-content" tabIndex={-1}>
      {topbar}
      <div className="ui-gallery-state">
        <div className="ui-gallery-placeholder-card">
          <Sparkles size={24} strokeWidth={1.6} aria-hidden="true" />
          <strong>{instance.status === 'unavailable' ? '无法连接实例' : 'UI 工坊尚未开放'}</strong>
          <p>{instance.status === 'unavailable' ? '请检查服务端后重试。' : '当前实例没有启用 UI 工坊功能。'}</p>
          {instance.status === 'unavailable' && <button type="button" className="primary-button" onClick={() => void instance.refresh()}>重新连接</button>}
        </div>
      </div>
    </main>;
  }

  return <main className="ui-gallery" id="main-content" tabIndex={-1}>
    {topbar}
    <div className="ui-gallery-scroll">
      <div className="ui-gallery-content">
        <div className="ui-gallery-bar">
          <h1>我的组件</h1>
          <span className="ui-gallery-count">{items.length}</span>
          <label className="ui-gallery-search">
            <Search size={15} strokeWidth={1.75} aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索组件" maxLength={200} />
          </label>
          <button type="button" className="primary-button ui-gallery-new" onClick={openCreate}>
            <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
            新建组件
          </button>
        </div>

        {error && <p className="ui-gallery-error" role="alert">{error}</p>}

        {items.length === 0
          ? (listLoaded ? <div className="ui-gallery-empty">
            <span className="ui-gallery-empty-icon"><Sparkles size={22} strokeWidth={1.6} aria-hidden="true" /></span>
            <strong>{query ? '没有匹配的组件' : '还没有组件'}</strong>
            <p>{query ? '换个关键词试试。' : '新建一个组件，然后在工作台里描述你想要的界面。'}</p>
            {!query && <button type="button" className="primary-button" onClick={openCreate}>新建组件</button>}
          </div> : null)
          : <div className="ui-gallery-list" role="list" aria-label="组件列表">
            {items.map((item) => <Link key={item.id} href={`/ui/${item.id}`} asChild>
              <LinkAnchor className="ui-gallery-row" role="listitem" aria-label={`打开组件 ${item.name}`}>
                <span className="ui-gallery-row-art" aria-hidden="true"><LayoutTemplate size={19} strokeWidth={1.6} /></span>
                <span className="ui-gallery-row-copy">
                  <span className="ui-gallery-row-title">
                    <strong>{item.name}</strong>
                    <span className={`ui-component-badge ${statusClass(item)}`}>{statusLabel(item)}</span>
                  </span>
                  {item.description && <span className="ui-gallery-row-desc">{item.description}</span>}
                  <span className="ui-gallery-row-meta">{item.stateful ? '有状态' : '展示型'} · v{item.currentVersion}{item.updatedAt ? ` · ${formatTime(item.updatedAt)}` : ''}</span>
                </span>
                <ChevronRight size={16} strokeWidth={1.75} className="ui-gallery-row-chevron" aria-hidden="true" />
              </LinkAnchor>
            </Link>)}
          </div>}
      </div>
    </div>

    {createOpen && <Dialog title="新建组件" onClose={() => { if (!creating) { setCreateOpen(false); setNewName(''); } }} className="compact-dialog">
      <form onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <label className="field-label" htmlFor="ui-gallery-name">组件名称</label>
        <input id="ui-gallery-name" className="text-field" value={newName} maxLength={200} required
          placeholder="例如：项目进度看板" onChange={(event) => setNewName(event.target.value)} autoFocus />
        <label className="model-key-toggle dialog-checkbox ui-gallery-mode">
          <input className="model-checkbox-input" type="checkbox" checked={newStateful}
            onChange={(event) => setNewStateful(event.target.checked)} />
          <span className="model-checkbox" aria-hidden="true" />
          与对话绑定（有状态）
        </label>
        {error && <p className="settings-message is-error" role="alert">{error}</p>}
        <div className="dialog-footer">
          <button type="button" className="secondary-button" onClick={() => { setCreateOpen(false); setNewName(''); }} disabled={creating}>取消</button>
          <button type="submit" className="primary-button" disabled={!newName.trim() || creating}>
            {creating ? '创建中…' : '创建'}
          </button>
        </div>
      </form>
    </Dialog>}
  </main>;
}
