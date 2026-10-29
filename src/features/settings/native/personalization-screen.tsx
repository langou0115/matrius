import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ActionSheet } from '@/components/native/action-sheet';
import { Field } from '@/components/native/field';
import { useModels } from '@/features/models/model-state';
import { useNativeTheme } from '@/theme/native-theme';
import { personalizationLimits } from '../personalization';
import { usePersonalization } from '../personalization-state';
import { Footnote, Section, SettingsPage } from './settings-shell';

export function PersonalizationScreen() {
  const theme = useNativeTheme();
  const { preferences, update } = usePersonalization();
  const models = useModels();
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleModel = models.titleModel;

  function choose(id: string | null) {
    setError(null);
    void models.setTitleModelId(id).catch(() => setError('标题模型设置未能保存，请重试。'));
  }

  return (
    <SettingsPage title="个性化" subtitle="告诉模型你希望它如何回答，以及需要了解的个人信息。">
      <Section title="对话标题">
        <Pressable accessibilityRole="button" accessibilityLabel="选择标题生成模型" onPress={() => setChoosing(true)}
          style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}>
          <View style={styles.rowCopy}>
            <Text style={[styles.rowTitle, { color: theme.colors.foreground }]}>标题生成模型</Text>
            <Text numberOfLines={1} style={[styles.rowValue, { color: theme.colors.mutedForeground }]}>
              {titleModel ? `${titleModel.name} · ${titleModel.providerName}` : '跟随当前对话模型'}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={17} color={theme.colors.mutedForeground} />
        </Pressable>
      </Section>
      {error ? <Footnote error>{error}</Footnote> : null}

      <Section title="自定义指令">
        <View style={styles.fields}>
          <Field label="你希望模型如何回复？" multiline value={preferences.customInstructions}
            onChangeText={(value) => update({ customInstructions: value })}
            maxLength={personalizationLimits.customInstructions}
            placeholder="例如：优先用中文回答，先给结论再解释；提供代码时附上简短注释。"
            hint={`${preferences.customInstructions.length} / ${personalizationLimits.customInstructions}`} />
        </View>
      </Section>

      <Section title="关于你">
        <View style={styles.fields}>
          <Field label="如何称呼你" value={preferences.aboutName} onChangeText={(value) => update({ aboutName: value })}
            maxLength={personalizationLimits.aboutName} placeholder="你希望模型使用的称呼" />
          <Field label="职业" value={preferences.occupation} onChangeText={(value) => update({ occupation: value })}
            maxLength={personalizationLimits.occupation} placeholder="例如：软件工程师、设计师、学生" />
          <Field label="更多关于你" multiline value={preferences.aboutMore} onChangeText={(value) => update({ aboutMore: value })}
            maxLength={personalizationLimits.aboutMore} placeholder="可填写你的兴趣、背景或需要模型考虑的其他信息。"
            hint={`${preferences.aboutMore.length} / ${personalizationLimits.aboutMore}`} />
        </View>
      </Section>

      <ActionSheet visible={choosing} title="标题生成模型" onClose={() => setChoosing(false)}
        items={[
          { label: `${!models.titleModelId ? '✓ ' : ''}跟随当前对话模型`, onPress: () => choose(null) },
          ...models.models.map((model) => ({
            label: `${models.titleModelId === model.id ? '✓ ' : ''}${model.name} · ${model.providerName}`,
            onPress: () => choose(model.id),
          })),
        ]} />
      {!models.ready && !models.error ? <Footnote>正在读取模型配置…</Footnote> : null}
      {models.error ? <Footnote error>{models.error}</Footnote> : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 13 },
  rowCopy: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 14.5, fontWeight: '500' },
  rowValue: { fontSize: 12.5 },
  fields: { padding: 14, gap: 14 },
});
