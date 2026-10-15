import { StyleSheet, Text, View } from 'react-native';

export default function NativeHomeScreen() {
  return <View style={styles.page}><Text style={styles.title}>Matrius</Text><Text style={styles.description}>当前优先开发 Web 版，移动端界面将在后续适配。</Text></View>;
}
const styles = StyleSheet.create({
  page: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: '#ffffff' },
  title: { fontSize: 28, fontWeight: '600', color: '#0f1419', marginBottom: 12 },
  description: { fontSize: 15, lineHeight: 24, color: '#536471', textAlign: 'center' },
});
