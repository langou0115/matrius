import { LOCAL_WORK_HOST_ID, WINDOWS_DRIVES_ROOT, type HostDirectoryListing, type WorkHostEntry } from '@contract/work-projects';
import {
  ArrowUp,
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  FileText,
  Folder,
  LoaderCircle,
  Monitor,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { Dialog } from '@/components/web/dialog';
import { useInstance } from '@/features/instance/instance-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { browseHostDirectory } from './work-api';
import { WorkErrorDialog } from './work-error-dialog';

type Props = {
  hostId: string;
  hostLabel: string;
  initialPath: string;
  onSelect: (path: string, browseDir?: string) => void;
  onClose: () => void;
};

const PREVIEW_TREE: Record<string, { parentPath: string | null; entries: WorkHostEntry[] }> = {
  '/home/dev': {
    parentPath: '/home',
    entries: [
      { kind: 'directory', name: 'projects', path: '/home/dev/projects', accessible: true },
      { kind: 'directory', name: 'restricted', path: '/home/dev/restricted', accessible: false },
      { kind: 'directory', name: 'scripts', path: '/home/dev/scripts', accessible: true },
      { kind: 'directory', name: '.config', path: '/home/dev/.config', accessible: true },
      { kind: 'file', name: 'notes.md', path: '/home/dev/notes.md', accessible: true },
    ],
  },
  '/home/dev/projects': {
    parentPath: '/home/dev',
    entries: [
      { kind: 'directory', name: 'matrius', path: '/home/dev/projects/matrius', accessible: true },
      { kind: 'directory', name: 'sandbox-api', path: '/home/dev/projects/sandbox-api', accessible: true },
      { kind: 'file', name: 'workspace.code-workspace', path: '/home/dev/projects/workspace.code-workspace', accessible: true },
    ],
  },
  '/home/dev/projects/matrius': {
    parentPath: '/home/dev/projects',
    entries: [
      { kind: 'directory', name: 'ui', path: '/home/dev/projects/matrius/ui', accessible: true },
      { kind: 'directory', name: 'server', path: '/home/dev/projects/matrius/server', accessible: true },
      { kind: 'directory', name: 'contract', path: '/home/dev/projects/matrius/contract', accessible: true },
      { kind: 'file', name: 'package.json', path: '/home/dev/projects/matrius/package.json', accessible: true },
      { kind: 'file', name: 'README.md', path: '/home/dev/projects/matrius/README.md', accessible: true },
    ],
  },
  '/home/dev/scripts': {
    parentPath: '/home/dev',
    entries: [
      { kind: 'file', name: 'bootstrap.sh', path: '/home/dev/scripts/bootstrap.sh', accessible: true },
    ],
  },
  '/home/dev/.config': {
    parentPath: '/home/dev',
    entries: [],
  },
  '/home': {
    parentPath: '/',
    entries: [
      { kind: 'directory', name: 'dev', path: '/home/dev', accessible: true },
    ],
  },
  '/': {
    parentPath: null,
    entries: [
      { kind: 'directory', name: 'home', path: '/home', accessible: true },
    ],
  },
  [WINDOWS_DRIVES_ROOT]: {
    parentPath: null,
    entries: [
      { kind: 'directory', name: 'C:\\', path: 'C:\\', accessible: true },
      { kind: 'directory', name: 'D:\\', path: 'D:\\', accessible: true },
    ],
  },
  'C:\\': {
    parentPath: WINDOWS_DRIVES_ROOT,
    entries: [
      { kind: 'directory', name: 'Users', path: 'C:\\Users', accessible: true },
    ],
  },
  'C:\\Users': {
    parentPath: 'C:\\',
    entries: [
      { kind: 'directory', name: 'dev', path: 'C:\\Users\\dev', accessible: true },
    ],
  },
  'C:\\Users\\dev': {
    parentPath: 'C:\\Users',
    entries: [
      { kind: 'directory', name: 'Desktop', path: 'C:\\Users\\dev\\Desktop', accessible: true },
    ],
  },
  'D:\\': {
    parentPath: WINDOWS_DRIVES_ROOT,
    entries: [
      { kind: 'directory', name: 'Engineer', path: 'D:\\Engineer', accessible: true },
    ],
  },
  'D:\\Engineer': {
    parentPath: 'D:\\',
    entries: [
      { kind: 'directory', name: 'matrius', path: 'D:\\Engineer\\matrius', accessible: true },
    ],
  },
};

function previewListing(hostId: string, requestedPath?: string): HostDirectoryListing {
  if (requestedPath && !PREVIEW_TREE[requestedPath]) {
    throw new Error(`无法访问目录：${requestedPath}`);
  }
  const key = requestedPath ?? (hostId === LOCAL_WORK_HOST_ID ? 'C:\\Users\\dev' : '/home/dev');
  const node = PREVIEW_TREE[key];
  return {
    hostId,
    path: key,
    parentPath: node.parentPath,
    ...(key === WINDOWS_DRIVES_ROOT ? { selectable: false } : {}),
    truncated: false,
    entries: node.entries,
  };
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error && reason.message ? reason.message : '读取目录失败，请重试。';
}

function fallbackParentPath(currentPath: string): string | null {
  const trimmed = currentPath.trim();
  if (!trimmed || trimmed === '/' || /^[A-Za-z]:[\\/]?$/u.test(trimmed)) return null;
  const clean = trimmed.replace(/[\\/]+$/u, '');
  const sepIndex = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  if (sepIndex < 0) return null;
  if (sepIndex === 0) return '/';
  const parent = clean.slice(0, sepIndex);
  return /^[A-Za-z]:$/u.test(parent) ? `${parent}\\` : parent;
}

export function DirectoryBrowserDialog({
  hostId,
  hostLabel,
  initialPath,
  onSelect,
  onClose,
}: Props) {
  const instance = useInstance();
  const preview = useIsPreview();

  const initialPreview = preview ? previewListing(hostId, initialPath || undefined) : null;
  const [listing, setListing] = useState<HostDirectoryListing | null>(initialPreview);
  const [pathInput, setPathInput] = useState(initialPreview?.path ?? initialPath);
  const [filter, setFilter] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(!preview);
  const [error, setError] = useState<string | null>(null);
  const listingRef = useRef<HostDirectoryListing | null>(initialPreview);
  const requestSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const loadDirectory = useCallback(async (targetPath?: string) => {
    const seq = ++requestSeq.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setFilter('');

    try {
      const next = preview
        ? previewListing(hostId, targetPath)
        : await browseHostDirectory(instance.request, hostId, targetPath, controller.signal);
      if (requestSeq.current !== seq) return;
      listingRef.current = next;
      setListing(next);
      setPathInput(next.path);
      setSelectedPath(null);
    } catch (reason) {
      if (controller.signal.aborted || requestSeq.current !== seq) return;
      if (listingRef.current) {
        setPathInput(listingRef.current.path);
      }
      setError(errorMessage(reason));
    } finally {
      if (requestSeq.current === seq) {
        setLoading(false);
      }
    }
  }, [hostId, instance.request, preview]);

  useEffect(() => {
    if (preview) return;
    const seq = ++requestSeq.current;
    const controller = new AbortController();
    abortRef.current = controller;

    browseHostDirectory(instance.request, hostId, initialPath || undefined, controller.signal)
      .then((next) => {
        if (controller.signal.aborted || requestSeq.current !== seq) return;
        listingRef.current = next;
        setListing(next);
        setPathInput(next.path);
        setSelectedPath(null);
        setError(null);
      })
      .catch(async (reason: unknown) => {
        if (controller.signal.aborted || requestSeq.current !== seq) return;
        if (initialPath) {
          try {
            const fallback = await browseHostDirectory(instance.request, hostId, undefined, controller.signal);
            if (controller.signal.aborted || requestSeq.current !== seq) return;
            listingRef.current = fallback;
            setListing(fallback);
            setPathInput(fallback.path);
            setSelectedPath(null);
            setError(errorMessage(reason));
            return;
          } catch {
            if (controller.signal.aborted || requestSeq.current !== seq) return;
          }
        }
        setError(errorMessage(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted && requestSeq.current === seq) {
          setLoading(false);
        }
      });

    return () => { controller.abort(); };
  }, [hostId, initialPath, instance.request, preview]);

  const visibleEntries = useMemo(() => {
    const raw = listing?.entries ?? [];
    const byHidden = showHidden ? raw : raw.filter((entry) => !entry.name.startsWith('.'));
    const query = filter.trim().toLowerCase();
    if (!query) return byHidden;
    return byHidden.filter((entry) => entry.name.toLowerCase().includes(query));
  }, [filter, listing, showHidden]);

  const hiddenCount = useMemo(
    () => (listing?.entries ?? []).filter((entry) => entry.name.startsWith('.')).length,
    [listing],
  );

  function handleNavigateSubmit(event: FormEvent) {
    event.preventDefault();
    const nextPath = pathInput.trim();
    if (!nextPath || loading) return;
    void loadDirectory(nextPath);
  }

  const upPath = listing ? listing.parentPath : fallbackParentPath(pathInput);
  const currentLocation = listing?.path ?? pathInput.trim();
  const isWindowsLocal = hostId === LOCAL_WORK_HOST_ID && (
    currentLocation === WINDOWS_DRIVES_ROOT
    || /^[A-Za-z]:(?:[\\/]|$)/u.test(currentLocation)
  );
  const effectiveChoice = selectedPath ?? (listing?.selectable === false ? '' : (listing?.path ?? ''));
  const canConfirm = !loading && Boolean(effectiveChoice);

  return (
    <>
      <Dialog
        title="选择项目目录"
        onClose={onClose}
        className="catalog-dialog work-browser-dialog"
      >
      <div className="work-browser-meta-row">
        <span className="work-host-chip">{hostLabel}</span>
        {listing?.truncated && <span className="work-browser-truncated">仅展示前 {listing.entries.length} 项</span>}
      </div>

      <form className="work-browser-nav" onSubmit={handleNavigateSubmit}>
        {isWindowsLocal && (
          <button
            type="button"
            className={`work-browser-pc${listing?.path === WINDOWS_DRIVES_ROOT ? ' is-active' : ''}`}
            aria-label="此电脑"
            aria-pressed={listing?.path === WINDOWS_DRIVES_ROOT}
            disabled={loading || listing?.path === WINDOWS_DRIVES_ROOT}
            onClick={() => void loadDirectory(WINDOWS_DRIVES_ROOT)}
          >
            <Monitor size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>此电脑</span>
          </button>
        )}
        <button
          type="button"
          className="icon-button work-browser-up"
          aria-label="返回上一级"
          disabled={loading || !upPath}
          onClick={() => { if (upPath) void loadDirectory(upPath); }}
        >
          <ArrowUp size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <input
          className="text-field work-browser-path-input"
          value={pathInput}
          aria-label="当前目录路径"
          placeholder="输入目录路径，按回车前往"
          autoCapitalize="none"
          spellCheck={false}
          onChange={(event) => setPathInput(event.target.value)}
        />
        <button
          type="button"
          className="icon-button work-browser-refresh"
          aria-label="刷新目录"
          disabled={loading}
          onClick={() => void loadDirectory(listing?.path ?? (pathInput.trim() || undefined))}
        >
          <RefreshCw size={15} strokeWidth={1.75} className={loading ? 'loading-spinner' : undefined} aria-hidden="true" />
        </button>
      </form>

      <div className="work-browser-toolbar">
        <div className="work-browser-filter-wrap">
          <Search size={14} strokeWidth={1.75} aria-hidden="true" />
          <input
            type="search"
            className="text-field work-browser-filter"
            value={filter}
            aria-label="筛选当前目录"
            placeholder="筛选当前目录中的文件夹…"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        {hiddenCount > 0 && (
          <button
            type="button"
            className={`work-hidden-toggle${showHidden ? ' is-active' : ''}`}
            aria-pressed={showHidden}
            onClick={() => setShowHidden((current) => !current)}
          >
            {showHidden ? <EyeOff size={13} strokeWidth={1.75} aria-hidden="true" /> : <Eye size={13} strokeWidth={1.75} aria-hidden="true" />}
            隐藏项 ({hiddenCount})
          </button>
        )}
      </div>

      <div className="work-browser-list" role="region" aria-label="目录列表">
        {loading ? (
          <div className="work-browser-state" role="status">
            <LoaderCircle size={18} strokeWidth={1.75} className="loading-spinner" aria-hidden="true" />
            <span>正在读取目录…</span>
          </div>
        ) : visibleEntries.length > 0 ? (
          visibleEntries.map((entry) => {
            const isDir = entry.kind === 'directory';
            const accessible = entry.accessible !== false;
            const isSelected = accessible && selectedPath === entry.path;
            return (
              <button
                key={entry.path}
                type="button"
                className={`work-browser-item${isSelected ? ' is-selected' : ''}${accessible ? '' : ' is-disabled'}`}
                onClick={() => {
                  if (!accessible) {
                    setError(`没有权限访问：${entry.path}`);
                    return;
                  }
                  if (isDir) {
                    void loadDirectory(entry.path);
                  } else {
                    setSelectedPath((current) => (current === entry.path ? null : entry.path));
                  }
                }}
              >
                <span className={`work-entry-icon ${isDir ? 'is-dir' : 'is-file'}`} aria-hidden="true">
                  {isDir ? <Folder size={16} strokeWidth={1.75} /> : <FileText size={16} strokeWidth={1.75} />}
                </span>
                <span className="work-browser-name">{entry.name}</span>
                {!accessible ? (
                  <span className="work-browser-locked">无权限</span>
                ) : isDir ? (
                  <ChevronRight size={14} strokeWidth={1.75} className="work-entry-arrow" aria-hidden="true" />
                ) : isSelected ? (
                  <Check size={14} strokeWidth={2} className="work-entry-check" aria-hidden="true" />
                ) : null}
              </button>
            );
          })
        ) : (
          <p className="catalog-status" role="status">
            {!listing
              ? '无法读取当前目录，可返回上一级或输入其他路径。'
              : filter.trim()
                ? `没有匹配「${filter.trim()}」的文件夹。`
                : hiddenCount > 0 && !showHidden
                  ? '当前目录下仅包含隐藏文件，可点击右侧“隐藏项”查看。'
                  : '当前目录下没有文件或子目录。'}
          </p>
        )}
      </div>

      <div className="work-browser-footer">
        <div className="work-browser-selection" title={effectiveChoice || undefined}>
          <code>{effectiveChoice || (listing?.selectable === false ? '请选择磁盘或目录' : '—')}</code>
        </div>
        <div className="dialog-footer">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button
            type="button"
            className="primary-button"
            data-autofocus
            disabled={!canConfirm}
            onClick={() => {
              if (!effectiveChoice) return;
              onSelect(effectiveChoice, listing?.path ?? effectiveChoice);
              onClose();
            }}
          >
            {selectedPath ? '确认选择' : '选择当前目录'}
          </button>
        </div>
      </div>
      </Dialog>

      {error && (
        <WorkErrorDialog
          title="无法访问目录"
          message={error}
          onClose={() => setError(null)}
        />
      )}
    </>
  );
}
