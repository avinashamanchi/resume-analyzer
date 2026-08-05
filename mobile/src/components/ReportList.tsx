import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ReportRecord } from '../storage/reportRepository';
import { tokens } from '../theme/tokens';
import { AppButton, Card, uiStyles } from './primitives';

function reportDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Saved locally';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function ReportList({
  reports,
  onOpen,
  onDelete,
}: Readonly<{
  reports: readonly ReportRecord[];
  onOpen(id: string): void;
  onDelete(id: string): void;
}>) {
  const [confirming, setConfirming] = useState<ReportRecord | null>(null);
  return (
    <View style={styles.list}>
      {reports.map(report => (
        <Card key={report.id}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${report.title}`}
            onPress={() => onOpen(report.id)}
            style={styles.openTarget}>
            <Text style={styles.title}>{report.title}</Text>
            <Text style={uiStyles.caption}>{reportDate(report.createdAt)} · {report.sourceType === 'pdf' ? 'PDF' : 'Text'}</Text>
            <View style={styles.scoreLine}>
              <Text style={styles.score}>{report.score.readinessScore}/100</Text>
              <Text style={styles.scoreLabel}>{report.score.label}</Text>
            </View>
          </Pressable>
          <AppButton
            label="Delete"
            accessibilityLabel={`Delete ${report.title}`}
            onPress={() => setConfirming(report)}
            tone="danger"
          />
        </Card>
      ))}
      {confirming !== null ? (
        <View accessible accessibilityRole="alert" accessibilityLabel="Delete saved report?" style={styles.confirmation}>
          <Text style={uiStyles.sectionTitle}>Delete saved report?</Text>
          <Text style={uiStyles.muted}>This removes only this local report. It cannot be undone.</Text>
          <AppButton label="Keep report" onPress={() => setConfirming(null)} tone="quiet" />
          <AppButton label="Delete report" onPress={() => { onDelete(confirming.id); setConfirming(null); }} tone="danger" />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { rowGap: tokens.space.md },
  openTarget: { minHeight: tokens.target.minimum, rowGap: 7 },
  title: { color: tokens.color.text, fontSize: 18, lineHeight: 24, fontWeight: '700' },
  scoreLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 10 },
  score: { color: tokens.color.text, fontSize: 25, lineHeight: 30, fontWeight: '800' },
  scoreLabel: { color: tokens.color.accent, fontSize: 15, lineHeight: 21, fontWeight: '700' },
  confirmation: {
    padding: 18,
    rowGap: tokens.space.sm,
    borderWidth: 1,
    borderColor: tokens.color.danger,
    borderRadius: tokens.radius.card,
    backgroundColor: tokens.color.surface,
  },
});
