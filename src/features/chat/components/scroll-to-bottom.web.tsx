import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import { Icon } from '@/components/web/icon';
import { flushScrollPositions, readScrollPosition, rememberScrollPosition } from '../scroll-position.web';

// Rounding leaves a pixel or two between scrollTop and the real end.
const BOTTOM_EPSILON = 2;
// The reader counts as "at the bottom" while the drift stays inside this share
// of the viewport, so following stops as soon as they scroll away deliberately.
const AT_BOTTOM_RATIO = 0.12;
// Showing the button at the same small distance made it pop up after a single
// notch of the wheel. It is only worth offering once the reader has scrolled a
// whole screen away from the newest message, so visibility gets its own,
// deliberately generous threshold.
const SHOW_ABOVE_RATIO = 1;
// Safety net for a smooth scroll that never reports a landing position.
const JUMP_TIMEOUT = 800;

type ChatAutoScrollOptions = {
  /** The element that scrolls the messages. */
  containerRef: RefObject<HTMLElement | null>;
  /** Changes when the scroller is remounted, such as after switching conversation. */
  containerKey: string;
  /** Changes whenever the conversation grows, streamed text included. */
  followKey: string;
  /** Conversation whose reading position is restored and remembered; omit for unsaved drafts. */
  scrollKey?: string | null;
};

function distanceFromBottom(element: HTMLElement) {
  return Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight);
}

function atBottomThreshold(element: HTMLElement) {
  return Math.max(BOTTOM_EPSILON, element.clientHeight * AT_BOTTOM_RATIO);
}

function showThreshold(element: HTMLElement) {
  return Math.max(BOTTOM_EPSILON, element.clientHeight * SHOW_ABOVE_RATIO);
}

/**
 * Keeps the newest message in view while the reader sits at the bottom, and
 * stops the moment they scroll back to read instead of yanking them down on the
 * next streamed token. Returns whether the "jump to latest" button should be
 * offered, and the callback that acts on it.
 */
