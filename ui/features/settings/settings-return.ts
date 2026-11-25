import { isDesktopTarget } from '@/core/platform/target';
import { isWorkPath } from '@/features/work/work-href';
import type { Href } from '@/router';

import { conversationHref } from '@/features/chat/conversation-href';

/**
 * Settings is a full-page route, so the workspace page it was opened from has to be
 * remembered explicitly. The chat state's active conversation is not enough: a library
 * origin has no conversation, and returning from settings must not open a new chat.
 */
let lastWorkspacePath: string | null = null;

export function isSettingsPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  return path === '/settings' || path.startsWith('/settings/')
    || path === '/mock/chat/settings' || path.startsWith('/mock/chat/settings/');
}

/** Remember the last non-settings page; settings pages never overwrite the origin. */
export function rememberWorkspacePath(pathname: string): void {
  if (isSettingsPath(pathname)) return;
  lastWorkspacePath = pathname.replace(/\/+$/, '') || '/';
}

export function rememberedWorkspacePath(): string | null {
  return lastWorkspacePath;
}

/** Where the settings back link goes: the origin page, else the active conversation/home. */
export function workspaceReturnHref(activeId: string | null, preview: boolean, mobile = false): Href {
  if (lastWorkspacePath && isWorkPath(lastWorkspacePath) && (mobile || !isDesktopTarget())) {
    return conversationHref(activeId, preview);
  }
  return (lastWorkspacePath ?? conversationHref(activeId, preview)) as Href;
}

export function workspaceReturnLabel(_mobile = false): string {
  return '返回应用';
}

/** The tracker is process-wide; tests reset it between cases. */
export function resetWorkspaceReturnForTests(): void {
  lastWorkspacePath = null;
}
