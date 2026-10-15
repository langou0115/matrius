import { Redirect } from 'expo-router';

import MockDirectory from '@/features/workspace/mock-directory.web';

export default function MockIndexRoute() {
  return __DEV__ ? <MockDirectory /> : <Redirect href="/" />;
}
