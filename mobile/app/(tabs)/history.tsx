import { useRouter } from 'expo-router';
import React from 'react';
import { Text, View } from 'react-native';

import { useAppController } from '../../src/controllers/AppController';
import { AppButton, Card, Eyebrow, Screen, Title, uiStyles } from '../../src/components/primitives';
import { ReportList } from '../../src/components/ReportList';

export default function HistoryScreen() {
  const router = useRouter();
  const { history } = useAppController();
  return (
    <Screen>
      <View>
        <Eyebrow>On this device</Eyebrow>
        <Title>Saved reports.</Title>
      </View>
      <Text style={uiStyles.muted}>Resume text, filenames, job descriptions, and service identifiers are never part of local history.</Text>
      {history.error !== null && history.status === 'ready' ? (
        <Text accessibilityRole="alert" style={uiStyles.muted}>{history.error}</Text>
      ) : null}
      {history.status === 'loading' ? (
        <Text accessibilityRole="alert" style={uiStyles.muted}>Loading local reports…</Text>
      ) : history.status === 'blocked' ? (
        <Card><Text style={uiStyles.sectionTitle}>Local history unavailable</Text><Text style={uiStyles.muted}>Resume.AI could not open its private report store safely.</Text></Card>
      ) : history.status === 'error' ? (
        <Card>
          <Text style={uiStyles.sectionTitle}>Local history did not load</Text>
          <Text accessibilityRole="alert" style={uiStyles.muted}>{history.error}</Text>
          <AppButton label="Try loading history again" onPress={() => { void history.load(); }} tone="secondary" />
        </Card>
      ) : history.reports.length === 0 ? (
        <Card>
          <Text style={uiStyles.sectionTitle}>No saved reports</Text>
          <Text style={uiStyles.muted}>Reports appear here only after you finish an analysis and choose Save locally.</Text>
          <AppButton label="Analyze a resume" onPress={() => router.push('/(tabs)')} />
        </Card>
      ) : (
        <ReportList
          reports={history.reports}
          onOpen={id => router.push(`/results/${id}`)}
          onDelete={id => history.delete(id)}
        />
      )}
    </Screen>
  );
}
