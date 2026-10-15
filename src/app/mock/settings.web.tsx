import { Redirect } from 'expo-router';

import SettingsScreen from '@/features/settings/settings-screen.web';

export default function MockSettingsRoute() {
  return __DEV__ ? <SettingsScreen /> : <Redirect href="/" />;
}
