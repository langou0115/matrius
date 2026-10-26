import type { AuthState } from '@/core/api/auth-session';

export function workspaceScope(auth: AuthState, preview: boolean) {
  if (preview) return 'preview';
  if (auth.user && !auth.user.mustChangePassword) return `cloud:${auth.user.id}`;
  if (auth.status === 'checking' || auth.status === 'unavailable') return 'pending';
  return 'local';
}
