import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { IconName } from '@/components/native/icon';
import { useAuth } from '@/features/auth/auth-state';
import { useNativeTheme } from '@/theme/native-theme';
import { searchSettings, searchSettingsContent, visibleSettings } from '../settings-catalog';
import { Divider, Footnote, Section, SettingsPage } from './settings-shell';

const icons: Record<string, IconName> = {
  account: 'person-circle-outline',
  appearance: 'color-palette-outline',
  personalization: 'options-outline',
  models: 'hardware-chip-outline',
  labs: 'flask-outline',
  about: 'information-circle-outline',
};

function NavRow({ icon, title, description, onPress }: {
  icon: IconName;
  title: string;
  description: string;
  onPress: () => void;
}) {
  const theme = useNativeTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={onPress}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}>
      <View style={[styles.icon, { backgroundColor: theme.colors.muted, borderRadius: Math.min(theme.radius, 10) }]}>
        <Ionicons name={icon} size={19} color={theme.colors.foreground} />
      </View>
      <View style={styles.copy}>
        <Text style={[styles.title, { color: theme.colors.foreground }]}>{title}</Text>
        <Text style={[styles.description, { color: theme.colors.mutedForeground }]}>{description}</Text>
      </View>
      <Ionicons name="chevron-forward" size={17} color={theme.colors.mutedForeground} />
    </Pressable>
  );
}

export function SettingsListScreen() {
  const theme = useNativeTheme();
  const auth = useAuth();
  const [query, setQuery] = useState('');
  const items = visibleSettings(auth.user?.features ?? [], false, Boolean(auth.user));
  const groups = items.reduce<string[]>((list, item) => (list.includes(item.group) ? list : [...list, item.group]), []);
  const searching = query.trim().length > 0;
  // Search the same catalog as the web layout, but only reach rows this account can see.
  const categories = searching
    ? searchSettings(query).filter((item) => items.some((visible) => visible.id === item.id))
    : [];
  const targets = searching
    ? searchSettingsContent(query).filter((target) => items.some((item) => item.id === target.category))
    : [];
  const empty = searching && !categories.length && !targets.length;

  return (
    <SettingsPage title="设置">
      <View style={[styles.search, { backgroundColor: theme.colors.background, borderColor: theme.colors.input, borderRadius: Math.min(theme.radius, 12) }]}>
        <Ionicons name="search" size={16} color={theme.colors.mutedForeground} />
        <TextInput value={query} onChangeText={setQuery} placeholder="搜索设置" placeholderTextColor={theme.colors.mutedForeground}
          accessibilityLabel="搜索设置项" autoCapitalize="none" autoCorrect={false} clearButtonMode="while-editing"
          style={[styles.searchInput, { color: theme.colors.foreground }]} />
      </View>

      {searching ? (
        <>
          {categories.length ? (
            <Section title="设置分类">
              {categories.map((item, index) => (
                <View key={item.id}>
                  {index > 0 ? <Divider /> : null}
                  <NavRow icon={icons[item.id] ?? 'settings-outline'} title={item.title} description={item.description}
                    onPress={() => router.push(`/settings/${item.id}`)} />
                </View>
              ))}
            </Section>
          ) : null}
          {targets.length ? (
            <Section title="设置项">
              {targets.map((target, index) => (
                <View key={target.id}>
                  {index > 0 ? <Divider /> : null}
                  <NavRow icon={icons[target.category] ?? 'settings-outline'} title={target.title} description={target.description}
                    onPress={() => router.push(`/settings/${target.category}`)} />
                </View>
              ))}
            </Section>
          ) : null}
          {empty ? <Footnote>没有找到相关设置。</Footnote> : null}
        </>
      ) : (
        <>
          {groups.map((group) => (
            <Section key={group} title={group}>
              {items.filter((item) => item.group === group).map((item, index) => (
                <View key={item.id}>
                  {index > 0 ? <Divider /> : null}
                  <NavRow icon={icons[item.id] ?? 'settings-outline'} title={item.title} description={item.description}
                    onPress={() => router.push(`/settings/${item.id}`)} />
                </View>
              ))}
            </Section>
          ))}
          <Footnote>{auth.user
            ? '账号设置保存在云端，模型配置与 API key 保存在本机。'
            : '当前使用本地工作区，数据只保存在这台设备上。'}</Footnote>
        </>
      )}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, minHeight: 42 },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  icon: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  copy: { flex: 1, gap: 2 },
  title: { fontSize: 15, fontWeight: '500' },
  description: { fontSize: 12, lineHeight: 17 },
});
