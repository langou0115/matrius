import { useLocalSearchParams } from 'expo-router';

import { ModelScreen } from '@/features/models/native/model-screen';

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export default function ModelSettingsScreen() {
  const { providerId, modelId } = useLocalSearchParams<{ providerId: string | string[]; modelId: string | string[] }>();
  return <ModelScreen providerId={first(providerId)} modelId={first(modelId)} />;
}
