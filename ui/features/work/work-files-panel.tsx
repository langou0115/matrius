import { LOCAL_WORK_HOST_ID, type WorkHostEntry, type WorkProject } from '@contract/work-projects';
import { ChevronRight, Folder, FolderOpen, KeyRound, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { ApiError } from '@/core/api/instance-client';
import { FileTypeIcon } from '@/features/chat/components/file-type-icon';
import { useInstance } from '@/features/instance/instance-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { browseHostDirectory, createPreviewDirectoryListing, unlockWorkHost } from './work-api';
import {
  MAX_WORK_FILES_WIDTH,
  MIN_WORK_FILES_WIDTH,
  bumpHostUnlockVersion,
  clampWorkFilesWidth,
  useWorkState,
} from './work-state';

type TreeCache = Record<string, { entries: WorkHostEntry[]; loading?: boolean; error?: string }>;

function errorMessage(reason: unknown): string {
  return reason instanceof Error && reason.message ? reason.message : '读取工作目录失败。';
}

function WorkTreeBranch({
  entries,
  depth,
  expanded,
  treeCache,
  onToggleDir,
  onOpenFile,
}: {
  entries: readonly WorkHostEntry[];
  depth: number;
  expanded: Readonly<Record<string, boolean>>;
  treeCache: Readonly<TreeCache>;
  onOpenFile: (entry: WorkHostEntry) => void;
  onToggleDir: (entry: WorkHostEntry) => void;
}) {
  return (
    <>
      {entries.map((entry) => {
        const isDir = entry.kind === 'directory';
        const isOpen = isDir && !!expanded[entry.path];
        const branch = isDir ? treeCache[entry.path] : undefined;
        const accessible = entry.accessible !== false;
        const paddingLeft = 10 + depth * 14;

        if (!isDir) {
          return (
            <button
              key={entry.path}
              type="button"
              className={`work-tree-row is-file${accessible ? '' : ' is-disabled'}`}
              disabled={!accessible}
              onClick={() => onOpenFile(entry)}
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
              className={`work-tree-row is-dir${isOpen ? ' is-open' : ''}${accessible ? '' : ' is-disabled'}`}
              style={{ paddingLeft }}
              aria-expanded={accessible ? isOpen : undefined}
              disabled={!accessible}
              title={entry.path}
              onClick={() => onToggleDir(entry)}
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
  const instance = useInstance();
  const preview = useIsPreview();
  const { hostUnlockVersion } = useWorkState();
  const panelRef = useRef<HTMLElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const [resizing, setResizing] = useState(false);
  const [rootEntries, setRootEntries] = useState<WorkHostEntry[]>([]);
  const [rootLoading, setRootLoading] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);
  const [needsSshUnlock, setNeedsSshUnlock] = useState(false);
  const [sshPassword, setSshPassword] = useState('');
  const [rememberPassword, setRememberPassword] = useState(true);
  const [unlocking, setUnlocking] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [treeCache, setTreeCache] = useState<TreeCache>({});

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
  }, [hostUnlockVersion, loadRoot, project]);

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

  function handleRefresh() {
    if (!project || rootLoading) return;
    setExpanded({});
    setTreeCache({});
    void loadRoot(project);
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
              onClick={handleRefresh}
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
        {!project ? (
          <p className="research-empty">选择项目以查看工作目录</p>
        ) : rootLoading ? (
          <div className="work-tree-state" role="status">
            <LoaderCircle size={15} strokeWidth={1.75} className="loading-spinner" aria-hidden="true" />
            <span>正在读取目录…</span>
          </div>
        ) : needsSshUnlock && project ? (
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
        ) : rootError ? (
          <p className="work-tree-error" role="alert">{rootError}</p>
        ) : rootEntries.length > 0 ? (
          <div className="work-file-tree" role="tree" aria-label={`${project.name} 文件列表`}>
            <WorkTreeBranch
              entries={rootEntries}
              depth={0}
              expanded={expanded}
              treeCache={treeCache}
              onToggleDir={(entry) => void toggleDirectory(entry)}
              onOpenFile={onOpenFile}
            />
          </div>
        ) : (
          <p className="research-empty">目录下暂无文件</p>
        )}
      </div>
    </aside>
  );
}
