import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useAppController, type DisplayReport } from '../../src/controllers/AppController';
import { FeedbackSections } from '../../src/components/FeedbackSections';
import { AppButton, Card, Eyebrow, Screen, Title, uiStyles } from '../../src/components/primitives';
import { ScoreCard } from '../../src/components/ScoreCard';
import { AnalysisResponseSchema, type AnalysisResponse } from '../../src/domain/contracts';
import { tokens } from '../../src/theme/tokens';

function analysisFromDisplay(value: DisplayReport): AnalysisResponse | null {
  const direct = AnalysisResponseSchema.safeParse(value);
  if (direct.success) return direct.data;
  if ('id' in value) {
    const stored = AnalysisResponseSchema.safeParse({
      schemaVersion: 1,
      analysisId: value.id,
      sourceType: value.sourceType,
      score: value.score,
      feedback: value.feedback,
    });
    return stored.success ? stored.data : null;
  }
  return null;
}

export default function ResultsScreen() {
  const params = useLocalSearchParams<{ analysisId?: string | string[] }>();
  const router = useRouter();
  const { actions, analysis, history } = useAppController();
  const id = Array.isArray(params.analysisId) ? params.analysisId[0] : params.analysisId;
  const [result, setResult] = useState<AnalysisResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const saved = useMemo(() => history.reports.some(report => report.id === id), [history.reports, id]);

  useEffect(() => {
    let active = true;
    if (typeof id !== 'string') {
      setLoaded(true);
      return () => { active = false; };
    }
    void history.get(id).then(value => {
      if (!active) return;
      setResult(value === null ? null : analysisFromDisplay(value));
      setLoaded(true);
    });
    return () => { active = false; };
  }, [history.get, id]);

  if (!loaded) {
    return <Screen><Eyebrow>Resume.AI</Eyebrow><Title>Opening report…</Title></Screen>;
  }
  if (result === null) {
    return (
      <Screen>
        <Eyebrow>Local report</Eyebrow>
        <Title>Report not found.</Title>
        <Text style={uiStyles.muted}>This analysis is not available in the current session or local history.</Text>
        <AppButton label="Start a new analysis" onPress={() => router.replace('/(tabs)')} />
      </Screen>
    );
  }

  const save = async () => {
    const savedReport = await history.saveCurrent();
    setReceipt(savedReport === null ? 'The report could not be saved locally.' : 'Saved locally on this device.');
  };
  const share = async () => {
    try {
      await actions.shareSummary(result);
      setReceipt('Share sheet opened.');
    } catch {
      setReceipt('The summary was not shared.');
    }
  };
  const startNew = async () => {
    await analysis.commands.reset();
    router.replace('/(tabs)');
  };

  return (
    <Screen>
      <View style={styles.heading}>
        <Eyebrow>Analysis complete</Eyebrow>
        <Title>Your editorial read.</Title>
        <Text style={uiStyles.muted}>Use the score as a structured review signal, then judge each suggestion against the role and your real experience.</Text>
      </View>
      <ScoreCard score={result.score} />
      <FeedbackSections result={result} />
      <Card>
        <Text style={uiStyles.sectionTitle}>Keep or share</Text>
        <Text style={uiStyles.muted}>Nothing saves automatically. Sharing sends a text summary only.</Text>
        <AppButton label={saved ? 'Saved locally' : 'Save locally'} onPress={() => { void save(); }} disabled={saved} />
        <AppButton label="Share summary" onPress={() => { void share(); }} tone="secondary" />
        <AppButton label="PDF export unavailable" onPress={() => undefined} disabled tone="quiet" />
        <Text style={uiStyles.caption}>Accessible PDF export is added in the next release step; no file has been created.</Text>
        <AppButton label="New analysis" onPress={() => { void startNew(); }} tone="quiet" />
        {saved ? <AppButton label="Delete saved report" onPress={() => setConfirmDelete(true)} tone="danger" /> : null}
      </Card>
      {receipt !== null ? <Text accessibilityRole="alert" style={styles.receipt}>{receipt}</Text> : null}
      {confirmDelete ? (
        <Card style={styles.deleteCard}>
          <Text accessibilityRole="header" style={uiStyles.sectionTitle}>Delete this local report?</Text>
          <Text style={uiStyles.muted}>This cannot be undone.</Text>
          <AppButton label="Keep report" onPress={() => setConfirmDelete(false)} tone="quiet" />
          <AppButton label="Confirm delete report" onPress={() => { void history.delete(result.analysisId).then(deleted => { setConfirmDelete(false); setReceipt(deleted ? 'Local report deleted.' : 'The local report was not deleted.'); }); }} tone="danger" />
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: { rowGap: 10 },
  receipt: { color: tokens.color.accent, fontSize: 15, lineHeight: 22 },
  deleteCard: { borderColor: tokens.color.danger },
});
