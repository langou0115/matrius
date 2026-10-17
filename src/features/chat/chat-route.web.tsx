import { router, useLocalSearchParams, usePathname } from 'expo-router';

import { Dialog } from '@/components/web/dialog';
import { useIsPreview } from '@/features/workspace/preview-context';
import ChatScreen from './chat-screen.web';
import { conversationHref } from './conversation-href';
import { useConversationRouteState } from './conversation-route-state';

export default function ChatRoute() {
  const { conversationId } = useLocalSearchParams<{ conversationId?: string }>();
  const pathname = usePathname();
  const preview = useIsPreview();
  const id = pathname.includes('/c/') && typeof conversationId === 'string' ? conversationId : null;
  const { exists, ready } = useConversationRouteState(id);

  if (!exists) return <Dialog title="对话不存在" className="compact-dialog" onClose={() => router.replace(conversationHref(null, preview))}>
    <p className="dialog-description" role="alert">当前浏览器中没有这段对话，可能已删除或保存在其他设备中。</p>
    <footer className="dialog-footer"><button type="button" className="secondary-button" onClick={() => router.replace(conversationHref(null, preview))}>返回新对话</button></footer>
  </Dialog>;
  if (!ready) return null;
  return <ChatScreen />;
}
