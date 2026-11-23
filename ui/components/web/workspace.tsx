import { Suspense, lazy, useCallback, useEffect, useState, type PropsWithChildren } from 'react';

import { isDesktopTarget } from '@/core/platform/target';
import { useChat } from '@/features/chat/chat-state';
import { useSidebarRouteTab, useSidebarTab } from '@/features/chat/sidebar-mode';
import { SearchDialog } from '@/features/chat/components/search-dialog';
import { Dialog } from './dialog';
import { useMobile } from './use-mobile';
import { Sidebar } from '@/features/chat/components/sidebar';

const WorkWorkspace = lazy(() =>
  import('@/features/work/work-workspace').then((module) => ({ default: module.WorkWorkspace })),
);

export function Workspace({ children }: PropsWithChildren) {
  const { sidebarOpen, dispatch } = useChat();
  const mobile = useMobile();
  const showModeSwitch = isDesktopTarget() && !mobile;
  const storedTab = useSidebarTab(showModeSwitch);
  const routeTab = useSidebarRouteTab();
  // When AppShell owns the router, WorkRoute renders through `children` (`<Outlet />`);
  // isolated component tests stub `@/router` without AppShell and rely on storedTab here.
  const showWorkPane = showModeSwitch && routeTab === undefined && storedTab === 'work';
  const closeSidebar = () => { if (sidebarOpen) dispatch({ type: 'sidebar' }); };
  const [sidebarVisible, setSidebarVisible] = useState(sidebarOpen);
  if (sidebarOpen && !sidebarVisible) setSidebarVisible(true);
  useEffect(() => {
    if (sidebarOpen) return;
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200;
    const timer = window.setTimeout(() => setSidebarVisible(false), delay);
    return () => window.clearTimeout(timer);
  }, [sidebarOpen]);
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
    {mobile ? (sidebarOpen || sidebarVisible) && <Dialog title="工作区导航" hideHeader className={`mobile-sidebar${sidebarOpen ? '' : ' is-closing'}`} onClose={closeSidebar}>
      <div onClick={(event) => {
        if ((event.target as HTMLElement).closest('a, .new-conversation, .conversation-select')) closeSidebar();
      }}><Sidebar onSearch={() => { closeSidebar(); openSearch(); }} collapsed={false} /></div>
    </Dialog> : <Sidebar onSearch={openSearch} collapsed={!sidebarOpen} />}
    <div className="workspace-content">
      {showWorkPane ? (
        <Suspense fallback={null}>
          <WorkWorkspace />
        </Suspense>
      ) : children}
    </div>
    {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} />}
  </div>;
}
