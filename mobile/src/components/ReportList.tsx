import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { ReportRecord } from '../storage/reportRepository';
import { tokens } from '../theme/tokens';
import { AppButton, Card, uiStyles } from './primitives';

const DELETE_FAILURE_MESSAGE = 'The local report was not deleted. Try again.';

function reportDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Saved locally';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function ReportList({
  reports,
  onOpen,
  onDelete,
  hasMore = false,
  hasNewer = false,
  loadingMore = false,
  onLoadMore = async () => {},
  onReturnToNewest = async () => {},
}: Readonly<{
  reports: readonly ReportRecord[];
  onOpen(id: string): void;
  onDelete(id: string): Promise<boolean>;
  hasMore?: boolean;
  hasNewer?: boolean;
  loadingMore?: boolean;
  onLoadMore?(): Promise<void>;
  onReturnToNewest?(): Promise<void>;
}>) {
  const [confirming, setConfirming] = useState<ReportRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const openConfirmation = (report: ReportRecord) => {
    setDeleteError(null);
    setConfirming(report);
  };

  const closeConfirmation = () => {
    if (deleting) return;
    setDeleteError(null);
    setConfirming(null);
  };

  const confirmDelete = async () => {
    if (confirming === null || deleting) return;
    const id = confirming.id;
    setDeleting(true);
    setDeleteError(null);
    let deleted = false;
    try {
      deleted = await onDelete(id);
    } catch {
      deleted = false;
    }
    if (!mounted.current) return;
    setDeleting(false);
    if (deleted) {
      setConfirming(null);
      return;
    }
    setDeleteError(DELETE_FAILURE_MESSAGE);
    try {
      AccessibilityInfo.announceForAccessibility(DELETE_FAILURE_MESSAGE);
    } catch {
      // The visible, content-free alert remains available if native announcement fails.
    }
  };

  return (
    <View style={styles.list}>
      <FlatList
        testID="report-list"
        data={reports}
        keyExtractor={report => report.id}
        renderItem={({ item: report }) => (
          <Card>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${report.title}`}
              onPress={() => onOpen(report.id)}
              style={styles.openTarget}>
              <Text style={styles.title}>{report.title}</Text>
              <Text style={uiStyles.caption}>{reportDate(report.createdAt)} · {report.sourceType === 'pdf' ? 'PDF' : 'Text'}</Text>
              <View style={styles.scoreLine}>
                <Text style={styles.score}>{report.score.readinessScore}/100</Text>
                <Text style={styles.scoreLabel}>{report.score.label}</Text>
              </View>
            </Pressable>
            <AppButton
              label="Delete"
              accessibilityLabel={`Delete ${report.title}`}
              onPress={() => openConfirmation(report)}
              tone="danger"
            />
          </Card>
        )}
        contentContainerStyle={styles.listContent}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={7}
        removeClippedSubviews
        onEndReached={() => {
          if (hasMore && !loadingMore) void onLoadMore();
        }}
        onEndReachedThreshold={0.35}
        ListFooterComponent={(
          <View style={styles.footer}>
            {loadingMore ? (
              <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={uiStyles.muted}>
                Loading older reports…
              </Text>
            ) : null}
            {hasMore ? (
              <AppButton
                label="Load older reports"
                onPress={() => { void onLoadMore(); }}
                disabled={loadingMore}
                tone="secondary"
              />
            ) : null}
            {hasNewer ? (
              <AppButton
                label="Return to newest reports"
                onPress={() => { void onReturnToNewest(); }}
                disabled={loadingMore}
                tone="quiet"
              />
            ) : null}
          </View>
        )}
      />
      {confirming !== null ? (
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={closeConfirmation}
          statusBarTranslucent>
          <View style={styles.backdrop}>
            <Pressable
              accessible={false}
              importantForAccessibility="no"
              style={StyleSheet.absoluteFill}
              onPress={closeConfirmation}
            />
            <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
              <View
                testID="delete-report-modal"
                accessibilityRole={'dialog' as never}
                accessibilityLabel="Delete saved report?"
                accessibilityViewIsModal
                style={styles.confirmation}>
                <Text accessibilityRole="header" style={uiStyles.sectionTitle}>Delete saved report?</Text>
                <Text style={uiStyles.muted}>This removes the report from active local history. Restoring an existing backup may restore reports deleted from the active app.</Text>
                {deleteError !== null ? (
                  <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.error}>{deleteError}</Text>
                ) : null}
                <AppButton label="Keep report" onPress={closeConfirmation} disabled={deleting} tone="quiet" />
                <AppButton label="Delete report" onPress={() => { void confirmDelete(); }} disabled={deleting} tone="danger" />
              </View>
            </SafeAreaView>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  listContent: { rowGap: tokens.space.md, paddingBottom: tokens.space.lg },
  footer: { rowGap: tokens.space.sm },
  openTarget: { minHeight: tokens.target.minimum, rowGap: 7 },
  title: { color: tokens.color.text, fontSize: 18, lineHeight: 24, fontWeight: '700' },
  scoreLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 10 },
  score: { color: tokens.color.text, fontSize: 25, lineHeight: 30, fontWeight: '800' },
  scoreLabel: { color: tokens.color.accent, fontSize: 15, lineHeight: 21, fontWeight: '700' },
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.68)',
  },
  safeArea: { flex: 1, justifyContent: 'flex-end' },
  confirmation: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 18,
    rowGap: tokens.space.sm,
    borderWidth: 1,
    borderColor: tokens.color.danger,
    borderRadius: tokens.radius.card,
    backgroundColor: tokens.color.surface,
  },
  error: { color: tokens.color.danger, fontSize: 15, lineHeight: 22 },
});
