import type {
  WorkGitChange,
  WorkGitCommitFile,
  WorkGitCommitNode,
  WorkGitDiffRequest,
  WorkGitDiffScope,
  WorkGitStatus,
} from '@contract/work-git';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  CloudDownload,
  Folder,
  FolderOpen,
  GitCommitHorizontal,
  GitFork,
  List,
  ListTree,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from 'react';

import { Dialog } from '@/components/web/dialog';
import { FileTypeIcon } from '@/features/chat/components/file-type-icon';
import { useInstance } from '@/features/instance/instance-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import {
  checkoutWorkGit,
  commitWorkGit,
  discardWorkGit,
  fetchWorkGit,
  pullWorkGit,
  pushWorkGit,
  readWorkGit,
  readWorkGitCommitFiles,
  stageWorkGit,
  unstageWorkGit,
} from './work-api';
import { GitBranchSelect } from './work-git-branch-select';
import { WorkGitDiffView } from './work-git-diff';
import { WorkGitGraph } from './work-git-graph';
import {
  authorColor,
  authorInitials,
  buildGitChangeTree,
  formatGitFullDate,
  parseGitRefs,
  type GitChangeTreeNode,
} from './work-git-model';

const demoCommitFiles: WorkGitCommitFile[] = [
  { path: 'example', status: 'M', additions: 1, deletions: 1 },
  { path: 'ui/main.tsx', status: 'M', additions: 3, deletions: 1 },
];

const SIDEBAR_WIDTH_KEY = 'matrius:work-git-sidebar-width';
const MIN_GIT_SIDEBAR_WIDTH = 220;
const MAX_GIT_SIDEBAR_WIDTH = 480;
const DEFAULT_GIT_SIDEBAR_WIDTH = 296;

const MIN_INSPECTOR_HEIGHT = 200;
const DEFAULT_INSPECTOR_RATIO = 0.52;

const sampleStatus: WorkGitStatus = {
  root: '/home/dev/projects/matrius',
  branch: 'main',
  upstream: 'origin/main',
  ahead: 1,
  behind: 0,
  localBranches: ['main', 'feature/editor'],
  remoteBranches: ['origin/main', 'origin/feature/editor'],
  changes: [
    { path: 'README.md', index: '.', workingTree: 'M' },
    { path: 'ui/main.tsx', index: 'M', workingTree: '.' },
  ],
};

function readStoredSidebarWidth(): number {
  try {
    const raw = globalThis.localStorage?.getItem(SIDEBAR_WIDTH_KEY);
    if (!raw) return DEFAULT_GIT_SIDEBAR_WIDTH;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_GIT_SIDEBAR_WIDTH;
    return Math.round(Math.min(MAX_GIT_SIDEBAR_WIDTH, Math.max(MIN_GIT_SIDEBAR_WIDTH, parsed)));
  } catch {
    return DEFAULT_GIT_SIDEBAR_WIDTH;
  }
}

function persistSidebarWidth(width: number): void {
  try {
    globalThis.localStorage?.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // Ignore storage failures
  }
}

function changeLabel(code: string): string {
  return ({
    M: '修改',
    A: '新增',
    D: '删除',
    T: '类型变更',
    U: '冲突',
    '?': '未跟踪',
  } as Record<string, string>)[code] ?? code;
}

function ChangeRow({
  path,
  code,
  scope,
  treeView,
  depth,
  isSelected,
  isChecked,
  busy,
  onToggleChecked,
  onSelect,
  onStage,
  onUnstage,
  onRequestDiscard,
}: {
  path: string;
  code: string;
  scope: WorkGitDiffScope;
  treeView: boolean;
  depth: number;
  isSelected: boolean;
  isChecked: boolean;
  busy: boolean;
  onToggleChecked: (path: string, enabled: boolean) => void;
  onSelect: (path: string, scope: WorkGitDiffScope) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onRequestDiscard: (paths: string[]) => void;
}) {
  const slash = path.lastIndexOf('/');
  const filename = slash >= 0 ? path.slice(slash + 1) : path;
  const directory = slash >= 0 ? path.slice(0, slash) : '';
  const indentPadding = treeView ? 8 + depth * 14 : 6;

  return (
    <div
      className={`work-git-change${isSelected ? ' is-selected' : ''}`}
      style={{ paddingLeft: indentPadding }}
    >
      <label className="work-git-check-label" title={`选择 ${path}`}>
        <input
          type="checkbox"
          className="work-git-checkbox-input"
          aria-label={`选择 ${path} 进行提交`}
          checked={isChecked}
          disabled={busy}
          onChange={(event) => onToggleChecked(path, event.target.checked)}
        />
        <span className="work-git-checkbox" aria-hidden="true" />
      </label>

      <button
        type="button"
        className="work-git-change-btn"
        title={path}
        aria-pressed={isSelected}
        onClick={() => onSelect(path, scope)}
      >
        <span className="work-git-file-icon" aria-hidden="true">
          <FileTypeIcon file={{ name: filename, type: '' }} />
        </span>
        <span className="work-git-filename">{filename}</span>
        {!treeView && directory && <span className="work-git-directory">{directory}</span>}
      </button>

      <div className="work-git-row-actions">
        {scope === 'worktree' && (
          <>
            <button
              type="button"
              className="icon-button work-git-row-action"
              aria-label={`放弃更改：${path}`}
              title="放弃更改"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                onRequestDiscard([path]);
              }}
            >
              <Undo2 size={13} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button work-git-row-action"
              aria-label={`暂存更改：${path}`}
              title="暂存更改"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                onStage([path]);
              }}
            >
              <Plus size={13} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </>
        )}
        {scope === 'index' && (
          <button
            type="button"
            className="icon-button work-git-row-action"
            aria-label={`取消暂存：${path}`}
            title="取消暂存"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              onUnstage([path]);
            }}
          >
            <Minus size={13} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
      </div>

      <span className="work-git-state-letter" data-change={code} title={changeLabel(code)}>
        {code === '?' ? 'U' : code}
      </span>
    </div>
  );
}

