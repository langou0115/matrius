import { Slot, usePathname } from 'expo-router';
import { FontDisplay, useFonts } from 'expo-font';
import Head from 'expo-router/head';

import { AppFrame } from '@/components/web/app-frame';
import { Workspace } from '@/components/web/workspace';
import { LocalWorkspace } from '@/components/web/local-workspace';
import { BackgroundNotifications } from '@/features/chat/components/background-notifications.web';
import '@/global.css';
import { version as katexVersion } from 'katex';

export default function WebLayout() {
  const pathname = usePathname().replace(/\/$/, '');
  const preview = __DEV__ && (pathname === '/mock' || pathname.startsWith('/mock/'));
  const fullPage = pathname === '/settings' || pathname.startsWith('/settings/') || pathname === '/mock'
    || pathname === '/mock/chat/settings' || pathname.startsWith('/mock/chat/settings/');
  useFonts({
    Inter: { uri: require('@/assets/fonts/Inter-Regular.ttf'), display: FontDisplay.SWAP },
    InterMedium: { uri: require('@/assets/fonts/Inter-Medium.ttf'), display: FontDisplay.SWAP },
    InterSemiBold: { uri: require('@/assets/fonts/Inter-SemiBold.ttf'), display: FontDisplay.SWAP },
    NotoSansSC: { uri: require('@/assets/fonts/NotoSansSC-Regular.ttf'), display: FontDisplay.SWAP },
    NotoSansSCSemiBold: { uri: require('@/assets/fonts/NotoSansSC-SemiBold.ttf'), display: FontDisplay.SWAP },
    JetBrainsMono: { uri: require('@/assets/fonts/JetBrainsMono-Regular.ttf'), display: FontDisplay.SWAP },
  });
  return <>
    <Head><title>Matrius · 自由对话</title><meta name="description" content="一个安静、自由的 AI 对话空间。" /><link rel="stylesheet" href={`/vendor/katex/${katexVersion}/katex.min.css`} /></Head>
    <LocalWorkspace key={preview ? 'mock' : 'local'} preview={preview}><AppFrame>
      {fullPage ? <Slot /> : <Workspace><Slot /></Workspace>}
      {/* Inside the themed shell and above every route, including full-page settings. */}
      <BackgroundNotifications />
    </AppFrame></LocalWorkspace>
  </>;
}
