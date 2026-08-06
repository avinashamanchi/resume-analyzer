import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { AnalysisResponse } from '../domain/contracts';
import { scorePresentation } from '../domain/scorePresentation';
import { tokens } from '../theme/tokens';
import { Card, uiStyles } from './primitives';

export function ScoreCard({ score }: Readonly<{ score: AnalysisResponse['score'] }>) {
  const presentation = scorePresentation(score.components);
  return (
    <Card>
      <View accessibilityLabel="Resume readiness score" style={styles.scoreRow}>
        <View style={styles.scoreCopy}>
          <Text style={styles.kicker}>Resume readiness</Text>
          <Text style={styles.label}>{score.label}</Text>
          <Text style={uiStyles.caption}>Deterministic resume-readiness-v1 method</Text>
        </View>
        <Text
          accessibilityLabel={`Readiness score: ${score.readinessScore} out of 100, ${score.label}`}
          style={styles.score}>
          {score.readinessScore}
          <Text style={styles.outOf}>/100</Text>
        </Text>
      </View>
      <View style={uiStyles.rule} />
      <View style={styles.components}>
        {presentation.components.map(component => (
          <View key={component.key} style={styles.componentRow}>
            <Text style={uiStyles.body}>{component.label}</Text>
            <Text style={styles.componentValue}>{component.value}/{component.maximum}</Text>
          </View>
        ))}
      </View>
      {score.explanations.map((explanation, index) => (
        <Text key={`${index}-${explanation}`} style={uiStyles.muted}>• {explanation}</Text>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  scoreRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', rowGap: 14 },
  scoreCopy: { flexShrink: 1, minWidth: 150, rowGap: 4 },
  kicker: { color: tokens.color.accent, fontSize: 13, lineHeight: 18, fontWeight: '700', letterSpacing: 0.5 },
  label: { color: tokens.color.text, fontSize: 25, lineHeight: 31, fontWeight: '800' },
  score: { color: tokens.color.text, fontSize: 46, lineHeight: 50, fontWeight: '800', letterSpacing: -2 },
  outOf: { color: tokens.color.muted, fontSize: 16, letterSpacing: 0 },
  components: { rowGap: 10 },
  componentRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', columnGap: 12 },
  componentValue: { color: tokens.color.text, fontSize: 16, lineHeight: 24, fontWeight: '700' },
});
