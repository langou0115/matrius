import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';

import type {
  UiBindingSnapshot,
  UiComponentArtifact,
  UiComponentVersionContent,
} from '@contract/ui-component';
import { Link } from '@/router';
import { LinkAnchor } from '@/components/web/link-anchor';
import { useInstance } from '@/features/instance/instance-state';
import {
  getUiBinding,
  getUiComponentVersion,
  reportUiCommandResult,
  saveUiBindingState,
} from '@/core/api/ui-components';
import { UiComponentFrame } from './ui-component-frame';

type CardEvent = { name: string; payload: unknown; at: number };

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  return '组件暂时无法加载。';
}

/**
 * One rendered component inside an assistant message.
 *
 * Stateless components fetch their pinned version and render the props stored
 * with the message. Stateful components load their per-conversation binding and
 * render the **current** state, so a reload or a later turn shows the same live
 * object. State writes are serialized and validated by the server.
 */
export function UiComponentCard({
  artifact,
  onSendToAgent,
}: {
  artifact: UiComponentArtifact;
  onSendToAgent?: (text: string) => void;
}) {
  const { request } = useInstance();
  const bindingId = artifact.bindingId;
  const [content, setContent] = useState<UiComponentVersionContent | null>(null);
  const [snapshot, setSnapshot] = useState<UiBindingSnapshot | null>(null);
  // The latest state the frame reported, so a later props/commands update cannot
  // echo the stale snapshot back into the component and wipe its local state.
  const [liveState, setLiveState] = useState<{ value: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<CardEvent[]>([]);
  const [reloadToken, setReloadToken] = useState(0);
  const revisionRef = useRef(0);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  const stateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingState = useRef<{ value: unknown } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (stateTimer.current) clearTimeout(stateTimer.current);
      stateTimer.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (stateTimer.current) clearTimeout(stateTimer.current);
    stateTimer.current = null;
    pendingState.current = null;
    void (async () => {
      try {
        if (bindingId) {
          const { binding } = await getUiBinding(request, bindingId);
          if (cancelled) return;
          revisionRef.current = binding.revision;
          setSnapshot(binding);
          setContent(binding.content);
        } else {
          const { version } = await getUiComponentVersion(request, artifact.componentId, artifact.version);
          if (cancelled) return;
          setContent(version);
        }
        if (!cancelled) {
          setLiveState(null);
          setError(null);
        }
      } catch (reason) {
        if (!cancelled) setError(errorMessage(reason));
      }
    })();
    return () => { cancelled = true; };
  }, [artifact.componentId, artifact.version, bindingId, reloadToken, request]);

  /** Serialized: every write reads the latest revision, so spikes cannot race each other. */
  const writeState = useCallback((next: unknown) => {
    if (!bindingId) return;
    chainRef.current = chainRef.current.then(async () => {
      try {
        const { revision } = await saveUiBindingState(request, bindingId, next, revisionRef.current);
        revisionRef.current = revision;
      } catch (reason) {
        if (!mountedRef.current) return;
        setError(errorMessage(reason));
        // Resync so the frame shows the authoritative state instead of drifting.
        try {
          const { binding } = await getUiBinding(request, bindingId);
          if (!mountedRef.current) return;
          revisionRef.current = binding.revision;
          setSnapshot(binding);
          setLiveState(null);
        } catch {
          // Keep the original message.
        }
      }
    });
  }, [bindingId, request]);

  const persistState = useCallback((next: unknown) => {
    if (!bindingId) return;
    setLiveState({ value: next });
    pendingState.current = { value: next };
    if (stateTimer.current) return;
    // Typing in a filter can fire dozens of changes; persist the last one after a short pause.
    stateTimer.current = setTimeout(() => {
      stateTimer.current = null;
      const pending = pendingState.current;
      pendingState.current = null;
      if (pending) writeState(pending.value);
    }, 350);
  }, [bindingId, writeState]);

  const persistCommand = useCallback((id: string, result: { ok: boolean; error?: string; state?: unknown }) => {
    if (!bindingId) return;
    // A command result is authoritative: drop a debounced local write that would overwrite it.
    if (stateTimer.current) clearTimeout(stateTimer.current);
    stateTimer.current = null;
    pendingState.current = null;
    if (result.state !== undefined) setLiveState({ value: result.state });
    chainRef.current = chainRef.current.then(async () => {
      try {
        const response = await reportUiCommandResult(request, bindingId, id, {
          ok: result.ok,
          ...(result.error ? { error: result.error } : {}),
          ...(result.state !== undefined ? { state: result.state } : {}),
          baseRevision: revisionRef.current,
        });
        if (typeof response.revision === 'number') revisionRef.current = response.revision;
        const { binding } = await getUiBinding(request, bindingId);
        if (!mountedRef.current) return;
        revisionRef.current = binding.revision;
        setSnapshot(binding);
        setLiveState(null);
      } catch (reason) {
        if (mountedRef.current) setError(errorMessage(reason));
      }
    });
  }, [bindingId, request]);

  // A command can be issued in the same reply after the card mounted, so the artifact gains
  // commandIds without the binding changing. Refresh just the binding to pick it up.
  const commandKey = (artifact.commandIds ?? []).join(',');
  useEffect(() => {
    if (!bindingId || !commandKey) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { binding } = await getUiBinding(request, bindingId);
        if (cancelled) return;
        revisionRef.current = binding.revision;
        setSnapshot(binding);
      } catch {
        // The command stays pending; a later reload will deliver it.
      }
    })();
    return () => { cancelled = true; };
  }, [bindingId, commandKey, request]);

  const handleEvent = useCallback((name: string, payload: unknown) => {
    setEvents((current) => [{ name, payload, at: Date.now() }, ...current].slice(0, 5));
  }, []);

  const declaredEvents = content?.events ?? [];
  const eventToAgent = events[0] ? declaredEvents.find((item) => item.name === events[0].name && item.toAgent) : undefined;

  function sendEventToAgent() {
    const latest = events[0];
    if (!latest || !eventToAgent || !onSendToAgent) return;
    let payload = 'null';
    try { payload = JSON.stringify(latest.payload ?? null, null, 2); } catch { payload = String(latest.payload); }
    onSendToAgent(`组件「${artifact.name}」触发了交互事件「${latest.name}」，数据如下：\n\`\`\`json\n${payload}\n\`\`\`\n请根据这个结果继续。`);
    setEvents([]);
  }

  return <section className="ui-component-card" aria-label={`UI 组件：${artifact.name}`}>
    <header className="ui-component-card-header">
      <span className="ui-component-card-title">{content?.name ?? artifact.name}</span>
      <span className="ui-component-card-meta">v{artifact.version}{bindingId ? ' · 会话绑定' : ''}</span>
      {content && content.status !== 'published' && <span className="ui-component-badge is-draft">草稿</span>}
      <Link href={`/ui/${artifact.componentId}`} asChild>
        <LinkAnchor className="ui-component-card-link">在 UI 工坊中打开</LinkAnchor>
      </Link>
    </header>

    {error && <div className="ui-component-card-error" role="alert">
      <span>{error}</span>
      <button type="button" className="ui-component-card-retry" onClick={() => setReloadToken((value) => value + 1)}>
        <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />重试
      </button>
    </div>}

    {!content && !error && <div className="ui-component-skeleton" aria-hidden="true" />}

    {content && <UiComponentFrame
      content={content}
      props={snapshot ? snapshot.props : artifact.props}
      state={liveState ? liveState.value : (snapshot?.state ?? null)}
      commands={snapshot?.pendingCommands ?? []}
      onStateChange={bindingId ? persistState : undefined}
      onCommandResult={bindingId ? persistCommand : undefined}
      onEvent={handleEvent}
      onError={setError}
    />}

    {events.length > 0 && <div className="ui-component-card-events">
      <span>最近交互：{events[0].name}</span>
      {eventToAgent && onSendToAgent && <button type="button" className="ui-component-card-action" onClick={sendEventToAgent}>交给 AI</button>}
      <button type="button" className="ui-component-card-action is-muted" onClick={() => setEvents([])}>清除</button>
    </div>}
  </section>;
}
