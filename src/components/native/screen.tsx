import type { PropsWithChildren } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useNativeTheme } from '@/theme/native-theme';

export function Screen({ children, edges = ['top', 'bottom'], style }: PropsWithChildren<{
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
  style?: StyleProp<ViewStyle>;
}>) {
  const theme = useNativeTheme();
  return (
    <SafeAreaView edges={edges} style={[styles.screen, { backgroundColor: theme.colors.background }, style]}>
      {children}
    </SafeAreaView>
  );
}

/** Content container used by list/form pages. */
export function Page({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  return <View style={[styles.page, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  page: { flex: 1, paddingHorizontal: 18 },
});
