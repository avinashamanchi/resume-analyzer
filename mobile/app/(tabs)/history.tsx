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
    <Screen bottomInset="tab-bar" scroll={false}>
      <View>
        <Eyebrow>On this device</Eyebrow>
        <Title>Saved reports.</Title>
      </View>
      <Text style={uiStyles.muted}>Raw/original PDF bytes, filenames, resume-input fields, job-description-input fields, installation tokens, and request identifiers are not stored in local reports. Generated feedback and bullet drafts may quote, transform, or restate names, contact information, resume content, or job-description content.</Text>
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
          hasMore={history.hasMore}
          hasNewer={history.hasNewer}
          loadingMore={history.loadingMore}
          onLoadMore={history.loadMore}
          onReturnToNewest={history.returnToNewest}
        />
      )}
    </Screen>
  );
}
