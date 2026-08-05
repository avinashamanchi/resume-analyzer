import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

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
      <Pressable style={styles.backdrop} onPress={onDecline} accessibilityLabel="Dismiss AI data consent">
        <Pressable
          accessibilityRole={'dialog' as never}
          accessibilityLabel="AI data consent"
          accessibilityViewIsModal
          onPress={() => undefined}
          style={styles.sheet}>
          <Text accessibilityRole="header" style={styles.title}>Before Resume.AI analyzes</Text>
          <Text style={uiStyles.body}>
            Resume.AI sends your selected resume content and optional job description to its server. Extracted or pasted text is then sent to Groq to create feedback.
          </Text>
          <Text style={uiStyles.muted}>
            Temporary PDF cleanup is verified and blocks processing if it cannot complete. Reports stay on this device only when you choose Save locally.
          </Text>
          <View style={styles.actions}>
            <AppButton label="Not now" onPress={onDecline} disabled={busy} tone="quiet" />
            <AppButton label="Agree and analyze" onPress={onAgree} disabled={busy} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.68)',
  },
  sheet: {
    maxHeight: '88%',
    padding: 22,
    paddingBottom: 34,
    rowGap: tokens.space.md,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: tokens.color.border,
    backgroundColor: tokens.color.surface,
  },
  title: { color: tokens.color.text, fontSize: 25, lineHeight: 31, fontWeight: '800' },
  actions: { flexDirection: 'column', rowGap: tokens.space.sm },
});
