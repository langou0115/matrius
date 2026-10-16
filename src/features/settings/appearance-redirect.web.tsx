import { Redirect, type Href } from 'expo-router';
import { useSettingsRoot } from './settings-page.web';

export default function AppearanceRedirect() {
  const href: Href = `${useSettingsRoot()}/appearance`;
  return <Redirect href={href} />;
}
