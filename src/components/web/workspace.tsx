import { useCallback, useEffect, useState, type PropsWithChildren } from 'react';

import { useChat } from '@/features/chat/chat-state';
import { SearchDialog } from '@/features/chat/components/search-dialog';
import { Sidebar } from '@/features/chat/components/sidebar';

export function Workspace({ children }: PropsWithChildren) {
  const { sidebarOpen } = useChat();
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (document.querySelector('dialog[open]')) return;
        event.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  return <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
    <a className="skip-link" href="#main-content">跳到主要内容</a>
    {/* Keep the sidebar mounted so collapse and expand can animate; `inert` removes the
        hidden copy from focus order and pointer interaction. */}
    <Sidebar onSearch={openSearch} collapsed={!sidebarOpen} />
    <div className="workspace-content">{children}</div>
    {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} />}
  </div>;
}
