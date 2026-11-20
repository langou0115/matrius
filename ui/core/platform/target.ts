export type AppTarget = 'web' | 'desktop';

/**
 * Desktop-only capabilities (such as the "工作" sidebar tab) stay hidden on Web
 * builds and default `npm run dev` / `npm run dev:web` sessions.
 */
export function isDesktopTarget(): boolean {
  return import.meta.env.VITE_MATRIUS_TARGET === 'desktop';
}
