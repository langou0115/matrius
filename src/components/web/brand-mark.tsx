import { useEffect, useRef, useState } from 'react';

const SOURCE = '/brand/matrius-sailboat.png';

type Props = { size?: number; className?: string };

/**
 * The sailboat artwork shared by the sidebar, empty-conversation header and about card.
 * The original PNG stays in `public/`; favicon and PWA icons use the same artwork.
 *
 * A failed image never retries on its own, so one request that raced a file write leaves
 * the mark blank for the rest of the session. Retry once, then fall back to an inline
 * sailboat: the sidebar and welcome page must never lose their identity to a missing asset.
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
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v13H4l8-13Zm3 2 6 11h-6V5ZM2 19h20l-3 3H5l-3-3Z" />
      </g>
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
