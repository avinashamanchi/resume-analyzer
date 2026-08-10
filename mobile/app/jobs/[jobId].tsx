import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { useBilling } from '../../src/billing/BillingProvider';
import { AppButton, Card, Eyebrow, Screen, Title, uiStyles } from '../../src/components/primitives';
import { JobStatusSchema, type JobRecord } from '../../src/workspace/contracts';
import { workspacePlanFromVerified } from '../../src/workspace/plan';
import { useWorkspaceData } from '../../src/workspace/WorkspaceProvider';

export default function JobDetailScreen() {
  const params = useLocalSearchParams<{ jobId?: string | string[] }>();
  const id = Array.isArray(params.jobId) ? params.jobId[0] : params.jobId;
  const router = useRouter();
  const data = useWorkspaceData();
  const billing = useBilling();
  const [job, setJob] = useState<JobRecord | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (data.status !== 'ready' || typeof id !== 'string') {
      setLoaded(data.status !== 'loading');
      return;
    }
    try {
      setJob(await data.repository.getJob(id));
    } catch {
      setMessage('This local job could not be opened safely.');
    } finally {
      setLoaded(true);
    }
  }, [data, id]);
  useEffect(() => { void load(); }, [load]);

  const setStatus = async (statusValue: unknown) => {
    const status = JobStatusSchema.safeParse(statusValue);
    if (!status.success || job === null || data.status !== 'ready') return;
    try {
      const updated = await data.repository.saveJob({
        id: job.id,
        companyLabel: job.companyLabel,
        roleLabel: job.roleLabel,
        status: status.data,
        nextActionAt: job.nextActionAt,
        notes: job.notes,
        linkedVersionId: job.linkedVersionId,
      }, workspacePlanFromVerified(billing.verifiedPlan));
      setJob(updated);
      setMessage(`Status saved as ${status.data} only on this device.`);
    } catch {
      setMessage('The job status was not updated.');
    }
  };

  const deleteJob = async () => {
    if (data.status !== 'ready' || typeof id !== 'string') return;
    try {
      if (await data.repository.deleteJob(id)) router.replace('/jobs');
      else setMessage('The job was already removed.');
    } catch {
      setMessage('The job was not deleted.');
    }
  };

  if (!loaded) return <Screen><Eyebrow>Local job</Eyebrow><Title>Opening job…</Title></Screen>;
  if (job === null) return <Screen><Eyebrow>Local job</Eyebrow><Title>Job not found.</Title><AppButton label="Back to jobs" onPress={() => router.replace('/jobs')} /></Screen>;
  return (
    <Screen>
      <View><Eyebrow>Saved only on this device</Eyebrow><Title>{job.roleLabel}</Title></View>
      <Card>
        <Text style={uiStyles.sectionTitle}>{job.companyLabel}</Text>
        <Text style={uiStyles.body}>Status: {job.status}</Text>
        <Text style={uiStyles.muted}>{job.notes.length === 0 ? 'No notes.' : job.notes}</Text>
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>Update status</Text>
        {(['saved', 'applied', 'interviewing', 'offer', 'rejected', 'archived'] as const).map(status => (
          <AppButton key={status} label={`Mark ${status}`} onPress={() => { void setStatus(status); }} disabled={job.status === status} tone="secondary" />
        ))}
      </Card>
      {message !== null ? <Text accessibilityRole="alert" style={uiStyles.muted}>{message}</Text> : null}
      {confirmingDelete ? (
        <Card>
          <Text accessibilityRole="header" style={uiStyles.sectionTitle}>Delete this local job?</Text>
          <AppButton label="Keep job" onPress={() => setConfirmingDelete(false)} tone="quiet" />
          <AppButton label="Confirm delete job" onPress={() => { void deleteJob(); }} tone="danger" />
        </Card>
      ) : <AppButton label="Delete job" onPress={() => setConfirmingDelete(true)} tone="danger" />}
      <AppButton label="Back to jobs" onPress={() => router.back()} tone="quiet" />
    </Screen>
  );
}
