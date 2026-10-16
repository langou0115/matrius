import { Link, type Href } from 'expo-router';
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
  const backHref: Href = index ? (preview ? '/mock/chat' : '/') : root;
  return <main className="settings-main" id="main-content" tabIndex={-1}>
    <header className="chat-topbar">
      <Link href={backHref} asChild><LinkAnchor className="settings-back"><Icon name="back" size={18} />{index ? '返回对话' : '返回设置'}</LinkAnchor></Link>
    </header>
    <div className="settings-scroll"><div className="settings-content">
      <div className="settings-heading"><h1>{title}</h1><p>{description}</p></div>
      {children}
    </div></div>
  </main>;
}
