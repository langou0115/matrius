import { ActivityIndicator, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

import { useNativeTheme } from '@/theme/native-theme';

export function Button({ label, onPress, variant = 'secondary', disabled, loading, style }: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'destructive' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useNativeTheme();
  const background = variant === 'primary' ? theme.colors.primary
    : variant === 'destructive' ? theme.colors.destructive
      : variant === 'ghost' ? 'transparent' : theme.colors.secondary;
  const foreground = variant === 'primary' ? theme.colors.primaryForeground
    : variant === 'destructive' ? theme.colors.destructiveForeground
      : variant === 'ghost' ? theme.colors.foreground : theme.colors.secondaryForeground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button, { backgroundColor: background, borderRadius: Math.min(theme.radius, 14), opacity: disabled ? 0.45 : pressed ? 0.75 : 1 },
        variant === 'ghost' && styles.ghost, style,
      ]}
    >
      {loading ? <ActivityIndicator color={foreground} /> : <Text style={[styles.label, { color: foreground }]}>{label}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: 44, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  ghost: { paddingHorizontal: 8 },
  label: { fontSize: 15, fontWeight: '600' },
});
