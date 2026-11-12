import { useSyncExternalStore } from 'react';

const mobile = '(max-width: 767px)';
/** The stylesheet's large-canvas breakpoint; below it a side column would squeeze the transcript. */
const wide = '(min-width: 1024px)';

function subscribeTo(query: string, notify: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
}

export function useMobile() {
  return useSyncExternalStore(
    (notify) => subscribeTo(mobile, notify),
    () => window.matchMedia(mobile).matches,
    () => false,
  );
}

/** True when there is room for a column beside the conversation, so panels open beside it. */
export function useWideViewport() {
  return useSyncExternalStore(
    (notify) => subscribeTo(wide, notify),
    () => window.matchMedia(wide).matches,
    () => false,
  );
}
