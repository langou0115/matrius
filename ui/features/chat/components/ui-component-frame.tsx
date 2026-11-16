import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  composeUiComponentDocument,
  type UiBindingCommand,
  type UiComponentVersionContent,
  type UiFrameMessage,
  type UiHostMessage,
  type UiThemeTokens,
} from '@contract/ui-component';

/**
 * Shared renderer for the workshop preview and the chat card.
 *
 * Isolation: the frame runs with `sandbox="allow-scripts"` only, so it has an
 * opaque origin and cannot reach the parent DOM, cookies, storage or tokens. The
 * document's meta CSP blocks every network request and eval. All communication
 * is `postMessage`, validated by source and message type, and the component can
 * never crash the React tree because it lives in a separate document.
 */

const MIN_HEIGHT = 80;
const MAX_HEIGHT = 1200;
const INITIAL_HEIGHT = 240;
const READY_TIMEOUT_MS = 5_000;

const THEME_KEYS = ['background', 'foreground', 'card', 'muted', 'muted-foreground', 'border', 'primary'] as const;

function readTheme(): UiThemeTokens {
  const host = typeof document === 'undefined' ? null : document.querySelector('.matrius-app');
  const style = host ? getComputedStyle(host) : null;
  const tokens: UiThemeTokens = { mode: host?.getAttribute('data-color-mode') ?? 'light' };
  for (const key of THEME_KEYS) {
    const value = style?.getPropertyValue(`--${key}`).trim();
    if (value) tokens[key] = value;
  }
  return tokens;
}

function clampHeight(value: number): number {
  if (!Number.isFinite(value)) return INITIAL_HEIGHT;
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(value)));
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  } catch {
    return false;
  }
}

export type UiComponentFrameProps = {
  content: UiComponentVersionContent;
  props?: unknown;
  state?: unknown;
  commands?: UiBindingCommand[];
  initialHeight?: number;
  onStateChange?: (state: unknown) => void;
  onCommandResult?: (id: string, result: { ok: boolean; error?: string; state?: unknown }) => void;
  onEvent?: (name: string, payload: unknown) => void;
  onError?: (message: string) => void;
  onReady?: () => void;
  className?: string;
};

export function UiComponentFrame({
  content,
  props,
  state,
  commands,
  initialHeight = INITIAL_HEIGHT,
  onStateChange,
  onCommandResult,
  onEvent,
  onError,
  onReady,
  className,
}: UiComponentFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const readyRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPropsRef = useRef<unknown>(props);
  const lastStateRef = useRef<unknown>(state);
  const deliveredRef = useRef<Set<string>>(new Set());
  const callbacks = useRef({ onStateChange, onCommandResult, onEvent, onError, onReady });
  const [height, setHeight] = useState(() => clampHeight(initialHeight));
  const [ready, setReady] = useState(false);
  const srcDoc = useMemo(() => composeUiComponentDocument(content.html), [content.html]);

  useEffect(() => {
    callbacks.current = { onStateChange, onCommandResult, onEvent, onError, onReady };
  });

  const post = useCallback((message: UiHostMessage) => {
    const frame = frameRef.current;
    if (!frame?.contentWindow) return;
    frame.contentWindow.postMessage(message, '*');
  }, []);

  // A frame that never reaches `ready` is almost always blocked or broken code;
  // surface it instead of leaving an empty card.
  const armTimeout = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      if (!readyRef.current) callbacks.current.onError?.('组件在 5 秒内没有完成渲染，可能包含无法执行的代码。');
    }, READY_TIMEOUT_MS);
  }, []);

  const handleLoad = useCallback(() => {
    readyRef.current = false;
    setReady(false);
    deliveredRef.current.clear();
    lastPropsRef.current = props;
    lastStateRef.current = state;
    post({
      type: 'matrius:init',
      props: props === undefined ? null : props,
      state: state === undefined ? null : state,
      theme: readTheme(),
      locale: 'zh-CN',
      component: { componentId: content.componentId, version: content.version },
    });
    armTimeout();
  }, [armTimeout, content.componentId, content.version, post, props, state]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as UiFrameMessage | null;
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
      switch (data.type) {
        case 'matrius:ready': {
          readyRef.current = true;
          setReady(true);
          if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
          if (typeof data.height === 'number') setHeight(clampHeight(data.height));
          callbacks.current.onReady?.();
          return;
        }
        case 'matrius:resize': {
          setHeight(clampHeight(data.height));
          return;
        }
        case 'matrius:state': {
          lastStateRef.current = data.state;
          callbacks.current.onStateChange?.(data.state);
          return;
        }
        case 'matrius:event': {
          callbacks.current.onEvent?.(String(data.name), data.payload);
          return;
        }
        case 'matrius:command-result': {
          callbacks.current.onCommandResult?.(String(data.id), {
            ok: Boolean(data.ok),
            ...(data.error ? { error: String(data.error) } : {}),
            ...(data.state !== undefined ? { state: data.state } : {}),
          });
          return;
        }
        case 'matrius:error': {
          callbacks.current.onError?.(String(data.message || '组件运行出错。'));
          return;
        }
        default:
          return;
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const propsKey = useMemo(() => {
    try { return JSON.stringify(props ?? null); } catch { return String(props); }
  }, [props]);
  const stateKey = useMemo(() => {
    try { return JSON.stringify(state ?? null); } catch { return String(state); }
  }, [state]);
  const commandsKey = (commands ?? []).map((command) => command.id).join(',');

  // Push later updates only after `ready`; the init message already carried the first values.
  useEffect(() => {
    if (!ready) return;
    if (!sameJson(props, lastPropsRef.current)) {
      lastPropsRef.current = props;
      post({ type: 'matrius:props', props: props === undefined ? null : props });
    }
    if (!sameJson(state, lastStateRef.current)) {
      lastStateRef.current = state;
      post({ type: 'matrius:state', state: state === undefined ? null : state });
    }
    for (const command of commands ?? []) {
      if (deliveredRef.current.has(command.id)) continue;
      deliveredRef.current.add(command.id);
      post({ type: 'matrius:command', id: command.id, name: command.name, payload: command.payload });
    }
    // The three keys below stand in for props/state/commands so updates compare structurally.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the refs hold the latest payloads; re-subscribing on every render would be wasted work.
  }, [commandsKey, post, propsKey, ready, stateKey]);

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  return <iframe
    ref={frameRef}
    className={`ui-component-frame${className ? ` ${className}` : ''}`}
    title={content.name}
    sandbox="allow-scripts"
    referrerPolicy="no-referrer"
    srcDoc={srcDoc}
    style={{ height }}
    onLoad={handleLoad}
  />;
}
