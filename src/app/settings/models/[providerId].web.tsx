import { Redirect } from 'expo-router';

/** Providers are expanded in the web single-page settings, so deep links land there. */
export default function ProviderSettingsRedirect() {
  return <Redirect href="/settings/models" />;
}
