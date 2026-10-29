import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Dialog } from '@/components/native/dialog';
import { useNativeTheme } from '@/theme/native-theme';
import { useChat } from '../chat-state';

export function SearchDialog({ onClose }: { onClose: () => void }) {
  const theme = useNativeTheme();
  const { conversations } = useChat();
  const [query, setQuery] = useState('');
  const results = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [...conversations].sort((a, b) => b.updatedAt - a.updatedAt).flatMap((conversation) => {
      const message = needle ? conversation.messages.find((item) => item.content.toLocaleLowerCase().includes(needle)) : undefined;
      if (needle && !conversation.title.toLocaleLowerCase().includes(needle) && !message) return [];
      const content = message?.content;
      const start = content ? Math.max(0, content.toLocaleLowerCase().indexOf(needle) - 24) : 0;
      return [{ ...conversation, snippet: content ? `${start > 0 ? '…' : ''}${content.slice(start, start + 100)}` : null }];
    }).slice(0, 50);
  }, [conversations, query]);

  function open(id: string) {
    onClose();
    router.push(`/c/${encodeURIComponent(id)}`);
  }

  return (
    <Dialog visible title="搜索对话" onClose={onClose}>
      <View style={[styles.field, { backgroundColor: theme.colors.muted, borderRadius: Math.min(theme.radius, 10) }]}>
        <Ionicons name="search" size={17} color={theme.colors.mutedForeground} />
        <TextInput autoFocus value={query} onChangeText={setQuery} accessibilityLabel="搜索标题和消息内容"
          placeholder="搜索标题或消息内容…" placeholderTextColor={theme.colors.mutedForeground}
          returnKeyType="search" onSubmitEditing={() => { if (results[0]) open(results[0].id); }}
          style={[styles.input, { color: theme.colors.foreground }]} />
      </View>
      <ScrollView style={styles.results} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
        {results.length ? results.map((item) => (
          <Pressable key={item.id} accessibilityRole="button" onPress={() => open(item.id)}
            style={({ pressed }) => [styles.result, { borderBottomColor: theme.colors.border, opacity: pressed ? 0.6 : 1 }]}>
            <Ionicons name="chatbubble-outline" size={18} color={theme.colors.mutedForeground} />
            <View style={styles.resultCopy}>
              <Text numberOfLines={1} style={[styles.resultTitle, { color: theme.colors.foreground }]}>{item.title}</Text>
              {item.snippet ? <Text numberOfLines={2} style={[styles.resultSnippet, { color: theme.colors.mutedForeground }]}>{item.snippet}</Text> : null}
            </View>
          </Pressable>
        )) : (
          <View style={styles.empty}>
            <Ionicons name="search-outline" size={28} color={theme.colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: theme.colors.foreground }]}>{query.trim() ? '没有找到相关对话' : '还没有可搜索的对话'}</Text>
            <Text style={[styles.emptyText, { color: theme.colors.mutedForeground }]}>{query.trim() ? '试试其他关键词，标题和消息内容都可以搜索。' : '开始对话后，可以在这里快速找回。'}</Text>
          </View>
        )}
      </ScrollView>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  field: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10 },
  input: { flex: 1, fontSize: 15, paddingVertical: 10 },
  results: { maxHeight: 380 },
  result: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  resultCopy: { flex: 1, gap: 2 },
  resultTitle: { fontSize: 14.5, fontWeight: '600' },
  resultSnippet: { fontSize: 12.5, lineHeight: 18 },
  empty: { alignItems: 'center', gap: 6, paddingVertical: 32, paddingHorizontal: 12 },
  emptyTitle: { fontSize: 15, fontWeight: '600' },
  emptyText: { fontSize: 12.5, lineHeight: 18, textAlign: 'center' },
});
