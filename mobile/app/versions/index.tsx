import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput, View } from 'react-native';

import { useBilling } from '../../src/billing/BillingProvider';
import { AppButton, Card, Eyebrow, Screen, Title, uiStyles } from '../../src/components/primitives';
import { useAppController } from '../../src/controllers/AppController';
import { tokens } from '../../src/theme/tokens';
import type { ResumeVersion, WorkspaceCursor } from '../../src/workspace/contracts';
import { isVerifiedWorkspacePro, workspacePlanFromVerified } from '../../src/workspace/plan';
import { useWorkspaceData } from '../../src/workspace/WorkspaceProvider';

const PAGE_SIZE = 25;
const MAX_VERSION_LABELS = 200;

export default function VersionsScreen() {
  const router = useRouter();
  const data = useWorkspaceData();
  const billing = useBilling();
  const { analysis } = useAppController();
  const [title, setTitle] = useState('');
  const [roleLabel, setRoleLabel] = useState('');
  const [versions, setVersions] = useState<readonly ResumeVersion[]>([]);
  const [nextCursor, setNextCursor] = useState<WorkspaceCursor | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const verifiedPro = isVerifiedWorkspacePro(billing.verifiedPlan);
  const sourceText = useMemo(() => {
    const source = analysis.state.source;
    return source !== null && source.kind !== 'pdf' ? source.text : null;
  }, [analysis.state.source]);

  const loadNewest = useCallback(async () => {
    if (data.status !== 'ready') return;
    try {
      const page = await data.repository.listVersions({ before: null, limit: PAGE_SIZE });
      setVersions(page.items);
      setNextCursor(page.nextCursor);
    } catch {
      setMessage('Saved versions could not be loaded.');
    }
  }, [data]);

  useEffect(() => { void loadNewest(); }, [loadNewest]);

  const loadMore = async () => {
    if (data.status !== 'ready' || loadingMore || nextCursor === null) return;
    const cursor = nextCursor;
    setLoadingMore(true);
    try {
      const page = await data.repository.listVersions({ before: cursor, limit: PAGE_SIZE });
      setVersions(current => {
        const known = new Set(current.map(item => item.id));
        return [...current, ...page.items.filter(item => !known.has(item.id))]
          .slice(0, MAX_VERSION_LABELS);
      });
      setNextCursor(page.nextCursor);
      setMessage(null);
    } catch {
      setMessage('Older saved versions could not be loaded.');
    } finally {
      setLoadingMore(false);
    }
  };

  const save = async () => {
    if (saving || data.status !== 'ready') return;
    const result = analysis.state.result;
    if (result === null || sourceText === null) {
      setMessage('Finish an analysis with reviewed or pasted text before saving a version.');
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await data.repository.saveVersion({
        title: title.trim(),
        roleLabel: roleLabel.trim().length === 0 ? null : roleLabel.trim(),
        resumeText: sourceText,
        score: result.score,
        keywords: result.feedback?.matchedKeywords ?? [],
      }, workspacePlanFromVerified(billing.verifiedPlan));
      setTitle('');
      setRoleLabel('');
      setMessage('Version saved only on this device.');
      await loadNewest();
    } catch {
      setMessage(verifiedPro
        ? 'The version could not be saved safely.'
        : 'Free includes one saved version. Upgrade to Pro for more versions.');
    } finally {
      setSaving(false);
    }
  };

  const header = (
    <View style={styles.header}>
      <View><Eyebrow>Local resume workspace</Eyebrow><Title>Resume versions.</Title></View>
      <Text style={uiStyles.muted}>Nothing saves automatically. The reviewed text and score from your current analysis stay on this device.</Text>
      <Card>
        <Text style={uiStyles.sectionTitle}>Save current analysis</Text>
        <TextInput accessibilityLabel="Version title" placeholder="Version title" placeholderTextColor="#7d8984" value={title} onChangeText={setTitle} maxLength={120} style={uiStyles.compactInput} />
        <TextInput accessibilityLabel="Target role" placeholder="Target role (optional)" placeholderTextColor="#7d8984" value={roleLabel} onChangeText={setRoleLabel} maxLength={120} style={uiStyles.compactInput} />
        <AppButton label={saving ? 'Saving version…' : 'Save version on this device'} onPress={() => { void save(); }} disabled={saving || title.trim().length === 0} />
      </Card>
      {message !== null ? <Text accessibilityRole="alert" style={uiStyles.muted}>{message}</Text> : null}
    </View>
  );

  const footer = (
    <View style={styles.footer}>
      {nextCursor !== null ? <AppButton label={loadingMore ? 'Loading older resume versions…' : 'Load older resume versions'} onPress={() => { void loadMore(); }} disabled={loadingMore} tone="secondary" /> : null}
      {versions.length >= 1 && sourceText !== null ? <AppButton label="Compare saved and current versions" onPress={() => router.push('/compare')} tone="secondary" /> : null}
      {verifiedPro && versions.length >= 2 ? <AppButton label="Choose saved versions to compare" onPress={() => router.push('/compare')} tone="secondary" /> : null}
      <AppButton label="Back to workspace" onPress={() => router.back()} tone="quiet" />
    </View>
  );

  return (
    <Screen scroll={false}>
      <FlatList
        style={styles.list}
        contentContainerStyle={styles.content}
        data={versions}
        keyExtractor={version => version.id}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header}
        ListEmptyComponent={<Text style={uiStyles.muted}>No resume versions are saved on this device.</Text>}
        ListFooterComponent={footer}
        onEndReached={() => { void loadMore(); }}
        onEndReachedThreshold={0.4}
        renderItem={({ item: version }) => (
          <Card>
            <Text style={uiStyles.sectionTitle}>{version.title}</Text>
            <Text style={uiStyles.muted}>{version.roleLabel ?? 'General version'}</Text>
            <AppButton label={`Open ${version.title}`} onPress={() => router.push(`/versions/${version.id}`)} tone="secondary" />
          </Card>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  content: { rowGap: tokens.space.md, paddingBottom: tokens.space.lg },
  header: { rowGap: tokens.space.lg, marginBottom: tokens.space.sm },
  footer: { rowGap: tokens.space.md, marginTop: tokens.space.sm },
});
