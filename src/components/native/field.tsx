import type { ComponentProps } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { useNativeTheme } from '@/theme/native-theme';

export function Field({ label, hint, error, multiline, style, ...props }: ComponentProps<typeof TextInput> & {
  label?: string;
  hint?: string;
  error?: string | null;
}) {
  const theme = useNativeTheme();
  return (
    <View style={styles.field}>
      {label ? <Text style={[styles.label, { color: theme.colors.foreground }]}>{label}</Text> : null}
      <TextInput
        {...props}
        multiline={multiline}
        placeholderTextColor={theme.colors.mutedForeground}
        style={[
          styles.input,
          {
            color: theme.colors.foreground,
            backgroundColor: theme.colors.background,
            borderColor: error ? theme.colors.destructive : theme.colors.input,
            borderRadius: Math.min(theme.radius, 12),
          },
          multiline && styles.multiline,
          style,
        ]}
      />
      {error ? <Text style={[styles.hint, { color: theme.colors.destructive }]}>{error}</Text>
        : hint ? <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  label: { fontSize: 13, fontWeight: '600' },
  input: { borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 11, fontSize: 15 },
  multiline: { minHeight: 120, textAlignVertical: 'top', paddingTop: 11 },
  hint: { fontSize: 12, lineHeight: 17 },
});
