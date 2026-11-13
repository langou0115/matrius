import type { InstanceState } from '@/core/api/instance-client';

export function workspaceScope(instance: InstanceState, preview: boolean) {
  if (preview) return 'preview';
  return instance.status === 'ready' ? 'instance' : 'pending';
}
