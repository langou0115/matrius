import { LOCAL_WORK_HOST_ID } from '@contract/work-projects';
import {
  WINDOWS_SHELL_OPTIONS,
  defaultTerminalTitle,
  normalizeWorkTerminalTitle,
  type WindowsTerminalShell,
  type WorkTerminalPreset,
  type WorkTerminalSession,
} from '@contract/work-terminals';
import {
  ChevronDown,
  PanelRight,
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
  type FormEvent,
} from 'react';

import { Dialog } from '@/components/web/dialog';
import { useInstance } from '@/features/instance/instance-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { TerminalPresetIcon } from './terminal-preset-icon';
import {
  createWorkTerminal,
  deleteWorkTerminal,
  listWorkTerminals,
  updateWorkTerminal,
} from './work-api';
import { WorkErrorDialog } from './work-error-dialog';
import { WorkFilesPanel } from './work-files-panel';
import { loadWorkSettings } from './work-shell-preference';
import {
  MAX_WORK_FILES_WIDTH,
  MIN_WORK_FILES_WIDTH,
  addWorkTerminal,
  detectPreviewPlatform,
  hydrateWorkSettings,
  isWindowsPlatform,
  removeWorkTerminals,
  selectWorkTerminal,
  setWorkFilesPanelWidth,
  setWorkServerPlatform,
  setWorkTerminals,
  toggleWorkFilesPanel,
  updateWorkTerminalMeta,
  useWorkState,
} from './work-state';
import { WorkTerminalView } from './work-terminal-view';

