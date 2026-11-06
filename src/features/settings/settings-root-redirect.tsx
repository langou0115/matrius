import { Redirect, type Href } from '@/router';

import { useSettingsRoot } from './settings-page';

export default function SettingsRootRedirect() {
  const href: Href = `${useSettingsRoot()}/appearance`;
  return <Redirect href={href} />;
}
