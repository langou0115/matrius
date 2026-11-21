import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Check, ListChecks, MessageSquare, MoreHorizontal, Pause, Pencil, Play, Plus, Search, Trash2, X, Zap } from 'lucide-react';

import { Dialog } from '@/components/web/dialog';
import { Icon } from '@/components/web/icon';
import { useMobile } from '@/components/web/use-mobile';
import { useChat } from '@/features/chat/chat-state';
import { conversationHref } from '@/features/chat/conversation-href';
import { LibraryMenu } from '@/features/files/library-menu';
import { useModels } from '@/features/models/model-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { router } from '@/router';
import { TaskModal, type TaskModalSubmitPayload } from './task-modal';
import type { ScheduledTask } from './tasks-api';
import { useTasks } from './tasks-state';

type TaskStatusFilter = 'active' | 'paused' | 'completed' | 'all';

const STATUS_TABS: readonly { id: TaskStatusFilter; label: string }[] = [
  { id: 'active', label: '已开启' },
  { id: 'paused', label: '已暂停' },
  { id: 'completed', label: '已结束' },
  { id: 'all', label: '全部' },
];

type ModalState =
  | { mode: 'create'; title?: string; prompt?: string }
  | { mode: 'edit'; task: ScheduledTask }
  | null;

function EmptyTasksIllustration() {
  return (
    <svg
      className="tasks-empty-illustration"
      width="104"
      height="88"
      viewBox="0 0 104 88"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M25 27C25 14.5 38 7 53 9C68 11 84 18 82 36C80 54 67 66 47 65C29 64 25 41 25 27Z"
        className="tasks-illus-blob"
      />
      <ellipse cx="52" cy="76" rx="26" ry="3.5" className="tasks-illus-shadow" />
      <rect x="27" y="14" width="38" height="46" rx="7" transform="rotate(-7 27 14)" className="tasks-illus-back" />
      <rect x="33" y="13" width="38" height="48" rx="7" className="tasks-illus-card" />
      <rect x="40" y="24" width="5" height="5" rx="1.2" className="tasks-illus-line" />
      <rect x="48" y="25" width="16" height="3" rx="1.5" className="tasks-illus-line" />
      <rect x="40" y="34" width="5" height="5" rx="1.2" className="tasks-illus-line" />
      <rect x="48" y="35" width="16" height="3" rx="1.5" className="tasks-illus-line" />
      <rect x="40" y="44" width="5" height="5" rx="1.2" className="tasks-illus-line" />
      <rect x="48" y="45" width="11" height="3" rx="1.5" className="tasks-illus-line" />
      <circle cx="69" cy="54" r="14" className="tasks-illus-clock-ring" />
      <circle cx="69" cy="54" r="10.5" className="tasks-illus-clock-face" />
      <path d="M69 48.5V54.5L73 57" strokeLinecap="round" strokeLinejoin="round" className="tasks-illus-clock-hand" />
      <path d="M77 10V15M74.5 12.5H79.5" strokeLinecap="round" className="tasks-illus-spark" />
      <path d="M20 55V59M18 57H22" strokeLinecap="round" className="tasks-illus-spark" />
    </svg>
  );
}

