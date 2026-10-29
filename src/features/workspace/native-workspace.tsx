import { useCallback, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from 'react-native';

import { LocalDataConflict, writeWorkspace } from '@/core/database/local-store';
import { ChatProvider, useChat } from '@/features/chat/chat-state';
import { ChatRuntimeProvider } from '@/features/chat/chat-runtime';
import { DraftProvider } from '@/features/chat/draft-state';
import { useAuth } from '@/features/auth/auth-state';
import { NetworkToolsProvider } from '@/features/auth/network-tools-state';
import { ModelProvider } from '@/features/models/model-state';
import { PersonalizationProvider, usePersonalization } from '@/features/settings/personalization-state';
import { AppearanceProvider, useAppearance } from '@/theme/appearance';
import { createCloudWorkspaceRepository } from './cloud-workspace-repository';
import { loadWorkspace } from './workspace-repository';
import { stripMessageImages, type LoadedWorkspace, type WorkspaceData } from './workspace-schema';
import { PreviewContext } from './preview-context';
import { workspaceScope } from './workspace-mode';

function WorkspacePersistence({ initial, cloud, children }: PropsWithChildren<{
  initial: LoadedWorkspace;
  cloud?: ReturnType<typeof createCloudWorkspaceRepository>;
}>) {
  const { conversations, deletedConversationIds, activeId, sidebarOpen } = useChat();
  const { themeId, mode } = useAppearance();
  const { preferences: personalization } = usePersonalization();
  const data: WorkspaceData = useMemo(() => ({
    schemaVersion: 1,
    chat: {
      conversations: stripMessageImages(conversations),
      ...(deletedConversationIds?.length ? { deletedConversationIds } : {}),
      activeId,
      sidebarOpen,
    },
    appearance: { themeId, mode },
    personalization,
  }), [conversations, deletedConversationIds, activeId, sidebarOpen, themeId, mode, personalization]);
  const revision = useRef(initial.revision);
  const saved = useRef(JSON.stringify(initial.data));
  const queue = useRef(Promise.resolve());
  const pending = useRef<WorkspaceData | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const streaming = conversations.some((conversation) => conversation.messages.some((message) => message.status === 'streaming'));

  // Serialize snapshots through one queue so a slow write cannot overwrite a newer action.
  const flush = useCallback(() => {
    const snapshot = pending.current;
    if (!snapshot) return;
    const serialized = JSON.stringify(snapshot);
    queue.current = queue.current.then(async () => {
      if (saved.current === serialized) return;
      if (cloud) await cloud.save(snapshot);
      else revision.current = await writeWorkspace(snapshot, revision.current);
      saved.current = serialized;
      setError(null);
    }).catch((reason: unknown) => {
      setError(reason instanceof LocalDataConflict
        ? '本机数据已在其他会话中更新。请保留当前内容后重新打开应用。'
        : cloud ? '最新修改未能保存到云端。请检查网络后重试。'
          : '最新修改未能保存到本机，退出应用可能丢失这些修改。');
    });
  }, [cloud]);

  useEffect(() => {
    pending.current = data;
    if (!streaming && saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = undefined; }
    if (saveTimer.current) return;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = undefined;
      flush();
    }, streaming ? (cloud ? 1500 : 300) : 0);
  }, [data, retry, streaming, cloud, flush]);

  // Leaving the app is the mobile equivalent of closing the tab: give the queue a chance
  // to finish while the process is still alive.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'background' && state !== 'inactive') return;
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = undefined; }
      flush();
    });
    return () => subscription.remove();
  }, [flush]);

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    flush();
  }, [flush]);

  return (
    <View style={styles.fill}>
      {error && (
        <View style={styles.banner} accessibilityRole="alert">
          <Text style={styles.bannerText}>{error}</Text>
          <Pressable accessibilityRole="button" onPress={() => setRetry((value) => value + 1)}>
            <Text style={styles.bannerAction}>重试保存</Text>
          </Pressable>
        </View>
      )}
      <View style={styles.fill}>{children}</View>
    </View>
  );
}

