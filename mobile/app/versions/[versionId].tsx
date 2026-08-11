import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import { AppButton, Card, Eyebrow, Screen, Title, uiStyles } from '../../src/components/primitives';
import { useAppController } from '../../src/controllers/AppController';
import type { VersionAggregate } from '../../src/workspace/workspaceRepository';
import { useWorkspaceData } from '../../src/workspace/WorkspaceProvider';

export default function VersionDetailScreen() {
  const params = useLocalSearchParams<{ versionId?: string | string[] }>();
  const id = Array.isArray(params.versionId) ? params.versionId[0] : params.versionId;
  const router = useRouter();
  const data = useWorkspaceData();
  const { analysis } = useAppController();
  const [aggregate, setAggregate] = useState<VersionAggregate | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const sourceText = useMemo(() => {
    const source = analysis.state.source;
    return source !== null && source.kind !== 'pdf' ? source.text : null;
  }, [analysis.state.source]);

  const load = useCallback(async () => {
    if (data.status !== 'ready' || typeof id !== 'string') {
      setLoaded(data.status !== 'loading');
      return;
    }
    try {
      setAggregate(await data.repository.getVersion(id));
    } catch {
      setMessage('This local version could not be opened safely.');
    } finally {
      setLoaded(true);
    }
  }, [data, id]);

  useEffect(() => { void load(); }, [load]);

  const addSnapshot = async () => {
    const result = analysis.state.result;
    if (data.status !== 'ready' || typeof id !== 'string' || result === null || sourceText === null) {
      setMessage('Finish another reviewed-text analysis before adding a revision.');
      return;
    }
    try {
      await data.repository.addSnapshot(id, {
        resumeText: sourceText,
        score: result.score,
        keywords: result.feedback?.matchedKeywords ?? [],
      });
      setMessage('New revision saved only on this device.');
      await load();
    } catch {
      setMessage('The revision could not be saved safely.');
    }
  };

  const deleteVersion = async () => {
    if (data.status !== 'ready' || typeof id !== 'string') return;
    try {
      if (await data.repository.deleteVersion(id)) router.replace('/versions');
      else setMessage('The version was already removed.');
    } catch {
      setMessage('The version was not deleted.');
    }
  };

  if (!loaded) return <Screen><Eyebrow>Local version</Eyebrow><Title>Opening version…</Title></Screen>;
  if (aggregate === null) return <Screen><Eyebrow>Local version</Eyebrow><Title>Version not found.</Title><AppButton label="Back to versions" onPress={() => router.replace('/versions')} /></Screen>;
  const latest = aggregate.snapshots.find(snapshot => snapshot.id === aggregate.version.latestSnapshotId)!;
  return (
    <Screen>
      <View><Eyebrow>Saved only on this device</Eyebrow><Title>{aggregate.version.title}</Title></View>
      <Text style={uiStyles.muted}>{aggregate.version.roleLabel ?? 'General resume version'} · {aggregate.snapshots.length} revision{aggregate.snapshots.length === 1 ? '' : 's'}</Text>
      <Card>
        <Text style={uiStyles.sectionTitle}>Latest score</Text>
        <Text style={uiStyles.body}>{latest.score.readinessScore}/100 — {latest.score.label}</Text>
        <Text selectable style={uiStyles.body}>{latest.resumeText}</Text>
      </Card>
      <AppButton label="Add current analysis as a revision" onPress={() => { void addSnapshot(); }} tone="secondary" />
      {message !== null ? <Text accessibilityRole="alert" style={uiStyles.muted}>{message}</Text> : null}
      {confirmingDelete ? (
        <Card>
          <Text accessibilityRole="header" style={uiStyles.sectionTitle}>Delete this version and every local revision?</Text>
          <Text style={uiStyles.muted}>Linked jobs stay on this device but will no longer point to this version.</Text>
          <AppButton label="Keep version" onPress={() => setConfirmingDelete(false)} tone="quiet" />
          <AppButton label="Confirm delete version" onPress={() => { void deleteVersion(); }} tone="danger" />
        </Card>
      ) : <AppButton label="Delete version" onPress={() => setConfirmingDelete(true)} tone="danger" />}
      <AppButton label="Back to versions" onPress={() => router.back()} tone="quiet" />
    </Screen>
  );
}
