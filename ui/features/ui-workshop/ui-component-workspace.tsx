import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Loader2,
  Pencil,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react';

import type { MessageFile, MessageImage } from '@contract/agent-types';
import type { UiComponentDetail, UiComponentVersionContent } from '@contract/ui-component';
import { Dialog } from '@/components/web/dialog';
import { Icon } from '@/components/web/icon';
import { LinkAnchor } from '@/components/web/link-anchor';
import { useChat } from '@/features/chat/chat-state';
import { Composer } from '@/features/chat/components/composer';
import { MessageAttachments } from '@/features/chat/components/message-attachments';
import { MessageContent } from '@/features/chat/components/message-content';
import { UiComponentFrame } from '@/features/chat/components/ui-component-frame';
import { useInstance } from '@/features/instance/instance-state';
import { useMobile } from '@/components/web/use-mobile';
import { useModels } from '@/features/models/model-state';
import { hasFeature } from '@/core/features/capabilities';
import {
  archiveUiComponent,
  getLatestUiComponentVersion,
  getUiComponent,
  getUiComponentVersion,
  patchUiComponent,
  publishUiComponent,
} from '@/core/api/ui-components';
import { Link, router, useLocalSearchParams } from '@/router';
import { useWorkshopChat } from './use-workshop';

const SUGGESTIONS = [
  '做一个项目进度看板，展示任务、负责人、进度和状态，支持按状态筛选。',
  '做一个销售趋势图，可以切换月份并显示每月总额。',
  '做一个中国象棋棋盘，可以走子，并记住当前局面。',
];

// The chat/preview split is remembered locally; it is a device preference, not instance data.
const SPLIT_KEY = 'matrius.ui-workshop.split';
const SPLIT_DEFAULT = 420;
const SPLIT_MIN = 320;
const SPLIT_MAX = 760;

function readSplitWidth(): number {
  if (typeof window === 'undefined') return SPLIT_DEFAULT;
  try {
    const value = Number(window.localStorage.getItem(SPLIT_KEY));
    return Number.isFinite(value) && value >= SPLIT_MIN ? value : SPLIT_DEFAULT;
  } catch {
    return SPLIT_DEFAULT;
  }
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  return '请求失败，请重试。';
}

function statusLabel(component: UiComponentDetail['component']): string {
  if (component.status === 'archived') return '已归档';
  if (component.publishedVersion === null) return '草稿';
  return component.currentVersion > component.publishedVersion ? '有修改待发布' : '已发布';
}

function statusClass(component: UiComponentDetail['component']): string {
  if (component.status === 'archived') return 'is-archived';
  if (component.publishedVersion === null) return 'is-draft';
  return component.currentVersion > component.publishedVersion ? 'is-pending' : 'is-published';
}

