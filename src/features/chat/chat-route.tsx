import { useEffect } from 'react';
import { router } from '@/router';

import { Dialog } from '@/components/web/dialog';
import { useIsPreview } from '@/features/workspace/preview-context';
import ChatScreen from './chat-screen';
import { conversationHref } from './conversation-href';
import { useConversationRouteState } from './conversation-route-state';
import { writeLastRoute } from './last-conversation';
import { useLocationPathname } from './location-pathname';

/** `/c/<id>` (or `/mock/chat/c/<id>` in preview) from a pathname; null for every other page. */
function conversationIdIn(pathname: string | null | undefined, preview: boolean): string | null {
  const root = preview ? '/mock/chat' : '';
  const match = pathname ? new RegExp(`^${root}/c/([^/]+)/?$`).exec(pathname) : null;
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export default function ChatRoute() {
  // Navigations whose router state has not settled yet must not be mistaken for the root;
  // the address bar is what the user navigated to.
  const pathname = useLocationPathname();
  const preview = useIsPreview();
  const id = conversationIdIn(pathname, preview);
  const { exists, ready } = useConversationRouteState(id);
  // Mirror the page synchronously in localStorage. The workspace itself is saved through
  // IndexedDB, which lags behind a fast tab switch and refuses writes from a stale tab,
  // so local mode could otherwise forget the conversation before it ever reached disk.
  useEffect(() => {
    // The root route itself means nothing here: it may be the page a resume is about to
    // leave. Only an actual conversation page updates the mirror. Wait for the history
    // update: the router can mount this route for `/c/<id>` a tick before navigating to
    // `/`, and that stale mount must not undo the "new conversation" choice.
    if (preview || !id) return;
    const target = exists ? id : null;
    const timer = setTimeout(() => {
      if (conversationIdIn(globalThis.location?.pathname, preview) === id) writeLastRoute(target);
    }, 100);
    return () => clearTimeout(timer);
  }, [id, exists, preview]);

  if (!exists) return <Dialog title="对话不存在" className="compact-dialog" onClose={() => router.replace(conversationHref(null, preview))}>
    <p className="dialog-description" role="alert">当前浏览器中没有这段对话，可能已删除或保存在其他设备中。</p>
    <footer className="dialog-footer"><button type="button" className="secondary-button" onClick={() => router.replace(conversationHref(null, preview))}>返回新对话</button></footer>
  </Dialog>;
  if (!ready) return null;
  return <ChatScreen />;
}
