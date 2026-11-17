import { useMemo, useState } from 'react';
import { Bell, BookOpen, CalendarClock, Compass, MessageSquare, Pause, Pencil, Play, Plus, Repeat, Sparkles, Trash2 } from 'lucide-react';

import { Dialog } from '@/components/web/dialog';
import { Icon } from '@/components/web/icon';
import { LinkAnchor } from '@/components/web/link-anchor';
import { useChat } from '@/features/chat/chat-state';
import { conversationHref } from '@/features/chat/conversation-href';
import { useModels } from '@/features/models/model-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { Link } from '@/router';
import { TaskModal, type TaskModalSubmitPayload } from './task-modal';
import type { ScheduledTask } from './tasks-api';
import { useTasks } from './tasks-state';

const SUGGESTION_ICONS = [
  { icon: BookOpen, tone: 'blue' },
  { icon: Sparkles, tone: 'purple' },
  { icon: Compass, tone: 'amber' },
  { icon: Bell, tone: 'rose' },
] as const;

type ModalState =
  | { mode: 'create'; title?: string; prompt?: string }
  | { mode: 'edit'; task: ScheduledTask }
  | null;

function stripCommandPrefix(prompt: string): string {
  return prompt.replace(/^帮我新建一个定时任务[：:]\s*/u, '').trim();
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

function statusLabel(task: ScheduledTask): string {
  if (task.status === 'completed') return '已完成';
  if (task.status === 'paused' || !task.enabled) return '已暂停';
  return '运行中';
}

export default function TasksScreen() {
  const { sidebarOpen, conversations, dispatch } = useChat();
  const preview = useIsPreview();
  const models = useModels();
  const { tasks, suggestions, suggestionsLoading, loading, error, createTask, updateTask, removeTask, runTaskNow } = useTasks();

  const [modalState, setModalState] = useState<ModalState>(null);
  const [deleting, setDeleting] = useState<ScheduledTask | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  const conversationIds = useMemo(() => new Set(conversations.map((item) => item.id)), [conversations]);
  const missingModel = !preview && models.ready && !models.selected;

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
        enabled: true,
        baseRevision: modalState.task.revision,
      });
    }
    setModalState(null);
  }

  async function handleToggle(task: ScheduledTask) {
    setBusyTaskId(task.id);
    try {
      await updateTask(task.id, { enabled: !task.enabled, baseRevision: task.revision });
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
    if (!deleting || busyTaskId === deleting.id) return;
    setBusyTaskId(deleting.id);
    setDeleteError(null);
    try {
      await removeTask(deleting.id);
      setDeleting(null);
    } catch (caught) {
      setDeleteError(caught instanceof Error ? caught.message : '删除定时任务失败。');
    } finally {
      setBusyTaskId(null);
    }
  }

  return (
    <main className="library-main" id="main-content" tabIndex={-1}>
      <header className="library-topbar">
        {!sidebarOpen && (
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

      <div className="library-scroll">
        <div className="library-content tasks-content">
          {missingModel && (
            <p className="settings-message is-error" role="status">
              当前尚未配置可用模型，定时任务到期后无法发起对话。请先前往设置配置模型服务。
            </p>
          )}
          {error && <p className="settings-message is-error" role="alert">{error}</p>}

          {loading && !tasks.length ? (
            <div className="tasks-empty">正在加载定时任务…</div>
          ) : tasks.length === 0 ? (
            <section className="tasks-suggestions" aria-label="推荐定时任务">
              <div className="tasks-suggestions-list">
                {suggestionsLoading || !suggestions ? (
                  Array.from({ length: 4 }, (_, index) => (
                    <div key={index} className="task-suggestion-row is-skeleton" aria-hidden="true">
                      <span className="task-suggestion-icon skeleton-box" />
                      <span className="task-suggestion-body">
                        <span className="skeleton-line is-title" />
                        <span className="skeleton-line is-desc" />
                      </span>
                    </div>
                  ))
                ) : suggestions.map((item, index) => {
                  const preset = SUGGESTION_ICONS[index % SUGGESTION_ICONS.length];
                  const ItemIcon = preset.icon;
                  return (
                    <button
                      key={`${item.title}-${item.prompt}`}
                      type="button"
                      className="task-suggestion-row"
                      onClick={() => setModalState({
                        mode: 'create',
                        title: item.title,
                        prompt: stripCommandPrefix(item.prompt),
                      })}
                    >
                      <span className={`task-suggestion-icon is-${preset.tone}`}>
                        <ItemIcon size={18} strokeWidth={1.75} aria-hidden="true" />
                      </span>
                      <span className="task-suggestion-body">
                        <strong>{item.title}</strong>
                        <span>{stripCommandPrefix(item.prompt)}</span>
                      </span>
                      <Plus size={18} strokeWidth={1.6} className="task-suggestion-plus" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </section>
          ) : (
            <div className="tasks-list">
              {tasks.map((task) => {
                const hasConversation = !!task.conversationClientId && conversationIds.has(task.conversationClientId);
                const busy = busyTaskId === task.id;
                const isActive = task.enabled && task.status === 'active';
                return (
                  <article key={task.id} className="task-card">
                    <div className="task-card-head">
                      <div className="task-card-title-group">
                        <div className="task-card-badges">
                          <span className={`task-status-badge is-${task.status}`}>
                            {statusLabel(task)}
                          </span>
                          <span className="task-kind-badge">
                            {task.kind === 'recurring'
                              ? <><Repeat size={12} aria-hidden="true" />{formatInterval(task.intervalMinutes)}</>
                              : <><CalendarClock size={12} aria-hidden="true" />单次定时</>}
                          </span>
                        </div>
                        <h2>{task.title}</h2>
                      </div>
                      <div className="task-card-actions">
                        <button
                          type="button"
                          className="task-action-btn"
                          disabled={busy}
                          onClick={() => { void handleRunNow(task); }}
                          title="立即执行一次"
                        >
                          <Play size={14} aria-hidden="true" />
                          <span>立即执行</span>
                        </button>
                        {task.status !== 'completed' && (
                          <button
                            type="button"
                            className="task-action-btn"
                            disabled={busy}
                            onClick={() => { void handleToggle(task); }}
                          >
                            {isActive
                              ? <><Pause size={14} aria-hidden="true" /><span>暂停</span></>
                              : <><Play size={14} aria-hidden="true" /><span>恢复</span></>}
                          </button>
                        )}
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`编辑任务：${task.title}`}
                          disabled={busy}
                          onClick={() => setModalState({ mode: 'edit', task })}
                        >
                          <Pencil size={15} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`删除任务：${task.title}`}
                          disabled={busy}
                          onClick={() => {
                            setDeleteError(null);
                            setDeleting(task);
                          }}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                      </div>
                    </div>

                    <p className="task-card-prompt">{task.prompt}</p>

                    <div className="task-card-meta">
                      <span>
                        {task.status === 'completed'
                          ? `执行时间：${formatDateTime(task.lastRunAtMs ?? task.runAtMs)}`
                          : `下次执行：${formatDateTime(task.nextRunAtMs)}`}
                      </span>
                      <span>上次执行：{formatDateTime(task.lastRunAtMs)}</span>
                      <span>已执行 {task.runCount} 次</span>
                      {hasConversation && task.conversationClientId ? (
                        <Link href={conversationHref(task.conversationClientId, preview)} asChild>
                          <LinkAnchor className="task-conv-link">
                            <MessageSquare size={13} aria-hidden="true" />
                            <span>查看关联对话</span>
                          </LinkAnchor>
                        </Link>
                      ) : (
                        <span className="task-conv-pending">执行时将自动创建并绑定对话</span>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>

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
          title="删除定时任务？"
          onClose={() => {
            if (busyTaskId !== deleting.id) {
              setDeleteError(null);
              setDeleting(null);
            }
          }}
          className="compact-dialog"
        >
          <p className="dialog-description">
            “{deleting.title}”将被删除，但已产生的历史对话记录会保留。
          </p>
          {deleteError && <p className="settings-message is-error" role="alert">{deleteError}</p>}
          <div className="dialog-footer">
            <button
              type="button"
              className="secondary-button"
              disabled={busyTaskId === deleting.id}
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
              disabled={busyTaskId === deleting.id}
              onClick={() => { void handleDelete(); }}
            >
              {busyTaskId === deleting.id ? '删除中…' : '删除任务'}
            </button>
          </div>
        </Dialog>
      )}
    </main>
  );
}
