import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { tokens } from '../theme/tokens';
import { AppButton, uiStyles } from './primitives';

export function ConsentSheet({
  visible,
  busy,
  onAgree,
  onDecline,
}: Readonly<{
  visible: boolean;
  busy: boolean;
  onAgree(): void;
  onDecline(): void;
}>) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDecline}
      statusBarTranslucent>
      <View style={styles.backdrop}>
        <Pressable
          accessible={false}
          importantForAccessibility="no"
          style={StyleSheet.absoluteFill}
          onPress={onDecline}
        />
        <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
          <View
            testID="consent-dialog"
            accessibilityRole={'dialog' as never}
            accessibilityLabel="AI data consent"
            accessibilityViewIsModal
            style={styles.sheet}>
            <ScrollView
              testID="consent-scroll"
              style={styles.copyScroll}
              contentContainerStyle={styles.copyContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator>
              <Text accessibilityRole="header" style={styles.title}>Before Resume.AI analyzes</Text>
              <Text style={uiStyles.body}>
                Resume.AI sends your selected resume content and optional job description to its server. Extracted or pasted text is then sent to Groq to create feedback.
              </Text>
              <Text style={uiStyles.muted}>
                The selected PDF is uploaded and processed before temporary cleanup runs. After the request ends, Resume.AI verifies removal of its app-owned temporary PDF.
              </Text>
              <Text style={uiStyles.muted}>
                If cleanup cannot be verified, Resume.AI does not show the analysis as successful and blocks future analysis until cleanup succeeds. Cleanup cannot undo processing already completed by the Resume.AI server or Groq.
              </Text>
              <Text style={uiStyles.muted}>
                Reports use Resume.AI’s local SQLite store only when you choose Save locally. Depending on your settings, encrypted device or iCloud backups may include them.
              </Text>
            </ScrollView>
            <View testID="consent-actions" style={styles.actions}>
              <AppButton label="Not now" onPress={onDecline} disabled={busy} tone="quiet" />
              <AppButton label="Agree and analyze" onPress={onAgree} disabled={busy} />
            </View>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.68)',
  },
  safeArea: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    maxHeight: '100%',
    minHeight: 0,
    padding: 22,
    paddingBottom: 34,
    rowGap: tokens.space.sm,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: tokens.color.border,
    backgroundColor: tokens.color.surface,
  },
  copyScroll: { flexShrink: 1, minHeight: 0 },
  copyContent: { flexGrow: 1, rowGap: tokens.space.md },
  title: { color: tokens.color.text, fontSize: 25, lineHeight: 31, fontWeight: '800' },
  actions: { flexShrink: 0, flexDirection: 'column', rowGap: tokens.space.sm },
});
