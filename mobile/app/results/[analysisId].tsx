import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  findNodeHandle,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { FeedbackSections } from '../../src/components/FeedbackSections';
import { AppButton, Card, Eyebrow, Screen, Title, uiStyles } from '../../src/components/primitives';
import { ScoreCard } from '../../src/components/ScoreCard';
import { useAppController, type DisplayReport } from '../../src/controllers/AppController';
import { AnalysisResponseSchema, type AnalysisResponse } from '../../src/domain/contracts';
import {
  ReportExportError,
  reportExporter,
  type ReportExporterPort,
} from '../../src/export/reportExporter';
import {
  ReportRecordSchema,
  type ReportRecord,
} from '../../src/storage/reportRepository';
import { tokens } from '../../src/theme/tokens';

type LoadedReport = Readonly<{
  result: AnalysisResponse;
  exportRecord: ReportRecord;
}>;

type ReceiptNotice = Readonly<{ sequence: number; routeEpoch: number; message: string }>;

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

function loadedFromDisplay(value: DisplayReport): LoadedReport | null {
  const result = analysisFromDisplay(value);
  if (result === null) return null;
  const stored = ReportRecordSchema.safeParse(value);
  if (stored.success) return { result, exportRecord: stored.data };
  const exportRecord = ReportRecordSchema.safeParse({
    id: result.analysisId,
    title: 'Resume analysis',
    createdAt: new Date().toISOString(),
    sourceType: result.sourceType,
    score: result.score,
    feedback: result.feedback,
  });
  if (!exportRecord.success) return null;
  return { result, exportRecord: exportRecord.data };
}

function focusNode(value: View | Text | null): void {
  if (value === null) return;
  try {
    const handle = findNodeHandle(value);
    if (handle !== null) AccessibilityInfo.setAccessibilityFocus(handle);
  } catch {
    // A screen disappearing during an async action has no remaining focus target.
  }
}

