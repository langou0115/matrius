import { useLocalSearchParams } from 'expo-router';

import { ProviderScreen } from '@/features/models/native/provider-screen';

export default function ProviderSettingsScreen() {
  const { providerId } = useLocalSearchParams<{ providerId: string | string[] }>();
  return <ProviderScreen providerId={Array.isArray(providerId) ? providerId[0] ?? '' : providerId ?? ''} />;
}
