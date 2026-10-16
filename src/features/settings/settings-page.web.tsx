import { Link, router, usePathname, type Href } from 'expo-router';
import type { PropsWithChildren } from 'react';

import { Icon } from '@/components/web/icon';
import { LinkAnchor } from '@/components/web/link-anchor';
import { useIsPreview } from '@/features/workspace/preview-context';

export function useSettingsRoot() {
  return useIsPreview() ? '/mock/chat/settings' : '/settings';
}

export function SettingsPage({ title, description, index = false, children }: PropsWithChildren<{ title: string; description: string; index?: boolean }>) {
  const preview = useIsPreview();
  const root = useSettingsRoot();
  const pathname = usePathname();
  const homeHref: Href = preview ? '/mock/chat' : '/';
  const parentHref = (index ? homeHref : pathname.slice(0, pathname.lastIndexOf('/')) || root) as Href;
  return <main className="settings-main" id="main-content" tabIndex={-1}>
      <header className="settings-topbar">
        <nav className="settings-navigation" aria-label="设置导航">
          <button type="button" className="icon-button" aria-label="返回上一页" onClick={() => { if (router.canGoBack()) router.back(); else router.replace(parentHref); }}><Icon name="back" size={20} /></button>
          <Link href={homeHref} replace asChild><LinkAnchor className="icon-button" aria-label="返回主界面"><Icon name="home" size={20} /></LinkAnchor></Link>
        </nav>
      </header>
      <div className="settings-scroll"><div className="settings-content">
        <div className="settings-heading"><h1>{title}</h1><p>{description}</p></div>
        {children}
      </div></div>
  </main>;
}
