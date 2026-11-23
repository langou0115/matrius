import { LOCAL_WORK_HOST_ID, type WorkHostEntry } from '@contract/work-projects';
import {
  WINDOWS_SHELL_OPTIONS,
  defaultTerminalTitle,
  normalizeWorkTerminalTitle,
  type WindowsTerminalShell,
  type WorkTerminalSession,
} from '@contract/work-terminals';
import {
  ChevronDown,
  FileText,
  PanelRight,
  GitBranch,
  Pencil,
  Pin,
  PinOff,
  Plus,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type MouseEvent,
} from 'react';

import { Dialog } from '@/components/web/dialog';
import { useFeature, useInstance } from '@/features/instance/instance-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { TerminalPresetIcon } from './terminal-preset-icon';
import {
  createWorkTerminal,
  deleteWorkTerminal,
  listWorkTerminals,
  updateWorkTerminal,
} from './work-api';
import { WorkErrorDialog } from './work-error-dialog';
import { WorkGitView } from './work-git-view';
import { WorkFilePreview } from './work-file-preview';
import { useWorkFileSave } from './work-file-save';
import { WorkFilesPanel } from './work-files-panel';
import { loadWorkSettings } from './work-shell-preference';
import {
  MAX_WORK_FILES_WIDTH,
  MIN_WORK_FILES_WIDTH,
  addWorkTerminal,
  bumpCliSessionsRefresh,
  detectPreviewPlatform,
  closeWorkFiles,
  openWorkFile,
  openWorkGit,
  closeWorkGit,
  isFileDraftDirty,
  hydrateWorkSettings,
  isWindowsPlatform,
  removeWorkTerminals,
  reorderWorkTerminals,
  selectWorkTerminal,
  setWorkFilesPanelWidth,
  setWorkServerPlatform,
  setWorkTerminals,
  toggleWorkFilesPanel,
  updateWorkTerminalMeta,
  useWorkState,
} from './work-state';
import { WorkTerminalView } from './work-terminal-view';

function resolveTabDragPosition(
  event: DragEvent<HTMLElement>,
  fromIndex: number,
  toIndex: number,
): 'before' | 'after' {
  const rect = typeof event.currentTarget?.getBoundingClientRect === 'function'
    ? event.currentTarget.getBoundingClientRect()
    : null;
  if (rect && rect.width > 0 && event.clientX > 0) {
    return event.clientX > rect.left + rect.width / 2 ? 'after' : 'before';
  }
  return fromIndex < toIndex ? 'after' : 'before';
}

