import { memo, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { List, X } from 'lucide-react';

import type { Message } from '../chat-state';

type Props = { messages: Message[]; containerRef: RefObject<HTMLElement | null>; onNavigate: (target: HTMLElement) => void };

export const ConversationNavigator = memo(function ConversationNavigator({ messages, containerRef, onNavigate }: Props) {
  const questions = useMemo(() => messages.filter((message) => message.role === 'user'), [messages]);
  const messageKey = JSON.stringify(questions.map((message) => message.id));
  const enabled = questions.length >= 4;
  const [current, setCurrent] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const nav = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const cardId = useId();

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;
    const elements = Array.from(container.querySelectorAll<HTMLElement>('[data-user-message-id]'));
    let frame = 0;
    function sync() {
      frame = 0;
      if (!container) return;
      const anchor = container.getBoundingClientRect().top + 100;
      let active: HTMLElement | undefined = elements[0];
      for (const element of elements) {
        if (element.getBoundingClientRect().top > anchor) break;
        active = element;
      }
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) active = elements.at(-1);
      setCurrent(active?.dataset.userMessageId ?? null);
    }
    function schedule() { if (!frame) frame = requestAnimationFrame(sync); }
    container.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const observer = new ResizeObserver(schedule);
    const content = container.querySelector('.messages-content');
    if (content) observer.observe(content);
    observer.observe(container);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      container.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      observer.disconnect();
    };
  }, [containerRef, messageKey, enabled]);

  useEffect(() => {
    if (!open) return;
    const cardList = list.current;
    const active = cardList?.querySelector<HTMLElement>('[aria-current="location"]');
    if (cardList && active) cardList.scrollTop = Math.max(0, active.offsetTop - cardList.clientHeight / 2 + active.offsetHeight / 2);
  }, [current, open]);

  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !nav.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  if (!enabled) return null;
  const activeIndex = Math.max(0, questions.findIndex((message) => message.id === current));
  const barCount = Math.min(15, questions.length);
  const activeBar = Math.round(activeIndex * (barCount - 1) / (questions.length - 1));
  return <nav ref={nav} className="conversation-navigator" aria-label="对话导航"
    onPointerEnter={(event) => { if (event.pointerType === 'mouse') setOpen(true); }}
    onPointerLeave={(event) => { if (event.pointerType === 'mouse' && !nav.current?.contains(document.activeElement)) setOpen(false); }}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    }}>
    <button ref={trigger} className="conversation-navigator-trigger" type="button" aria-label={`对话导航，共 ${questions.length} 个提问`}
      aria-expanded={open} aria-controls={cardId} onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>('button')?.focus()); } }}>
      <List className="navigator-mobile-icon" size={19} strokeWidth={1.75} aria-hidden="true" />
      <span className="navigator-bars" aria-hidden="true">{Array.from({ length: barCount }, (_, index) => <span key={index} className={activeBar === index ? 'is-current' : ''} />)}</span>
    </button>
    {open && <div id={cardId} className="conversation-navigator-card">
      <header><strong>对话导航</strong><span>{questions.length}</span><button type="button" aria-label="关闭对话导航" onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={16} strokeWidth={1.75} aria-hidden="true" /></button></header>
      <div ref={list} className="conversation-navigator-list" onKeyDown={(event) => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
        buttons[next]?.focus({ preventScroll: true });
        const target = buttons[next];
        if (target) event.currentTarget.scrollTop = Math.max(0, target.offsetTop - event.currentTarget.clientHeight / 2);
      }}>
        {questions.map((message, index) => {
          const preview = (message.content.trim() || (message.images?.length ? '图片消息' : message.quote ? `引用：${message.quote}` : '提问')).replace(/\s+/g, ' ');
          return <button key={message.id} type="button" aria-current={current === message.id ? 'location' : undefined}
            aria-label={`第 ${index + 1} 个提问：${preview}`} onClick={(event) => {
              const target = Array.from(containerRef.current?.querySelectorAll<HTMLElement>('[data-user-message-id]') ?? []).find((element) => element.dataset.userMessageId === message.id);
              if (target) { onNavigate(target); setCurrent(message.id); }
              if (event.detail > 0) { event.currentTarget.blur(); setOpen(false); }
            }}><span>{index + 1}</span><span>{preview.slice(0, 160)}</span></button>;
        })}
      </div>
    </div>}
  </nav>;
});
