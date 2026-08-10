import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput, View } from 'react-native';

import { useBilling } from '../../src/billing/BillingProvider';
import { AppButton, Card, Eyebrow, Screen, Title, uiStyles } from '../../src/components/primitives';
import { tokens } from '../../src/theme/tokens';
import type { JobRecord, ResumeVersion, WorkspaceCursor } from '../../src/workspace/contracts';
import { isVerifiedWorkspacePro, workspacePlanFromVerified } from '../../src/workspace/plan';
import { useWorkspaceData } from '../../src/workspace/WorkspaceProvider';

const PAGE_SIZE = 25;
const MAX_JOB_LABELS = 500;

function nextActionTimestamp(value: string): string | null | undefined {
  if (value.length === 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const timestamp = `${value}T12:00:00.000Z`;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) && date.toISOString() === timestamp
    ? timestamp
    : undefined;
}

export default function JobsScreen() {
  const router = useRouter();
  const data = useWorkspaceData();
  const billing = useBilling();
  const [company, setCompany] = useState('');
  const [role, setRole] = useState('');
  const [notes, setNotes] = useState('');
  const [nextActionDate, setNextActionDate] = useState('');
  const [linkedVersionId, setLinkedVersionId] = useState<string | null>(null);
  const [versionOptions, setVersionOptions] = useState<readonly ResumeVersion[]>([]);
  const [jobs, setJobs] = useState<readonly JobRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<WorkspaceCursor | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const verifiedPro = isVerifiedWorkspacePro(billing.verifiedPlan);

  const loadNewest = useCallback(async () => {
    if (data.status !== 'ready') return;
    try {
      const [page, versions] = await Promise.all([
        data.repository.listJobs({ before: null, limit: PAGE_SIZE }),
        data.repository.listVersions({ before: null, limit: 10 }),
      ]);
      setJobs(page.items);
      setNextCursor(page.nextCursor);
      setVersionOptions(versions.items);
    } catch {
      setMessage('Tracked jobs could not be loaded.');
    }
  }, [data]);
  useEffect(() => { void loadNewest(); }, [loadNewest]);

  const loadMore = async () => {
    if (data.status !== 'ready' || loadingMore || nextCursor === null) return;
    const cursor = nextCursor;
    setLoadingMore(true);
    try {
      const page = await data.repository.listJobs({ before: cursor, limit: PAGE_SIZE });
      setJobs(current => {
        const known = new Set(current.map(item => item.id));
        return [...current, ...page.items.filter(item => !known.has(item.id))]
          .slice(0, MAX_JOB_LABELS);
      });
      setNextCursor(page.nextCursor);
      setMessage(null);
    } catch {
      setMessage('Older tracked jobs could not be loaded.');
    } finally {
      setLoadingMore(false);
    }
  };

  const save = async () => {
    if (saving || data.status !== 'ready') return;
    const nextActionAt = nextActionTimestamp(nextActionDate);
    if (nextActionAt === undefined) {
      setMessage('Enter the next action date as a real calendar date in YYYY-MM-DD format.');
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await data.repository.saveJob({
        companyLabel: company.trim(),
        roleLabel: role.trim(),
        status: 'saved',
        nextActionAt,
        notes,
        linkedVersionId,
      }, workspacePlanFromVerified(billing.verifiedPlan));
      setCompany('');
      setRole('');
      setNotes('');
      setNextActionDate('');
      setLinkedVersionId(null);
      setMessage('Job saved only on this device.');
      await loadNewest();
    } catch {
      setMessage(verifiedPro
        ? 'The job could not be saved safely.'
        : 'Free includes three tracked jobs. Upgrade to Pro for more.');
    } finally {
      setSaving(false);
    }
  };

  const header = (
    <View style={styles.header}>
      <View><Eyebrow>Private local tracker</Eyebrow><Title>Job tracker.</Title></View>
      <Text style={uiStyles.muted}>No scraping, email, calendar, or automatic applications. You control every local update.</Text>
      <Card>
        <Text style={uiStyles.sectionTitle}>Track a job</Text>
        <TextInput accessibilityLabel="Company" placeholder="Company" placeholderTextColor="#7d8984" value={company} onChangeText={setCompany} maxLength={120} style={uiStyles.compactInput} />
        <TextInput accessibilityLabel="Role" placeholder="Role" placeholderTextColor="#7d8984" value={role} onChangeText={setRole} maxLength={120} style={uiStyles.compactInput} />
        <TextInput accessibilityLabel="Next action date" placeholder="Next action date: YYYY-MM-DD (optional)" placeholderTextColor="#7d8984" value={nextActionDate} onChangeText={setNextActionDate} maxLength={10} autoCapitalize="none" autoCorrect={false} keyboardType="numbers-and-punctuation" style={uiStyles.compactInput} />
        <TextInput accessibilityLabel="Job notes" placeholder="Notes (optional)" placeholderTextColor="#7d8984" value={notes} onChangeText={setNotes} maxLength={2_000} multiline style={uiStyles.input} />
        <Text style={uiStyles.body}>Linked resume version: {versionOptions.find(version => version.id === linkedVersionId)?.title ?? 'None'}</Text>
        {versionOptions.map(version => (
          <AppButton key={version.id} label={`Link ${version.title}`} onPress={() => setLinkedVersionId(version.id)} disabled={linkedVersionId === version.id} tone="quiet" />
        ))}
        {linkedVersionId !== null ? <AppButton label="Remove linked resume version" onPress={() => setLinkedVersionId(null)} tone="quiet" /> : null}
        <AppButton label={saving ? 'Saving job…' : 'Save job on this device'} onPress={() => { void save(); }} disabled={saving || company.trim().length === 0 || role.trim().length === 0} />
      </Card>
      {message !== null ? <Text accessibilityRole="alert" style={uiStyles.muted}>{message}</Text> : null}
    </View>
  );

  const footer = (
    <View style={styles.footer}>
      {nextCursor !== null ? <AppButton label={loadingMore ? 'Loading older jobs…' : 'Load older jobs'} onPress={() => { void loadMore(); }} disabled={loadingMore} tone="secondary" /> : null}
      <AppButton label="Back to workspace" onPress={() => router.back()} tone="quiet" />
    </View>
  );

  return (
    <Screen scroll={false}>
      <FlatList
        style={styles.list}
        contentContainerStyle={styles.content}
        data={jobs}
        keyExtractor={job => job.id}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header}
        ListEmptyComponent={<Text style={uiStyles.muted}>No jobs are tracked on this device.</Text>}
        ListFooterComponent={footer}
        onEndReached={() => { void loadMore(); }}
        onEndReachedThreshold={0.4}
        renderItem={({ item: job }) => (
          <Card>
            <Text style={uiStyles.sectionTitle}>{job.roleLabel}</Text>
            <Text style={uiStyles.muted}>{job.companyLabel} · {job.status}</Text>
            <AppButton label={`Open ${job.roleLabel} at ${job.companyLabel}`} onPress={() => router.push(`/jobs/${job.id}`)} tone="secondary" />
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
