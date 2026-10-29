import { Redirect } from 'expo-router';

/** Models are edited inside the provider card on the web settings page. */
export default function ModelSettingsRedirect() {
  return <Redirect href="/settings/models" />;
}
