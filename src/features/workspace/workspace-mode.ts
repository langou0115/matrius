import type { AuthState } from '@/core/api/auth-session';

/** A production workspace has exactly one backend; there is no anonymous local fallback. */
export function workspaceScope(auth: AuthState, preview: boolean) {
  if (preview) return 'preview';
  if (auth.user && !auth.user.mustChangePassword) return 'instance';
  if (auth.status === 'checking' || auth.status === 'unavailable') return 'pending';
  return 'locked';
}
