import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { AppButton, Card, Eyebrow, Screen, Title, uiStyles } from '../../src/components/primitives';
import type { JobRecord, ResumeVersion } from '../../src/workspace/contracts';
import { useWorkspaceData } from '../../src/workspace/WorkspaceProvider';

export default function WorkspaceScreen() {
  const router = useRouter();
  const data = useWorkspaceData();
  const [versions, setVersions] = useState<readonly ResumeVersion[]>([]);
  const [jobs, setJobs] = useState<readonly JobRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (data.status !== 'ready') {
      setLoading(data.status === 'loading');
      return () => { active = false; };
    }
    void Promise.all([
      data.repository.listVersions({ before: null, limit: 5 }),
      data.repository.listJobs({ before: null, limit: 5 }),
    ]).then(([versionPage, jobPage]) => {
      if (!active) return;
      setVersions(versionPage.items);
      setJobs(jobPage.items);
      setError(null);
      setLoading(false);
    }).catch(() => {
      if (!active) return;
      setError('The local career workspace did not load.');
      setLoading(false);
    });
    return () => { active = false; };
  }, [data]);

  return (
    <Screen bottomInset="tab-bar">
      <View>
        <Eyebrow>Private on-device workspace</Eyebrow>
        <Title>Build toward the role.</Title>
      </View>
      <Card>
        <Text style={uiStyles.sectionTitle}>Local by design</Text>
        <Text style={uiStyles.muted}>
          Resume versions, job notes, and comparisons stay in this app’s local databases and do not sync to a server. Nothing saves until you press a save button. Device backups may include this local content.
        </Text>
      </Card>
      {data.status === 'blocked' ? (
        <Card><Text accessibilityRole="alert" style={uiStyles.muted}>The private workspace could not be opened safely. Analysis and report history remain available.</Text></Card>
      ) : loading ? (
        <Text accessibilityRole="alert" style={uiStyles.muted}>Opening private workspace…</Text>
      ) : error !== null ? (
        <Text accessibilityRole="alert" style={uiStyles.muted}>{error}</Text>
      ) : (
        <>
          <Card>
            <Text style={uiStyles.sectionTitle}>Resume versions</Text>
            <Text style={uiStyles.muted}>{versions.length === 0 ? 'No saved versions yet.' : `${versions.length} recent version${versions.length === 1 ? '' : 's'} on this device.`}</Text>
            <AppButton label="Open resume versions" onPress={() => router.push('/versions')} />
            {versions.length >= 1 ? (
              <AppButton label="Open local version comparison" onPress={() => router.push('/compare')} tone="secondary" />
            ) : null}
          </Card>
          <Card>
            <Text style={uiStyles.sectionTitle}>Job tracker</Text>
            <Text style={uiStyles.muted}>{jobs.length === 0 ? 'No jobs tracked yet.' : `${jobs.length} recent job${jobs.length === 1 ? '' : 's'} on this device.`}</Text>
            <AppButton label="Open job tracker" onPress={() => router.push('/jobs')} />
          </Card>
        </>
      )}
    </Screen>
  );
}
