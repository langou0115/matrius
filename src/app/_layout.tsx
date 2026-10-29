// Must run before any provider SDK module is evaluated by the route tree.
import '@/core/platform/install-fetch';
// Keep this side-effect import first; the named import below reuses the same module.
// eslint-disable-next-line import/no-duplicates
import 'react-native-gesture-handler';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
// eslint-disable-next-line import/no-duplicates
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider } from '@/features/auth/auth-state';
import { NativeWorkspace } from '@/features/workspace/native-workspace';
import { useNativeTheme } from '@/theme/native-theme';

function ThemedStatusBar() {
  const theme = useNativeTheme();
  return <StatusBar style={theme.mode === 'dark' ? 'light' : 'dark'} />;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <NativeWorkspace>
            <ThemedStatusBar />
            <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right' }} />
          </NativeWorkspace>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
