import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { tokens } from '../theme/tokens';
import { AppButton, Card, uiStyles } from './primitives';

export type SourceMode = 'pdf' | 'paste';

export function SourcePicker({
  mode,
  displayName,
  busy,
  onModeChange,
  onChoosePdf,
}: Readonly<{
  mode: SourceMode;
  displayName: string | null;
  busy: boolean;
  onModeChange(mode: SourceMode): void;
  onChoosePdf(): void;
}>) {
  return (
    <Card>
      <Text style={uiStyles.sectionTitle}>Resume source</Text>
      <View accessibilityRole="tablist" style={styles.segmented}>
        {(['pdf', 'paste'] as const).map(value => (
          <Pressable
            key={value}
            accessibilityRole="tab"
            accessibilityLabel={value === 'pdf' ? 'PDF' : 'Paste text'}
            accessibilityState={{ selected: mode === value, disabled: busy }}
            disabled={busy}
            onPress={() => onModeChange(value)}
            style={[styles.segment, mode === value && styles.segmentSelected]}>
            <Text style={[styles.segmentText, mode === value && styles.segmentTextSelected]}>
              {value === 'pdf' ? 'PDF' : 'Paste text'}
            </Text>
          </Pressable>
        ))}
      </View>
      {mode === 'pdf' ? (
        <>
          <Text style={uiStyles.muted}>Choose a text-based PDF up to 10 MB. It is staged only for this request.</Text>
          <AppButton
            label={displayName === null ? 'Choose resume PDF' : 'Choose another PDF'}
            accessibilityLabel="Choose resume PDF"
            onPress={onChoosePdf}
            disabled={busy}
            tone="secondary"
          />
          {displayName !== null ? (
            <Text accessibilityLabel="Selected resume filename" numberOfLines={2} style={styles.filename}>
              {displayName}
            </Text>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  segmented: {
    flexDirection: 'row',
    padding: 3,
    borderRadius: tokens.radius.control,
    backgroundColor: tokens.color.background,
  },
  segment: {
    flex: 1,
    minHeight: tokens.target.minimum,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  segmentSelected: { backgroundColor: tokens.color.surfaceRaised },
  segmentText: { color: tokens.color.muted, fontSize: 15, fontWeight: '700' },
  segmentTextSelected: { color: tokens.color.accent },
  filename: { color: tokens.color.text, fontSize: 15, lineHeight: 21, fontWeight: '600' },
});
