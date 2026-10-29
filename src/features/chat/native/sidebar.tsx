import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/features/auth/auth-state';
import { useNativeTheme } from '@/theme/native-theme';
import { useChat, type Conversation } from '../chat-state';
import { useChatRuntime } from '../chat-runtime';
import { ConversationMenu } from './conversation-menu';
import { SearchDialog } from './search-dialog';

export function Sidebar({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useNativeTheme();
  const { conversations, activeId, dispatch } = useChat();
  const runtime = useChatRuntime();
  const auth = useAuth();
  const [menuId, setMenuId] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  // A long press should open the menu without the release also navigating.
  const longPressedAt = useRef(0);
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  const groups = [
    { name: '置顶', items: sorted.filter((item) => item.pinned) },
    { name: '最近', items: sorted.filter((item) => !item.pinned) },
  ];
  const menuConversation = conversations.find((item) => item.id === menuId) ?? null;

  function open(id: string | null) {
    onClose();
    if (id) router.push(`/c/${encodeURIComponent(id)}`);
    else { dispatch({ type: 'select', id: null }); router.replace('/'); }
  }

  function deleteConversation(conversation: Conversation) {
    dispatch({ type: 'delete', id: conversation.id });
    if (activeId === conversation.id) router.replace('/');
  }

  return (
    <>
      <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
        <View style={styles.overlay}>
          <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="关闭侧栏" onPress={onClose} />
          <SafeAreaView edges={['top', 'bottom', 'left']} style={[styles.drawer, { backgroundColor: theme.colors.sidebar, borderRightColor: theme.colors.sidebarBorder }]}>
            <View style={styles.header}>
              <Text style={[styles.brand, { color: theme.colors.sidebarForeground }]}>Matrius</Text>
              <View style={styles.headerActions}>
                <Pressable accessibilityRole="button" accessibilityLabel="搜索对话" hitSlop={8} onPress={() => setSearching(true)} style={styles.iconButton}>
                  <Ionicons name="search-outline" size={20} color={theme.colors.sidebarForeground} />
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="收起侧栏" hitSlop={8} onPress={onClose} style={styles.iconButton}>
                  <Ionicons name="close-outline" size={22} color={theme.colors.sidebarForeground} />
                </Pressable>
              </View>
            </View>

            <Pressable accessibilityRole="button" onPress={() => open(null)}
              style={({ pressed }) => [styles.newChat, { backgroundColor: activeId === null ? theme.colors.sidebarAccent : 'transparent', borderRadius: Math.min(theme.radius, 10), opacity: pressed ? 0.65 : 1 }]}>
              <Ionicons name="create-outline" size={19} color={theme.colors.sidebarForeground} />
              <Text style={[styles.newChatLabel, { color: theme.colors.sidebarForeground }]}>新对话</Text>
            </Pressable>

            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {groups.map((group) => group.items.length ? (
                <View key={group.name} style={styles.group}>
                  <Text style={[styles.groupLabel, { color: theme.colors.mutedForeground }]}>{group.name}</Text>
                  {group.items.map((conversation) => {
                    const last = conversation.messages.at(-1);
                    const running = conversation.id !== activeId && runtime.isRunning(conversation.id);
                    const completed = conversation.id !== activeId && conversation.completedReadAt === null && last?.role === 'assistant' && last.status === 'complete';
                    const error = conversation.errorReadAt == null && last?.role === 'assistant' && last.status === 'error';
                    const active = activeId === conversation.id;
                    return (
                      <View key={conversation.id} style={[styles.row, { backgroundColor: active ? theme.colors.sidebarAccent : 'transparent', borderRadius: Math.min(theme.radius, 10) }]}>
                        <Pressable accessibilityRole="button" accessibilityLabel={conversation.title}
                          accessibilityHint="长按可置顶、重命名或删除"
                          onPress={() => { if (Date.now() - longPressedAt.current < 700) return; open(conversation.id); }}
                          onLongPress={() => { longPressedAt.current = Date.now(); setMenuId(conversation.id); }}
                          delayLongPress={450}
                          style={({ pressed }) => [styles.rowMain, { opacity: pressed ? 0.65 : 1 }]}>
                          <Text numberOfLines={1} style={[styles.rowTitle, { color: active ? theme.colors.sidebarAccentForeground : theme.colors.sidebarForeground }]}>{conversation.title}</Text>
                          {running || completed || error ? (
                            <View style={[styles.statusDot, { backgroundColor: error ? theme.colors.destructive : theme.colors.primary }]} />
                          ) : null}
                        </Pressable>
                        <Pressable accessibilityRole="button" accessibilityLabel={`对话操作：${conversation.title}`}
                          hitSlop={8} onPress={() => setMenuId(conversation.id)} style={styles.moreButton}>
                          <Ionicons name="ellipsis-horizontal" size={17} color={theme.colors.mutedForeground} />
                        </Pressable>
                      </View>
                    );
                  })}
                </View>
              ) : null)}
              {!conversations.length ? <Text style={[styles.empty, { color: theme.colors.mutedForeground }]}>还没有对话</Text> : null}
            </ScrollView>

            <Pressable accessibilityRole="button" accessibilityLabel="打开设置" onPress={() => { onClose(); router.push('/settings'); }}
              style={({ pressed }) => [styles.account, { borderTopColor: theme.colors.sidebarBorder, opacity: pressed ? 0.65 : 1 }]}>
              <View style={[styles.avatar, { backgroundColor: theme.colors.sidebarAccent }]}>
                {auth.user
                  ? <Text style={[styles.avatarLetter, { color: theme.colors.sidebarAccentForeground }]}>{auth.user.username.slice(0, 1).toUpperCase()}</Text>
                  : <Ionicons name="person-outline" size={18} color={theme.colors.sidebarForeground} />}
              </View>
              <View style={styles.accountCopy}>
                <Text numberOfLines={1} style={[styles.accountName, { color: theme.colors.sidebarForeground }]}>{auth.user ? auth.user.username : '未登录'}</Text>
                <Text numberOfLines={1} style={[styles.accountMeta, { color: theme.colors.mutedForeground }]}>{auth.user
                  ? auth.user.mustChangePassword ? '需要修改密码' : '已登录 · 设置'
                  : auth.status === 'checking' ? '正在验证登录…'
                    : auth.status === 'unavailable' ? '无法验证登录状态' : '在设置中登录或管理'}</Text>
              </View>
              <Ionicons name="settings-outline" size={19} color={theme.colors.mutedForeground} />
            </Pressable>
          </SafeAreaView>
        </View>
      </Modal>

      {menuConversation ? (
        <ConversationMenu
          conversation={menuConversation}
          visible
          onClose={() => setMenuId(null)}
          onPin={() => dispatch({ type: 'pin', id: menuConversation.id })}
          onRename={(title) => dispatch({ type: 'rename', id: menuConversation.id, title })}
          onDelete={() => deleteConversation(menuConversation)}
        />
      ) : null}
      {searching ? <SearchDialog onClose={() => setSearching(false)} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.42)' },
  drawer: { width: '86%', maxWidth: 360, height: '100%', borderRightWidth: StyleSheet.hairlineWidth },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  brand: { fontSize: 20, fontWeight: '700', letterSpacing: 0.2 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  iconButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  newChat: { flexDirection: 'row', alignItems: 'center', gap: 9, marginHorizontal: 10, paddingHorizontal: 12, minHeight: 44 },
  newChatLabel: { fontSize: 15, fontWeight: '500' },
  list: { flex: 1, marginTop: 8 },
  listContent: { paddingHorizontal: 10, paddingBottom: 16 },
  group: { marginBottom: 10, gap: 1 },
  groupLabel: { fontSize: 11, fontWeight: '600', paddingHorizontal: 10, paddingVertical: 6, textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowMain: { flex: 1, minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 10, paddingRight: 4 },
  rowTitle: { flex: 1, fontSize: 14.5 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  moreButton: { width: 34, height: 42, alignItems: 'center', justifyContent: 'center' },
  empty: { fontSize: 13, textAlign: 'center', paddingVertical: 28 },
  account: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth },
  avatar: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { fontSize: 15, fontWeight: '700' },
  accountCopy: { flex: 1, gap: 1 },
  accountName: { fontSize: 14, fontWeight: '600' },
  accountMeta: { fontSize: 11.5 },
});
