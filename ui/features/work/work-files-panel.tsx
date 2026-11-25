import { LOCAL_WORK_HOST_ID, type WorkHostEntry, type WorkProject } from '@contract/work-projects';
import {
  ChevronRight,
  Copy,
  ExternalLink,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  KeyRound,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from 'react';

import { Dialog } from '@/components/web/dialog';
import { ApiError } from '@/core/api/instance-client';
import { FileTypeIcon } from '@/features/chat/components/file-type-icon';
import { useInstance } from '@/features/instance/instance-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import {
  browseHostDirectory,
  createPreviewDirectoryListing,
  createWorkFileEntry,
  deleteWorkFileEntry,
  renameWorkFileEntry,
  revealWorkFileInExplorer,
  unlockWorkHost,
} from './work-api';
import {
  MAX_WORK_FILES_WIDTH,
  MIN_WORK_FILES_WIDTH,
  bumpHostUnlockVersion,
  clampWorkFilesWidth,
  closeWorkFiles,
  useWorkState,
} from './work-state';

type TreeCache = Record<string, { entries: WorkHostEntry[]; loading?: boolean; error?: string }>;

function errorMessage(reason: unknown): string {
  return reason instanceof Error && reason.message ? reason.message : '读取工作目录失败。';
}

function parentDirectoryOf(path: string): string {
  const cleaned = path.replace(/[\\/]+$/u, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  if (idx <= 0) return cleaned;
  return cleaned.slice(0, idx);
}

function relativePathOf(root: string, target: string): string {
  const normRoot = root.replaceAll('\\', '/').replace(/\/+$/u, '');
  const normTarget = target.replaceAll('\\', '/');
  if (normTarget.toLowerCase().startsWith(`${normRoot.toLowerCase()}/`)) {
    return normTarget.slice(normRoot.length + 1);
  }
  return normTarget;
}

function WorkTreeBranch({
  entries,
  depth,
  expanded,
  treeCache,
  onToggleDir,
  onOpenFile,
  onContextMenuEntry,
  parentIgnored = false,
}: {
  entries: readonly WorkHostEntry[];
  depth: number;
  expanded: Readonly<Record<string, boolean>>;
  treeCache: Readonly<TreeCache>;
  onOpenFile: (entry: WorkHostEntry) => void;
  onToggleDir: (entry: WorkHostEntry) => void;
  onContextMenuEntry?: (event: MouseEvent<HTMLElement>, entry: WorkHostEntry) => void;
  parentIgnored?: boolean;
}) {
  return (
    <>
      {entries.map((entry) => {
        const isDir = entry.kind === 'directory';
        const isOpen = isDir && !!expanded[entry.path];
        const branch = isDir ? treeCache[entry.path] : undefined;
        const accessible = entry.accessible !== false;
        const ignored = parentIgnored || Boolean(entry.ignored);
        const paddingLeft = 10 + depth * 14;

        if (!isDir) {
          return (
            <button
              key={entry.path}
              type="button"
              className={`work-tree-row is-file${accessible ? '' : ' is-disabled'}${ignored ? ' is-ignored' : ''}`}
              disabled={!accessible}
              onClick={() => onOpenFile(entry)}
              onContextMenu={(event) => onContextMenuEntry?.(event, entry)}
              style={{ paddingLeft }}
              title={entry.path}
            >
              <span className="work-tree-spacer" aria-hidden="true" />
              <span className="work-tree-file-icon" aria-hidden="true">
                <FileTypeIcon file={{ name: entry.name, type: '' }} />
              </span>
              <span className="work-tree-name">{entry.name}</span>
            </button>
          );
        }

        return (
          <div key={entry.path} className="work-tree-node">
            <button
              type="button"
              className={`work-tree-row is-dir${isOpen ? ' is-open' : ''}${accessible ? '' : ' is-disabled'}${ignored ? ' is-ignored' : ''}`}
              style={{ paddingLeft }}
              aria-expanded={accessible ? isOpen : undefined}
              disabled={!accessible}
              title={entry.path}
              onClick={() => onToggleDir(entry)}
              onContextMenu={(event) => onContextMenuEntry?.(event, entry)}
            >
              <ChevronRight size={14} strokeWidth={1.75} className="work-tree-chevron" aria-hidden="true" />
              <span className="work-tree-folder-icon" aria-hidden="true">
                {isOpen
                  ? <FolderOpen size={15} strokeWidth={1.75} />
                  : <Folder size={15} strokeWidth={1.75} />}
              </span>
              <span className="work-tree-name">{entry.name}</span>
            </button>

            {isOpen && (
              <div className="work-tree-children">
                {branch?.loading ? (
                  <div className="work-tree-state" style={{ paddingLeft: paddingLeft + 22 }} role="status">
                    <LoaderCircle size={13} strokeWidth={1.75} className="loading-spinner" aria-hidden="true" />
                    <span>读取中…</span>
                  </div>
                ) : branch?.error ? (
                  <p className="work-tree-error" style={{ paddingLeft: paddingLeft + 22 }} role="alert">
                    {branch.error}
                  </p>
                ) : branch?.entries.length ? (
                  <WorkTreeBranch
                    entries={branch.entries}
                    depth={depth + 1}
                    expanded={expanded}
                    treeCache={treeCache}
                    onToggleDir={onToggleDir}
                    onOpenFile={onOpenFile}
                    onContextMenuEntry={onContextMenuEntry}
                    parentIgnored={ignored}
                  />
                ) : (
                  <span className="work-tree-empty" style={{ paddingLeft: paddingLeft + 22 }}>空目录</span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

type TreeModalState =
  | { kind: 'create-file'; parentPath: string }
  | { kind: 'create-dir'; parentPath: string }
  | { kind: 'rename'; entry: WorkHostEntry }
  | { kind: 'delete'; entry: WorkHostEntry };

/** Reusable project file tree body with right-click context menu (CRUD + copy path + refresh). */
export function WorkFileTree({
  project,
  onOpenFile,
  refreshTick = 0,
  onLoadingChange,
}: {
  project: WorkProject | null;
  onOpenFile: (entry: WorkHostEntry) => void;
  refreshTick?: number;
  onLoadingChange?: (loading: boolean) => void;
}) {
  const instance = useInstance();
  const preview = useIsPreview();
  const { hostUnlockVersion } = useWorkState();

  const [rootEntries, setRootEntries] = useState<WorkHostEntry[]>([]);
  const [rootLoading, setRootLoading] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);
  const [needsSshUnlock, setNeedsSshUnlock] = useState(false);
  const [sshPassword, setSshPassword] = useState('');
  const [rememberPassword, setRememberPassword] = useState(true);
  const [unlocking, setUnlocking] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [treeCache, setTreeCache] = useState<TreeCache>({});
  const [localRefreshTick, setLocalRefreshTick] = useState(0);

  const [treeMenu, setTreeMenu] = useState<{
    x: number;
    y: number;
    entry: WorkHostEntry | null;
  } | null>(null);
  const [modal, setModal] = useState<TreeModalState | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onLoadingChange?.(rootLoading);
  }, [onLoadingChange, rootLoading]);

  const loadRoot = useCallback(async (targetProject: WorkProject | null, signal?: AbortSignal) => {
    if (!targetProject) {
      setRootEntries([]);
      setRootError(null);
      setNeedsSshUnlock(false);
      setRootLoading(false);
      return;
    }

    if (preview) {
      try {
        const listing = createPreviewDirectoryListing(targetProject.hostId, targetProject.directory);
        setRootEntries(listing.entries);
        setRootError(null);
        setNeedsSshUnlock(false);
      } catch (reason) {
        setRootEntries([]);
        setRootError(errorMessage(reason));
        setNeedsSshUnlock(false);
      } finally {
        setRootLoading(false);
      }
      return;
    }

    setRootLoading(true);
    setRootError(null);
    setNeedsSshUnlock(false);
    try {
      const listing = await browseHostDirectory(
        instance.request,
        targetProject.hostId,
        targetProject.directory,
        signal,
      );
      if (signal?.aborted) return;
      setRootEntries(listing.entries);
    } catch (reason) {
      if (signal?.aborted) return;
      setRootEntries([]);
      const authRequired = reason instanceof ApiError
        && (reason.code === 'ssh_auth_required' || reason.status === 401);
      setNeedsSshUnlock(authRequired && targetProject.hostId !== LOCAL_WORK_HOST_ID);
      setRootError(errorMessage(reason));
    } finally {
      if (!signal?.aborted) setRootLoading(false);
    }
  }, [instance.request, preview]);

  useEffect(() => {
    setExpanded({});
    setTreeCache({});
    setSshPassword('');
    const controller = new AbortController();
    void loadRoot(project, controller.signal);
    return () => { controller.abort(); };
  }, [hostUnlockVersion, loadRoot, localRefreshTick, project, refreshTick]);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!treeMenu || !el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    el.style.left = `${Math.max(8, Math.min(treeMenu.x, vw - width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(treeMenu.y, vh - height - 8))}px`;
  }, [treeMenu]);

  useEffect(() => {
    if (!treeMenu) return;
    const close = () => setTreeMenu(null);
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [treeMenu]);

  const reloadDirectory = useCallback(async (dirPath: string) => {
    if (!project || preview) {
      setLocalRefreshTick((t) => t + 1);
      return;
    }
    const normRoot = project.directory.replace(/[\\/]+$/u, '').toLowerCase();
    const normDir = dirPath.replace(/[\\/]+$/u, '').toLowerCase();
    if (!dirPath || normDir === normRoot) {
      await loadRoot(project);
      return;
    }
    setTreeCache((current) => ({ ...current, [dirPath]: { entries: current[dirPath]?.entries ?? [], loading: true } }));
    try {
      const listing = await browseHostDirectory(instance.request, project.hostId, dirPath, undefined, { refresh: true });
      setTreeCache((current) => ({ ...current, [dirPath]: { entries: listing.entries } }));
    } catch (reason) {
      setTreeCache((current) => ({ ...current, [dirPath]: { entries: [], error: errorMessage(reason) } }));
    }
  }, [instance.request, loadRoot, preview, project]);

  async function handleUnlockSubmit(event: FormEvent) {
    event.preventDefault();
    if (!project || unlocking || !sshPassword.trim()) return;
    setUnlocking(true);
    setRootError(null);
    try {
      await unlockWorkHost(instance.request, project.hostId, sshPassword, rememberPassword);
      setSshPassword('');
      setNeedsSshUnlock(false);
      bumpHostUnlockVersion();
    } catch (reason) {
      setRootError(errorMessage(reason));
    } finally {
      setUnlocking(false);
    }
  }

  async function toggleDirectory(entry: WorkHostEntry) {
    if (!project || entry.accessible === false) return;
    const isCurrentlyOpen = !!expanded[entry.path];
    setExpanded((current) => ({ ...current, [entry.path]: !isCurrentlyOpen }));
    if (isCurrentlyOpen || treeCache[entry.path]?.entries.length || treeCache[entry.path]?.loading) return;

    if (preview) {
      try {
        const listing = createPreviewDirectoryListing(project.hostId, entry.path);
        setTreeCache((current) => ({ ...current, [entry.path]: { entries: listing.entries } }));
      } catch (reason) {
        setTreeCache((current) => ({
          ...current,
          [entry.path]: { entries: [], error: errorMessage(reason) },
        }));
      }
      return;
    }

    setTreeCache((current) => ({ ...current, [entry.path]: { entries: [], loading: true } }));
    try {
      const listing = await browseHostDirectory(instance.request, project.hostId, entry.path);
      setTreeCache((current) => ({ ...current, [entry.path]: { entries: listing.entries } }));
    } catch (reason) {
      setTreeCache((current) => ({
        ...current,
        [entry.path]: { entries: [], error: errorMessage(reason) },
      }));
    }
  }

  function openContextMenu(event: MouseEvent<HTMLElement>, entry: WorkHostEntry | null) {
    if (!project) return;
    event.preventDefault();
    event.stopPropagation();
    setTreeMenu({ x: event.clientX, y: event.clientY, entry });
  }

  async function handleModalSubmit(event: FormEvent) {
    event.preventDefault();
    if (!project || !modal || actionBusy) return;
    setActionError(null);
    if (preview) {
      setModal(null);
      return;
    }
    setActionBusy(true);
    try {
      if (modal.kind === 'create-file' || modal.kind === 'create-dir') {
        const created = await createWorkFileEntry(instance.request, project.id, {
          parentPath: modal.parentPath,
          name: nameInput.trim(),
          kind: modal.kind === 'create-dir' ? 'directory' : 'file',
        });
        setModal(null);
        await reloadDirectory(modal.parentPath);
        if (modal.parentPath !== project.directory) {
          setExpanded((prev) => ({ ...prev, [modal.parentPath]: true }));
        }
        if (created.kind === 'file') {
          onOpenFile(created);
        }
      } else if (modal.kind === 'rename') {
        const renamed = await renameWorkFileEntry(instance.request, project.id, {
          path: modal.entry.path,
          newName: nameInput.trim(),
        });
        setModal(null);
        closeWorkFiles(project.id, [modal.entry.path]);
        await reloadDirectory(parentDirectoryOf(modal.entry.path));
        if (renamed.kind === 'file') {
          onOpenFile(renamed);
        }
      } else if (modal.kind === 'delete') {
        await deleteWorkFileEntry(instance.request, project.id, { path: modal.entry.path });
        setModal(null);
        closeWorkFiles(project.id, [modal.entry.path]);
        await reloadDirectory(parentDirectoryOf(modal.entry.path));
      }
    } catch (reason) {
      setActionError(reason instanceof Error && reason.message ? reason.message : '操作失败，请重试。');
    } finally {
      setActionBusy(false);
    }
  }

  function copyText(text: string) {
    setTreeMenu(null);
    void navigator.clipboard?.writeText(text).catch(() => {});
  }

  const targetDirForCreate = treeMenu?.entry
    ? (treeMenu.entry.kind === 'directory' ? treeMenu.entry.path : parentDirectoryOf(treeMenu.entry.path))
    : (project?.directory ?? '');

  if (!project) {
    return <p className="research-empty">选择项目以查看工作目录</p>;
  }
  if (rootLoading) {
    return (
      <div className="work-tree-state" role="status">
        <LoaderCircle size={15} strokeWidth={1.75} className="loading-spinner" aria-hidden="true" />
        <span>正在读取目录…</span>
      </div>
    );
  }
  if (needsSshUnlock) {
    return (
      <form className="work-files-unlock-form" onSubmit={(event) => void handleUnlockSubmit(event)}>
        <div className="work-files-unlock-title">
          <KeyRound size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>输入 SSH 密码以加载目录</span>
        </div>
        {rootError && <p className="work-tree-error" role="alert">{rootError}</p>}
        <input
          type="password"
          className="text-field"
          value={sshPassword}
          onChange={(event) => setSshPassword(event.target.value)}
          placeholder="输入 SSH 密码"
          autoComplete="current-password"
          disabled={unlocking}
          required
        />
        <label className="work-unlock-remember">
          <input
            type="checkbox"
            checked={rememberPassword}
            onChange={(event) => setRememberPassword(event.target.checked)}
            disabled={unlocking}
          />
          <span>保存密码</span>
        </label>
        <button type="submit" className="primary-button" disabled={unlocking || !sshPassword.trim()}>
          {unlocking ? '正在连接…' : '解锁目录'}
        </button>
      </form>
    );
  }
  if (rootError) {
    return <p className="work-tree-error" role="alert">{rootError}</p>;
  }

  return (
    <>
      <div
        className="work-file-tree"
        role="tree"
        aria-label={`${project.name} 文件列表`}
        onContextMenu={(event) => openContextMenu(event, null)}
      >
        {rootEntries.length > 0 ? (
          <WorkTreeBranch
            entries={rootEntries}
            depth={0}
            expanded={expanded}
            treeCache={treeCache}
            onToggleDir={(entry) => void toggleDirectory(entry)}
            onOpenFile={onOpenFile}
            onContextMenuEntry={openContextMenu}
          />
        ) : (
          <p className="research-empty">目录下暂无文件</p>
        )}
      </div>

      {treeMenu && (
        <div
          ref={menuRef}
          className="conversation-menu work-tree-context-menu"
          role="menu"
          aria-label="文件树操作"
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              const parentPath = targetDirForCreate;
              setTreeMenu(null);
              setActionError(null);
              setNameInput('');
              setModal({ kind: 'create-file', parentPath });
            }}
          >
            <FilePlus size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>新建文件</span>
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              const parentPath = targetDirForCreate;
              setTreeMenu(null);
              setActionError(null);
              setNameInput('');
              setModal({ kind: 'create-dir', parentPath });
            }}
          >
            <FolderPlus size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>新建文件夹</span>
          </button>
          {treeMenu.entry && (
            <>
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  const target = treeMenu.entry!;
                  setTreeMenu(null);
                  setActionError(null);
                  setNameInput(target.name);
                  setModal({ kind: 'rename', entry: target });
                }}
              >
                <Pencil size={15} strokeWidth={1.75} aria-hidden="true" />
                <span>重命名</span>
              </button>
              <button
                role="menuitem"
                type="button"
                onClick={() => copyText(treeMenu.entry!.path)}
              >
                <Copy size={15} strokeWidth={1.75} aria-hidden="true" />
                <span>复制路径</span>
              </button>
              <button
                role="menuitem"
                type="button"
                onClick={() => copyText(relativePathOf(project.directory, treeMenu.entry!.path))}
              >
                <Copy size={15} strokeWidth={1.75} aria-hidden="true" />
                <span>复制相对路径</span>
              </button>
            </>
          )}
          {project.hostId === LOCAL_WORK_HOST_ID && (
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                const targetPath = treeMenu.entry?.path ?? project.directory;
                setTreeMenu(null);
                if (!preview) {
                  void revealWorkFileInExplorer(instance.request, project.id, targetPath).catch(() => {});
                }
              }}
            >
              <ExternalLink size={15} strokeWidth={1.75} aria-hidden="true" />
              <span>在系统资源文件夹中打开</span>
            </button>
          )}
          {treeMenu.entry && (
            <button
              role="menuitem"
              type="button"
              className="danger-text"
              onClick={() => {
                const target = treeMenu.entry!;
                setTreeMenu(null);
                setActionError(null);
                setModal({ kind: 'delete', entry: target });
              }}
            >
              <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
              <span>删除</span>
            </button>
          )}
        </div>
      )}

      {modal && (
        <Dialog
          title={
            modal.kind === 'create-file' ? '新建文件'
              : modal.kind === 'create-dir' ? '新建文件夹'
                : modal.kind === 'rename' ? '重命名'
                  : `删除${modal.entry.kind === 'directory' ? '文件夹' : '文件'}？`
          }
          className="compact-dialog"
          onClose={() => { if (!actionBusy) setModal(null); }}
        >
          {modal.kind === 'delete' ? (
            <form onSubmit={(event) => void handleModalSubmit(event)}>
              <p className="dialog-description">
                确定永久删除「{modal.entry.name}」吗？此操作无法撤销。
              </p>
              {actionError && <p className="work-tree-error" role="alert">{actionError}</p>}
              <div className="dialog-footer">
                <button type="button" className="secondary-button" data-autofocus disabled={actionBusy} onClick={() => setModal(null)}>取消</button>
                <button type="submit" className="danger-button" disabled={actionBusy}>
                  {actionBusy ? '删除中…' : '确认删除'}
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={(event) => void handleModalSubmit(event)}>
              <label className="field-label" htmlFor="work-tree-entry-name">
                {modal.kind === 'create-dir' ? '文件夹名称' : '名称'}
              </label>
              <input
                id="work-tree-entry-name"
                className="text-field"
                value={nameInput}
                data-autofocus
                maxLength={255}
                required
                disabled={actionBusy}
                onChange={(event) => setNameInput(event.target.value)}
              />
              {actionError && <p className="work-tree-error" role="alert">{actionError}</p>}
              <div className="dialog-footer">
                <button type="button" className="secondary-button" disabled={actionBusy} onClick={() => setModal(null)}>取消</button>
                <button type="submit" className="primary-button" disabled={actionBusy || !nameInput.trim()}>
                  {actionBusy ? '处理中…' : '确定'}
                </button>
              </div>
            </form>
          )}
        </Dialog>
      )}
    </>
  );
}