export function NativeWorkspace({ children }: PropsWithChildren) {
  const auth = useAuth();
  const scope = workspaceScope(auth, false);
  // Models and credentials belong to this device, independent of the workspace/account.
  return (
    <ModelProvider preview={false}>
      <ScopedWorkspace key={scope} scope={scope}>{children}</ScopedWorkspace>
    </ModelProvider>
  );
}

function ScopedWorkspace({ children, scope }: PropsWithChildren<{ scope: string }>) {
  const auth = useAuth();
  const [cloud] = useState(() => scope.startsWith('cloud:') ? createCloudWorkspaceRepository(async <T,>(path: string, init?: RequestInit) => {
    const matches = () => {
      const current = auth.getSnapshot();
      return current.user?.id === scope.slice(6) && !current.user.mustChangePassword;
    };
    if (!matches()) throw new Error('账号已切换，请重新打开对话空间。');
    const result = await auth.request<T>(path, init);
    if (!matches()) throw new Error('账号已切换，请重新打开对话空间。');
    return result;
  }) : undefined);
  const [loaded, setLoaded] = useState<LoadedWorkspace | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (scope === 'pending') return;
    let active = true;
    (cloud ? cloud.load() : loadWorkspace()).then((value) => {
      if (!active) return;
      setLoaded(value);
      setFailed(false);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [attempt, scope, cloud]);

  if (!loaded) {
    const unavailable = scope === 'pending' && auth.status === 'unavailable';
    return (
      <View style={styles.screen}>
        <Text style={styles.brand}>Matrius</Text>
        <Text style={styles.status}>
          {unavailable ? '无法验证账号，请联网后重试。也可以退出登录，继续使用本机数据。'
            : failed ? (cloud ? '无法读取云端数据，请检查网络后重试。' : '无法读取本机数据，请检查存储权限后重试。已有数据不会被覆盖。')
              : '正在打开你的对话空间…'}
        </Text>
        {!unavailable && !failed && <ActivityIndicator style={styles.spinner} />}
        {(unavailable || failed) && (
          <View style={styles.actions}>
            {failed && (
              <Pressable accessibilityRole="button" style={styles.button} onPress={() => { setFailed(false); setAttempt((value) => value + 1); }}>
                <Text style={styles.buttonText}>重新打开</Text>
              </Pressable>
            )}
            <Pressable accessibilityRole="button" style={styles.button} onPress={() => { void auth.refresh(); }}>
              <Text style={styles.buttonText}>重新验证</Text>
            </Pressable>
            {unavailable && (
              <Pressable accessibilityRole="button" style={styles.button} onPress={() => { void auth.logout().catch(() => {}); }}>
                <Text style={styles.buttonText}>退出登录并使用本地数据</Text>
              </Pressable>
            )}
          </View>
        )}
      </View>
    );
  }

  return (
    <AppearanceProvider initialPreferences={loaded.data.appearance}>
      <PersonalizationProvider initialPreferences={loaded.data.personalization}>
        <ChatProvider initialState={loaded.data.chat}>
          <DraftProvider>
            <PreviewContext value={false}>
              <NetworkToolsProvider>
                <ChatRuntimeProvider>
                  <WorkspacePersistence initial={loaded} cloud={cloud}>{children}</WorkspacePersistence>
                </ChatRuntimeProvider>
              </NetworkToolsProvider>
            </PreviewContext>
          </DraftProvider>
        </ChatProvider>
      </PersonalizationProvider>
    </AppearanceProvider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, backgroundColor: '#ffffff' },
  brand: { fontSize: 26, fontWeight: '600', color: '#0f1419', marginBottom: 12 },
  status: { fontSize: 15, lineHeight: 23, color: '#536471', textAlign: 'center' },
  spinner: { marginTop: 18 },
  actions: { marginTop: 20, gap: 10, alignSelf: 'stretch' },
  button: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: '#cfd9de', paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  buttonText: { fontSize: 15, color: '#0f1419' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: '#fde8e8' },
  bannerText: { flex: 1, fontSize: 13, lineHeight: 19, color: '#8a1c1c' },
  bannerAction: { fontSize: 13, fontWeight: '600', color: '#8a1c1c' },
});
