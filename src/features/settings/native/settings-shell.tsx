import type { PropsWithChildren, ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Header } from '@/components/native/header';
import { Screen } from '@/components/native/screen';
import { useNativeTheme } from '@/theme/native-theme';

/** One native stack page: a title bar and a single scrolling column. */
export function SettingsPage({ title, subtitle, children, right }: PropsWithChildren<{
  title: string;
  subtitle?: string;
  right?: ReactNode;
}>) {
  return (
    <Screen>
      <Header title={title} subtitle={subtitle} right={right} />
      <KeyboardAvoidingView style={styles.scroll} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag">
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

export function Section({ title, description, children }: PropsWithChildren<{ title?: string; description?: string }>) {
  const theme = useNativeTheme();
  return (
    <View style={styles.section}>
      {title ? <Text style={[styles.sectionTitle, { color: theme.colors.mutedForeground }]}>{title}</Text> : null}
      {description ? <Text style={[styles.sectionDescription, { color: theme.colors.mutedForeground }]}>{description}</Text> : null}
      <View style={[styles.sectionBody, { borderColor: theme.colors.border, backgroundColor: theme.colors.card, borderRadius: Math.min(theme.radius + 2, 14) }]}>
        {children}
      </View>
    </View>
  );
}

export function Card({ children, style }: PropsWithChildren<{ style?: object }>) {
  const theme = useNativeTheme();
  return <View style={[styles.card, { borderColor: theme.colors.border, backgroundColor: theme.colors.card, borderRadius: Math.min(theme.radius + 2, 14) }, style]}>{children}</View>;
}

export function Divider() {
  const theme = useNativeTheme();
  return <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />;
}

export function Footnote({ children, error }: PropsWithChildren<{ error?: boolean }>) {
  const theme = useNativeTheme();
  return <Text style={[styles.footnote, { color: error ? theme.colors.destructive : theme.colors.mutedForeground }]}>{children}</Text>;
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 36, gap: 18 },
  section: { gap: 8 },
  sectionTitle: { fontSize: 12, fontWeight: '600', paddingHorizontal: 4, textTransform: 'uppercase' },
  sectionDescription: { fontSize: 12.5, lineHeight: 18, paddingHorizontal: 4 },
  sectionBody: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  card: { borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 8 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 14 },
  footnote: { fontSize: 12.5, lineHeight: 18, paddingHorizontal: 4 },
});