function createPreviewTerminalSession(input: {
  projectId: string;
  hostId: string;
  title: string;
  shell?: WindowsTerminalShell;
  cwd: string;
}): WorkTerminalSession {
  return {
    id: `mock-terminal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    projectId: input.projectId,
    hostId: input.hostId,
    title: input.title,
    preset: 'shell',
    ...(input.shell ? { shell: input.shell } : {}),
    command: '',
    cwd: input.cwd,
    status: 'running',
    exitCode: null,
    pinned: false,
    createdAt: Date.now(),
  };
}

export function WorkWorkspace() {
  const instance = useInstance();
  const preview = useIsPreview();
  const hasGitFeature = useFeature('work-git');
  const gitEnabled = preview || hasGitFeature;
  const saveFile = useWorkFileSave();
  const {
    projects,
    activeProjectId,
    terminals,
    activeTerminalId,
    fileTabsByProject,
    gitTabsByProject,
    editorFontSize,
    hostUnlockVersion,
    filesPanelOpen,
    filesPanelWidth,
    serverPlatform,
    defaultWindowsShell,
    defaultWindowsShellLoaded,
  } = useWorkState();
  const hasUnsavedFiles = Object.values(fileTabsByProject).some((tabs) =>
    Array.from(tabs.drafts.values()).some(isFileDraftDirty),
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [resizingFiles, setResizingFiles] = useState(false);
  const [viewMeta, setViewMeta] = useState<Record<string, { pinned?: boolean; title?: string }>>({});
  const [tabMenu, setTabMenu] = useState<{
    key: string;
    projectId: string;
    anchor: HTMLElement | null;
    fallbackX: number;
    fallbackY: number;
  } | null>(null);
  const [renaming, setRenaming] = useState<{ key: string; terminal?: WorkTerminalSession } | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [draggingTerminalId, setDraggingTerminalId] = useState<string | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<{
    terminalId: string;
    position: 'before' | 'after';
  } | null>(null);

  const activeFileTabRef = useRef<HTMLButtonElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const addControlRef = useRef<HTMLDivElement>(null);
  const addCaretRef = useRef<HTMLButtonElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const tabMenuRef = useRef<HTMLDivElement>(null);
  const dragTerminalIdRef = useRef<string | null>(null);

  const clearTabDragState = useCallback(() => {
    dragTerminalIdRef.current = null;
    setDraggingTerminalId(null);
    setTabDropTarget(null);
  }, []);

  const activeProject = projects.find((item) => item.id === activeProjectId) ?? projects[0] ?? null;
  const projectTerminals = activeProject
    ? terminals.filter((item) => item.projectId === activeProject.id)
    : [];
  const fileTabs = activeProject ? fileTabsByProject[activeProject.id] : undefined;
  const gitTab = gitEnabled && activeProject ? gitTabsByProject[activeProject.id] : undefined;
  const gitActive = gitTab === 'active';
  const activeFile = gitActive ? undefined : fileTabs?.entries.find((entry) => entry.path === fileTabs.activePath);
  const filePaths = fileTabs?.entries.map((entry) => entry.path) ?? [];
  useLayoutEffect(() => {
    if (activeFile) activeFileTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeFile]);
  const projectId = activeProject?.id;
  const gitKey = JSON.stringify([projectId, 'git']);
  const fileKey = (path: string) => JSON.stringify([projectId, 'file', path]);
  const terminalKey = (id: string) => JSON.stringify([projectId, 'terminal', id]);
  const menuTerminal = projectTerminals.find((terminal) => terminalKey(terminal.id) === tabMenu?.key);
  const menuFile = fileTabs?.entries.find((entry) => fileKey(entry.path) === tabMenu?.key);
  const menuGit = Boolean(gitTab && tabMenu?.key === gitKey);
  const menuOpen = Boolean(tabMenu && tabMenu.projectId === projectId && (menuTerminal || menuFile || menuGit));
  const menuTitle = menuTerminal?.title ?? viewMeta[tabMenu?.key ?? '']?.title ?? menuFile?.name ?? 'Git';
  const menuPinned = menuTerminal?.pinned ?? viewMeta[tabMenu?.key ?? '']?.pinned;
  const effectivePlatform = preview ? (serverPlatform ?? detectPreviewPlatform()) : serverPlatform;
  const isWindowsLocal = activeProject?.hostId === LOCAL_WORK_HOST_ID && isWindowsPlatform(effectivePlatform);

  useEffect(() => {
    if (!hasUnsavedFiles) return;
    function warnAboutUnsavedFiles(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = true;
    }
    window.addEventListener('beforeunload', warnAboutUnsavedFiles);
    return () => window.removeEventListener('beforeunload', warnAboutUnsavedFiles);
  }, [hasUnsavedFiles]);

  useEffect(() => {
    if (preview) {
      if (serverPlatform === null) setWorkServerPlatform(detectPreviewPlatform());
      return;
    }
    if (instance.status !== 'ready') return;
    if (serverPlatform !== null && defaultWindowsShellLoaded) return;
    let cancelled = false;
    Promise.all([
      serverPlatform === null ? listWorkTerminals(instance.request).catch(() => null) : Promise.resolve(null),
      !defaultWindowsShellLoaded ? loadWorkSettings(instance.request).catch(() => null) : Promise.resolve(null),
    ]).then(([terminalRes, workSettings]) => {
      if (cancelled) return;
      if (workSettings) hydrateWorkSettings(workSettings);
      if (terminalRes) {
        if (terminalRes.platform) {
          setWorkServerPlatform(terminalRes.platform, terminalRes.windowsBuild ?? null);
        }
        if (terminals.length === 0 && terminalRes.items.length > 0) {
          setWorkTerminals(terminalRes.items);
        }
      }
    });
    return () => { cancelled = true; };
  }, [defaultWindowsShellLoaded, instance.request, instance.status, preview, serverPlatform, terminals.length]);

  useEffect(() => {
    if (!addMenuOpen) return;
    addMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });

    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && addControlRef.current?.contains(event.target)) return;
      setAddMenuOpen(false);
    }
    function onDismiss() {
      setAddMenuOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onDismiss);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onDismiss);
    };
  }, [addMenuOpen]);

  useLayoutEffect(() => {
    const element = tabMenuRef.current;
    if (!tabMenu || !element || !menuOpen) return;
    const { width, height } = element.getBoundingClientRect();
    const viewportW = window.innerWidth || 1024;
    const viewportH = window.innerHeight || 768;
    const anchorRect = tabMenu.anchor && typeof tabMenu.anchor.getBoundingClientRect === 'function'
      ? tabMenu.anchor.getBoundingClientRect()
      : null;
    const desiredLeft = anchorRect ? anchorRect.left : tabMenu.fallbackX;
    const left = Math.max(8, Math.min(desiredLeft, viewportW - width - 8));
    let top: number;
    if (anchorRect) {
      const belowTop = anchorRect.bottom + 6;
      top = belowTop + height <= viewportH - 8
        ? belowTop
        : Math.max(8, anchorRect.top - height - 6);
    } else {
      top = Math.max(8, Math.min(tabMenu.fallbackY, viewportH - height - 8));
    }
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [menuOpen, tabMenu]);

  useEffect(() => {
    if (!tabMenu || !menuOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && tabMenuRef.current?.contains(event.target)) return;
      setTabMenu(null);
    }
    function onDismiss() {
      setTabMenu(null);
    }
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onDismiss);
    window.addEventListener('scroll', onDismiss, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('scroll', onDismiss, true);
    };
  }, [menuOpen, tabMenu]);

  const getMaxFilesPanelWidth = useCallback(() => {
    const screenWidth = screenRef.current?.getBoundingClientRect().width ?? 0;
    if (!screenWidth) return MAX_WORK_FILES_WIDTH;
    return Math.max(MIN_WORK_FILES_WIDTH, Math.min(MAX_WORK_FILES_WIDTH, screenWidth - 260));
  }, []);

  async function handleCreateTerminal(explicitShell?: WindowsTerminalShell) {
    if (creating) return;
    if (!activeProject) {
      setNotice('请先在左侧创建一个工作项目。');
      return;
    }

    const shell: WindowsTerminalShell | undefined = isWindowsLocal
      ? (explicitShell ?? defaultWindowsShell)
      : undefined;
    const sameFlavorCount = projectTerminals.filter((item) => (
      item.preset === 'shell' && item.shell === shell
    )).length;
    const title = defaultTerminalTitle('shell', sameFlavorCount, shell);

    if (preview) {
      addWorkTerminal(createPreviewTerminalSession({
        projectId: activeProject.id,
        hostId: activeProject.hostId,
        title,
        ...(shell ? { shell } : {}),
        cwd: activeProject.directory,
      }));
      return;
    }

    setCreating(true);
    try {
      const created = await createWorkTerminal(instance.request, {
        projectId: activeProject.id,
        preset: 'shell',
        ...(shell ? { shell } : {}),
        title,
        command: '',
      });
      addWorkTerminal(created);
    } catch (reason) {
      setNotice(reason instanceof Error && reason.message ? reason.message : '启动终端失败，请重试。');
    } finally {
      setCreating(false);
    }
  }

  function handleOpenFile(entry: WorkHostEntry): void {
    if (!activeProject) return;
    if (entry.path === activeFile?.path) {
      screenRef.current?.querySelector<HTMLTextAreaElement>('.work-code-input textarea')?.focus({ preventScroll: true });
    }
    openWorkFile(activeProject.id, entry);
  }

  function handleCloseFiles(projectId: string, paths: readonly string[]): boolean {
    const drafts = fileTabsByProject[projectId]?.drafts;
    if (paths.some((path) => drafts?.get(path)?.saving)) {
      setNotice('文件正在保存，请稍后关闭标签。');
      return false;
    }
    const hasChanges = paths.some((path) => isFileDraftDirty(drafts?.get(path)));
    if (hasChanges && !window.confirm('关闭标签会丢弃未保存的文件修改。继续关闭吗？')) return false;
    closeWorkFiles(projectId, paths);
    return true;
  }

  function handleCloseTabs(terminalIds: readonly string[]) {
    if (terminalIds.length === 0) return;
    const hasCli = terminals.some((item) => terminalIds.includes(item.id) && item.preset !== 'shell');
    removeWorkTerminals(terminalIds);
    if (!preview) {
      void Promise.allSettled(
        terminalIds.map((id) => deleteWorkTerminal(instance.request, id)),
      ).then(() => {
        if (hasCli) bumpCliSessionsRefresh();
      });
    }
  }

  async function handleTogglePin(target: WorkTerminalSession) {
    const previousPinned = Boolean(target.pinned);
    const nextPinned = !previousPinned;
    setTabMenu(null);
    updateWorkTerminalMeta(target.id, { pinned: nextPinned });
    if (!preview) {
      try {
        await updateWorkTerminal(instance.request, target.id, { pinned: nextPinned });
      } catch (reason) {
        updateWorkTerminalMeta(target.id, { pinned: previousPinned });
        setNotice(reason instanceof Error && reason.message ? reason.message : '保存终端置顶状态失败，请重试。');
      }
    }
  }

  async function handleRenameSubmit(event: FormEvent) {
    event.preventDefault();
    if (!renaming) return;
    let normalized: string;
    try {
      normalized = normalizeWorkTerminalTitle(renameTitle);
    } catch (reason) {
      setNotice(reason instanceof Error && reason.message ? reason.message : '终端名称不合法。');
      return;
    }
    if (!renaming.terminal) {
      const { key } = renaming;
      setViewMeta((meta) => ({ ...meta, [key]: { ...meta[key], title: normalized } }));
      setRenaming(null);
      return;
    }
    const targetId = renaming.terminal.id;
    const previousTitle = renaming.terminal.title;
    updateWorkTerminalMeta(targetId, { title: normalized }, { manualRename: true });
    setRenaming(null);
    if (!preview) {
      try {
        await updateWorkTerminal(instance.request, targetId, { title: normalized });
      } catch (reason) {
        updateWorkTerminalMeta(targetId, { title: previousTitle });
        setNotice(reason instanceof Error && reason.message ? reason.message : '保存终端名称失败，请重试。');
      }
    }
  }

  const screenStyle = filesPanelWidth !== null
    ? ({ '--work-files-width': `${filesPanelWidth}px` } as CSSProperties)
    : undefined;
  const closableTabs = {
    terminalIds: projectTerminals.filter((item) => !item.pinned).map((item) => item.id),
    paths: filePaths.filter((path) => !viewMeta[fileKey(path)]?.pinned),
    git: Boolean(gitTab && !viewMeta[gitKey]?.pinned),
  };
  const otherTabs = {
    terminalIds: closableTabs.terminalIds.filter((id) => id !== menuTerminal?.id),
    paths: closableTabs.paths.filter((path) => path !== menuFile?.path),
    git: closableTabs.git && !menuGit,
  };
  const hasClosableTabs = ({ terminalIds, paths, git }: typeof closableTabs) => Boolean(terminalIds.length || paths.length || git);

  function openTabMenu(event: MouseEvent<HTMLDivElement>, key: string) {
    if (!projectId) return;
    event.preventDefault();
    setAddMenuOpen(false);
    setTabMenu({ key, projectId, anchor: event.currentTarget, fallbackX: event.clientX, fallbackY: event.clientY });
  }

  function toggleViewPin(key: string) {
    setTabMenu(null);
    setViewMeta((meta) => ({ ...meta, [key]: { ...meta[key], pinned: !meta[key]?.pinned } }));
  }

  function closeWorkspaceTabs({ terminalIds, paths, git }: typeof closableTabs) {
    setTabMenu(null);
    if (!projectId || (paths.length && !handleCloseFiles(projectId, paths))) return;
    if (git) closeWorkGit(projectId);
    handleCloseTabs(terminalIds);
    setViewMeta((meta) => {
      const next = { ...meta };
      for (const path of paths) delete next[fileKey(path)];
      if (git) delete next[gitKey];
      return next;
    });
  }

  return (
    <div
      ref={screenRef}
      className={`work-screen${filesPanelOpen ? ' has-files-panel' : ''}${resizingFiles ? ' is-resizing' : ''}`}
      style={screenStyle}
      onKeyDown={(event) => {
        if (activeProject?.hostId !== LOCAL_WORK_HOST_ID || !activeFile || event.nativeEvent.isComposing) return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          void saveFile(activeProject.id, activeFile.path);
        }
      }}
    >
      <div className="work-workspace">
        <header className="work-topbar">
          <div className="work-tabs" role="tablist" aria-label="工作区标签页">
            {projectTerminals.map((session, tabIndex) => {
              const isActive = !gitActive && !activeFile && session.id === activeTerminalId;
              const isPinned = Boolean(session.pinned);
              const isDraggingTab = draggingTerminalId === session.id;
              const tabDropPos = tabDropTarget?.terminalId === session.id
                ? tabDropTarget.position
                : null;
              const ownerProject = projects.find((item) => item.id === session.projectId);
              return (
                <div
                  key={session.id}
                  data-terminal-id={session.id}
                  className={`work-tab${isActive ? ' is-active' : ''}${isPinned ? ' is-pinned' : ''}${isDraggingTab ? ' is-dragging' : ''}${tabDropPos === 'before' ? ' is-drop-before' : ''}${tabDropPos === 'after' ? ' is-drop-after' : ''}`}
                  draggable
                  onDragStart={(event) => {
                    if (event.target instanceof HTMLElement && event.target.closest('.work-tab-pin-btn, .work-tab-close')) {
                      event.preventDefault();
                      return;
                    }
                    setTabMenu(null);
                    setAddMenuOpen(false);
                    dragTerminalIdRef.current = session.id;
                    setDraggingTerminalId(session.id);
                    if (event.dataTransfer) {
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('application/x-matrius-terminal-tab', session.id);
                    }
                  }}
                  onDragOver={(event) => {
                    const sourceId = dragTerminalIdRef.current;
                    if (!sourceId || sourceId === session.id) return;
                    const fromIndex = projectTerminals.findIndex((item) => item.id === sourceId);
                    if (fromIndex < 0) return;
                    if (Boolean(projectTerminals[fromIndex].pinned) !== isPinned) return;
                    event.preventDefault();
                    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
                    const position = resolveTabDragPosition(event, fromIndex, tabIndex);
                    setTabDropTarget((prev) => (
                      prev?.terminalId === session.id && prev.position === position
                        ? prev
                        : { terminalId: session.id, position }
                    ));
                  }}
                  onDragLeave={(event) => {
                    const nextTarget = event.relatedTarget as Node | null;
                    if (nextTarget && event.currentTarget.contains(nextTarget)) return;
                    setTabDropTarget((prev) => (
                      prev?.terminalId === session.id ? null : prev
                    ));
                  }}
                  onDrop={(event) => {
                    const sourceId = dragTerminalIdRef.current
                      ?? event.dataTransfer?.getData('application/x-matrius-terminal-tab')
                      ?? '';
                    const fromIndex = projectTerminals.findIndex((item) => item.id === sourceId);
                    if (
                      !sourceId
                      || sourceId === session.id
                      || fromIndex < 0
                      || Boolean(projectTerminals[fromIndex].pinned) !== isPinned
                    ) {
                      clearTabDragState();
                      return;
                    }
                    event.preventDefault();
                    const position = resolveTabDragPosition(event, fromIndex, tabIndex);
                    clearTabDragState();
                    reorderWorkTerminals(sourceId, session.id, position);
                  }}
                  onDragEnd={clearTabDragState}
                  onContextMenu={(event) => openTabMenu(event, terminalKey(session.id))}
                >
                  <button
                    type="button"
                    role="tab"
                    className="work-tab-select"
                    aria-selected={isActive}
                    title={ownerProject ? `${ownerProject.name} · ${session.cwd}` : session.cwd}
                    onClick={() => selectWorkTerminal(session.id)}
                  >
                    <TerminalPresetIcon preset={session.preset} shell={session.shell} size={14} />
                    <span className="work-tab-title">{session.title}</span>
                  </button>
                  {isPinned ? (
                    <button
                      type="button"
                      className="icon-button work-tab-pin-btn"
                      aria-label={`取消固定：${session.title}`}
                      title="取消固定"
                      draggable={false}
                      onClick={() => void handleTogglePin(session)}
                    >
                      <Pin size={12} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="icon-button work-tab-close"
                      aria-label={`关闭终端：${session.title}`}
                      draggable={false}
                      onClick={() => void handleCloseTabs([session.id])}
                    >
                      <X size={13} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })}
            {activeProject && fileTabs?.entries.map((entry) => {
              const key = fileKey(entry.path);
              const meta = viewMeta[key];
              return (
                <div key={key} onContextMenu={(event) => openTabMenu(event, key)} className={`work-tab${entry.path === activeFile?.path ? ' is-active' : ''}${meta?.pinned ? ' is-pinned' : ''}`}>
                  <button
                    type="button"
                    role="tab"
                    className="work-tab-select"
                    aria-selected={entry.path === activeFile?.path}
                    ref={entry.path === activeFile?.path ? activeFileTabRef : undefined}
                    title={entry.path}
                    onClick={() => handleOpenFile(entry)}
                  >
                    <FileText size={14} aria-hidden="true" />
                    <span className="work-tab-title">{meta?.title ?? entry.name}</span>
                    {isFileDraftDirty(fileTabs.drafts.get(entry.path)) && (
                      <span className="work-file-dirty" role="img" aria-label="未保存" title="未保存" />
                    )}
                  </button>
                  <button
                    type="button"
                    className={`icon-button ${meta?.pinned ? 'work-tab-pin-btn' : 'work-tab-close'}`}
                    aria-label={meta?.pinned ? `取消固定：${meta.title ?? entry.name}` : `关闭文件：${meta?.title ?? entry.name}`}
                    onClick={() => meta?.pinned ? toggleViewPin(key) : closeWorkspaceTabs({ terminalIds: [], paths: [entry.path], git: false })}
                  >
                    {meta?.pinned ? <Pin size={12} strokeWidth={1.75} aria-hidden="true" /> : <X size={13} strokeWidth={1.75} aria-hidden="true" />}
                  </button>
                </div>
              );
            })}
            {activeProject && gitTab && (
              <div onContextMenu={(event) => openTabMenu(event, gitKey)} className={`work-tab${gitActive ? ' is-active' : ''}${viewMeta[gitKey]?.pinned ? ' is-pinned' : ''}`}>
                <button type="button" role="tab" aria-selected={gitActive} className="work-tab-select" onClick={() => openWorkGit(activeProject.id)}>
                  <GitBranch size={14} aria-hidden="true" />
                  <span className="work-tab-title">{viewMeta[gitKey]?.title ?? 'Git'}</span>
                </button>
                <button
                  type="button"
                  className={`icon-button ${viewMeta[gitKey]?.pinned ? 'work-tab-pin-btn' : 'work-tab-close'}`}
                  aria-label={viewMeta[gitKey]?.pinned ? "取消固定 Git 标签" : "关闭 Git 标签"}
                  onClick={() => viewMeta[gitKey]?.pinned ? toggleViewPin(gitKey) : closeWorkspaceTabs({ terminalIds: [], paths: [], git: true })}
                >
                  {viewMeta[gitKey]?.pinned ? <Pin size={12} strokeWidth={1.75} aria-hidden="true" /> : <X size={13} aria-hidden="true" />}
                </button>
              </div>
            )}
          </div>

          <div className="work-topbar-actions">
            <div className="work-add-control" ref={addControlRef}>
              <div className={`work-add-split${addMenuOpen ? ' is-open' : ''}`}>
                <button
                  type="button"
                  className="work-add-primary"
                  aria-label="添加终端"
                  title={isWindowsLocal
                    ? `新建 ${WINDOWS_SHELL_OPTIONS.find((item) => item.id === defaultWindowsShell)?.label ?? 'PowerShell'}`
                    : '新建终端'}
                  disabled={creating}
                  onClick={() => {
                    setAddMenuOpen(false);
                    void handleCreateTerminal();
                  }}
                >
                  <Plus size={15} strokeWidth={1.9} aria-hidden="true" />
                </button>
                <button
                  ref={addCaretRef}
                  type="button"
                  className="work-add-caret"
                  aria-label="选择终端类型"
                  aria-haspopup="menu"
                  aria-expanded={addMenuOpen}
                  disabled={creating}
                  onClick={() => setAddMenuOpen((open) => !open)}
                >
                  <ChevronDown size={12} strokeWidth={1.9} aria-hidden="true" />
                </button>
              </div>

              {addMenuOpen && (
                <div
                  ref={addMenuRef}
                  className="conversation-menu work-add-menu"
                  role="menu"
                  aria-label="选择终端类型"
                  onKeyDown={(event) => {
                    const items = Array.from(
                      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
                    );
                    if (!items.length) return;
                    const index = items.indexOf(document.activeElement as HTMLButtonElement);
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setAddMenuOpen(false);
                      addCaretRef.current?.focus();
                    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                      event.preventDefault();
                      const next = event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? items.length - 1
                          : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
                      items[next]?.focus();
                    }
                  }}
                >
                  {isWindowsLocal ? (
                    WINDOWS_SHELL_OPTIONS.map((option) => (
                      <button
                        key={option.id}
                        role="menuitem"
                        type="button"
                        data-preset="shell"
                        data-shell={option.id}
                        onClick={() => {
                          setAddMenuOpen(false);
                          void handleCreateTerminal(option.id);
                        }}
                      >
                        <TerminalPresetIcon preset="shell" shell={option.id} size={15} />
                        <span className="work-add-menu-label">{option.label}</span>
                      </button>
                    ))
                  ) : (
                    <button
                      role="menuitem"
                      type="button"
                      data-preset="shell"
                      onClick={() => {
                        setAddMenuOpen(false);
                        void handleCreateTerminal();
                      }}
                    >
                      <TerminalPresetIcon preset="shell" size={15} />
                      <span className="work-add-menu-label">终端</span>
                    </button>
                  )}
                </div>
              )}
            </div>

            {gitEnabled && (
              <button
                type="button"
                className={`icon-button work-topbar-btn${gitActive ? ' is-active' : ''}`}
                aria-label="打开 Git 查看器"
                title="Git"
                aria-pressed={gitActive}
                disabled={!activeProject}
                onClick={() => { if (activeProject) openWorkGit(activeProject.id); }}
              >
                <GitBranch size={17} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className={`icon-button work-topbar-btn${filesPanelOpen ? ' is-active' : ''}`}
              aria-label={filesPanelOpen ? '收起工作目录' : '展开工作目录'}
              aria-expanded={filesPanelOpen}
              onClick={() => toggleWorkFilesPanel()}
            >
              <PanelRight size={17} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        </header>

        <main className="work-main" id="main-content" tabIndex={-1} aria-label="工作区">
          {terminals.length > 0 && (
            <WorkTerminalView
              terminals={terminals}
              activeProjectId={activeProject?.id ?? null}
              activeTerminalId={activeTerminalId}
              hidden={gitActive || Boolean(activeFile) || projectTerminals.length === 0}
            />
          )}
          {activeProject && gitTab && (
            <WorkGitView key={activeProject.id} projectId={activeProject.id} active={gitActive} />
          )}
          {activeProject && activeFile && (
            <WorkFilePreview
              key={JSON.stringify([activeProject.id, activeFile.path, hostUnlockVersion])}
              hostId={activeProject.hostId}
              projectId={activeProject.id}
              file={activeFile}
              draft={fileTabs?.drafts.get(activeFile.path)}
              fontSize={editorFontSize}
            />
          )}
        </main>
      </div>

      {filesPanelOpen && (
        <WorkFilesPanel
          key={activeProject?.id}
          project={activeProject}
          onOpenFile={handleOpenFile}
          width={filesPanelWidth}
          getMaxWidth={getMaxFilesPanelWidth}
          onResize={(nextWidth, maxWidth) => setWorkFilesPanelWidth(nextWidth, maxWidth)}
          onResizeStateChange={setResizingFiles}
          onClose={() => toggleWorkFilesPanel(false)}
        />
      )}

      {tabMenu && menuOpen && (
        <div
          ref={tabMenuRef}
          id="work-tab-menu"
          className="conversation-menu work-tab-menu"
          role="menu"
          aria-label={`标签页操作：${menuTitle}`}
          onKeyDown={(event) => {
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
            );
            if (!items.length) return;
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === 'Escape' || event.key === 'Tab') {
              if (event.key === 'Escape') event.preventDefault();
              setTabMenu(null);
            } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              const next = event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? items.length - 1
                  : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
              items[next]?.focus();
            }
          }}
        >
          <button
            role="menuitem"
            type="button"
            data-action="pin"
            onClick={() => menuTerminal ? void handleTogglePin(menuTerminal) : toggleViewPin(tabMenu.key)}
          >
            {menuPinned
              ? <PinOff size={15} strokeWidth={1.75} aria-hidden="true" />
              : <Pin size={15} strokeWidth={1.75} aria-hidden="true" />}
            <span>{menuPinned ? '取消固定' : '固定'}</span>
          </button>
          <button
            role="menuitem"
            type="button"
            data-action="close-others"
            disabled={!hasClosableTabs(otherTabs)}
            onClick={() => closeWorkspaceTabs(otherTabs)}
          >
            <X size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>关闭其他</span>
          </button>
          <button
            role="menuitem"
            type="button"
            data-action="close-all"
            disabled={!hasClosableTabs(closableTabs)}
            onClick={() => closeWorkspaceTabs(closableTabs)}
          >
            <X size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>全部关闭</span>
          </button>
          <button
            role="menuitem"
            type="button"
            data-action="rename"
            onClick={() => {
              setRenaming({ key: tabMenu.key, terminal: menuTerminal });
              setRenameTitle(menuTitle);
              setTabMenu(null);
            }}
          >
            <Pencil size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>重命名</span>
          </button>
        </div>
      )}

      {renaming && (
        <Dialog
          title={renaming.terminal ? '重命名终端' : '重命名标签页'}
          className="compact-dialog work-tab-rename-dialog"
          onClose={() => setRenaming(null)}
        >
          <form onSubmit={(event) => void handleRenameSubmit(event)}>
            <label className="field-label" htmlFor="work-terminal-title-input">{renaming.terminal ? '终端名称' : '标签页名称'}</label>
            <input
              id="work-terminal-title-input"
              className="text-field"
              value={renameTitle}
              data-autofocus
              maxLength={80}
              required
              onChange={(event) => setRenameTitle(event.target.value)}
            />
            <div className="dialog-footer">
              <button type="button" className="secondary-button" onClick={() => setRenaming(null)}>取消</button>
              <button type="submit" className="primary-button" disabled={!renameTitle.trim()}>保存名称</button>
            </div>
          </form>
        </Dialog>
      )}

      {notice && (
        <WorkErrorDialog
          title="提示"
          message={notice}
          className="work-workspace-notice-dialog"
          onClose={() => setNotice(null)}
        />
      )}
    </div>
  );
}