function ChangeTreeBranch({
  nodes,
  scope,
  depth,
  collapsedFolders,
  selected,
  checked,
  busy,
  onToggleFolder,
  onToggleChecked,
  onToggleFolderChecked,
  onSelect,
  onStage,
  onUnstage,
  onRequestDiscard,
}: {
  nodes: readonly GitChangeTreeNode[];
  scope: WorkGitDiffScope;
  depth: number;
  collapsedFolders: Readonly<Record<string, boolean>>;
  selected: WorkGitDiffRequest | null;
  checked: ReadonlySet<string>;
  busy: boolean;
  onToggleFolder: (folderKey: string) => void;
  onToggleChecked: (path: string, enabled: boolean) => void;
  onToggleFolderChecked: (paths: readonly string[], enabled: boolean) => void;
  onSelect: (path: string, scope: WorkGitDiffScope) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onRequestDiscard: (paths: string[]) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === 'file') {
          const { path } = node.change;
          return (
            <ChangeRow
              key={`${scope}:${path}`}
              path={path}
              code={node.code}
              scope={scope}
              treeView
              depth={depth}
              isSelected={selected?.path === path && selected.scope === scope}
              isChecked={checked.has(path)}
              busy={busy}
              onToggleChecked={onToggleChecked}
              onSelect={onSelect}
              onStage={onStage}
              onUnstage={onUnstage}
              onRequestDiscard={onRequestDiscard}
            />
          );
        }

        const folderKey = `${scope}:${node.key}`;
        const isCollapsed = Boolean(collapsedFolders[folderKey]);
        const checkedCount = node.paths.filter((p) => checked.has(p)).length;
        const allChecked = checkedCount > 0 && checkedCount === node.paths.length;
        const someChecked = checkedCount > 0 && checkedCount < node.paths.length;

        return (
          <div key={folderKey} className="work-git-tree-folder">
            <div
              className="work-git-folder-row"
              style={{ paddingLeft: 8 + depth * 14 }}
            >
              <label className="work-git-check-label" title={`选择 ${node.name}`}>
                <input
                  type="checkbox"
                  className="work-git-checkbox-input"
                  aria-label={`选择目录 ${node.name}`}
                  checked={allChecked}
                  data-indeterminate={someChecked ? 'true' : undefined}
                  disabled={busy}
                  onChange={(event) => onToggleFolderChecked(node.paths, event.target.checked)}
                />
                <span className={`work-git-checkbox${someChecked ? ' is-indeterminate' : ''}`} aria-hidden="true" />
              </label>

              <button
                type="button"
                className="work-git-folder-btn"
                aria-expanded={!isCollapsed}
                title={node.key}
                onClick={() => onToggleFolder(folderKey)}
              >
                <ChevronRight
                  size={13}
                  strokeWidth={1.75}
                  className={`work-git-chevron${!isCollapsed ? ' is-open' : ''}`}
                  aria-hidden="true"
                />
                <span className="work-git-folder-icon" aria-hidden="true">
                  {!isCollapsed
                    ? <FolderOpen size={14} strokeWidth={1.75} />
                    : <Folder size={14} strokeWidth={1.75} />}
                </span>
                <span className="work-git-folder-name">{node.name}</span>
              </button>

              <div className="work-git-row-actions">
                {scope === 'worktree' && (
                  <>
                    <button
                      type="button"
                      className="icon-button work-git-row-action"
                      aria-label={`放弃目录更改：${node.name}`}
                      title="放弃目录更改"
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRequestDiscard(node.paths);
                      }}
                    >
                      <Undo2 size={13} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="icon-button work-git-row-action"
                      aria-label={`暂存目录：${node.name}`}
                      title="暂存目录"
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        onStage(node.paths);
                      }}
                    >
                      <Plus size={13} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </>
                )}
                {scope === 'index' && (
                  <button
                    type="button"
                    className="icon-button work-git-row-action"
                    aria-label={`取消暂存目录：${node.name}`}
                    title="取消暂存目录"
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation();
                      onUnstage(node.paths);
                    }}
                  >
                    <Minus size={13} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>

            {!isCollapsed && (
              <div className="work-git-tree-children">
                <ChangeTreeBranch
                  nodes={node.children}
                  scope={scope}
                  depth={depth + 1}
                  collapsedFolders={collapsedFolders}
                  selected={selected}
                  checked={checked}
                  busy={busy}
                  onToggleFolder={onToggleFolder}
                  onToggleChecked={onToggleChecked}
                  onToggleFolderChecked={onToggleFolderChecked}
                  onSelect={onSelect}
                  onStage={onStage}
                  onUnstage={onUnstage}
                  onRequestDiscard={onRequestDiscard}
                />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

export function WorkGitView({ projectId, active }: { projectId: string; active: boolean }) {
  const { request } = useInstance();
  const demo = useIsPreview();

  const [status, setStatus] = useState<WorkGitStatus | null>(demo ? sampleStatus : null);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busy = busyAction !== null;

  const [refresh, setRefresh] = useState(0);
  const [commit, setCommit] = useState<WorkGitCommitNode | null>(null);
  const [commitFiles, setCommitFiles] = useState<WorkGitCommitFile[]>([]);
  const [commitFilesLoading, setCommitFilesLoading] = useState(false);
  const [commitFilesError, setCommitFilesError] = useState<string | null>(null);
  const [selectedCommitFile, setSelectedCommitFile] = useState<string | null>(null);
  const [graphNodes, setGraphNodes] = useState<WorkGitCommitNode[]>([]);
  const [selection, setSelection] = useState<WorkGitDiffRequest | null>(null);

  const [treeView, setTreeView] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});
  const [discardTargets, setDiscardTargets] = useState<string[] | null>(null);

  const [sidebarWidth, setSidebarWidth] = useState<number>(readStoredSidebarWidth);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [inspectorHeight, setInspectorHeight] = useState<number | null>(null);
  const [inspectorMaximized, setInspectorMaximized] = useState(false);
  const [resizingInspector, setResizingInspector] = useState(false);

  const viewRef = useRef<HTMLElement>(null);
  const mainAreaRef = useRef<HTMLDivElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    dragCleanupRef.current?.();
  }, []);

  const selectedChange = status?.changes.find(({ path }) => path === selection?.path);
  const selected = selectedChange && selection
    && (selection.scope === 'index' ? !['.', '?'].includes(selectedChange.index) : selectedChange.workingTree !== '.')
    ? selection
    : null;

  const stagedChanges = useMemo(
    () => (status ? status.changes.filter(({ index }) => index !== '.' && index !== '?') : []),
    [status],
  );
  const workingChanges = useMemo(
    () => (status ? status.changes.filter(({ workingTree }) => workingTree !== '.') : []),
    [status],
  );
  const checkedPaths = useMemo(
    () => status?.changes.filter(({ path }) => checked.has(path)).map(({ path }) => path) ?? [],
    [checked, status],
  );

  useEffect(() => {
    if (demo || !active || busy) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function update() {
      try {
        const result = await readWorkGit(request, projectId, controller.signal);
        if (controller.signal.aborted) return;
        setStatus(result);
        setLoadError(null);
        setChecked((previous) => new Set(result.changes.filter(({ path }) => previous.has(path)).map(({ path }) => path)));
      } catch (reason) {
        if (!controller.signal.aborted) {
          setLoadError(reason instanceof Error ? reason.message : '无法读取 Git 状态。');
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(update, 5000);
      }
    }
    void update();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, busy, demo, projectId, refresh, request]);

  const commitOid = commit?.oid ?? null;
  useEffect(() => {
    if (!active || demo || !commitOid) return;
    const controller = new AbortController();
    void readWorkGitCommitFiles(request, projectId, commitOid, controller.signal).then(
      (files) => {
        if (controller.signal.aborted) return;
        setCommitFiles(files);
        setCommitFilesError(null);
        setCommitFilesLoading(false);
        setSelectedCommitFile((prev) => (prev && files.some((item) => item.path === prev) ? prev : files[0]?.path ?? null));
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        setCommitFiles([]);
        setSelectedCommitFile(null);
        setCommitFilesLoading(false);
        setCommitFilesError(reason instanceof Error ? reason.message : '无法读取提交文件列表。');
      },
    );
    return () => controller.abort();
  }, [active, commitOid, demo, projectId, request]);

  const startSidebarResize = useCallback((startX: number) => {
    dragCleanupRef.current?.();
    const baseWidth = sidebarWidth;
    setResizingSidebar(true);

    function handleMove(event: PointerEvent) {
      const next = Math.round(Math.min(MAX_GIT_SIDEBAR_WIDTH, Math.max(MIN_GIT_SIDEBAR_WIDTH, baseWidth + (event.clientX - startX))));
      setSidebarWidth(next);
      persistSidebarWidth(next);
    }
    function handleStop() {
      setResizingSidebar(false);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleStop);
      window.removeEventListener('pointercancel', handleStop);
      dragCleanupRef.current = null;
    }

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleStop);
    window.addEventListener('pointercancel', handleStop);
    dragCleanupRef.current = handleStop;
  }, [sidebarWidth]);

  const startInspectorResize = useCallback((startY: number) => {
    dragCleanupRef.current?.();
    const areaHeight = mainAreaRef.current?.getBoundingClientRect().height ?? 600;
    const baseHeight = inspectorHeight ?? Math.round(areaHeight * DEFAULT_INSPECTOR_RATIO);
    setResizingInspector(true);

    function handleMove(event: PointerEvent) {
      const maxH = Math.max(MIN_INSPECTOR_HEIGHT, Math.round(areaHeight * 0.82));
      const next = Math.round(Math.min(maxH, Math.max(MIN_INSPECTOR_HEIGHT, baseHeight + (startY - event.clientY))));
      setInspectorHeight(next);
    }
    function handleStop() {
      setResizingInspector(false);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleStop);
      window.removeEventListener('pointercancel', handleStop);
      dragCleanupRef.current = null;
    }

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleStop);
    window.addEventListener('pointercancel', handleStop);
    dragCleanupRef.current = handleStop;
  }, [inspectorHeight]);

  async function runStatusAction(
    actionName: string,
    successNotice: string | null,
    task: () => Promise<WorkGitStatus>,
  ) {
    if (busy) return;
    setBusyAction(actionName);
    setCommitError(null);
    setNotice(null);
    try {
      const nextStatus = await task();
      setStatus(nextStatus);
      setLoadError(null);
      setChecked((previous) => new Set(nextStatus.changes.filter(({ path }) => previous.has(path)).map(({ path }) => path)));
      if (successNotice) setNotice(successNotice);
      setRefresh((value) => value + 1);
    } catch (reason) {
      setCommitError(reason instanceof Error ? reason.message : '操作失败，请重试。');
    } finally {
      setBusyAction(null);
    }
  }

  function handleStage(paths: string[]) {
    if (!paths.length || busy) return;
    if (demo) {
      setStatus((prev) => prev && {
        ...prev,
        changes: prev.changes.map((c) => (paths.includes(c.path)
          ? { ...c, index: c.workingTree === '?' ? 'A' : c.workingTree, workingTree: '.' }
          : c)),
      });
      return;
    }
    void runStatusAction('stage', null, () => stageWorkGit(request, projectId, { paths }));
  }

  function handleUnstage(paths: string[]) {
    if (!paths.length || busy) return;
    if (demo) {
      setStatus((prev) => prev && {
        ...prev,
        changes: prev.changes.map((c) => (paths.includes(c.path)
          ? { ...c, index: '.', workingTree: c.index === 'A' ? '?' : c.index }
          : c)),
      });
      return;
    }
    void runStatusAction('unstage', null, () => unstageWorkGit(request, projectId, { paths }));
  }

  function handleDiscardConfirmed() {
    if (!discardTargets?.length || busy) return;
    const targets = discardTargets;
    setDiscardTargets(null);
    if (demo) {
      setStatus((prev) => prev && {
        ...prev,
        changes: prev.changes
          .map((c) => (targets.includes(c.path) ? { ...c, workingTree: '.' } : c))
          .filter((c) => !(c.index === '.' && c.workingTree === '.') && !(c.index === '?' && targets.includes(c.path))),
      });
      return;
    }
    void runStatusAction('discard', '已放弃所选工作区更改', () => discardWorkGit(request, projectId, { paths: targets }));
  }

  function handleCheckout(branch: string) {
    if (!branch || branch === status?.branch || busy) return;
    if (demo) {
      const normalized = status?.remoteBranches.includes(branch) && branch.includes('/')
        ? branch.slice(branch.indexOf('/') + 1)
        : branch;
      setStatus((prev) => prev && {
        ...prev,
        branch: normalized,
        localBranches: prev.localBranches.includes(normalized) ? prev.localBranches : [...prev.localBranches, normalized],
      });
      setNotice(`已切换到分支 ${normalized}`);
      return;
    }
    void runStatusAction('checkout', `已切换到分支 ${branch}`, () => checkoutWorkGit(request, projectId, { branch }));
  }

  async function handleFetch() {
    if (busy || demo) return;
    await runStatusAction('fetch', '已获取远程分支', () => fetchWorkGit(request, projectId));
  }

  async function handlePull() {
    if (busy || demo) return;
    await runStatusAction('pull', '已拉取远程更新', () => pullWorkGit(request, projectId));
  }

  async function handlePush() {
    if (busy || demo) return;
    await runStatusAction('push', '已推送到远程分支', () => pushWorkGit(request, projectId));
  }

  const canCommitChecked = checkedPaths.length > 0;
  const canCommitStaged = !canCommitChecked && stagedChanges.length > 0;
  const canSubmitCommit = !busy && !loadError && Boolean(message.trim()) && (canCommitChecked || canCommitStaged);

  async function submitCommit() {
    if (!canSubmitCommit) return;
    const commitText = message.trim();
    const targetPaths = canCommitChecked
      ? checkedPaths
      : stagedChanges.map(({ path }) => path);

    setBusyAction('commit');
    setCommitError(null);
    setNotice(null);
    try {
      const { oid } = demo
        ? { oid: '9b832aa' }
        : await commitWorkGit(
            request,
            projectId,
            canCommitChecked ? { message: commitText, paths: targetPaths } : { message: commitText, staged: true },
          );
      if (demo) {
        setStatus((previous) => previous && {
          ...previous,
          ahead: previous.ahead + 1,
          changes: canCommitChecked
            ? previous.changes.filter(({ path }) => !targetPaths.includes(path))
            : previous.changes
                .map((c) => ({ ...c, index: '.' }))
                .filter((c) => c.workingTree !== '.'),
        });
      }
      setNotice(`已提交 ${oid}`);
      setRefresh((value) => value + 1);
      setMessage('');
      setChecked(new Set());
    } catch (reason) {
      setCommitError(reason instanceof Error ? reason.message : '提交失败。');
    } finally {
      setBusyAction(null);
    }
  }

  function handleCommitFormSubmit(event: FormEvent) {
    event.preventDefault();
    void submitCommit();
  }

  function handleCommitKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void submitCommit();
    }
  }

  function toggleChecked(path: string, enabled: boolean) {
    setChecked((previous) => {
      const next = new Set(previous);
      if (enabled) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  function toggleFolderChecked(paths: readonly string[], enabled: boolean) {
    setChecked((previous) => {
      const next = new Set(previous);
      for (const path of paths) {
        if (enabled) next.add(path);
        else next.delete(path);
      }
      return next;
    });
  }

  function handleSelectChange(path: string, scope: WorkGitDiffScope) {
    const isSame = selected?.path === path && selected.scope === scope;
    setCommit(null);
    setSelectedCommitFile(null);
    setSelection({ path, scope });
    if (isSame) setRefresh((value) => value + 1);
  }

  function handleSelectCommit(node: WorkGitCommitNode) {
    setSelection(null);
    setCommitFilesError(null);
    setInspectorMaximized(false);
    setCommit(node);
    if (demo) {
      setCommitFiles(demoCommitFiles);
      setCommitFilesLoading(false);
      setSelectedCommitFile(demoCommitFiles[0]?.path ?? null);
    } else {
      setCommitFiles([]);
      setSelectedCommitFile(null);
      setCommitFilesLoading(true);
    }
  }

  const groups: { title: string; scope: WorkGitDiffScope; changes: WorkGitChange[] }[] = useMemo(() => {
    if (!status) return [];
    const list: { title: string; scope: WorkGitDiffScope; changes: WorkGitChange[] }[] = [];
    if (stagedChanges.length > 0) {
      list.push({ title: '暂存的更改', scope: 'index', changes: stagedChanges });
    }
    list.push({ title: '更改', scope: 'worktree', changes: workingChanges });
    return list;
  }, [stagedChanges, status, workingChanges]);

  const commitButtonLabel = busyAction === 'commit'
    ? '正在提交…'
    : canCommitChecked
      ? `提交 ${checkedPaths.length} 个文件`
      : canCommitStaged
        ? `提交已暂存 (${stagedChanges.length})`
        : '提交';

  const commitRefs = useMemo(() => (commit ? parseGitRefs(commit.refs) : []), [commit]);
  const viewStyle = {
    '--work-git-sidebar-width': `${sidebarWidth}px`,
  } as CSSProperties;

  return (
    <section
      ref={viewRef}
      className={`work-git-view${resizingSidebar ? ' is-resizing-col' : ''}${resizingInspector ? ' is-resizing-row' : ''}`}
      style={viewStyle}
      role="tabpanel"
      aria-label="Git"
      hidden={!active}
    >
      <aside className="work-git-sidebar" aria-label="源代码管理">
        <header className="work-git-header">
          <button
            type="button"
            className="icon-button work-git-graph-button"
            aria-label="查看提交图"
            title="查看提交图"
            aria-pressed={Boolean(status && !selected && !commit)}
            disabled={!status}
            onClick={() => {
              setSelection(null);
              setCommit(null);
              setSelectedCommitFile(null);
            }}
          >
            <GitFork size={15} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <strong title={status?.root}>源代码管理</strong>
          <button
            type="button"
            className="icon-button"
            aria-label={treeView ? '切换为列表视图' : '切换为树状视图'}
            title={treeView ? '切换为列表视图' : '切换为树状视图'}
            disabled={!status}
            onClick={() => setTreeView((value) => !value)}
          >
            {treeView
              ? <List size={15} strokeWidth={1.75} aria-hidden="true" />
              : <ListTree size={15} strokeWidth={1.75} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="刷新 Git 状态"
            title="刷新 Git 状态"
            disabled={busy}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={14} strokeWidth={1.75} className={busyAction === 'refresh' ? 'loading-spinner' : undefined} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="获取远程分支"
            title="获取远程分支 (Fetch)"
            disabled={busy || demo || !status || !!loadError}
            onClick={() => void handleFetch()}
          >
            <CloudDownload size={15} strokeWidth={1.75} className={busyAction === 'fetch' ? 'loading-spinner' : undefined} aria-hidden="true" />
          </button>
        </header>

        {status && (
          <div className="work-git-branch-bar">
            <div className="work-git-branch-row">
              <GitBranchSelect
                ariaLabel="切换分支"
                placeholder="分离的 HEAD"
                value={status.branch}
                localBranches={status.localBranches}
                remoteBranches={status.remoteBranches}
                disabled={busy}
                onChange={(branch) => {
                  if (branch) handleCheckout(branch);
                }}
              />
              {status.upstream && (
                <div className="work-git-sync-actions">
                  <button
                    type="button"
                    className="icon-button work-git-sync-btn"
                    aria-label="拉取远程更新"
                    title="拉取 (Pull)"
                    disabled={busy || demo || !!loadError}
                    onClick={() => void handlePull()}
                  >
                    <ArrowDown size={13} strokeWidth={1.85} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-button work-git-sync-btn"
                    aria-label="推送到远程"
                    title="推送 (Push)"
                    disabled={busy || demo || !!loadError}
                    onClick={() => void handlePush()}
                  >
                    <ArrowUp size={13} strokeWidth={1.85} aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
            {status.upstream && (
              <div className="work-git-upstream">
                <span className="work-git-upstream-name" title={status.upstream}>{status.upstream}</span>
                <span className={`work-git-ab${status.ahead > 0 ? ' is-active' : ''}`} title="领先提交数">
                  <ArrowUp size={11} strokeWidth={2} aria-hidden="true" />
                  {status.ahead}
                </span>
                <span className={`work-git-ab${status.behind > 0 ? ' is-active' : ''}`} title="落后提交数">
                  <ArrowDown size={11} strokeWidth={2} aria-hidden="true" />
                  {status.behind}
                </span>
              </div>
            )}
          </div>
        )}

        {loadError && <p className="work-git-banner is-error" role="alert">{loadError}</p>}
        {!status && !loadError && <p className="work-tree-state" role="status">正在读取 Git 状态…</p>}

        {status && (
          <div className="work-git-sidebar-body">
            <form className="work-git-submit" onSubmit={handleCommitFormSubmit}>
              <div className="work-git-commit-box">
                <textarea
                  placeholder="消息 (Ctrl+Enter 提交)"
                  aria-label="提交说明"
                  maxLength={1000}
                  value={message}
                  disabled={busy}
                  onKeyDown={handleCommitKeyDown}
                  onChange={(event) => setMessage(event.target.value)}
                />
              </div>
              <div className="work-git-commit-controls">
                <button type="submit" className="work-git-commit-btn" disabled={!canSubmitCommit}>
                  <Check size={14} strokeWidth={2} aria-hidden="true" />
                  <span>{commitButtonLabel}</span>
                </button>
                <label className="work-git-select-all" title="全选或取消全选">
                  <input
                    type="checkbox"
                    className="work-git-checkbox-input"
                    aria-label="选择全部变更"
                    checked={checkedPaths.length > 0 && checkedPaths.length === status.changes.length}
                    disabled={busy || !status.changes.length}
                    onChange={(event) => setChecked(new Set(event.target.checked ? status.changes.map(({ path }) => path) : []))}
                  />
                  <span className="work-git-checkbox" aria-hidden="true" />
                  <span>全选</span>
                </label>
              </div>
              {commitError && (
                <div className="work-git-banner is-error" role="alert">
                  <span>{commitError}</span>
                  <button type="button" className="icon-button" aria-label="关闭错误提示" onClick={() => setCommitError(null)}>
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
              )}
              {(busyAction === 'fetch' || busyAction === 'pull' || busyAction === 'push' || notice) && (
                <div className="work-git-banner is-info" role="status">
                  <span>
                    {busyAction === 'fetch'
                      ? '正在获取远程分支…'
                      : busyAction === 'pull'
                        ? '正在拉取更新…'
                        : busyAction === 'push'
                          ? '正在推送提交…'
                          : notice}
                  </span>
                  {notice && !busy && (
                    <button type="button" className="icon-button" aria-label="关闭提示" onClick={() => setNotice(null)}>
                      <X size={12} aria-hidden="true" />
                    </button>
                  )}
                </div>
              )}
            </form>

            <div className="work-git-changes">
              {groups.map(({ title, scope, changes }) => {
                const isCollapsed = Boolean(collapsedSections[scope]);
                const treeNodes = treeView
                  ? buildGitChangeTree(changes.map((change) => ({
                      change,
                      code: scope === 'index' ? change.index : change.workingTree,
                    })))
                  : null;

                return (
                  <div key={scope} className="work-git-group">
                    <div className="work-git-group-header">
                      <button
                        type="button"
                        className="work-git-group-toggle"
                        aria-expanded={!isCollapsed}
                        onClick={() => setCollapsedSections((prev) => ({ ...prev, [scope]: !isCollapsed }))}
                      >
                        <ChevronRight
                          size={14}
                          strokeWidth={1.75}
                          className={`work-git-chevron${!isCollapsed ? ' is-open' : ''}`}
                          aria-hidden="true"
                        />
                        <span className="work-git-group-title">{title}</span>
                      </button>
                      <div className="work-git-group-actions">
                        {scope === 'worktree' && changes.length > 0 && (
                          <>
                            <button
                              type="button"
                              className="icon-button work-git-row-action"
                              aria-label="放弃全部更改"
                              title="放弃全部更改"
                              disabled={busy}
                              onClick={() => setDiscardTargets(changes.map((c) => c.path))}
                            >
                              <Undo2 size={13} strokeWidth={1.75} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="icon-button work-git-row-action"
                              aria-label="暂存全部更改"
                              title="暂存全部更改"
                              disabled={busy}
                              onClick={() => handleStage(changes.map((c) => c.path))}
                            >
                              <Plus size={13} strokeWidth={1.75} aria-hidden="true" />
                            </button>
                          </>
                        )}
                        {scope === 'index' && changes.length > 0 && (
                          <button
                            type="button"
                            className="icon-button work-git-row-action"
                            aria-label="取消暂存全部"
                            title="取消暂存全部"
                            disabled={busy}
                            onClick={() => handleUnstage(changes.map((c) => c.path))}
                          >
                            <Minus size={13} strokeWidth={1.75} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                      <span className="work-git-count-pill">{changes.length}</span>
                    </div>

                    {!isCollapsed && (
                      <div className="work-git-group-items">
                        {changes.length === 0 ? (
                          <p className="work-git-empty-state">工作区干净，没有待提交更改</p>
                        ) : treeNodes ? (
                          <ChangeTreeBranch
                            nodes={treeNodes}
                            scope={scope}
                            depth={0}
                            collapsedFolders={collapsedFolders}
                            selected={selected}
                            checked={checked}
                            busy={busy}
                            onToggleFolder={(key) => setCollapsedFolders((prev) => ({ ...prev, [key]: !prev[key] }))}
                            onToggleChecked={toggleChecked}
                            onToggleFolderChecked={toggleFolderChecked}
                            onSelect={handleSelectChange}
                            onStage={handleStage}
                            onUnstage={handleUnstage}
                            onRequestDiscard={(targets) => setDiscardTargets(targets)}
                          />
                        ) : (
                          changes.map(({ path, index, workingTree }) => {
                            const code = scope === 'index' ? index : workingTree;
                            return (
                              <ChangeRow
                                key={`${scope}:${path}`}
                                path={path}
                                code={code}
                                scope={scope}
                                treeView={false}
                                depth={0}
                                isSelected={selected?.path === path && selected.scope === scope}
                                isChecked={checked.has(path)}
                                busy={busy}
                                onToggleChecked={toggleChecked}
                                onSelect={handleSelectChange}
                                onStage={handleStage}
                                onUnstage={handleUnstage}
                                onRequestDiscard={(targets) => setDiscardTargets(targets)}
                              />
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </aside>

      <div
        className={`work-git-resizer${resizingSidebar ? ' is-dragging' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整源代码管理栏宽度"
        aria-valuemin={MIN_GIT_SIDEBAR_WIDTH}
        aria-valuemax={MAX_GIT_SIDEBAR_WIDTH}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== undefined && event.button !== 0) return;
          event.preventDefault();
          startSidebarResize(event.clientX);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const step = event.shiftKey ? 32 : 16;
          const delta = event.key === 'ArrowRight' ? step : -step;
          const next = Math.round(Math.min(MAX_GIT_SIDEBAR_WIDTH, Math.max(MIN_GIT_SIDEBAR_WIDTH, sidebarWidth + delta)));
          setSidebarWidth(next);
          persistSidebarWidth(next);
        }}
      />

      <div className="work-git-main" ref={mainAreaRef}>
        {selected ? (
          <WorkGitDiffView
            key={JSON.stringify([selected.path, selected.scope])}
            projectId={projectId}
            file={selected}
            active={active}
            demo={demo}
            refresh={refresh}
            busy={busy}
            onStageFile={(path) => handleStage([path])}
            onUnstageFile={(path) => handleUnstage([path])}
            onDiscardFile={(path) => setDiscardTargets([path])}
            onClose={() => setSelection(null)}
          />
        ) : (
          status && active ? (
            <>
              {!inspectorMaximized && (
                <WorkGitGraph
                  key={projectId}
                  projectId={projectId}
                  demo={demo}
                  refresh={refresh}
                  localBranches={status.localBranches}
                  remoteBranches={status.remoteBranches}
                  pendingChangeCount={status.changes.length}
                  selectedOid={commit?.oid ?? null}
                  onCommit={handleSelectCommit}
                  onNodesLoaded={setGraphNodes}
                />
              )}

              {commit && (
                <section
                  className={`work-git-inspector${inspectorMaximized ? ' is-maximized' : ''}`}
                  style={!inspectorMaximized && inspectorHeight ? { height: inspectorHeight, flex: 'none' } : undefined}
                  aria-label="提交详情"
                >
                  {!inspectorMaximized && (
                    <div
                      className={`work-git-inspector-resizer${resizingInspector ? ' is-dragging' : ''}`}
                      role="separator"
                      aria-orientation="horizontal"
                      aria-label="调整提交详情面板高度"
                      tabIndex={0}
                      onPointerDown={(event) => {
                        if (event.button !== undefined && event.button !== 0) return;
                        event.preventDefault();
                        startInspectorResize(event.clientY);
                      }}
                    />
                  )}

                  <header className="work-git-inspector-header">
                    <div className="work-git-inspector-title-row">
                      <GitCommitHorizontal size={15} strokeWidth={1.75} aria-hidden="true" />
                      <strong title={commit.subject}>{commit.subject || '无提交说明'}</strong>
                      {commitRefs.map((ref) => (
                        <span key={ref.raw} className={`work-git-ref is-${ref.kind}${ref.kind === 'head' ? ' current' : ''}`}>
                          {ref.label}
                        </span>
                      ))}
                      <div className="work-git-inspector-actions">
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={inspectorMaximized ? '还原分栏' : '最大化提交详情'}
                          title={inspectorMaximized ? '还原分栏' : '最大化提交详情'}
                          onClick={() => setInspectorMaximized((value) => !value)}
                        >
                          {inspectorMaximized
                            ? <Minimize2 size={14} strokeWidth={1.75} aria-hidden="true" />
                            : <Maximize2 size={14} strokeWidth={1.75} aria-hidden="true" />}
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="关闭提交详情"
                          title="关闭提交详情"
                          onClick={() => {
                            setCommit(null);
                            setSelectedCommitFile(null);
                            setInspectorMaximized(false);
                          }}
                        >
                          <X size={15} strokeWidth={1.75} aria-hidden="true" />
                        </button>
                      </div>
                    </div>

                    <div className="work-git-inspector-meta">
                      <span className="work-git-inspector-author">
                        <span
                          className="work-git-author-avatar"
                          style={{ background: authorColor(commit.author) }}
                          aria-hidden="true"
                        >
                          {authorInitials(commit.author)}
                        </span>
                        <span>{commit.author}</span>
                        {commit.email && <span className="work-git-inspector-email">&lt;{commit.email}&gt;</span>}
                      </span>
                      <time dateTime={commit.date}>{formatGitFullDate(commit.date)}</time>
                      <code className="work-git-graph-hash" title={commit.oid}>{commit.oid.slice(0, 7)}</code>
                      {commit.parents.length > 0 && (
                        <span className="work-git-inspector-parents">
                          <span>父提交:</span>
                          {commit.parents.map((parentOid) => {
                            const parentNode = graphNodes.find((n) => n.oid === parentOid);
                            return parentNode ? (
                              <button
                                key={parentOid}
                                type="button"
                                className="work-git-parent-link"
                                title={parentNode.subject}
                                onClick={() => handleSelectCommit(parentNode)}
                              >
                                {parentOid.slice(0, 7)}
                              </button>
                            ) : (
                              <code key={parentOid} className="work-git-graph-hash">{parentOid.slice(0, 7)}</code>
                            );
                          })}
                        </span>
                      )}
                    </div>

                    {commit.body && <p className="work-git-inspector-body">{commit.body}</p>}
                  </header>

                  <div className="work-git-inspector-content">
                    <aside className="work-git-inspector-files" aria-label="此次提交更改的文件">
                      <div className="work-git-inspector-files-head">
                        <span>变更文件</span>
                        <span className="work-git-count-pill">{commitFiles.length}</span>
                      </div>
                      {commitFilesLoading ? (
                        <p className="work-git-empty-state" role="status">正在读取文件列表…</p>
                      ) : commitFilesError ? (
                        <p className="work-tree-error" role="alert">{commitFilesError}</p>
                      ) : commitFiles.length === 0 ? (
                        <p className="work-git-empty-state">无文件变更</p>
                      ) : (
                        commitFiles.map((item) => {
                          const fileName = item.path.split('/').at(-1) || item.path;
                          const fileDir = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '';
                          const activeFile = selectedCommitFile === item.path;
                          return (
                            <button
                              key={item.path}
                              type="button"
                              className={`work-git-inspector-file${activeFile ? ' is-selected' : ''}`}
                              aria-pressed={activeFile}
                              title={item.path}
                              onClick={() => setSelectedCommitFile(item.path)}
                            >
                              <span className="work-git-file-icon" aria-hidden="true">
                                <FileTypeIcon file={{ name: fileName, type: '' }} />
                              </span>
                              <span className="work-git-inspector-file-copy">
                                <span className="work-git-filename">{fileName}</span>
                                {fileDir && <span className="work-git-directory">{fileDir}</span>}
                              </span>
                              <span className="work-git-diff-stats">
                                {item.additions !== null && item.additions > 0 && <span className="is-add">+{item.additions}</span>}
                                {item.deletions !== null && item.deletions > 0 && <span className="is-del">-{item.deletions}</span>}
                              </span>
                              <span className="work-git-state-letter" data-change={item.status} title={changeLabel(item.status)}>
                                {item.status}
                              </span>
                            </button>
                          );
                        })
                      )}
                    </aside>

                    {selectedCommitFile ? (
                      <WorkGitDiffView
                        key={`${commit.oid}:${selectedCommitFile}`}
                        projectId={projectId}
                        file={{ oid: commit.oid, subject: commit.subject, path: selectedCommitFile }}
                        active={active}
                        demo={demo}
                      />
                    ) : commitFilesLoading ? (
                      <p className="work-tree-state work-git-diff-notice" role="status">正在读取文件列表…</p>
                    ) : (
                      <p className="work-tree-state work-git-diff-notice">
                        {commitFiles.length === 0 ? '此提交没有文件变更。' : '选择左侧文件查看差异'}
                      </p>
                    )}
                  </div>
                </section>
              )}
            </>
          ) : null
        )}
      </div>

      {discardTargets && (
        <Dialog
          title="放弃工作区更改"
          className="compact-dialog work-git-discard-dialog"
          onClose={() => setDiscardTargets(null)}
        >
          <p className="dialog-description">
            {discardTargets.length === 1
              ? `确定要放弃对「${discardTargets[0]}」的更改吗？此操作无法撤销，未跟踪的新文件将被永久删除。`
              : `确定要放弃所选 ${discardTargets.length} 个文件的更改吗？此操作无法撤销，未跟踪的新文件将被永久删除。`}
          </p>
          <div className="dialog-footer">
            <button type="button" className="secondary-button" onClick={() => setDiscardTargets(null)}>
              取消
            </button>
            <button type="button" className="danger-button" data-autofocus onClick={handleDiscardConfirmed}>
              放弃更改
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
