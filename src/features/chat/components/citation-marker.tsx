import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { hostname, type CitationSource } from '../citations';
import { SiteIcon } from './source-card';

const CARD_WIDTH = 340;
const CARD_GAP = 8;
const VIEWPORT_MARGIN = 12;
const CLOSE_DELAY_MS = 120;
// Layout effects run before paint in the browser; Node-side rendering falls back to an effect.
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

type Position = { left: number; top: number; width: number };

function canHover(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(hover: hover)').matches;
}

/**
 * A superscript citation marker. The number is the source's place in the answer, and the link goes
 * straight to the page. Hovering (or focusing) the marker on a device with a pointer shows a small
 * preview card with the site, title and search snippet; on touch devices the card is skipped and a
 * tap follows the link directly.
 */
export function CitationMarker({ source }: { source: CitationSource }) {
  const marker = useRef<HTMLElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const tooltipId = useId();
  const hasDetails = source.resolved && !!(source.url || source.title || source.snippet);

  const clearClose = useCallback(() => {
    if (!closeTimer.current) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const hide = useCallback(() => {
    clearClose();
    setOpen(false);
  }, [clearClose]);

  const scheduleHide = useCallback(() => {
    clearClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, CLOSE_DELAY_MS);
  }, [clearClose]);

  const show = useCallback(() => {
    if (!hasDetails || !canHover()) return;
    clearClose();
    setOpen(true);
  }, [clearClose, hasDetails]);

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  useBrowserLayoutEffect(() => {
    if (!open) {
      setPortalTarget(null);
      return;
    }
    // Portal into the themed shell, not <body>, so the card keeps the active palette's variables.
    setPortalTarget(marker.current?.closest('.matrius-app') ?? document.body);
  }, [open]);

  useBrowserLayoutEffect(() => {
    if (!open || !portalTarget) {
      setPosition(null);
      return;
    }
    const update = () => {
      const markerElement = marker.current;
      const cardElement = card.current;
      if (!markerElement || !cardElement) return;
      const rect = markerElement.getBoundingClientRect();
      const width = Math.min(CARD_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
      const height = cardElement.offsetHeight || 148;
      const left = Math.min(
        Math.max(rect.left + rect.width / 2 - width / 2, VIEWPORT_MARGIN),
        Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
      );
      const above = rect.top - CARD_GAP - height >= VIEWPORT_MARGIN;
      const top = above
        ? rect.top - CARD_GAP - height
        : Math.max(VIEWPORT_MARGIN, Math.min(rect.bottom + CARD_GAP, window.innerHeight - height - VIEWPORT_MARGIN));
      setPosition({ left, top, width });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, portalTarget, source.url, source.title, source.snippet]);

  const domain = source.domain || (source.url ? hostname(source.url) : '');
  const title = source.title && source.title !== domain ? source.title : '';
  const label = source.resolved && source.title ? `来源 ${source.number}：${source.title}` : `来源 ${source.number}`;
  const handlers = {
    onMouseEnter: () => show(),
    onMouseLeave: scheduleHide,
    onFocus: () => show(),
    onBlur: scheduleHide,
    onKeyDown: (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); },
    onClick: hide,
  };
  const setMarker = (element: HTMLElement | null) => { marker.current = element; };

  return <>
    <sup className="message-citation-wrap">
      {source.url
        ? <a ref={setMarker} className="message-citation" href={source.url}
          target="_blank" rel="noopener noreferrer" aria-label={label}
          aria-describedby={open ? tooltipId : undefined} {...handlers}>{source.number}</a>
        : <span ref={setMarker} className="message-citation is-static"
          tabIndex={0} role="note" aria-label={label}
          aria-describedby={open ? tooltipId : undefined} {...handlers}>{source.number}</span>}
    </sup>
    {open && hasDetails && portalTarget ? createPortal(
      <div ref={card} id={tooltipId} role="tooltip" className="citation-card"
        style={{
          left: position?.left ?? 0,
          top: position?.top ?? 0,
          width: position?.width ?? Math.min(CARD_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2),
          visibility: position ? 'visible' : 'hidden',
        }}
        onMouseEnter={clearClose} onMouseLeave={scheduleHide}>
        <span className="citation-card-site">
          <SiteIcon url={source.url} />
          <span>{domain || '来源'}</span>
        </span>
        {title ? <span className="citation-card-title">{title}</span> : null}
        {source.snippet ? <span className="citation-card-snippet">{source.snippet}</span> : null}
      </div>,
      portalTarget,
    ) : null}
  </>;
}
