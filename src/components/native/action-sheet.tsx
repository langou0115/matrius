import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useNativeTheme } from '@/theme/native-theme';

export type ActionSheetItem = { label: string; onPress: () => void; destructive?: boolean; disabled?: boolean };

export function ActionSheet({ visible, title, items, onClose }: {
  visible: boolean;
  title?: string;
  items: ActionSheetItem[];
  onClose: () => void;
}) {
  const theme = useNativeTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="关闭" onPress={onClose} />
        <SafeAreaView edges={['bottom']} style={[styles.sheet, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
          {title ? <Text numberOfLines={2} style={[styles.title, { color: theme.colors.mutedForeground }]}>{title}</Text> : null}
          {items.map((item, index) => (
            <Pressable
              key={`${item.label}-${index}`}
              accessibilityRole="button"
              disabled={item.disabled}
              onPress={() => { onClose(); item.onPress(); }}
              style={({ pressed }) => [styles.item, { borderTopColor: theme.colors.border, opacity: item.disabled ? 0.4 : pressed ? 0.6 : 1 }]}
            >
              <Text style={[styles.label, { color: item.destructive ? theme.colors.destructive : theme.colors.foreground }]}>{item.label}</Text>
            </Pressable>
          ))}
          <Pressable accessibilityRole="button" onPress={onClose} style={({ pressed }) => [styles.item, styles.cancel, { borderTopColor: theme.colors.border, opacity: pressed ? 0.6 : 1 }]}>
            <Text style={[styles.label, styles.cancelLabel, { color: theme.colors.foreground }]}>取消</Text>
          </Pressable>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8 },
  title: { fontSize: 12, textAlign: 'center', paddingVertical: 10, paddingHorizontal: 20 },
  item: { minHeight: 52, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, borderTopWidth: StyleSheet.hairlineWidth },
  label: { fontSize: 16 },
  cancel: { marginTop: 6 },
  cancelLabel: { fontWeight: '600' },
});
