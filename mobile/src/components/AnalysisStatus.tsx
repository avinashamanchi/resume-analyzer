import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { AnalysisState } from '../analysis/analysisReducer';
import { tokens } from '../theme/tokens';
import { AppButton } from './primitives';

export function AnalysisStatus({
  state,
  onCancel,
  onRetry,
  onRecoverPrivacy,
}: Readonly<{
  state: AnalysisState;
  onCancel(): void;
  onRetry(): void;
  onRecoverPrivacy(): void;
}>) {
  if (state.privacyReadiness === 'checking') {
    return <Text accessibilityRole="alert" style={styles.message}>Checking private temporary storage…</Text>;
  }
  if (state.status === 'analyzing') {
    return (
      <View accessibilityRole="alert" style={styles.panel}>
        <Text style={styles.title}>Analyzing securely…</Text>
        <Text style={styles.copy}>Keep Resume.AI open while this request finishes.</Text>
        <AppButton label="Cancel analysis" onPress={onCancel} tone="quiet" />
      </View>
    );
  }
  if (state.status === 'failed' && state.error !== null) {
    return (
      <View accessibilityRole="alert" style={styles.errorPanel}>
        <Text style={styles.title}>Analysis did not finish</Text>
        <Text style={styles.copy}>{state.error.message}</Text>
        {state.error.retryable && state.source !== null && !state.cleanupPending ? (
          <AppButton label="Try analysis again" onPress={onRetry} tone="secondary" />
        ) : null}
        {state.privacyReadiness === 'blocked' &&
        state.cleanupPending &&
        state.privacyRecoveryAvailable ? (
          <AppButton label="Retry private cleanup" onPress={onRecoverPrivacy} tone="secondary" />
        ) : null}
      </View>
    );
  }
  if (state.status === 'cancelled') {
    return <Text accessibilityRole="alert" style={styles.message}>Analysis cancelled. Nothing was saved.</Text>;
  }
  return null;
}

const styles = StyleSheet.create({
  panel: {
    padding: 18,
    rowGap: tokens.space.sm,
    borderWidth: 1,
    borderColor: tokens.color.accent,
    borderRadius: tokens.radius.card,
    backgroundColor: tokens.color.surface,
  },
  errorPanel: {
    padding: 18,
    rowGap: tokens.space.sm,
    borderWidth: 1,
    borderColor: tokens.color.warning,
    borderRadius: tokens.radius.card,
    backgroundColor: tokens.color.surface,
  },
  title: { color: tokens.color.text, fontSize: 18, lineHeight: 24, fontWeight: '700' },
  copy: { color: tokens.color.muted, fontSize: 15, lineHeight: 22 },
  message: { color: tokens.color.muted, fontSize: 15, lineHeight: 22 },
});