export function useChatAutoScroll({ containerRef, containerKey, followKey, scrollKey }: ChatAutoScrollOptions) {
  const [visible, setVisible] = useState(false);
  const following = useRef(true);
  // Set while we move the scroller ourselves, so the scroll event it produces is
  // not mistaken for the reader taking over.
  const pinned = useRef(false);
  const jumping = useRef(false);
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set when the reader sends a message. The pin below runs after the new content
  // has been laid out, which is the only point where the end of the list is known,
  // and this flag asks it to animate there instead of holding the current position.
  const followRequested = useRef(false);

  const stopJump = useCallback(() => {
    jumping.current = false;
    if (jumpTimer.current === null) return;
    clearTimeout(jumpTimer.current);
    jumpTimer.current = null;
  }, []);

  // `preserve` keeps a follow decision that was made deliberately — by a wheel
  // gesture or by a pin — instead of re-deriving it from the current position.
  const sync = useCallback((preserve = false) => {
    const element = containerRef.current;
    if (!element) return;
    const distance = distanceFromBottom(element);
    if (!preserve) following.current = distance <= atBottomThreshold(element);
    setVisible(!jumping.current && distance > showThreshold(element));
  }, [containerRef]);

  const pin = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    const requested = followRequested.current;
    followRequested.current = false;
    if (!following.current && !requested) return;
    following.current = true;
    setVisible(false);
    // Already at the end: no scroll event will follow, so do not arm the flag
    // that marks the next scroll event as ours.
    if (distanceFromBottom(element) <= BOTTOM_EPSILON) return;
    // A requested jump is visible on purpose; let it run instead of snapping the
    // end of the list under the reader's eyes on the next streamed chunk.
    if (requested && !jumping.current) {
      jumping.current = true;
      jumpTimer.current = setTimeout(() => {
        jumpTimer.current = null;
        jumping.current = false;
        sync(true);
      }, JUMP_TIMEOUT);
      element.scrollTo({ behavior: 'smooth', top: element.scrollHeight });
      return;
    }
    if (jumping.current) return;
    pinned.current = true;
    element.scrollTop = element.scrollHeight;
  }, [containerRef, sync]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const key = scrollKey;
    stopJump();
    pinned.current = false;
    following.current = true;
    // Reopen where the reader stopped. "At the bottom" resolves against the current height,
    // so a reply that arrived while the conversation was closed stays visible.
    const saved = key ? readScrollPosition(key) : null;
    element.scrollTop = saved && !saved.atBottom
      ? Math.min(saved.top, Math.max(0, element.scrollHeight - element.clientHeight))
      : element.scrollHeight;
    sync();
    // The scroll listener records every move as it happens, so switching only has to make
    // sure the most recent position has reached storage. Reading the shared scroller here
    // would already see the next conversation's content and could overwrite the old offset.
    return flushScrollPositions;
  }, [containerKey, scrollKey, containerRef, stopJump, sync]);

  useEffect(() => { pin(); }, [followKey, pin]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    // A deliberate move toward older messages has to stop the follow before the
    // next streamed chunk can pull the viewport back down.
    const pause = () => {
      stopJump();
      pinned.current = false;
      following.current = false;
      sync(true);
    };

    const remember = () => {
      if (!scrollKey) return;
      // The element is shared by every conversation. Once React has swapped in another one,
      // a scroll event caused by the new content's height must not be filed under the old ID.
      if (element.dataset.conversationKey != null && element.dataset.conversationKey !== containerKey) return;
      rememberScrollPosition(scrollKey, {
        top: element.scrollTop,
        atBottom: distanceFromBottom(element) <= atBottomThreshold(element),
      });
    };
    const handleScroll = () => {
      remember();
      if (pinned.current) {
        // Our own pin landed on the end, so refresh the button but keep following.
        pinned.current = false;
        stopJump();
        sync(true);
        return;
      }
      if (jumping.current && distanceFromBottom(element) > BOTTOM_EPSILON) return;
      stopJump();
      sync();
    };
    const handleWheel = (event: globalThis.WheelEvent) => { if (event.deltaY < 0) pause(); };
    let lastTouchY: number | null = null;
    const handleTouchStart = (event: globalThis.TouchEvent) => { lastTouchY = event.touches[0]?.clientY ?? null; };
    const handleTouchMove = (event: globalThis.TouchEvent) => {
      const currentTouchY = event.touches[0]?.clientY;
      if (currentTouchY === undefined) return;
      // Dragging the finger down walks the viewport toward older messages.
      if (lastTouchY !== null && currentTouchY > lastTouchY) pause();
      lastTouchY = currentTouchY;
    };
    const handleTouchEnd = () => { lastTouchY = null; };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) pause();
    };

    element.addEventListener('scroll', handleScroll, { passive: true });
    element.addEventListener('wheel', handleWheel, { passive: true });
    element.addEventListener('touchstart', handleTouchStart, { passive: true });
    element.addEventListener('touchmove', handleTouchMove, { passive: true });
    element.addEventListener('touchend', handleTouchEnd, { passive: true });
    element.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    element.addEventListener('keydown', handleKeyDown);
    return () => {
      element.removeEventListener('scroll', handleScroll);
      element.removeEventListener('wheel', handleWheel);
      element.removeEventListener('touchstart', handleTouchStart);
      element.removeEventListener('touchmove', handleTouchMove);
      element.removeEventListener('touchend', handleTouchEnd);
      element.removeEventListener('touchcancel', handleTouchEnd);
      element.removeEventListener('keydown', handleKeyDown);
    };
  }, [containerKey, scrollKey, containerRef, stopJump, sync]);

  useEffect(() => stopJump, [stopJump]);

  const scrollToBottom = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    stopJump();
    pinned.current = false;
    following.current = true;
    jumping.current = true;
    setVisible(false);
    // The landing scroll event normally clears the jump; the timer covers a
    // smooth scroll the browser never finishes.
    jumpTimer.current = setTimeout(() => {
      jumpTimer.current = null;
      jumping.current = false;
      sync(true);
    }, JUMP_TIMEOUT);
    element.scrollTo({ behavior: 'smooth', top: element.scrollHeight });
  }, [containerRef, stopJump, sync]);

  /**
   * Asks the next content change to bring the newest message back into view, with
   * the same animation as the button. Called on send, where the new message is not
   * in the DOM yet; scrolling right away would only reach the previous end.
   */
  const followLatest = useCallback(() => {
    followRequested.current = true;
  }, []);

  const scrollToMessage = useCallback((target: HTMLElement) => {
    const element = containerRef.current;
    if (!element || !element.contains(target)) return;
    stopJump();
    following.current = false;
    pinned.current = false;
    const top = element.scrollTop + target.getBoundingClientRect().top - element.getBoundingClientRect().top - 76;
    element.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    sync(true);
  }, [containerRef, stopJump, sync]);

  return { scrollToBottom, scrollToMessage, followLatest, visible };
}

type ScrollToBottomButtonProps = {
  /** A reply is still streaming for this conversation. */
  generating: boolean;
  onScrollToBottom: () => void;
  visible: boolean;
};

export function ScrollToBottomButton({ generating, onScrollToBottom, visible }: ScrollToBottomButtonProps) {
  if (!visible) return null;
  return <div className="scroll-to-bottom-slot">
    <button
      type="button"
      className="scroll-to-bottom-button"
      aria-label={generating ? '回到最新消息，回复生成中' : '回到最新消息'}
      onClick={onScrollToBottom}
    >
      {generating ? <span className="scroll-to-bottom-spinner" aria-hidden="true" /> : <Icon name="expand" size={20} />}
    </button>
  </div>;
}
