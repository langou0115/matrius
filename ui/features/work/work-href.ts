import type { Href } from '@/router';

export type SidebarMode = 'work' | 'chat';

export function workHref(projectId: string | null, preview = false): Href {
  const root = preview ? '/mock/chat' : '';
  return (projectId ? `${root}/p/${encodeURIComponent(projectId)}` : `${root}/work`) as Href;
}

/** `/p/<id>` (or `/mock/chat/p/<id>` in preview) from a pathname; null for every other page. */
export function workProjectIdIn(pathname: string | null | undefined, preview = false): string | null {
  const root = preview ? '/mock/chat' : '';
  const match = pathname ? new RegExp(`^${root}/p/([^/]+)/?$`).exec(pathname) : null;
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function isWorkPath(pathname: string | null | undefined): boolean {
  const normalized = (pathname ?? '').replace(/\/+$/, '') || '/';
  return normalized === '/work'
    || normalized === '/p'
    || normalized.startsWith('/p/')
    || normalized === '/mock/chat/work'
    || normalized === '/mock/chat/p'
    || normalized.startsWith('/mock/chat/p/');
}

function isNeutralRoutePath(pathname: string): boolean {
  return pathname === '/settings'
    || pathname.startsWith('/settings/')
    || pathname === '/mock/chat/settings'
    || pathname.startsWith('/mock/chat/settings/')
    || pathname === '/debug'
    || pathname.startsWith('/debug/')
    || pathname === '/mock/process'
    || pathname.startsWith('/mock/process/')
    || pathname === '/mock/storage'
    || pathname.startsWith('/mock/storage/')
    || pathname === '/mock/intelligent-ui'
    || pathname.startsWith('/mock/intelligent-ui/');
}

/** Determine the sidebar mode owned by a route pathname, or null for standalone full-page routes. */
export function sidebarTabForPathname(pathname: string | null | undefined): SidebarMode | null {
  const normalized = (pathname ?? '').replace(/\/+$/, '') || '/';
  if (isWorkPath(normalized)) return 'work';
  if (isNeutralRoutePath(normalized)) return null;
  return 'chat';
}
