import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useNativeTheme } from '@/theme/native-theme';

export function Dialog({ visible, title, description, onClose, children, footer }: {
  visible: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const theme = useNativeTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="关闭" onPress={onClose} />
        <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={[styles.card, { backgroundColor: theme.colors.card, borderColor: theme.colors.border, borderRadius: Math.min(theme.radius + 6, 22) }]}>
            <ScrollView bounces={false} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
              <Text style={[styles.title, { color: theme.colors.foreground }]}>{title}</Text>
              {description ? <Text style={[styles.description, { color: theme.colors.mutedForeground }]}>{description}</Text> : null}
              {children}
            </ScrollView>
            {footer ? <View style={[styles.footer, { borderTopColor: theme.colors.border }]}>{footer}</View> : null}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  keyboard: { width: '100%', alignItems: 'center', justifyContent: 'center' },
  card: { width: '100%', maxWidth: 420, maxHeight: '80%', borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  content: { padding: 20, gap: 12 },
  title: { fontSize: 17, fontWeight: '600' },
  description: { fontSize: 14, lineHeight: 21 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, padding: 14, borderTopWidth: StyleSheet.hairlineWidth },
});
