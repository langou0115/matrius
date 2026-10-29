import { Redirect } from 'expo-router';

import LibraryScreen from '@/features/files/library-screen.web';

export default function MockLibraryRoute() {
  return __DEV__ ? <LibraryScreen /> : <Redirect href="/" />;
}
