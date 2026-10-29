import * as Clipboard from 'expo-clipboard';
import { Fragment, useMemo, type ReactNode } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useNativeTheme } from '@/theme/native-theme';
import { containsMath, parseMarkdown, type Block, type Inline } from './markdown';
import { MathWebView } from './math-webview';

const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

function inlineNodes(nodes: Inline[], keyPrefix: string, styles: { code: object; link: object }): ReactNode {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.type) {
      case 'text': return <Fragment key={key}>{node.value}</Fragment>;
      case 'code': return <Text key={key} style={styles.code}>{node.value}</Text>;
      case 'strong': return <Text key={key} style={stylesLink}>{inlineNodes(node.children, key, styles)}</Text>;
      case 'em': return <Text key={key} style={stylesEm}>{inlineNodes(node.children, key, styles)}</Text>;
      case 'link': return (
        <Text key={key} style={styles.link} onPress={() => { void Linking.openURL(node.href).catch(() => {}); }}>
          {inlineNodes(node.children, key, styles)}
        </Text>
      );
      case 'math': return <Text key={key} style={styles.code}>{node.tex}</Text>;
    }
  });
}

const stylesLink = { fontWeight: '700' as const };
const stylesEm = { fontStyle: 'italic' as const };

function CodeBlock({ code, lang, table }: { code: string; lang?: string; table?: boolean }) {
  const theme = useNativeTheme();
  return (
    <View style={[styles.codeBlock, { backgroundColor: theme.colors.muted, borderRadius: Math.min(theme.radius, 10) }]}>
      <View style={styles.codeHeader}>
        <Text style={[styles.codeLang, { color: theme.colors.mutedForeground }]}>{table ? '表格' : lang || '代码'}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="复制代码" hitSlop={8} onPress={() => { void Clipboard.setStringAsync(code); }}>
          <Text style={[styles.copy, { color: theme.colors.mutedForeground }]}>复制</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.codeScroll}>
        <Text selectable style={[styles.codeText, { color: theme.colors.foreground }]}>{code}</Text>
      </ScrollView>
    </View>
  );
}

function Blocks({ blocks, depth = 0 }: { blocks: Block[]; depth?: number }) {
  const theme = useNativeTheme();
  const inlineStyle = useMemo(() => ({
    code: { fontFamily: mono, fontSize: 14, backgroundColor: theme.colors.muted, color: theme.colors.foreground },
    link: { color: theme.colors.primary, textDecorationLine: 'underline' as const },
  }), [theme]);
  return (
    <>
      {blocks.map((block, index) => {
        const key = `${depth}-${index}`;
        switch (block.type) {
          case 'paragraph': return (
            <Text key={key} selectable style={[styles.paragraph, { color: theme.colors.foreground }]}>
              {inlineNodes(block.children, key, inlineStyle)}
            </Text>
          );
          case 'heading': return (
            <Text key={key} selectable style={[styles.paragraph, styles[`heading${Math.min(block.level, 3)}` as 'heading1'], { color: theme.colors.foreground }]}>
              {inlineNodes(block.children, key, inlineStyle)}
            </Text>
          );
          case 'code': return <CodeBlock key={key} code={block.code} lang={block.lang} />;
          case 'table': return <CodeBlock key={key} code={block.code} table />;
          case 'quote': return (
            <View key={key} style={[styles.quote, { borderLeftColor: theme.colors.border }]}>
              <Blocks blocks={block.blocks} depth={depth + 1} />
            </View>
          );
          case 'list': return (
            <View key={key} style={styles.list}>
              {block.items.map((item, itemIndex) => (
                <View key={`${key}-${itemIndex}`} style={styles.listItem}>
                  <Text style={[styles.bullet, { color: theme.colors.foreground }]}>{block.ordered ? `${itemIndex + 1}.` : '•'}</Text>
                  <Text selectable style={[styles.paragraph, styles.listText, { color: theme.colors.foreground }]}>
                    {inlineNodes(item, `${key}-${itemIndex}`, inlineStyle)}
                  </Text>
                </View>
              ))}
            </View>
          );
          case 'rule': return <View key={key} style={[styles.rule, { backgroundColor: theme.colors.border }]} />;
        }
      })}
    </>
  );
}

/** Streaming text bypasses parsing: half-written Markdown would flicker between shapes. */
export function MessageContent({ content, streaming }: { content: string; streaming?: boolean }) {
  const theme = useNativeTheme();
  const blocks = useMemo(() => streaming ? [] : parseMarkdown(content), [content, streaming]);
  if (streaming) return <Text selectable style={[styles.paragraph, { color: theme.colors.foreground }]}>{content || '正在思考…'}</Text>;
  if (containsMath(content)) return <MathWebView markdown={content} />;
  return <Blocks blocks={blocks} />;
}

const styles = StyleSheet.create({
  paragraph: { fontSize: 16, lineHeight: 24, marginBottom: 10 },
  heading1: { fontSize: 20, fontWeight: '700', lineHeight: 28 },
  heading2: { fontSize: 18, fontWeight: '700', lineHeight: 26 },
  heading3: { fontSize: 16.5, fontWeight: '700', lineHeight: 24 },
  codeBlock: { marginBottom: 10, overflow: 'hidden' },
  codeHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 10, paddingTop: 8 },
  codeLang: { fontSize: 11, textTransform: 'uppercase' },
  copy: { fontSize: 12 },
  codeScroll: { padding: 10, paddingTop: 4 },
  codeText: { fontSize: 13.5, lineHeight: 20, fontFamily: mono },
  quote: { borderLeftWidth: 3, paddingLeft: 12, marginBottom: 10 },
  list: { marginBottom: 10, gap: 4 },
  listItem: { flexDirection: 'row', gap: 8 },
  bullet: { fontSize: 16, lineHeight: 24, minWidth: 18 },
  listText: { flex: 1, marginBottom: 0 },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 12 },
});