export function ResultsScreen({
  exporter = reportExporter,
}: Readonly<{ exporter?: ReportExporterPort }>) {
  const params = useLocalSearchParams<{ analysisId?: string | string[] }>();
  const router = useRouter();
  const { actions, analysis, history } = useAppController();
  const id = Array.isArray(params.analysisId) ? params.analysisId[0] : params.analysisId;
  const [loadedReport, setLoadedReport] = useState<LoadedReport | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadedId, setLoadedId] = useState<string | undefined>(undefined);
  const [receipt, setReceipt] = useState<ReceiptNotice | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [preparingPdf, setPreparingPdf] = useState(false);
  const mounted = useRef(true);
  const routeAuthority = useRef({ analysisId: id, epoch: 0 });
  if (routeAuthority.current.analysisId !== id) {
    routeAuthority.current = { analysisId: id, epoch: routeAuthority.current.epoch + 1 };
  }
  const routeEpoch = routeAuthority.current.epoch;
  const shareAuthority = useRef<symbol | null>(null);
  const headingRef = useRef<View | null>(null);
  const receiptRef = useRef<Text | null>(null);
  const deleteErrorRef = useRef<Text | null>(null);
  const receiptSequence = useRef(0);
  const saved = useMemo(
    () => history.reports.some(report => report.id === id),
    [history.reports, id],
  );

  const publishReceipt = (message: string) => {
    receiptSequence.current += 1;
    setReceipt({ sequence: receiptSequence.current, routeEpoch, message });
  };

  const routeIsCurrent = (analysisId: string | undefined, epoch: number): boolean => (
    mounted.current &&
    routeAuthority.current.analysisId === analysisId &&
    routeAuthority.current.epoch === epoch
  );

  const beginShare = (kind: 'text' | 'pdf'): symbol | null => {
    if (shareAuthority.current !== null) return null;
    const authority = Symbol('results-share');
    shareAuthority.current = authority;
    setSharing(true);
    setPreparingPdf(kind === 'pdf');
    return authority;
  };

  const finishShare = (authority: symbol): void => {
    if (shareAuthority.current !== authority) return;
    shareAuthority.current = null;
    if (mounted.current) {
      setSharing(false);
      setPreparingPdf(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    void exporter.cleanupAbandoned().catch(() => {
      if (mounted.current) {
        publishReceipt('A temporary PDF could not be verified as removed. Reopen this report to retry cleanup.');
      }
    });
  }, [exporter]);

  useEffect(() => {
    let active = true;
    setConfirmDelete(false);
    setDeleteError(null);
    if (typeof id !== 'string') {
      setLoadedReport(null);
      setLoadedId(id);
      setLoaded(true);
      return () => { active = false; };
    }
    void history.get(id).then(value => {
      if (!active) return;
      setLoadedReport(value === null ? null : loadedFromDisplay(value));
      setLoadedId(id);
      setLoaded(true);
    });
    return () => { active = false; };
  }, [history.get, id]);

  useEffect(() => {
    if (loadedReport !== null) focusNode(headingRef.current);
  }, [loadedReport]);

  useEffect(() => {
    if (receipt === null || receipt.routeEpoch !== routeEpoch) return;
    AccessibilityInfo.announceForAccessibility(receipt.message);
    focusNode(deleteError === null ? receiptRef.current : deleteErrorRef.current);
  }, [deleteError, receipt, routeEpoch]);

  if (!loaded || loadedId !== id) {
    return <Screen><Eyebrow>Resume.AI</Eyebrow><Title>Opening report…</Title></Screen>;
  }
  if (loadedReport === null) {
    return (
      <Screen>
        <Eyebrow>Local report</Eyebrow>
        <Title>Report not found.</Title>
        <Text style={uiStyles.muted}>This analysis is not available in the current session or local history.</Text>
        <AppButton
          label="Start a new analysis"
          accessibilityHint="Returns to the Analyze tab."
          onPress={() => router.replace('/(tabs)')}
        />
      </Screen>
    );
  }

  const { result, exportRecord } = loadedReport;

  const save = async () => {
    const savedReport = await history.saveCurrent();
    if (mounted.current) {
      publishReceipt(savedReport === null
        ? 'The report could not be saved locally.'
        : 'Saved locally on this device.');
    }
  };

  const shareText = async () => {
    const authority = beginShare('text');
    if (authority === null) return;
    const actionId = id;
    const actionEpoch = routeEpoch;
    try {
      await actions.shareSummary(result);
      if (routeIsCurrent(actionId, actionEpoch)) publishReceipt('Text share sheet closed.');
    } catch {
      if (routeIsCurrent(actionId, actionEpoch)) publishReceipt('The text summary was not shared.');
    } finally {
      finishShare(authority);
    }
  };

  const sharePdf = async () => {
    const authority = beginShare('pdf');
    if (authority === null) return;
    const actionId = id;
    const actionEpoch = routeEpoch;
    publishReceipt('Preparing a PDF report…');
    try {
      const exportReceipt = await exporter.export(exportRecord);
      if (!routeIsCurrent(actionId, actionEpoch)) {
        await exporter.discard(exportReceipt);
        return;
      }
      await exporter.share(exportReceipt);
      if (routeIsCurrent(actionId, actionEpoch)) {
        publishReceipt('Share sheet closed. The temporary PDF was removed.');
      }
    } catch (error) {
      if (!routeIsCurrent(actionId, actionEpoch)) return;
      publishReceipt(
        error instanceof ReportExportError && error.code === 'cleanup_failed'
          ? 'The temporary PDF could not be verified as removed. Reopen this report to retry cleanup.'
          : 'The PDF report was not shared.',
      );
    } finally {
      finishShare(authority);
    }
  };

  const deleteReport = async () => {
    try {
      const deleted = await history.delete(result.analysisId);
      if (!mounted.current) return;
      if (deleted) {
        setConfirmDelete(false);
        setDeleteError(null);
        publishReceipt('Local report deleted.');
      } else {
        const message = 'The local report was not deleted. Try again.';
        setDeleteError(message);
        publishReceipt(message);
      }
    } catch {
      if (mounted.current) {
        const message = 'The local report was not deleted. Try again.';
        setDeleteError(message);
        publishReceipt(message);
      }
    }
  };

  const startNew = async () => {
    await analysis.commands.reset();
    if (mounted.current) router.replace('/(tabs)');
  };

  return (
    <Screen>
      <View
        ref={headingRef}
        accessible
        accessibilityLabel="Analysis complete. Your editorial read."
        accessibilityRole="header"
        style={styles.heading}>
        <Eyebrow>Analysis complete</Eyebrow>
        <Title>Your editorial read.</Title>
        <Text style={uiStyles.muted}>Use the score as a structured review signal, then judge each suggestion against the role and your real experience.</Text>
      </View>
      <ScoreCard score={result.score} />
      <FeedbackSections result={result} />
      <Card>
        <Text style={uiStyles.sectionTitle}>Keep or share</Text>
        <Text style={uiStyles.muted}>Nothing saves automatically. A PDF is created only after you choose Share report, contains the bounded report rather than source material, and is removed when the share sheet closes or fails.</Text>
        <AppButton
          label={saved ? 'Saved locally' : 'Save locally'}
          accessibilityHint={saved ? 'This report is already saved on this device.' : 'Saves this bounded report on this device.'}
          onPress={() => { void save(); }}
          disabled={saved || sharing}
        />
        <AppButton
          label="Share text summary"
          accessibilityHint="Opens the system share sheet with a bounded text summary."
          onPress={() => { void shareText(); }}
          disabled={sharing}
          tone="secondary"
        />
        <AppButton
          label={preparingPdf ? 'Preparing PDF report…' : 'Share PDF report'}
          accessibilityLabel="Share report"
          accessibilityHint="Creates a PDF report, opens the system share sheet, then removes the temporary file."
          onPress={() => { void sharePdf(); }}
          disabled={sharing}
          tone="secondary"
        />
        <AppButton
          label="New analysis"
          accessibilityHint="Clears the current analysis and returns to Analyze."
          onPress={() => { void startNew(); }}
          disabled={sharing}
          tone="quiet"
        />
        {saved ? (
          <AppButton
            label="Delete saved report"
            accessibilityHint="Opens a confirmation before deleting this local report."
            onPress={() => { setDeleteError(null); setConfirmDelete(true); }}
            disabled={sharing}
            tone="danger"
          />
        ) : null}
      </Card>
      {receipt !== null && receipt.routeEpoch === routeEpoch ? (
        <Text
          ref={receiptRef}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={styles.receipt}>
          {receipt.message}
        </Text>
      ) : null}
      {confirmDelete ? (
        <View
          accessibilityViewIsModal
          accessibilityLabel="Delete this local report?"
          testID="delete-result-modal">
          <Card style={styles.deleteCard}>
            <Text accessibilityRole="header" style={uiStyles.sectionTitle}>Delete this local report?</Text>
            <Text style={uiStyles.muted}>This cannot be undone.</Text>
            {deleteError !== null ? (
              <Text
                ref={deleteErrorRef}
                accessibilityRole="alert"
                accessibilityLiveRegion="assertive"
                testID="delete-result-error"
                style={styles.deleteError}>
                {deleteError}
              </Text>
            ) : null}
            <AppButton
              label="Keep report"
              accessibilityHint="Returns to the report without deleting it."
              onPress={() => { setDeleteError(null); setConfirmDelete(false); }}
              tone="quiet"
            />
            <AppButton
              label="Confirm delete report"
              accessibilityHint="Permanently deletes this bounded report from local history."
              onPress={() => { void deleteReport(); }}
              tone="danger"
            />
          </Card>
        </View>
      ) : null}
    </Screen>
  );
}

export default ResultsScreen;

const styles = StyleSheet.create({
  heading: { rowGap: 10 },
  receipt: { color: tokens.color.accent, fontSize: 15, lineHeight: 22 },
  deleteError: { color: tokens.color.warning, fontSize: 15, lineHeight: 22 },
  deleteCard: { borderColor: tokens.color.danger },
});
