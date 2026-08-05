import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { tokens } from '../../src/theme/tokens';

export default function SettingsScreen() {
  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>Settings</Text>
        <Text style={styles.copy}>Settings are not available in this foundation yet.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: tokens.color.background },
  content: { flex: 1, justifyContent: 'center', padding: 24 },
  title: { color: tokens.color.text, fontSize: 32, fontWeight: '700', marginBottom: 12 },
  copy: { color: tokens.color.muted, fontSize: 17, lineHeight: 24 },
});
