import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useNativeTheme } from '@/theme/native-theme';
import { Icon, type IconName } from './icon';

export function Header({ title, subtitle, onBack, right }: {
  title?: string;
  subtitle?: string;
  /** Pass `null` to hide the back affordance, or an action to override it. */
  onBack?: (() => void) | null;
  right?: ReactNode;
}) {
  const theme = useNativeTheme();
  const back = onBack === null ? null : onBack ?? (() => { if (router.canGoBack()) router.back(); else router.replace('/'); });
  return (
    <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
      <View style={styles.side}>
        {back && (
          <Pressable accessibilityRole="button" accessibilityLabel="返回" hitSlop={12} onPress={back} style={styles.iconButton}>
            <Icon name="chevron-back" size={24} color={theme.colors.foreground} />
          </Pressable>
        )}
      </View>
      <View style={styles.center}>
        <Text numberOfLines={1} style={[styles.title, { color: theme.colors.foreground }]}>{title ?? ''}</Text>
        {subtitle ? <Text numberOfLines={1} style={[styles.subtitle, { color: theme.colors.mutedForeground }]}>{subtitle}</Text> : null}
      </View>
      <View style={[styles.side, styles.right]}>{right}</View>
    </View>
  );
}

export function HeaderButton({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const theme = useNativeTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} hitSlop={10} onPress={onPress} style={styles.iconButton}>
      <Icon name={icon} color={theme.colors.foreground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { minHeight: 54, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 6 },
  side: { width: 48, flexDirection: 'row', alignItems: 'center' },
  right: { justifyContent: 'flex-end' },
  center: { flex: 1, alignItems: 'center' },
  title: { fontSize: 16, fontWeight: '600', maxWidth: '100%' },
  subtitle: { fontSize: 11, marginTop: 1 },
  iconButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
});
