import { Redirect, type Href } from '@/router';
import { useSettingsRoot } from './settings-page';

export default function AppearanceRedirect() {
  const href: Href = `${useSettingsRoot()}/appearance`;
  return <Redirect href={href} />;
}