function formatDateTime(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatInterval(minutes: number | null): string {
  if (!minutes) return '循环';
  if (minutes === 10_080) return '每周';
  if (minutes > 10_080 && minutes % 10_080 === 0) return `每 ${minutes / 10_080} 周`;
  if (minutes === 1440) return '每天';
  if (minutes > 1440 && minutes % 1440 === 0) return `每 ${minutes / 1440} 天`;
  if (minutes === 60) return '每小时';
  if (minutes > 60 && minutes % 60 === 0) return `每 ${minutes / 60} 小时`;
  return `每 ${minutes} 分钟`;
}

function resolveTaskStatus(task: ScheduledTask): Exclude<TaskStatusFilter, 'all'> {
  if (task.status === 'completed') return 'completed';
  if (task.status === 'paused' || !task.enabled) return 'paused';
  return 'active';
}

function statusLabel(task: ScheduledTask): string {
  const status = resolveTaskStatus(task);
  if (status === 'completed') return '已结束';
  if (status === 'paused') return '已暂停';
  return '已开启';
}

function emptyMessage(statusFilter: TaskStatusFilter, hasQuery: boolean): string {
  if (hasQuery) return '没有找到匹配的定时任务';
  if (statusFilter === 'active') return '没有已开启的定时任务';
  if (statusFilter === 'paused') return '没有已暂停的定时任务';
  if (statusFilter === 'completed') return '没有已结束的定时任务';
  return '还没有定时任务';
}

function TaskRow({
  task,
  mobile,
  selectable,
  selected,
  busy,
  menuOpen,
  onToggleSelect,
  onToggleStatus,
  onOpenMenu,
}: {
  task: ScheduledTask;
  mobile: boolean;
  selectable: boolean;
  selected: boolean;
  busy: boolean;
  menuOpen: boolean;
  onToggleSelect: () => void;
  onToggleStatus: () => void;
  onOpenMenu: (anchor: HTMLButtonElement, toggle?: boolean) => void;
}) {
  const press = useRef<{ timer?: ReturnType<typeof setTimeout>; x: number; y: number; fired: boolean }>({
    x: 0,
    y: 0,
    fired: false,
  });

  function cancelPress() {
    clearTimeout(press.current.timer);
    press.current.timer = undefined;
  }

  useEffect(() => cancelPress, []);

  const taskStatus = resolveTaskStatus(task);
  const isActive = taskStatus === 'active';
  const scheduleSummary = task.kind === 'recurring'
    ? formatInterval(task.intervalMinutes)
    : '单次定时';
  const timeSummary = taskStatus === 'completed'
    ? `执行于 ${formatDateTime(task.lastRunAtMs ?? task.runAtMs)}`
    : taskStatus === 'paused'
      ? (task.lastRunAtMs ? `上次 ${formatDateTime(task.lastRunAtMs)}` : '等待开启')
      : `下次 ${formatDateTime(task.nextRunAtMs)}`;

  return (
    <div
      className={`task-row${selected ? ' is-selected' : ''}${menuOpen ? ' is-menu-open' : ''}`}
      role="listitem"
    >
      {mobile && selectable && (
        <button
          type="button"
          className="library-item-select-control"
          aria-label={`${selected ? '取消选择' : '选择'} ${task.title}`}
          aria-pressed={selected}
          onClick={onToggleSelect}
        >
          <span className={`library-item-check${selected ? ' is-checked' : ''}`} aria-hidden="true">
            {selected && <Check size={13} strokeWidth={2.5} />}
          </span>
        </button>
      )}
      <button
        type="button"
        className={`task-row-main${mobile ? ' supports-long-press' : ''}`}
        onPointerDown={(event) => {
          cancelPress();
          press.current.fired = false;
          if (!mobile || !event.isPrimary || event.button !== 0) return;
          const anchor = event.currentTarget;
          press.current.x = event.clientX;
          press.current.y = event.clientY;
          press.current.timer = setTimeout(() => {
            press.current.fired = true;
            onOpenMenu(anchor);
          }, 500);
        }}
        onPointerMove={(event) => {
          if (Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 10) cancelPress();
        }}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onPointerLeave={cancelPress}
        onContextMenu={(event) => {
          if (!mobile) return;
          event.preventDefault();
          cancelPress();
          press.current.fired = true;
          onOpenMenu(event.currentTarget);
        }}
        aria-pressed={selectable ? selected : undefined}
        aria-label={selectable ? `${selected ? '取消选择' : '选择'} ${task.title}` : `任务操作 ${task.title}`}
        aria-haspopup={mobile ? 'menu' : undefined}
        aria-expanded={mobile ? menuOpen : undefined}
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          if (press.current.fired) {
            press.current.fired = false;
            event.preventDefault();
            return;
          }
          if (selectable) onToggleSelect();
          else if (mobile && event.detail === 0) onOpenMenu(event.currentTarget);
        }}
      >
        {selectable && !mobile && (
          <span className={`library-item-check${selected ? ' is-checked' : ''}`} aria-hidden="true">
            {selected && <Check size={13} strokeWidth={2.5} />}
          </span>
        )}
        <span className="task-row-copy">
          <span className="task-row-title" title={`${task.title}\n${task.prompt}`}>{task.title}</span>
          <span className="task-row-meta">{scheduleSummary} · {timeSummary}</span>
        </span>
      </button>
      <div className="task-row-actions">
        <button
          type="button"
          className={`task-status-btn is-${taskStatus}`}
          disabled={busy || taskStatus === 'completed'}
          onClick={onToggleStatus}
          title={taskStatus === 'completed' ? '已结束' : isActive ? '点击暂停' : '点击开启'}
          aria-label={taskStatus === 'completed'
            ? `${task.title} 状态：已结束`
            : `${task.title} 状态：${statusLabel(task)}，点击${isActive ? '暂停' : '开启'}`}
        >
          <span className="task-status-dot" aria-hidden="true" />
          <span>{statusLabel(task)}</span>
        </button>
        {!mobile && (
          <button
            type="button"
            className="icon-button task-row-more"
            aria-label={`更多操作：${task.title}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="设置"
            disabled={busy}
            onClick={(event) => onOpenMenu(event.currentTarget, true)}
          >
            <MoreHorizontal size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

export default function TasksScreen() {
  const mobile = useMobile();
  const { sidebarOpen, conversations, dispatch } = useChat();
  const preview = useIsPreview();
  const models = useModels();
  const { tasks, loading, error, createTask, updateTask, removeTasks, runTaskNow } = useTasks();

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<TaskStatusFilter>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [mobileSelecting, setMobileSelecting] = useState(false);
  const [pageMenuAnchor, setPageMenuAnchor] = useState<HTMLButtonElement | null>(null);
  const [modalState, setModalState] = useState<ModalState>(null);
  const [noConversationTask, setNoConversationTask] = useState<ScheduledTask | null>(null);
  const [deleting, setDeleting] = useState<ScheduledTask[] | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ taskId: string; element: HTMLButtonElement; alignElement?: HTMLElement | null } | null>(null);

  const conversationIds = useMemo(() => new Set(conversations.map((item) => item.id)), [conversations]);
  const missingModel = !preview && models.ready && !models.selected;

  const normalizedQuery = query.trim().toLowerCase();
  const filteredTasks = useMemo(() => tasks.filter((task) => {
    if (statusFilter !== 'all' && resolveTaskStatus(task) !== statusFilter) return false;
    if (!normalizedQuery) return true;
    return task.title.toLowerCase().includes(normalizedQuery)
      || task.prompt.toLowerCase().includes(normalizedQuery);
  }), [tasks, statusFilter, normalizedQuery]);

  const selectedTasks = useMemo(
    () => filteredTasks.filter((item) => selectedIds.has(item.id)),
    [filteredTasks, selectedIds],
  );
  const selectedCount = selectedTasks.length;

  const menuTask = menuAnchor ? tasks.find((item) => item.id === menuAnchor.taskId) ?? null : null;
  const menuTaskStatus = menuTask ? resolveTaskStatus(menuTask) : null;

  function clearSelection() {
    setSelectedIds(new Set());
    setMobileSelecting(false);
  }

  function changeQuery(next: string) {
    setQuery(next);
    clearSelection();
  }

  function changeStatusFilter(next: TaskStatusFilter) {
    setStatusFilter(next);
    clearSelection();
  }

  function toggleSelected(taskId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedCount > 0) {
      setSelectedIds(new Set());
      return;
    }
    setSelectedIds(new Set(filteredTasks.map((item) => item.id)));
  }

  function openDelete(targets: ScheduledTask[]) {
    if (!targets.length) return;
    setDeleteError(null);
    setDeleting(targets);
  }

  async function handleModalSubmit(payload: TaskModalSubmitPayload) {
    if (!modalState) return;
    if (modalState.mode === 'create') {
      await createTask({
        title: payload.title,
        prompt: payload.prompt,
        kind: payload.kind,
        intervalMinutes: payload.intervalMinutes,
        runAtMs: payload.runAtMs,
      });
    } else {
      await updateTask(modalState.task.id, {
        title: payload.title,
        prompt: payload.prompt,
        kind: payload.kind,
        intervalMinutes: payload.intervalMinutes,
        runAtMs: payload.runAtMs,
        enabled: modalState.task.status === 'completed' ? true : modalState.task.enabled,
        baseRevision: modalState.task.revision,
      });
    }
    setModalState(null);
  }

  async function handleToggle(task: ScheduledTask) {
    if (task.status === 'completed') return;
    const currentlyActive = resolveTaskStatus(task) === 'active';
    setBusyTaskId(task.id);
    try {
      await updateTask(task.id, { enabled: !currentlyActive, baseRevision: task.revision });
    } finally {
      setBusyTaskId(null);
    }
  }

  async function handleRunNow(task: ScheduledTask) {
    setBusyTaskId(task.id);
    try {
      await runTaskNow(task);
    } finally {
      setBusyTaskId(null);
    }
  }

  async function handleDelete() {
    if (!deleting?.length || deletingBusy) return;
    const targetIds = deleting.map((item) => item.id);
    setDeletingBusy(true);
    setDeleteError(null);
    try {
      await removeTasks(targetIds);
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const id of targetIds) next.delete(id);
        return next;
      });
      setDeleting(null);
      setMobileSelecting(false);
    } catch (caught) {
      setDeleteError(caught instanceof Error ? caught.message : '删除定时任务失败。');
    } finally {
      setDeletingBusy(false);
    }
  }

  function openBoundConversation(task: ScheduledTask) {
    const hasConversation = !!task.conversationClientId && conversationIds.has(task.conversationClientId);
    if (hasConversation && task.conversationClientId) {
      router.push(conversationHref(task.conversationClientId, preview));
      return;
    }
    setNoConversationTask(task);
  }

  const selectionBar = (selectedCount > 0 || (mobile && mobileSelecting)) && (
    <div
      className={`library-selection-actions${mobile ? ' is-mobile' : ''}`}
      role="group"
      aria-label={`已选择 ${selectedCount} 个定时任务`}
    >
      <span className="library-selection-count">已选 <b>{selectedCount}</b> 项</span>
      <button
        type="button"
        className="library-batch-button library-delete-selected"
        disabled={!selectedCount}
        aria-label={`删除所选 ${selectedCount} 个定时任务`}
        onClick={() => openDelete(selectedTasks)}
      >
        <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />删除
      </button>
    </div>
  );

  const toolbar = (
    <div className="library-toolbar tasks-toolbar">
      <div className="library-toolbar-row">
        <div className="library-search" role="search" aria-label="搜索定时任务">
          <Search size={16} strokeWidth={1.75} aria-hidden="true" />
          <input
            type="search"
            aria-label="搜索定时任务"
            placeholder="搜索定时任务"
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') changeQuery(''); }}
          />
          {query && (
            <button type="button" className="icon-button" aria-label="清空搜索" onClick={() => changeQuery('')}>
              <X size={14} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div className="library-toolbar-row library-filter-row">
        {!mobile && filteredTasks.length > 0 && (
          <label className="library-select-all">
            <input
              className="library-select-all-input"
              type="checkbox"
              checked={selectedCount > 0}
              onChange={toggleSelectAll}
              aria-label={selectedCount > 0 ? '取消选择' : '全选当前定时任务'}
            />
            <span className={`library-item-check${selectedCount > 0 ? ' is-checked is-indeterminate' : ''}`} aria-hidden="true" />
          </label>
        )}
        <div className="library-kinds" role="group" aria-label="任务状态">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`library-kind${statusFilter === tab.id ? ' is-active' : ''}`}
              aria-pressed={statusFilter === tab.id}
              onClick={() => changeStatusFilter(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {!mobile && selectionBar}
      </div>
    </div>
  );

  const selectable = !mobile || mobileSelecting;

  return (
    <main className="library-main" id="main-content" tabIndex={-1}>
      <header className="library-topbar">
        {mobile && !sidebarOpen && (
          <button
            className="sidebar-expand"
            type="button"
            onClick={() => dispatch({ type: 'sidebar' })}
            aria-label="展开侧栏"
            aria-expanded={false}
          >
            <Icon name="sidebar" size={22} />
          </button>
        )}
        {mobile && (
          <button
            type="button"
            className="icon-button library-page-more"
            aria-label={mobileSelecting ? '退出选择模式' : '定时任务操作'}
            aria-haspopup={mobileSelecting ? undefined : 'menu'}
            aria-expanded={mobileSelecting ? undefined : Boolean(pageMenuAnchor)}
            onClick={(event) => {
              if (mobileSelecting) {
                clearSelection();
              } else {
                const button = event.currentTarget;
                setPageMenuAnchor((current) => (current ? null : button));
              }
            }}
          >
            {mobileSelecting
              ? <X size={21} strokeWidth={1.75} aria-hidden="true" />
              : <MoreHorizontal size={21} strokeWidth={1.75} aria-hidden="true" />}
          </button>
        )}
        {mobile && !mobileSelecting && pageMenuAnchor && (
          <LibraryMenu anchor={pageMenuAnchor} label="定时任务操作" onClose={() => setPageMenuAnchor(null)}>
            <button
              type="button"
              role="menuitem"
              disabled={!filteredTasks.length}
              onClick={() => {
                const anchor = pageMenuAnchor;
                setSelectedIds(new Set());
                setMobileSelecting(true);
                setPageMenuAnchor(null);
                anchor.focus({ preventScroll: true });
              }}
            >
              <ListChecks size={16} strokeWidth={1.75} aria-hidden="true" />选择
            </button>
          </LibraryMenu>
        )}
      </header>

      <header className="library-heading tasks-heading">
        <h1>定时任务</h1>
        <button
          type="button"
          className="primary-button tasks-create-btn"
          onClick={() => setModalState({ mode: 'create' })}
        >
          <Plus size={17} strokeWidth={1.9} aria-hidden="true" />
          <span>新建定时任务</span>
        </button>
      </header>

      {mobile && <div className="library-mobile-toolbar">{toolbar}</div>}

      <div className="library-scroll">
        <div className="library-content tasks-content">
          {!mobile && toolbar}

          {missingModel && (
            <p className="settings-message is-error" role="status">
              当前尚未配置可用模型，定时任务到期后无法发起对话。请先前往设置配置模型服务。
            </p>
          )}
          {error && <p className="settings-message is-error" role="alert">{error}</p>}

          {loading && !tasks.length ? (
            <div className="tasks-empty">正在加载定时任务…</div>
          ) : filteredTasks.length === 0 ? (
            <div className="library-placeholder tasks-placeholder">
              <EmptyTasksIllustration />
              <p className="tasks-placeholder-text">{emptyMessage(statusFilter, Boolean(normalizedQuery))}</p>
              {normalizedQuery && (
                <div className="tasks-placeholder-actions">
                  <button type="button" className="secondary-button" onClick={() => changeQuery('')}>清空搜索</button>
                </div>
              )}
            </div>
          ) : (
            <div className={`tasks-list${mobile && mobileSelecting ? ' is-selecting' : ''}`} role="list" aria-label="定时任务列表">
              {filteredTasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  mobile={mobile}
                  selectable={selectable}
                  selected={selectedIds.has(task.id)}
                  busy={busyTaskId === task.id}
                  menuOpen={menuTask?.id === task.id}
                  onToggleSelect={() => toggleSelected(task.id)}
                  onToggleStatus={() => { void handleToggle(task); }}
                  onOpenMenu={(element, toggle = false) => {
                    const alignElement = mobile ? element.closest<HTMLElement>('.task-row') : null;
                    setMenuAnchor((current) => {
                      if (current?.taskId === task.id) return toggle ? null : current;
                      return { taskId: task.id, element, alignElement };
                    });
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {mobile && selectionBar}

      {menuTask && menuAnchor && (
        <LibraryMenu
          anchor={menuAnchor.element}
          alignAnchor={menuAnchor.alignElement}
          label={`${menuTask.title} 的操作`}
          onClose={() => setMenuAnchor(null)}
        >
          {menuTaskStatus !== 'completed' && (
            <button
              role="menuitem"
              type="button"
              disabled={busyTaskId === menuTask.id}
              onClick={() => {
                setMenuAnchor(null);
                void handleToggle(menuTask);
              }}
            >
              {menuTaskStatus === 'active'
                ? <><Pause size={15} strokeWidth={1.75} aria-hidden="true" />暂停</>
                : <><Play size={15} strokeWidth={1.75} aria-hidden="true" />开启</>}
            </button>
          )}
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setMenuAnchor(null);
              openBoundConversation(menuTask);
            }}
          >
            <MessageSquare size={15} strokeWidth={1.75} aria-hidden="true" />
            查看关联对话
          </button>
          <button
            role="menuitem"
            type="button"
            disabled={busyTaskId === menuTask.id}
            onClick={() => {
              setMenuAnchor(null);
              setModalState({ mode: 'edit', task: menuTask });
            }}
          >
            <Pencil size={15} strokeWidth={1.75} aria-hidden="true" />编辑
          </button>
          <button
            role="menuitem"
            type="button"
            disabled={busyTaskId === menuTask.id}
            onClick={() => {
              setMenuAnchor(null);
              void handleRunNow(menuTask);
            }}
          >
            <Zap size={15} strokeWidth={1.75} aria-hidden="true" />立即执行
          </button>
          <button
            role="menuitem"
            type="button"
            className="is-danger"
            disabled={busyTaskId === menuTask.id}
            onClick={() => {
              setMenuAnchor(null);
              openDelete([menuTask]);
            }}
          >
            <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />删除
          </button>
        </LibraryMenu>
      )}

      {noConversationTask && (
        <Dialog
          title="暂无关联对话"
          onClose={() => setNoConversationTask(null)}
          className="compact-dialog"
        >
          <p className="dialog-description">
            “{noConversationTask.title}”还没有关联对话，需要第一次执行后才会创建并关联。
          </p>
          <div className="dialog-footer">
            <button
              type="button"
              className="primary-button"
              data-autofocus
              onClick={() => setNoConversationTask(null)}
            >
              知道了
            </button>
          </div>
        </Dialog>
      )}

      {modalState && (
        <TaskModal
          mode={modalState.mode}
          initialTask={modalState.mode === 'edit' ? modalState.task : null}
          initialTitle={modalState.mode === 'create' ? modalState.title : undefined}
          initialPrompt={modalState.mode === 'create' ? modalState.prompt : undefined}
          onClose={() => setModalState(null)}
          onSubmit={handleModalSubmit}
        />
      )}

      {deleting && (
        <Dialog
          title={deleting.length > 1 ? `删除 ${deleting.length} 个定时任务？` : '删除定时任务？'}
          onClose={() => {
            if (!deletingBusy) {
              setDeleteError(null);
              setDeleting(null);
            }
          }}
          className="compact-dialog"
        >
          <p className="dialog-description">
            {deleting.length > 1
              ? `这 ${deleting.length} 个定时任务将被删除，但已产生的历史对话记录会保留。`
              : `“${deleting[0].title}”将被删除，但已产生的历史对话记录会保留。`}
          </p>
          {deleteError && <p className="settings-message is-error" role="alert">{deleteError}</p>}
          <div className="dialog-footer">
            <button
              type="button"
              className="secondary-button"
              disabled={deletingBusy}
              onClick={() => {
                setDeleteError(null);
                setDeleting(null);
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={deletingBusy}
              onClick={() => { void handleDelete(); }}
            >
              {deletingBusy ? '删除中…' : '删除任务'}
            </button>
          </div>
        </Dialog>
      )}
    </main>
  );
}
