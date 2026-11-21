import { useMobile } from '@/components/web/use-mobile';
import { Redirect, type Href } from '@/router';

import { SettingsPage, useSettingsRoot } from './settings-page';

export default function SettingsRootRedirect() {
  const href: Href = `${useSettingsRoot()}/appearance`;
  const mobile = useMobile();
  return mobile ? <SettingsPage title="设置" /> : <Redirect href={href} />;
}
