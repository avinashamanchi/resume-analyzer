import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import { useBilling } from '../src/billing/BillingProvider';
import { AppButton, Card, Eyebrow, Screen, Title, uiStyles } from '../src/components/primitives';
import { useAppController } from '../src/controllers/AppController';
import { compareVersions } from '../src/workspace/compareVersions';
import type {
  ResumeVersion,
  VersionComparison,
  VersionSnapshot,
  WorkspaceCursor,
} from '../src/workspace/contracts';
import { isVerifiedWorkspacePro } from '../src/workspace/plan';
import { useWorkspaceData } from '../src/workspace/WorkspaceProvider';

const CURRENT_VERSION_ID = '00000000-0000-4000-8000-000000000001';
const PAGE_SIZE = 25;

type Candidate = Readonly<{
  version: ResumeVersion;
  snapshot: VersionSnapshot;
}>;

type Selection = Readonly<{
  left: Candidate;
  right: Candidate;
}>;

type SavedVersionPage = Readonly<{
  items: readonly ResumeVersion[];
  nextCursor: WorkspaceCursor | null;
}>;

function delta(value: number | null): string {
  if (value === null) return 'not comparable';
  return value > 0 ? `+${value}` : String(value);
}

function latestCandidate(
  aggregate: Awaited<ReturnType<NonNullable<ReturnType<typeof useWorkspaceData>['repository']>['getVersion']>>,
): Candidate | null {
  if (aggregate === null) return null;
  const snapshot = aggregate.snapshots.find(item => item.id === aggregate.version.latestSnapshotId);
  return snapshot === undefined ? null : { version: aggregate.version, snapshot };
}

