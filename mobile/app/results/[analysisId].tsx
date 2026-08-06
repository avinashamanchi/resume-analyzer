import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  AppState,
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

type ShareAuthority = Readonly<{
  token: symbol;
  kind: 'text' | 'pdf';
  analysisId: string;
  routeEpoch: number;
  report: LoadedReport;
  lifecycle: AbortController;
}>;

type DeleteAuthority = Readonly<{
  token: symbol;
  analysisId: string;
  routeEpoch: number;
  report: LoadedReport;
  lifecycle: AbortController;
}>;

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
  const id = Array.isArray(params.analysisId) ? params.analysisId[0] : params.analysisId;
  return <ResultsScreenContent key={id ?? 'missing'} id={id} exporter={exporter} />;
}

function ResultsScreenContent({
  id,
  exporter,
}: Readonly<{ id: string | undefined; exporter: ReportExporterPort }>) {
  const router = useRouter();
  const { actions, analysis, history } = useAppController();
  const [loadedReport, setLoadedReport] = useState<LoadedReport | null>(null);
  const [loaded, setLoaded] = useState(typeof id !== 'string');
  const [receipt, setReceipt] = useState<ReceiptNotice | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [preparingPdf, setPreparingPdf] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const mounted = useRef(true);
  const shareAuthority = useRef<ShareAuthority | null>(null);
  const deleteAuthority = useRef<DeleteAuthority | null>(null);
  const routeEpoch = 0;
  const currentReport = loaded ? loadedReport : null;
  const currentReportRef = useRef<LoadedReport | null>(currentReport);
  const headingRef = useRef<View | null>(null);
  const receiptRef = useRef<Text | null>(null);
  const deleteErrorRef = useRef<Text | null>(null);
  const receiptSequence = useRef(0);
  const saved = useMemo(
    () => history.reports.some(report => report.id === id),
    [history.reports, id],
  );
  const getReport = history.get;

  const publishReceipt = useCallback((message: string) => {
    receiptSequence.current += 1;
    setReceipt({ sequence: receiptSequence.current, routeEpoch, message });
  }, []);

  const routeIsCurrent = (authority: ShareAuthority): boolean => (
    mounted.current &&
    !authority.lifecycle.signal.aborted &&
    id === authority.analysisId &&
    routeEpoch === authority.routeEpoch &&
    currentReportRef.current === authority.report
  );

  const beginShare = (
    kind: 'text' | 'pdf',
    analysisId: string | undefined,
    epoch: number,
    report: LoadedReport,
  ): ShareAuthority | null => {
    if (
      !mounted.current ||
      typeof analysisId !== 'string' ||
      id !== analysisId ||
      routeEpoch !== epoch ||
      currentReportRef.current !== report ||
      report.result.analysisId !== analysisId ||
      report.exportRecord.id !== analysisId ||
      shareAuthority.current !== null ||
      deleteAuthority.current !== null
    ) return null;
    const authority = Object.freeze({
      token: Symbol('results-share'),
      kind,
      analysisId,
      routeEpoch: epoch,
      report,
      lifecycle: new AbortController(),
    });
    shareAuthority.current = authority;
    setSharing(true);
    setPreparingPdf(kind === 'pdf');
    return authority;
  };

  const finishShare = (authority: ShareAuthority): void => {
    if (shareAuthority.current !== authority) return;
    shareAuthority.current = null;
    if (mounted.current) {
      setSharing(false);
      setPreparingPdf(false);
    }
  };

  const deleteIsCurrent = (authority: DeleteAuthority): boolean => (
    mounted.current &&
    !authority.lifecycle.signal.aborted &&
    deleteAuthority.current === authority &&
    id === authority.analysisId &&
    routeEpoch === authority.routeEpoch &&
    currentReportRef.current === authority.report
  );

  const beginDelete = (
    analysisId: string | undefined,
    epoch: number,
    report: LoadedReport,
  ): DeleteAuthority | null => {
    if (
      !mounted.current ||
      typeof analysisId !== 'string' ||
      id !== analysisId ||
      routeEpoch !== epoch ||
      currentReportRef.current !== report ||
      report.result.analysisId !== analysisId ||
      report.exportRecord.id !== analysisId ||
      shareAuthority.current !== null ||
      deleteAuthority.current !== null
    ) return null;
    const authority = Object.freeze({
      token: Symbol('results-delete'),
      analysisId,
      routeEpoch: epoch,
      report,
      lifecycle: new AbortController(),
    });
    deleteAuthority.current = authority;
    setDeleting(true);
    setDeleteError(null);
    publishReceipt('Deleting local report…');
    return authority;
  };

  const finishDelete = (authority: DeleteAuthority): void => {
    if (deleteAuthority.current !== authority) return;
    deleteAuthority.current = null;
    if (mounted.current) setDeleting(false);
  };

  useEffect(() => {
    mounted.current = true;
    const appStateSubscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'inactive' || nextState === 'background') {
        shareAuthority.current?.lifecycle.abort();
      }
    });
    return () => {
      mounted.current = false;
      shareAuthority.current?.lifecycle.abort();
      deleteAuthority.current?.lifecycle.abort();
      appStateSubscription.remove();
    };
  }, []);

  useEffect(() => {
    void exporter.cleanupAbandoned().catch(() => {
      if (mounted.current) {
        publishReceipt('A temporary PDF could not be verified as removed. Reopen this report to retry cleanup.');
      }
    });
  }, [exporter, publishReceipt]);

  useEffect(() => {
    currentReportRef.current = currentReport;
  }, [currentReport]);

  useEffect(() => {
    let active = true;
    if (typeof id !== 'string') return () => { active = false; };
    void getReport(id).then(value => {
      if (!active) return;
      setLoadedReport(value === null ? null : loadedFromDisplay(value));
      setLoaded(true);
    });
    return () => { active = false; };
  }, [getReport, id]);

  useEffect(() => {
    if (loadedReport !== null) focusNode(headingRef.current);
  }, [loadedReport]);

  useEffect(() => {
    if (receipt === null || receipt.routeEpoch !== routeEpoch) return;
    AccessibilityInfo.announceForAccessibility(receipt.message);
    focusNode(deleteError === null ? receiptRef.current : deleteErrorRef.current);
  }, [deleteError, receipt, routeEpoch]);

  if (!loaded) {
    return <Screen><Eyebrow>Resume.AI</Eyebrow><Title>Opening report…</Title></Screen>;
  }
  if (currentReport === null) {
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

  const { result, exportRecord } = currentReport;

  const save = async () => {
    const savedReport = await history.saveCurrent();
    if (mounted.current) {
      publishReceipt(savedReport === null
        ? 'The report could not be saved locally.'
        : 'Saved in the app’s local report store.');
    }
  };

  const shareText = async () => {
    const authority = beginShare('text', id, routeEpoch, currentReport);
    if (authority === null) return;
    try {
      await actions.shareSummary(result);
      if (routeIsCurrent(authority)) publishReceipt('Text share sheet closed.');
    } catch {
      if (routeIsCurrent(authority)) publishReceipt('The text summary was not shared.');
    } finally {
      finishShare(authority);
    }
  };

  const sharePdf = async () => {
    const authority = beginShare('pdf', id, routeEpoch, currentReport);
    if (authority === null) return;
    publishReceipt('Preparing a PDF report…');
    try {
      const exportReceipt = await exporter.export(exportRecord);
      if (!routeIsCurrent(authority)) {
        await exporter.discard(exportReceipt);
        return;
      }
      await exporter.share(exportReceipt, authority.lifecycle.signal);
      if (routeIsCurrent(authority)) {
        publishReceipt('Share sheet closed. The temporary PDF was removed.');
      }
    } catch (error) {
      if (!routeIsCurrent(authority)) return;
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
    const authority = beginDelete(id, routeEpoch, currentReport);
    if (authority === null) return;
    try {
      const deleted = await history.delete(result.analysisId);
      if (!deleteIsCurrent(authority)) return;
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
      if (deleteIsCurrent(authority)) {
        const message = 'The local report was not deleted. Try again.';
        setDeleteError(message);
        publishReceipt(message);
      }
    } finally {
      finishDelete(authority);
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
          accessibilityHint={saved ? 'This report is already in the local report store.' : 'Saves this bounded report in the local report store.'}
          onPress={() => { void save(); }}
          disabled={saved || sharing || deleting}
        />
        <AppButton
          label="Share text summary"
          accessibilityHint="Opens the system share sheet with a bounded text summary."
          onPress={() => { void shareText(); }}
          disabled={sharing || deleting}
          tone="secondary"
        />
        <AppButton
          label={preparingPdf ? 'Preparing PDF report…' : 'Share PDF report'}
          accessibilityLabel="Share report"
          accessibilityHint="Creates a PDF report, opens the system share sheet, then removes the temporary file."
          onPress={() => { void sharePdf(); }}
          disabled={sharing || deleting}
          tone="secondary"
        />
        <AppButton
          label="New analysis"
          accessibilityHint="Clears the current analysis and returns to Analyze."
          onPress={() => { void startNew(); }}
          disabled={sharing || deleting}
          tone="quiet"
        />
        {saved ? (
          <AppButton
            label="Delete saved report"
            accessibilityHint="Opens a confirmation before deleting this local report."
            onPress={() => { setDeleteError(null); setConfirmDelete(true); }}
            disabled={sharing || deleting}
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
            <Text style={uiStyles.muted}>This removes the active local record. An existing device or iCloud backup may still contain it.</Text>
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
              disabled={deleting}
              tone="quiet"
            />
            <AppButton
              label={deleting ? 'Deleting local report…' : 'Confirm delete report'}
              accessibilityLabel="Confirm delete report"
              accessibilityHint="Deletes this bounded report from active local history; an existing backup may still contain it."
              onPress={() => { void deleteReport(); }}
              disabled={deleting}
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