function formatTime(value: number): string {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function UiComponentWorkspace() {
  const instance = useInstance();
  const models = useModels();
  const mobile = useMobile();
  const { sidebarOpen, dispatch } = useChat();
  const { componentId: componentIdParam } = useLocalSearchParams<{ componentId?: string }>();
  const componentId = componentIdParam ?? '';
  const enabled = instance.status === 'ready' && hasFeature(instance.info, 'ui_workshop');

  const [detailState, setDetailState] = useState<{ componentId: string; detail: UiComponentDetail | null; error: string | null } | null>(null);
  const [versionState, setVersionState] = useState<{ componentId: string; content: UiComponentVersionContent } | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [previewState, setPreviewState] = useState<unknown>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Drafts are keyed by component so switching between two builders never leaks text.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = drafts[componentId] ?? '';
  const setDraft = useCallback((value: string) => {
    setDrafts((current) => ({ ...current, [componentId]: value }));
  }, [componentId]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<'chat' | 'preview'>('chat');
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [chatWidth, setChatWidth] = useState(readSplitWidth);
  const [bodyWidth, setBodyWidth] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  const [resizing, setResizing] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const bodyObserver = useRef<ResizeObserver | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Measure the actual column width: the sidebar collapsing changes how much room the
  // chat may take, and the split must follow it without a reload.
  const attachBody = useCallback((node: HTMLDivElement | null) => {
    bodyRef.current = node;
    bodyObserver.current?.disconnect();
    bodyObserver.current = null;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setBodyWidth(width);
    });
    observer.observe(node);
    bodyObserver.current = observer;
  }, []);

  const loaded = detailState?.componentId === componentId;
  const detail = loaded ? detailState.detail : null;
  const loadError = loaded ? detailState.error : null;
  const version = versionState?.componentId === componentId ? versionState.content : null;
  const conversationId = detail?.component.conversationId ?? null;
  const thinkingEffort = models.selected?.thinkingEffort ?? 'low';

  const refreshAll = useCallback(() => {
    setRefreshToken((value) => value + 1);
  }, []);
  const chat = useWorkshopChat({
    componentId: detail?.component.id ?? null,
    conversationId,
    onChange: refreshAll,
  });

  // Keep the canvas usable: the chat column stops 360px before the measured body ends.
  const maxChatWidth = Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, bodyWidth - 360));
  const splitWidth = Math.min(Math.max(chatWidth, SPLIT_MIN), maxChatWidth);

  useEffect(() => {
    try {
      window.localStorage.setItem(SPLIT_KEY, String(splitWidth));
    } catch {
      // Private mode: the width still applies for this session.
    }
  }, [splitWidth]);

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = splitWidth;
    const total = bodyRef.current?.getBoundingClientRect().width ?? bodyWidth;
    const max = Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, total - 360));
    setResizing(true);
    const onMove = (moveEvent: PointerEvent) => {
      setChatWidth(Math.round(Math.max(SPLIT_MIN, Math.min(startWidth + moveEvent.clientX - startX, max))));
    };
    const finish = () => {
      setResizing(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }

  // Component detail plus its latest version; every AI write bumps refreshToken.
  useEffect(() => {
    if (!enabled || !componentId) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const next = await getUiComponent(instance.request, componentId);
        if (cancelled) return;
        setDetailState({ componentId, detail: next, error: null });
        if (next.component.currentVersion > 0) {
          const { version: content } = await getLatestUiComponentVersion(instance.request, componentId);
          if (cancelled) return;
          setVersionState({ componentId, content });
        } else {
          setVersionState(null);
        }
        setPreviewState(null);
        setPreviewError(null);
        setError(null);
      } catch (reason) {
        if (!cancelled) setDetailState({ componentId, detail: null, error: errorMessage(reason) });
      }
    })();
    return () => { cancelled = true; };
  }, [componentId, enabled, instance.request, refreshToken]);

  // Follow the conversation.
  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [chat.messages, chat.sending]);

  async function submit(images: MessageImage[], files: MessageFile[]) {
    const text = draft.trim();
    if (!text && !images.length && !files.length) return false;
    if (chat.sending) {
      // Steering matches the chat composer, but only for text supplements.
      if (images.length || files.length || !text) return false;
      const sent = await chat.steer(text);
      if (sent) setDraft('');
      return sent;
    }
    const sent = await chat.send(text, images, files);
    if (sent) setDraft('');
    return sent;
  }

  async function publish(target?: number) {
    const versionNumber = target ?? version?.version;
    if (!detail || !versionNumber) return;
    if (target === undefined && version?.status !== 'draft') return;
    setBusy('publish');
    setError(null);
    try {
      await publishUiComponent(instance.request, detail.component.id, versionNumber, detail.component.revision);
      setNotice(`已发布 v${versionNumber}，现在可以在普通对话中调用这个组件。`);
      refreshAll();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  }

  async function submitRename() {
    if (!detail) return;
    const name = renameValue.trim();
    if (!name) return;
    setBusy('rename');
    setError(null);
    try {
      await patchUiComponent(instance.request, detail.component.id, { name, baseRevision: detail.component.revision });
      setRenameOpen(false);
      refreshAll();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  }

  async function archive() {
    if (!detail) return;
    setBusy('delete');
    setError(null);
    try {
      await archiveUiComponent(instance.request, detail.component.id, detail.component.revision);
      setDeleteOpen(false);
      router.replace('/ui');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  }

  async function previewVersion(target: number) {
    if (!detail) return;
    setBusy('preview');
    setError(null);
    try {
      const { version: content } = await getUiComponentVersion(instance.request, detail.component.id, target);
      setVersionState({ componentId: detail.component.id, content });
      setPreviewState(null);
      setPreviewError(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  }

  function fixWithAi() {
    if (!previewError || chat.sending) return;
    const message = `预览出现错误：\n${previewError}\n\n请修复这个组件，保持其他行为不变。`;
    setPreviewError(null);
    setMobileTab('chat');
    void chat.send(message);
  }

  function updateThinkingEffort(value: typeof thinkingEffort) {
    if (!models.selected) return;
    void models.setThinkingEffort(models.selected.id, value).catch(() => setNotice('保存思考强度失败，请重试。'));
  }

  // Shared by the loading, missing and disabled states: the expand button must never
  // disappear just because the component is still loading.
  const stateTopbar = <header className="ui-studio-topbar">
    {!sidebarOpen && !mobile && <button className="sidebar-expand" type="button" onClick={() => dispatch({ type: 'sidebar' })} aria-label="展开侧栏" aria-expanded={false}>
      <Icon name="sidebar" size={22} />
    </button>}
    <Link href="/ui" asChild>
      <LinkAnchor className="ui-studio-back" aria-label="返回组件库"><ArrowLeft size={17} strokeWidth={1.75} aria-hidden="true" /><span>组件库</span></LinkAnchor>
    </Link>
  </header>;

  if (instance.status === 'checking') {
    return <main className="ui-studio" id="main-content" tabIndex={-1}>
      {stateTopbar}
      <div className="ui-studio-state"><p role="status">正在连接实例…</p></div>
    </main>;
  }

  if (!enabled) {
    return <main className="ui-studio" id="main-content" tabIndex={-1}>
      {stateTopbar}
      <div className="ui-studio-state">
        <div className="ui-studio-missing-card">
          <Sparkles size={24} strokeWidth={1.6} aria-hidden="true" />
          <strong>UI 工坊尚未开放</strong>
          <p>当前实例没有启用 UI 工坊功能。</p>
          <Link href="/ui" asChild><LinkAnchor className="secondary-button">返回组件库</LinkAnchor></Link>
        </div>
      </div>
    </main>;
  }

  if (loaded && !detail) {
    return <main className="ui-studio" id="main-content" tabIndex={-1}>
      {stateTopbar}
      <div className="ui-studio-state">
        <div className="ui-studio-missing-card">
          <Sparkles size={24} strokeWidth={1.6} aria-hidden="true" />
          <strong>找不到这个组件</strong>
          <p>{loadError ?? '它可能已被删除，或链接不完整。'}</p>
          <div className="ui-studio-missing-actions">
            <button type="button" className="secondary-button" onClick={refreshAll}>重试</button>
            <Link href="/ui" asChild><LinkAnchor className="primary-button">返回组件库</LinkAnchor></Link>
          </div>
        </div>
      </div>
    </main>;
  }

  if (!loaded) {
    return <main className="ui-studio" id="main-content" tabIndex={-1}>
      {stateTopbar}
      <div className="ui-studio-state">
        <p className="ui-studio-loading" role="status"><Loader2 size={18} strokeWidth={1.75} className="is-spinning" aria-hidden="true" />正在打开组件…</p>
      </div>
    </main>;
  }

  const selected = detail?.component ?? null;
  const canPublish = Boolean(version) && version?.status === 'draft';

  return <main className="ui-studio" id="main-content" tabIndex={-1}>
    <header className="ui-studio-topbar">
      {!sidebarOpen && !mobile && <button className="sidebar-expand" type="button" onClick={() => dispatch({ type: 'sidebar' })} aria-label="展开侧栏" aria-expanded={false}>
        <Icon name="sidebar" size={22} />
      </button>}
      <Link href="/ui" asChild>
        <LinkAnchor className="ui-studio-back" aria-label="返回组件库"><ArrowLeft size={17} strokeWidth={1.75} aria-hidden="true" /><span>组件库</span></LinkAnchor>
      </Link>
      <div className="ui-studio-heading">
        <h1>{selected?.name ?? '组件'}</h1>
        {selected && <span className={`ui-component-badge ${statusClass(selected)}`}>{statusLabel(selected)}</span>}
        {version && <span className="ui-studio-version">v{version.version}</span>}
      </div>
      <div className="ui-studio-actions">
        <button type="button" className="ui-studio-icon" onClick={refreshAll} aria-label="刷新组件"><RefreshCw size={17} strokeWidth={1.75} aria-hidden="true" /></button>
        <button type="button" className="ui-studio-icon" aria-label="重命名组件"
          onClick={() => { setRenameValue(selected?.name ?? ''); setRenameOpen(true); }}><Pencil size={16} strokeWidth={1.75} aria-hidden="true" /></button>
        <button type="button" className="ui-studio-icon danger-icon" aria-label="删除组件" onClick={() => setDeleteOpen(true)}><Trash2 size={16} strokeWidth={1.75} aria-hidden="true" /></button>
        <button type="button" className="primary-button ui-studio-publish" onClick={() => void publish()} disabled={!canPublish || busy === 'publish'}>
          {busy === 'publish' ? <Loader2 size={15} strokeWidth={1.75} className="is-spinning" aria-hidden="true" /> : canPublish ? <Check size={15} strokeWidth={1.75} aria-hidden="true" /> : null}
          {canPublish ? `发布 v${version?.version}` : '已发布'}
        </button>
      </div>
    </header>

    <nav className="ui-studio-tabs" aria-label="组件视图">
      <button type="button" className={mobileTab === 'chat' ? 'is-active' : ''} onClick={() => setMobileTab('chat')}>对话</button>
      <button type="button" className={mobileTab === 'preview' ? 'is-active' : ''} onClick={() => setMobileTab('preview')}>预览</button>
    </nav>

    <div className="ui-studio-body" ref={attachBody} data-resizing={resizing ? 'true' : undefined}
      style={mobile ? undefined : { gridTemplateColumns: `${splitWidth}px 8px minmax(0, 1fr)` }}>
      <section className={`ui-studio-chat${mobileTab === 'chat' ? ' is-active' : ''}`} aria-label="AI 组件助手">
        <div className="ui-studio-chat-head">
          <span className="ui-studio-chat-mark"><Sparkles size={15} strokeWidth={1.8} aria-hidden="true" /></span>
          <strong>AI 组件助手</strong>
          {chat.sending && <span>正在设计…</span>}
        </div>

        <div className="ui-studio-messages" ref={scrollerRef}>
          {chat.messages.length === 0 && <div className="ui-studio-starter">
            <h2>先说说你想要的组件</h2>
            <p>AI 会写出真正可运行的界面，并在这里持续修改。</p>
            <div className="ui-studio-suggestions">
              {SUGGESTIONS.map((suggestion) => <button key={suggestion} type="button" className="ui-studio-suggestion"
                onClick={() => { setDraft(suggestion); setMobileTab('chat'); }}>
                {suggestion}
              </button>)}
            </div>
          </div>}

          {chat.messages.map((message) => message.role === 'user'
            ? <article className="ui-studio-message is-user" key={message.id}>
              {!!(message.images?.length || message.files?.length || message.fileIds?.length) && <MessageAttachments
                images={message.images} files={message.files} fileIds={message.fileIds} />}
              {message.content && <p>{message.content}</p>}
              {message.steering && <span className="ui-studio-steering">补充</span>}
            </article>
            : <article className="ui-studio-message is-assistant" key={message.id}>
              {message.content
                ? <MessageContent content={message.content} streaming={message.status === 'streaming'} />
                : message.status === 'streaming'
                  ? <p className="ui-studio-typing"><Loader2 size={15} strokeWidth={1.75} className="is-spinning" aria-hidden="true" />正在设计组件…</p>
                  : null}
              {message.status === 'error' && message.error && <p className="ui-studio-message-error" role="alert">{message.error}</p>}
            </article>)}
        </div>

        {(error || chat.notice || notice || chat.error) && <div className="ui-studio-banner" role="status">
          <span>{error ?? chat.error ?? chat.notice ?? notice}</span>
          <button type="button" className="ui-studio-banner-close" aria-label="关闭提示"
            onClick={() => { setError(null); setNotice(null); chat.clearError(); chat.clearNotice(); }}>×</button>
        </div>}

        <div className="ui-studio-composer">
          <Composer
            key={componentId}
            value={draft}
            onChange={setDraft}
            onSend={submit}
            thinkingEffort={thinkingEffort}
            onThinkingEffortChange={updateThinkingEffort}
            onNotice={setNotice}
            running={chat.sending}
            onStop={chat.stop}
            conversationId={conversationId}
            hint="描述你想要的组件，或继续修改…"
          />
        </div>
      </section>

      {!mobile && <div
        className="ui-studio-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整对话与预览宽度"
        aria-valuenow={splitWidth}
        aria-valuemin={SPLIT_MIN}
        aria-valuemax={maxChatWidth}
        tabIndex={0}
        onPointerDown={startResize}
        onDoubleClick={() => setChatWidth(Math.min(SPLIT_DEFAULT, maxChatWidth))}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            setChatWidth(Math.max(SPLIT_MIN, splitWidth - 24));
          } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            setChatWidth(Math.min(maxChatWidth, splitWidth + 24));
          } else if (event.key === 'Home') {
            event.preventDefault();
            setChatWidth(Math.min(SPLIT_DEFAULT, maxChatWidth));
          }
        }}
      />}

      <section className={`ui-studio-canvas${mobileTab === 'preview' ? ' is-active' : ''}`} aria-label="组件预览">
        <div className="ui-studio-canvas-head">
          <strong>实时预览</strong>
          {version && <span>v{version.version} · {version.status === 'published' ? '已发布' : '草稿'}</span>}
          <div className="ui-studio-canvas-actions">
            <button type="button" className="ui-studio-icon" onClick={refreshAll} aria-label="刷新预览"><RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" /></button>
          </div>
        </div>

        <div className="ui-studio-stage">
          {version
            ? <div className="ui-studio-frame">
              <UiComponentFrame
                key={`${version.componentId}@${version.version}`}
                content={version}
                props={{}}
                state={previewState}
                onStateChange={setPreviewState}
                onError={setPreviewError}
              />
            </div>
            : <div className="ui-studio-stage-empty">
              <Sparkles size={26} strokeWidth={1.5} aria-hidden="true" />
              <p>描述组件需求，生成后会在这里实时预览。</p>
            </div>}

          {previewError && <div className="ui-studio-preview-error" role="alert">
            <AlertCircle size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>{previewError}</span>
            <button type="button" className="ui-studio-fix" onClick={fixWithAi} disabled={chat.sending}>让 AI 修复</button>
            <button type="button" className="ui-studio-banner-close" onClick={() => setPreviewError(null)} aria-label="关闭错误提示">×</button>
          </div>}
        </div>

        <div className="ui-studio-canvas-foot">
          {version && <span>每次修改都会自动保存为草稿；发布后才会出现在普通对话的可用组件里。</span>}
          {detail && detail.versions.length > 0 && <details className="ui-studio-versions">
            <summary>版本记录（{detail.versions.length}）</summary>
            <ul>
              {detail.versions.slice(0, 12).map((item) => <li key={item.version}>
                <span className="ui-studio-version-number">v{item.version}</span>
                <span className={`ui-component-badge is-${item.status}`}>{item.status === 'published' ? '已发布' : '草稿'}</span>
                <span className="ui-studio-version-time">{formatTime(item.createdAt)}</span>
                {detail.component.publishedVersion === item.version && <span className="ui-studio-version-current">当前默认</span>}
                <span className="ui-studio-version-actions">
                  <button type="button" className="ui-studio-version-button" onClick={() => void previewVersion(item.version)} disabled={busy === 'preview'}>预览</button>
                  <button type="button" className="ui-studio-version-button" onClick={() => void publish(item.version)} disabled={busy === 'publish'}>发布</button>
                </span>
              </li>)}
            </ul>
          </details>}
        </div>
      </section>
    </div>

    {renameOpen && <Dialog title="重命名组件" onClose={() => { if (busy !== 'rename') setRenameOpen(false); }} className="compact-dialog">
      <form onSubmit={(event) => { event.preventDefault(); void submitRename(); }}>
        <label className="field-label" htmlFor="ui-studio-rename">组件名称</label>
        <input id="ui-studio-rename" className="text-field" value={renameValue} maxLength={200} required
          onChange={(event) => setRenameValue(event.target.value)} />
        <div className="dialog-footer">
          <button type="button" className="secondary-button" onClick={() => setRenameOpen(false)} disabled={busy === 'rename'}>取消</button>
          <button type="submit" className="primary-button" disabled={!renameValue.trim() || busy === 'rename'}>
            {busy === 'rename' ? '保存中…' : '保存名称'}
          </button>
        </div>
      </form>
    </Dialog>}

    {deleteOpen && <Dialog title="删除这个组件？" onClose={() => { if (busy !== 'delete') setDeleteOpen(false); }} className="compact-dialog">
      <p className="dialog-description">「{selected?.name}」将从组件列表和 AI 可用组件中移除。已经引用它的历史消息和会话绑定仍会保留，并继续显示。</p>
      <div className="dialog-footer">
        <button type="button" className="secondary-button" onClick={() => setDeleteOpen(false)} disabled={busy === 'delete'}>取消</button>
        <button type="button" className="danger-button" onClick={() => void archive()} disabled={busy === 'delete'}>
          {busy === 'delete' ? '删除中…' : '删除组件'}
        </button>
      </div>
    </Dialog>}
  </main>;
}
