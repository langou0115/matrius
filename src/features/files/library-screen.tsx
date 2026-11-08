import { Link, useLocalSearchParams } from '@/router';
import { FolderOpen, ListChecks, LogIn, MoreHorizontal, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { Dialog } from '@/components/web/dialog';
import { useMobile } from '@/components/web/use-mobile';
import { Icon } from '@/components/web/icon';
import { LinkAnchor } from '@/components/web/link-anchor';
import { useAuth } from '@/features/auth/auth-state';
import { useChat } from '@/features/chat/chat-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { hasFeature } from '@/core/features/capabilities';
import { fileContentUrl, fileExtension, type LibraryFile } from './files-api';
import { LibraryItem } from './library-item';
import { LibraryToolbar } from './library-toolbar';
import { LibraryMenu } from './library-menu';
import { previewFileRequest } from './mock-library';
import { useFileLibrary } from './use-file-library';

/** The empty and error panels share one centred card so the page has a single quiet state. */
function LibraryPlaceholder({ title, body, action }: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return <div className="library-placeholder">
    <span className="library-placeholder-icon"><FolderOpen size={24} strokeWidth={1.6} aria-hidden="true" /></span>
    <strong>{title}</strong>
    {body && <p>{body}</p>}
    {action}
  </div>;
}

export default function LibraryScreen() {
  const mobile = useMobile();
  const auth = useAuth();
  const preview = useIsPreview();
  const { sidebarOpen, dispatch } = useChat();
  const { kind: kindParam } = useLocalSearchParams<{ kind?: string }>();
  // The dev preview has no account or server; it renders the real screen against 500
  // generated files so pagination and filters can be checked without a backend.
  const enabled = preview || hasFeature(auth.status === 'authenticated' ? auth.user : null, 'files');
  const initialKind = kindParam === 'image' ? 'image' : kindParam === 'file' ? 'file' : 'all';
  const library = useFileLibrary({ request: preview ? previewFileRequest : auth.request, enabled, initialKind });
  const { nextCursor, loadMore, clearSelection } = library;
  const sentinel = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<LibraryFile | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renamingBusy, setRenamingBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<LibraryFile[] | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [mobileSelecting, setMobileSelecting] = useState(false);
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const pageMenuTrigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setMobileSelecting(false);
    setPageMenuOpen(false);
    clearSelection();
  }, [mobile, library.query, library.kind, library.sort, library.order, clearSelection]);

  function exitSelection() {
    library.clearSelection();
    setMobileSelecting(false);
  }

  // Load the next page a little before the sentinel is visible, so the list keeps flowing.
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !enabled || !nextCursor) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    }, { rootMargin: '240px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, nextCursor, loadMore]);

  function openRename(file: LibraryFile) {
    setRenameValue(file.filename);
    setRenameError(null);
    setRenaming(file);
  }

  async function submitRename(event: FormEvent) {
    event.preventDefault();
    if (!renaming) return;
    const filename = renameValue.trim();
    if (!filename) { setRenameError('文件名不能为空。'); return; }
    if (fileExtension(filename) !== fileExtension(renaming.filename)) {
      setRenameError('不能修改文件扩展名。');
      return;
    }
    setRenamingBusy(true);
    setRenameError(null);
    try {
      await library.rename(renaming.id, filename);
      setRenaming(null);
    } catch (reason) {
      setRenameError(reason instanceof Error ? reason.message : '重命名失败，请重试。');
    } finally {
      setRenamingBusy(false);
    }
  }

  function openDelete(files: LibraryFile[]) {
    if (!files.length) return;
    setDeleteError(null);
    setDeleting(files);
  }

  async function submitDelete() {
    if (!deleting) return;
    setDeletingBusy(true);
    setDeleteError(null);
    try {
      await library.remove(deleting.map((file) => file.id));
      setDeleting(null);
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : '删除失败，请重试。');
    } finally {
      setDeletingBusy(false);
    }
  }

  // Keep the expand button on the same top-left row as the chat topbar; the page heading
  // and its content always start below that row.
  const topbar = <header className="library-topbar">
    {!sidebarOpen && <button className="sidebar-expand" type="button"
      onClick={() => dispatch({ type: 'sidebar' })} aria-label="展开侧栏" aria-expanded={false}>
      <Icon name="sidebar" size={22} />
    </button>}
    {mobile && enabled && <button ref={pageMenuTrigger} type="button" className="icon-button library-page-more"
      aria-label={mobileSelecting ? '退出选择模式' : '资料库操作'}
      aria-haspopup={mobileSelecting ? undefined : 'menu'} aria-expanded={mobileSelecting ? undefined : pageMenuOpen}
      onClick={() => { if (mobileSelecting) exitSelection(); else setPageMenuOpen((open) => !open); }}>
      {mobileSelecting ? <X size={21} strokeWidth={1.75} aria-hidden="true" /> : <MoreHorizontal size={21} strokeWidth={1.75} aria-hidden="true" />}
    </button>}
    {mobile && !mobileSelecting && pageMenuOpen && pageMenuTrigger.current && <LibraryMenu anchor={pageMenuTrigger.current}
      label="资料库操作" onClose={() => setPageMenuOpen(false)}>
      <button type="button" role="menuitem" disabled={!library.items.length} onClick={() => {
        library.clearSelection();
        setMobileSelecting(true);
        setPageMenuOpen(false);
        pageMenuTrigger.current?.focus({ preventScroll: true });
      }}><ListChecks size={16} strokeWidth={1.75} aria-hidden="true" />选择</button>
    </LibraryMenu>}
  </header>;

  const heading = <header className="library-heading">
    <div>
      <h1>资料库</h1>
      <p>聊天中上传的图片与文档都保存在云端，可在这里统一管理。</p>
    </div>
  </header>;

  if (auth.status === 'checking') {
    return <main className="library-main" id="main-content" tabIndex={-1}>
      {topbar}
      {heading}
      <div className="library-scroll"><div className="library-content">
        <p className="settings-footnote" role="status">正在验证账号…</p>
      </div></div>
    </main>;
  }

  if (!enabled) {
    const unavailable = auth.status === 'unavailable';
    return <main className="library-main" id="main-content" tabIndex={-1}>
      {topbar}
      {heading}
      <div className="library-scroll"><div className="library-content">
        <LibraryPlaceholder
          title={unavailable ? '暂时无法验证账号' : auth.user ? '资料库尚未开放' : '登录后使用资料库'}
          body={unavailable
            ? '无法连接账号服务，正在自动重试；也可以立即重新验证。'
            : auth.user
              ? '当前账号还没有开通文件功能，请联系管理员。'
              : '登录账号后，对话中上传的图片和文档会保存到云端，可在这里搜索、下载和管理。'}
          action={unavailable
            ? <button type="button" className="primary-button library-placeholder-action"
              onClick={() => void auth.refresh()}>重新验证</button>
            : !auth.user
              ? <Link href="/settings/account" asChild>
                <LinkAnchor className="primary-button library-placeholder-action">
                  <LogIn size={16} strokeWidth={1.75} aria-hidden="true" />前往登录
                </LinkAnchor>
              </Link>
              : undefined}
        />
      </div></div>
    </main>;
  }

  const selectedFiles = library.selectedFiles;
  // Selecting all walks the remaining pages, so rows that were never scrolled into view
  // are included in batch download and delete too. Once anything is selected, the header
  // box clears the selection instead of adding the rest.
  function toggleSelectAll() {
    if (library.selected.size > 0) library.clearSelection();
    else void library.selectAll();
  }
  // Browsers allow a burst of same-origin downloads; each file goes through the same URL
  // the per-row download link uses.
  function downloadSelected() {
    for (const file of selectedFiles) {
      const anchor = document.createElement('a');
      anchor.href = file.previewUrl ?? fileContentUrl(file.id);
      anchor.download = file.filename;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    }
  }

  const toolbar = <LibraryToolbar
    selectable={!mobile}
    mobileSelectionActive={mobile && mobileSelecting}
    query={library.query} onQueryChange={library.setQuery}
    kind={library.kind} onKindChange={library.setKind}
    sort={library.sort} onSortChange={library.setSort}
    order={library.order} onToggleOrder={library.toggleOrder}
    total={library.items.length}
    selectedCount={library.selected.size}
    selectingAll={library.selectingAll}
    onToggleSelectAll={toggleSelectAll}
    onDownloadSelected={downloadSelected}
    onDeleteSelected={() => openDelete(selectedFiles)}
  />;

  return <main className="library-main" id="main-content" tabIndex={-1}>
    {topbar}
    {heading}
    {mobile && <div className="library-mobile-toolbar">{toolbar}</div>}
    <div className="library-scroll">
      <div className="library-content">
        {!mobile && toolbar}

        {library.error && <p className="account-message is-error" role="alert">{library.error}</p>}

        {library.loading && !library.items.length ? <div className="library-list" aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => <div className="library-item is-skeleton" key={index}>
            <span className="library-skeleton-check" />
            <span className="library-skeleton-artwork" />
            <span className="library-skeleton-copy"><span /><span /></span>
          </div>)}
        </div> : null}

        {!library.loading && !library.error && !library.items.length
          ? <LibraryPlaceholder title="还没有文件" />
          : null}

        {library.items.length > 0 && <div className={`library-list${library.refreshing ? ' is-refreshing' : ''}${mobile && mobileSelecting ? ' is-selecting' : ''}`}
          role="list" aria-label="资料库文件" aria-busy={library.refreshing || undefined}>
          {library.items.map((file) => <LibraryItem key={file.id} file={file}
            selectable={!mobile || mobileSelecting} selected={library.selected.has(file.id)} mobile={mobile}
            onToggle={() => library.toggleSelected(file)}
            onRename={() => openRename(file)}
            onDelete={() => openDelete([file])}
          />)}
        </div>}

        <div ref={sentinel} className="library-sentinel" aria-hidden="true" />
        {library.loadingMore && <p className="library-loading-more" role="status">正在加载更多…</p>}
      </div>
    </div>

    {renaming && <Dialog title="重命名文件" onClose={() => { if (!renamingBusy) setRenaming(null); }} className="compact-dialog">
      <form onSubmit={submitRename}>
        <label className="field-label" htmlFor="library-rename">文件名</label>
        <input id="library-rename" className="text-field" value={renameValue} maxLength={255}
          onChange={(event) => { setRenameValue(event.target.value); setRenameError(null); }} required />
        {renameError && <p className="account-message is-error" role="alert">{renameError}</p>}
        <div className="dialog-footer">
          <button type="button" className="secondary-button" disabled={renamingBusy} onClick={() => setRenaming(null)}>取消</button>
          <button type="submit" className="primary-button" disabled={renamingBusy || !renameValue.trim()}>
            {renamingBusy ? '保存中…' : '保存名称'}
          </button>
        </div>
      </form>
    </Dialog>}

    {deleting && <Dialog title={deleting.length > 1 ? `删除 ${deleting.length} 个文件？` : '删除文件？'}
      onClose={() => { if (!deletingBusy) setDeleting(null); }} className="compact-dialog">
      <p className="dialog-description">{deleting.length > 1
        ? '这些文件将从资料库中移除，历史对话里的附件会显示为“文件已删除”。'
        : `“${deleting[0].filename}”将从资料库中移除，历史对话里的附件会显示为“文件已删除”。`}</p>
      {deleteError && <p className="account-message is-error" role="alert">{deleteError}</p>}
      <div className="dialog-footer">
        <button type="button" className="secondary-button" disabled={deletingBusy} onClick={() => setDeleting(null)}>取消</button>
        <button type="button" className="danger-button" disabled={deletingBusy} onClick={() => void submitDelete()}>
          {deletingBusy ? '删除中…' : '删除文件'}
        </button>
      </div>
    </Dialog>}
  </main>;
}
