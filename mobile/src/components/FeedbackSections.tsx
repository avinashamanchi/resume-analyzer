import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { AnalysisResponse } from '../domain/contracts';
import { tokens } from '../theme/tokens';
import { Card, uiStyles } from './primitives';

function ListSection({ title, items, empty }: Readonly<{ title: string; items: readonly string[]; empty: string }>) {
  return (
    <Card>
      <Text style={uiStyles.sectionTitle}>{title}</Text>
      {items.length === 0
        ? <Text style={uiStyles.muted}>{empty}</Text>
        : items.map((item, index) => <Text key={`${index}-${item}`} style={uiStyles.body}>• {item}</Text>)}
    </Card>
  );
}

export function FeedbackSections({ result }: Readonly<{ result: AnalysisResponse }>) {
  const hasKeywordScore = result.score.components.keywords !== null;
  return (
    <View testID="feedback-stack" style={styles.stack}>
      <Card>
        <Text style={uiStyles.sectionTitle}>Editorial summary</Text>
        <Text style={uiStyles.body}>{result.feedback.summary}</Text>
      </Card>
      <ListSection title="Matched keywords" items={result.feedback.matchedKeywords} empty={hasKeywordScore ? 'No matched terms were identified.' : 'Add a job description to compare terms.'} />
      <ListSection title="Missing keywords" items={result.feedback.missingKeywords} empty={hasKeywordScore ? 'No missing terms were identified.' : 'Add a job description to compare terms.'} />
      <ListSection title="Strengths" items={result.feedback.strengths} empty="No strengths were returned." />
      <ListSection title="Improvements" items={result.feedback.improvements} empty="No improvements were returned." />
      <ListSection title="Power bullet drafts" items={result.feedback.powerBullets} empty="No bullet drafts were returned." />
      <Card style={styles.simulated}>
        <Text style={styles.simulatedLabel}>Simulated AI feedback</Text>
        <Text style={uiStyles.body}>{result.feedback.simulatedRecruiterComment}</Text>
        <Text style={uiStyles.caption}>This is generated perspective, not an employer decision or hiring prediction.</Text>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { flexDirection: 'column', rowGap: tokens.space.md },
  simulated: { borderColor: tokens.color.warning },
  simulatedLabel: { color: tokens.color.warning, fontSize: 13, lineHeight: 18, fontWeight: '800', letterSpacing: 0.7, textTransform: 'uppercase' },
});
