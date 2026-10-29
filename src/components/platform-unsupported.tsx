import { StyleSheet, Text, useColorScheme, View } from 'react-native';

/**
 * Placeholder for non-web platforms. Expo Router requires every `.web.tsx`
 * route to keep an extensionless fallback sibling; the web build always picks
 * the `.web.tsx` file, so this screen is only reachable from a future native
 * target until that route gets a real implementation.
 */
export default function PlatformUnsupported() {
  const dark = useColorScheme() === 'dark';
  return (
    <View style={styles.container}>
      <Text style={[styles.title, dark && styles.titleDark]}>当前平台尚未适配</Text>
      <Text style={[styles.body, dark && styles.bodyDark]}>
        Matrius 目前只提供 Web 界面。移动端适配完成后，这里会显示对应页面。
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 },
  title: { fontSize: 16, fontWeight: '600', color: '#111111' },
  titleDark: { color: '#f5f5f5' },
  body: { fontSize: 14, lineHeight: 20, textAlign: 'center', color: '#666666' },
  bodyDark: { color: '#a3a3a3' },
});