export function WorkFilesPanel({
  project,
  width,
  getMaxWidth,
  onResize,
  onResizeStateChange,
  onClose,
  onOpenFile,
}: {
  project: WorkProject | null;
  width: number | null;
  getMaxWidth: () => number;
  onResize: (nextWidth: number, maxWidth: number) => void;
  onResizeStateChange: (resizing: boolean) => void;
  onOpenFile: (entry: WorkHostEntry) => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const [resizing, setResizing] = useState(false);
  const [rootLoading, setRootLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => () => {
    dragCleanupRef.current?.();
  }, []);

  const readBaseWidth = useCallback(() => {
    const rectWidth = panelRef.current?.getBoundingClientRect().width ?? 0;
    if (rectWidth > 0) return rectWidth;
    return width ?? 320;
  }, [width]);

  function startResize(startX: number) {
    dragCleanupRef.current?.();
    const startWidth = readBaseWidth();
    setResizing(true);
    onResizeStateChange(true);

    function handleMove(moveEvent: PointerEvent) {
      const max = getMaxWidth();
      onResize(clampWorkFilesWidth(startWidth + (startX - moveEvent.clientX), max), max);
    }

    function handleStop() {
      setResizing(false);
      onResizeStateChange(false);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleStop);
      window.removeEventListener('pointercancel', handleStop);
      dragCleanupRef.current = null;
    }

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleStop);
    window.addEventListener('pointercancel', handleStop);
    dragCleanupRef.current = handleStop;
  }

  return (
    <aside ref={panelRef} className="research-panel work-files-panel" aria-labelledby={headingId}>
      <div
        className={`work-files-resizer${resizing ? ' is-dragging' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整工作目录宽度"
        aria-valuemin={MIN_WORK_FILES_WIDTH}
        aria-valuemax={MAX_WORK_FILES_WIDTH}
        aria-valuenow={Math.round(width ?? 320)}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== undefined && event.button !== 0) return;
          event.preventDefault();
          startResize(event.clientX);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const step = event.shiftKey ? 32 : 16;
          const delta = event.key === 'ArrowLeft' ? step : -step;
          const max = getMaxWidth();
          onResize(readBaseWidth() + delta, max);
        }}
      />
      <header className="research-panel-header">
        <h2 id={headingId} title={project?.directory}>{project ? project.name : '工作目录'}</h2>
        <div className="work-files-header-actions">
          {project && (
            <button
              type="button"
              className="icon-button"
              aria-label="刷新工作目录"
              disabled={rootLoading}
              onClick={() => setRefreshTick((tick) => tick + 1)}
            >
              <RefreshCw size={15} strokeWidth={1.75} className={rootLoading ? 'loading-spinner' : undefined} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="关闭工作目录"
            onClick={onClose}
          >
            <X size={17} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="research-panel-body work-files-body">
        <WorkFileTree
          project={project}
          onOpenFile={onOpenFile}
          refreshTick={refreshTick}
          onLoadingChange={setRootLoading}
        />
      </div>
    </aside>
  );
}
