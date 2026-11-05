import { useEffect, useRef, useState } from 'react';

const SOURCE = '/brand/matrius-color.svg';

type Props = { size?: number; className?: string };

/**
 * The colour crown artwork shared by the sidebar, the empty-conversation header and the
 * about card. The detailed vector stays in `public/` so the same path data never has to
 * enter the JavaScript bundle; the favicon and PWA PNGs in `public/icons/` are rendered
 * from the same source.
 *
 * A failed image never retries on its own, so one request that raced a file write leaves
 * the mark blank for the rest of the session. Retry once, then fall back to an inline
 * crown: the sidebar and welcome page must never lose their identity to a missing asset.
 */
export function BrandMark({ size = 22, className = '' }: Props) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);

  const classes = className ? `brand-mark ${className}` : 'brand-mark';

  if (failed) {
    return <svg className={classes} width={size} height={size} viewBox="0 0 24 24"
      fill="none" aria-hidden="true">
      <path d="M3 17.5 5 8l4.5 4L12 5l2.5 7L19 8l2 9.5H3Z" fill="currentColor" opacity=".9" />
      <circle cx="12" cy="4" r="1.4" fill="currentColor" />
    </svg>;
  }

  return <img className={classes} width={size} height={size}
    src={attempt === 0 ? SOURCE : `${SOURCE}?retry=${attempt}`}
    alt="" aria-hidden="true" draggable={false}
    onError={() => {
      if (attempt === 0) timer.current = setTimeout(() => setAttempt(1), 400);
      else setFailed(true);
    }} />;
}
