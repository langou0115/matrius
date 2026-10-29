import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppearance } from '@/theme/appearance';
import { oklchToHex } from '@/theme/color';
import { useNativeTheme } from '@/theme/native-theme';
import { themePresets } from '@/theme/presets';
import { resolveTheme } from '@/theme/resolve-theme';
import { displayModes } from '../settings-catalog';
import { Card, Section, SettingsPage } from './settings-shell';

const modeIcons = { light: 'sunny-outline', dark: 'moon-outline', system: 'phone-portrait-outline' } as const;

export function AppearanceScreen() {
  const { mode, setMode, themeId, setThemeId } = useAppearance();
  const current = useNativeTheme();
  const resolved = current.mode;

  return (
    <SettingsPage title="外观" subtitle="调整显示模式与配色主题。">
      <Section title="显示模式">
        <View style={styles.modes}>
          {displayModes.map((item) => {
            const active = mode === item.id;
            return (
              <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: active }} onPress={() => setMode(item.id)}
                style={({ pressed }) => [styles.mode, {
                  backgroundColor: active ? current.colors.primary : current.colors.muted,
                  borderRadius: Math.min(current.radius, 10), opacity: pressed ? 0.7 : 1,
                }]}>
                <Ionicons name={modeIcons[item.id]} size={17} color={active ? current.colors.primaryForeground : current.colors.foreground} />
                <Text style={[styles.modeLabel, { color: active ? current.colors.primaryForeground : current.colors.foreground }]}>{item.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </Section>

      <Section title="配色主题">
        <View style={styles.grid}>
          {themePresets.map((preset) => {
            const colors = resolveTheme(preset, resolved);
            const active = themeId === preset.id;
            const background = oklchToHex(colors.background);
            const sidebar = oklchToHex(colors.sidebar);
            const primary = oklchToHex(colors.primary);
            const muted = oklchToHex(colors.muted);
            const foreground = oklchToHex(colors.foreground);
            return (
              <Pressable key={preset.id} accessibilityRole="button" accessibilityState={{ selected: active }} onPress={() => setThemeId(preset.id)}
                style={({ pressed }) => [styles.themeCard, {
                  borderColor: active ? current.colors.primary : current.colors.border,
                  backgroundColor: current.colors.card,
                  borderRadius: Math.min(current.radius + 2, 14), opacity: pressed ? 0.75 : 1,
                }]}>
                <View style={[styles.preview, { backgroundColor: background, borderRadius: Math.min(current.radius, 9) }]}>
                  <View style={[styles.previewSidebar, { backgroundColor: sidebar }]}>
                    <View style={[styles.previewLine, { backgroundColor: foreground, opacity: 0.3 }]} />
                    <View style={[styles.previewLine, { backgroundColor: foreground, opacity: 0.2 }]} />
                    <View style={[styles.previewLine, { backgroundColor: foreground, opacity: 0.2 }]} />
                  </View>
                  <View style={styles.previewContent}>
                    <View style={[styles.previewPill, { backgroundColor: primary }]} />
                    <View style={[styles.previewLine, { backgroundColor: foreground, opacity: 0.3 }]} />
                    <View style={[styles.previewLine, { backgroundColor: muted }]} />
                  </View>
                </View>
                <View style={styles.themeLabelRow}>
                  <Text numberOfLines={1} style={[styles.themeLabel, { color: current.colors.foreground }]}>{preset.name}</Text>
                  {active ? <Ionicons name="checkmark-circle" size={16} color={current.colors.primary} /> : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      </Section>

      <Card>
        <Text style={[styles.hint, { color: current.colors.mutedForeground }]}>配色会随深色模式自动切换；选择“跟随系统”时由设备的显示设置决定。</Text>
      </Card>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  modes: { flexDirection: 'row', gap: 6, padding: 10 },
  mode: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 10 },
  modeLabel: { fontSize: 12.5, fontWeight: '500' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, padding: 10 },
  themeCard: { width: '47.5%', borderWidth: 1.5, padding: 8, gap: 7 },
  preview: { flexDirection: 'row', height: 62, overflow: 'hidden' },
  previewSidebar: { width: '30%', padding: 6, gap: 4 },
  previewContent: { flex: 1, padding: 8, gap: 5 },
  previewLine: { height: 4, borderRadius: 2 },
  previewPill: { width: '55%', height: 8, borderRadius: 4 },
  themeLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  themeLabel: { flex: 1, fontSize: 12.5, fontWeight: '500' },
  hint: { fontSize: 12.5, lineHeight: 18 },
});
