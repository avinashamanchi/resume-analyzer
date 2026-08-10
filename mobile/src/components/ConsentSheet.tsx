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
                Only text you review or paste, plus an optional job description, is sent to Resume.AI’s server. The server creates the structured score and, when requested, sends that text to Groq for optional feedback.
              </Text>
              <Text style={uiStyles.muted}>
                The selected PDF stays on this device and is never uploaded. PDFKit reads selectable text first; Apple Vision handles scanned pages. You must review the extracted text before analysis.
              </Text>
              <Text style={uiStyles.muted}>
                If local PDF cleanup cannot be verified, Resume.AI does not expose the extracted draft and blocks future analysis until cleanup succeeds. The deterministic score may still appear when optional AI feedback is unavailable.
              </Text>
              <Text style={uiStyles.muted}>
                Reports use Resume.AI’s local SQLite store only when you choose Save locally. Saved reports may be included in iPhone or iPad backups stored in iCloud or on a Mac or PC. iCloud backups are always encrypted, but iCloud Backup is end-to-end encrypted only when Advanced Data Protection is enabled. Computer backups are not encrypted by default; encryption depends on the user enabling Encrypt local backup. Restoring an existing backup may restore reports deleted from the active app.
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