function createPreviewTerminalSession(input: {
  projectId: string;
  hostId: string;
  title: string;
  preset: WorkTerminalPreset;
  shell?: WindowsTerminalShell;
  cwd: string;
}): WorkTerminalSession {
  return {
    id: `mock-terminal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    projectId: input.projectId,
    hostId: input.hostId,
    title: input.title,
    preset: input.preset,
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
  const {
    projects,
    activeProjectId,
    terminals,
    activeTerminalId,
    filesPanelOpen,
    filesPanelWidth,
    serverPlatform,
    defaultWindowsShell,
    defaultWindowsShellLoaded,
  } = useWorkState();
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [resizingFiles, setResizingFiles] = useState(false);
  const [tabMenu, setTabMenu] = useState<{
    terminalId: string;
    anchor: HTMLElement | null;
    fallbackX: number;
    fallbackY: number;
  } | null>(null);
  const [renaming, setRenaming] = useState<WorkTerminalSession | null>(null);
  const [renameTitle, setRenameTitle] = useState('');

  const screenRef = useRef<HTMLDivElement>(null);
  const addControlRef = useRef<HTMLDivElement>(null);
  const addCaretRef = useRef<HTMLButtonElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const tabMenuRef = useRef<HTMLDivElement>(null);

  const activeProject = projects.find((item) => item.id === activeProjectId) ?? projects[0] ?? null;
  const projectTerminals = activeProject
    ? terminals.filter((item) => item.projectId === activeProject.id)
    : [];
  const menuTerminal = tabMenu
    ? projectTerminals.find((item) => item.id === tabMenu.terminalId) ?? null
    : null;
  const effectivePlatform = preview ? (serverPlatform ?? detectPreviewPlatform()) : serverPlatform;
  const isWindowsLocal = activeProject?.hostId === LOCAL_WORK_HOST_ID && isWindowsPlatform(effectivePlatform);

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
        if (terminalRes.platform) setWorkServerPlatform(terminalRes.platform);
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
    if (!tabMenu || !element || !menuTerminal) return;
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
  }, [menuTerminal, tabMenu]);

  useEffect(() => {
    if (!tabMenu || !menuTerminal) return;
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
  }, [menuTerminal, tabMenu]);

  const getMaxFilesPanelWidth = useCallback(() => {
    const screenWidth = screenRef.current?.getBoundingClientRect().width ?? 0;
    if (!screenWidth) return MAX_WORK_FILES_WIDTH;
    return Math.max(MIN_WORK_FILES_WIDTH, Math.min(MAX_WORK_FILES_WIDTH, screenWidth - 260));
  }, []);

  async function handleCreateTerminal(preset: WorkTerminalPreset = 'shell', explicitShell?: WindowsTerminalShell) {
    if (creating) return;
    if (!activeProject) {
      setNotice('请先在左侧创建一个工作项目。');
      return;
    }

    const shell: WindowsTerminalShell | undefined = preset === 'shell' && isWindowsLocal
      ? (explicitShell ?? defaultWindowsShell)
      : undefined;
    const sameFlavorCount = projectTerminals.filter((item) => (
      item.preset === preset && (preset !== 'shell' || item.shell === shell)
    )).length;
    const title = defaultTerminalTitle(preset, sameFlavorCount, shell);

    if (preview) {
      addWorkTerminal(createPreviewTerminalSession({
        projectId: activeProject.id,
        hostId: activeProject.hostId,
        title,
        preset,
        ...(shell ? { shell } : {}),
        cwd: activeProject.directory,
      }));
      return;
    }

    setCreating(true);
    try {
      const created = await createWorkTerminal(instance.request, {
        projectId: activeProject.id,
        preset,
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

  async function handleCloseTabs(terminalIds: readonly string[]) {
    if (terminalIds.length === 0) return;
    if (!preview) {
      await Promise.allSettled(
        terminalIds.map((id) => deleteWorkTerminal(instance.request, id)),
      );
    }
    removeWorkTerminals(terminalIds);
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
    const targetId = renaming.id;
    const previousTitle = renaming.title;
    updateWorkTerminalMeta(targetId, { title: normalized });
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
  const otherClosableIds = menuTerminal
    ? projectTerminals.filter((item) => item.id !== menuTerminal.id && !item.pinned).map((item) => item.id)
    : [];
  const allClosableIds = projectTerminals.filter((item) => !item.pinned).map((item) => item.id);

  return (
    <div
      ref={screenRef}
      className={`work-screen${filesPanelOpen ? ' has-files-panel' : ''}${resizingFiles ? ' is-resizing' : ''}`}
      style={screenStyle}
    >
      <div className="work-workspace">
        <header className="work-topbar">
          <div className="work-tabs" role="tablist" aria-label="终端标签页">
            {projectTerminals.map((session) => {
              const isActive = session.id === activeTerminalId;
              const isPinned = Boolean(session.pinned);
              const ownerProject = projects.find((item) => item.id === session.projectId);
              return (
                <div
                  key={session.id}
                  className={`work-tab${isActive ? ' is-active' : ''}${isPinned ? ' is-pinned' : ''}`}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setAddMenuOpen(false);
                    const anchor = (event.currentTarget as HTMLElement | null)
                      ?? (event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('.work-tab') : null);
                    setTabMenu({
                      terminalId: session.id,
                      anchor,
                      fallbackX: event.clientX,
                      fallbackY: event.clientY,
                    });
                  }}
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
                    {session.status !== 'running' && (
                      <span className={`work-tab-status is-${session.status}`} aria-hidden="true" />
                    )}
                  </button>
                  {isPinned ? (
                    <button
                      type="button"
                      className="icon-button work-tab-pin-btn"
                      aria-label={`取消固定：${session.title}`}
                      title="取消固定"
                      onClick={() => void handleTogglePin(session)}
                    >
                      <Pin size={12} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="icon-button work-tab-close"
                      aria-label={`关闭终端：${session.title}`}
                      onClick={() => void handleCloseTabs([session.id])}
                    >
                      <X size={13} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })}
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
                    void handleCreateTerminal('shell');
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
                          void handleCreateTerminal('shell', option.id);
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
                        void handleCreateTerminal('shell');
                      }}
                    >
                      <TerminalPresetIcon preset="shell" size={15} />
                      <span className="work-add-menu-label">终端</span>
                    </button>
                  )}
                  <div className="work-add-menu-divider" role="separator" />
                  <button
                    role="menuitem"
                    type="button"
                    data-preset="claude"
                    className="is-disabled"
                    aria-disabled="true"
                    title="Claude Code 终端尚未开发完成"
                    onClick={(event) => event.preventDefault()}
                  >
                    <TerminalPresetIcon preset="claude" size={15} />
                    <span className="work-add-menu-label">Claude Code</span>
                    <span className="work-add-menu-badge">暂未接入</span>
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    data-preset="codex"
                    className="is-disabled"
                    aria-disabled="true"
                    title="Codex 终端尚未开发完成"
                    onClick={(event) => event.preventDefault()}
                  >
                    <TerminalPresetIcon preset="codex" size={15} />
                    <span className="work-add-menu-label">Codex</span>
                    <span className="work-add-menu-badge">暂未接入</span>
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    data-preset="antigravity"
                    className="is-disabled"
                    aria-disabled="true"
                    title="Antigravity 终端尚未开发完成"
                    onClick={(event) => event.preventDefault()}
                  >
                    <TerminalPresetIcon preset="antigravity" size={15} />
                    <span className="work-add-menu-label">Antigravity</span>
                    <span className="work-add-menu-badge">暂未接入</span>
                  </button>
                </div>
              )}
            </div>

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
              hidden={projectTerminals.length === 0}
            />
          )}
        </main>
      </div>

      {filesPanelOpen && (
        <WorkFilesPanel
          project={activeProject}
          width={filesPanelWidth}
          getMaxWidth={getMaxFilesPanelWidth}
          onResize={(nextWidth, maxWidth) => setWorkFilesPanelWidth(nextWidth, maxWidth)}
          onResizeStateChange={setResizingFiles}
          onClose={() => toggleWorkFilesPanel(false)}
        />
      )}

      {tabMenu && menuTerminal && (
        <div
          ref={tabMenuRef}
          id="work-tab-menu"
          className="conversation-menu work-tab-menu"
          role="menu"
          aria-label={`终端操作：${menuTerminal.title}`}
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
            onClick={() => void handleTogglePin(menuTerminal)}
          >
            {menuTerminal.pinned
              ? <PinOff size={15} strokeWidth={1.75} aria-hidden="true" />
              : <Pin size={15} strokeWidth={1.75} aria-hidden="true" />}
            <span>{menuTerminal.pinned ? '取消固定' : '固定'}</span>
          </button>
          <button
            role="menuitem"
            type="button"
            data-action="close-others"
            disabled={otherClosableIds.length === 0}
            onClick={() => {
              setTabMenu(null);
              void handleCloseTabs(otherClosableIds);
            }}
          >
            <X size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>关闭其他</span>
          </button>
          <button
            role="menuitem"
            type="button"
            data-action="close-all"
            disabled={allClosableIds.length === 0}
            onClick={() => {
              setTabMenu(null);
              void handleCloseTabs(allClosableIds);
            }}
          >
            <X size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>全部关闭</span>
          </button>
          <button
            role="menuitem"
            type="button"
            data-action="rename"
            onClick={() => {
              setRenaming(menuTerminal);
              setRenameTitle(menuTerminal.title);
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
          title="重命名终端"
          className="compact-dialog work-tab-rename-dialog"
          onClose={() => setRenaming(null)}
        >
          <form onSubmit={(event) => void handleRenameSubmit(event)}>
            <label className="field-label" htmlFor="work-terminal-title-input">终端名称</label>
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