export default function CompareScreen() {
  const router = useRouter();
  const data = useWorkspaceData();
  const billing = useBilling();
  const { analysis } = useAppController();
  const [pages, setPages] = useState<readonly SavedVersionPage[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pageBusy, setPageBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const verifiedPro = isVerifiedWorkspacePro(billing.verifiedPlan);

  const current = useMemo<Candidate | null>(() => {
    const source = analysis.state.source;
    const result = analysis.state.result;
    if (source === null || source.kind === 'pdf' || result === null) return null;
    const createdAt = '1970-01-01T00:00:00.000Z';
    const snapshot: VersionSnapshot = {
      id: result.analysisId,
      versionId: CURRENT_VERSION_ID,
      createdAt,
      resumeText: source.text,
      score: result.score,
      keywords: result.feedback?.matchedKeywords ?? [],
    };
    return {
      version: {
        id: CURRENT_VERSION_ID,
        title: 'Current unsaved analysis',
        roleLabel: null,
        createdAt,
        updatedAt: createdAt,
        latestSnapshotId: snapshot.id,
      },
      snapshot,
    };
  }, [analysis.state.result, analysis.state.source]);

  useEffect(() => {
    let active = true;
    if (data.status !== 'ready') {
      setLoaded(data.status !== 'loading');
      if (data.status === 'blocked') setMessage('The private workspace could not be opened safely.');
      return () => { active = false; };
    }
    setLoaded(false);
    setMessage(null);
    void data.repository.listVersions({ before: null, limit: PAGE_SIZE }).then(async page => {
      if (!active) return null;
      setPages([page]);
      setPageIndex(0);
      const compareSaved = verifiedPro && page.items.length >= 2;
      if (!compareSaved && (page.items.length < 1 || current === null)) return null;
      const leftVersion = compareSaved ? page.items[1] : page.items[0];
      const left = latestCandidate(await data.repository.getVersion(leftVersion.id));
      if (left === null) return null;
      if (!compareSaved) return { left, right: current! };
      const right = latestCandidate(await data.repository.getVersion(page.items[0].id));
      return right === null ? null : { left, right };
    }).then(result => {
      if (!active) return;
      setSelection(result);
      setLoaded(true);
      if (result === null) setMessage(current === null
        ? 'Save another version or finish a current reviewed-text analysis to compare.'
        : 'Save one local version to compare it with the current analysis.');
    }).catch(() => {
      if (!active) return;
      setLoaded(true);
      setMessage('These local versions could not be compared safely.');
    });
    return () => { active = false; };
  }, [current, data, verifiedPro]);

  const comparison = useMemo<VersionComparison | null>(() => {
    if (selection === null) return null;
    try {
      return compareVersions(selection.left.snapshot, selection.right.snapshot);
    } catch {
      return null;
    }
  }, [selection]);

  const choose = async (side: 'left' | 'right', version: ResumeVersion) => {
    if (data.status !== 'ready' || pageBusy) return;
    const other = side === 'left' ? selection?.right : selection?.left;
    if (other?.version.id === version.id) {
      setMessage('Choose two different versions.');
      return;
    }
    setPageBusy(true);
    try {
      const candidate = latestCandidate(await data.repository.getVersion(version.id));
      if (candidate === null) throw new Error('missing local candidate');
      if (selection === null) {
        if (current === null || current.version.id === candidate.version.id) {
          setMessage('Choose another local candidate.');
        } else {
          setSelection(side === 'left'
            ? { left: candidate, right: current }
            : { left: current, right: candidate });
          setMessage(null);
        }
      } else {
        setSelection(side === 'left'
          ? { ...selection, left: candidate }
          : { ...selection, right: candidate });
        setMessage(null);
      }
    } catch {
      setMessage('That local version could not be opened safely.');
    } finally {
      setPageBusy(false);
    }
  };

  const chooseCurrent = (side: 'left' | 'right') => {
    if (current === null || selection === null) return;
    const other = side === 'left' ? selection.right : selection.left;
    if (other.version.id === current.version.id) {
      setMessage('Choose two different versions.');
      return;
    }
    setSelection(side === 'left'
      ? { ...selection, left: current }
      : { ...selection, right: current });
    setMessage(null);
  };

  const loadOlder = async () => {
    if (data.status !== 'ready' || pageBusy) return;
    const page = pages[pageIndex];
    if (page?.nextCursor === null || page === undefined) return;
    if (pageIndex + 1 < pages.length) {
      setPageIndex(pageIndex + 1);
      return;
    }
    setPageBusy(true);
    try {
      const next = await data.repository.listVersions({ before: page.nextCursor, limit: PAGE_SIZE });
      setPages(currentPages => [...currentPages, next]);
      setPageIndex(pageIndex + 1);
      setMessage(null);
    } catch {
      setMessage('Older local versions could not be loaded safely.');
    } finally {
      setPageBusy(false);
    }
  };

  const visiblePage = pages[pageIndex] ?? null;

  return (
    <Screen>
      <View><Eyebrow>Deterministic and offline</Eyebrow><Title>Version comparison.</Title></View>
      <Text style={uiStyles.muted}>This comparison uses only bounded local score, keyword, and line differences. It makes no network request.</Text>
      {verifiedPro && visiblePage !== null ? (
        <Card>
          <Text style={uiStyles.sectionTitle}>Choose two saved versions</Text>
          <Text style={uiStyles.muted}>Only the selected resume bodies are opened. The list is paged 25 labels at a time.</Text>
          {current !== null ? (
            <Card>
              <Text style={uiStyles.body}>Current unsaved analysis</Text>
              <AppButton label="Use current analysis as first version" onPress={() => chooseCurrent('left')} disabled={pageBusy || selection?.left.version.id === CURRENT_VERSION_ID} tone="quiet" />
              <AppButton label="Use current analysis as second version" onPress={() => chooseCurrent('right')} disabled={pageBusy || selection?.right.version.id === CURRENT_VERSION_ID} tone="quiet" />
            </Card>
          ) : null}
          {visiblePage.items.map(version => (
            <Card key={version.id}>
              <Text style={uiStyles.body}>{version.title}</Text>
              <AppButton label={`Use ${version.title} as first version`} onPress={() => { void choose('left', version); }} disabled={pageBusy || selection?.left.version.id === version.id} tone="quiet" />
              <AppButton label={`Use ${version.title} as second version`} onPress={() => { void choose('right', version); }} disabled={pageBusy || selection?.right.version.id === version.id} tone="quiet" />
            </Card>
          ))}
          {pageIndex > 0 ? <AppButton label="Load newer versions" onPress={() => setPageIndex(index => Math.max(0, index - 1))} disabled={pageBusy} tone="secondary" /> : null}
          {visiblePage.nextCursor !== null ? <AppButton label="Load older versions" onPress={() => { void loadOlder(); }} disabled={pageBusy} tone="secondary" /> : null}
        </Card>
      ) : null}
      {!loaded ? <Text accessibilityRole="alert" style={uiStyles.muted}>Comparing local versions…</Text> : null}
      {message !== null ? <Text accessibilityRole="alert" style={uiStyles.muted}>{message}</Text> : null}
      {selection !== null && comparison !== null ? (
        <>
          {selection.left.version.id === CURRENT_VERSION_ID || selection.right.version.id === CURRENT_VERSION_ID ? (
            <Text style={uiStyles.muted}>The current reviewed analysis remains unsaved. Comparing it does not write to local storage.</Text>
          ) : null}
          <Card>
            <Text style={uiStyles.sectionTitle}>{selection.left.version.title} → {selection.right.version.title}</Text>
            <Text style={uiStyles.body}>Total score: {delta(comparison.scoreDelta)}</Text>
            <Text style={uiStyles.body}>Structure: {delta(comparison.componentDeltas.structure)}</Text>
            <Text style={uiStyles.body}>Impact: {delta(comparison.componentDeltas.impact)}</Text>
            <Text style={uiStyles.body}>Readability: {delta(comparison.componentDeltas.readability)}</Text>
            <Text style={uiStyles.body}>Keywords: {delta(comparison.componentDeltas.keywords)}</Text>
          </Card>
          <Card>
            <Text style={uiStyles.sectionTitle}>Keyword changes</Text>
            <Text style={uiStyles.body}>Added: {comparison.addedKeywords.join(', ') || 'None'}</Text>
            <Text style={uiStyles.body}>Removed: {comparison.removedKeywords.join(', ') || 'None'}</Text>
          </Card>
          <Card>
            <Text style={uiStyles.sectionTitle}>Line changes</Text>
            {comparison.addedLines.map((line, index) => <Text key={`a-${index}`} style={uiStyles.body}>+ {line}</Text>)}
            {comparison.removedLines.map((line, index) => <Text key={`r-${index}`} style={uiStyles.body}>− {line}</Text>)}
            {comparison.truncated ? <Text style={uiStyles.muted}>Displayed changes were capped for device performance.</Text> : null}
          </Card>
        </>
      ) : null}
      <AppButton label="Back to versions" onPress={() => router.back()} tone="quiet" />
    </Screen>
  );
}
