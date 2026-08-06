import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { useAppController } from '../../src/controllers/AppController';
import { AppButton, Card, Eyebrow, Screen, Title, uiStyles } from '../../src/components/primitives';
import { tokens } from '../../src/theme/tokens';

export default function SettingsScreen() {
  const router = useRouter();
  const { actions, history } = useAppController();
  const [receipt, setReceipt] = useState<string | null>(null);
  const [deleteText, setDeleteText] = useState('');
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);
  const [busy, setBusy] = useState(false);

  const clearConsent = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await actions.resetConsent();
      setReceipt('AI data consent was reset. You will be asked again before analysis.');
    } catch {
      setReceipt('AI data consent could not be reset.');
    } finally {
      setBusy(false);
    }
  };

  const cleanCache = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await actions.cleanupCache();
      setReceipt(result.verified ? 'Temporary files are clean.' : 'Temporary files could not be verified as clean.');
    } catch {
      setReceipt('Temporary files could not be verified as clean.');
    } finally {
      setBusy(false);
    }
  };

  const deleteAll = async () => {
    if (busy || deleteText !== 'DELETE') return;
    setBusy(true);
    try {
      const result = await history.deleteAll();
      setReceipt(`Deleted ${result.deletedReports} local ${result.deletedReports === 1 ? 'report' : 'reports'} and ${result.deletedTempFiles} temporary ${result.deletedTempFiles === 1 ? 'file' : 'files'}.`);
      setDeleteText('');
    } catch {
      setReceipt('Local reports were not deleted. No success receipt was issued.');
    } finally {
      setConfirmingDeleteAll(false);
      setBusy(false);
    }
  };

  return (
    <Screen bottomInset="tab-bar">
      <View>
        <Eyebrow>Resume.AI · version {actions.appVersion}</Eyebrow>
        <Title>Settings & privacy.</Title>
      </View>
      <Card>
        <Text style={uiStyles.sectionTitle}>How data moves</Text>
        <Text style={uiStyles.body}>Reports are optional and local to this device. Resume and job input is transient.</Text>
        <Text style={uiStyles.muted}>After consent, Resume.AI’s server extracts supported PDFs and sends resume text and optional job-description text to Groq for feedback.</Text>
        <Text style={uiStyles.muted}>Groq retains usage metadata and may retain inference content for up to 30 days; this project’s Zero Data Retention setting is unverified. Render application logs are retained for 7, 14, or 30 days by plan, while app-controlled logs are content-free.</Text>
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>Private controls</Text>
        <AppButton label="Reset AI data consent" onPress={() => { void clearConsent(); }} disabled={busy} tone="secondary" />
        <AppButton label="Clean temporary files" onPress={() => { void cleanCache(); }} disabled={busy} tone="secondary" />
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>Read before relying</Text>
        <Text style={uiStyles.muted}>Resume.AI cannot reproduce every applicant tracking system, promise interviews, or determine whether an employer will select you. Verify every AI suggestion.</Text>
        <AppButton label="Read privacy details" onPress={() => router.push('/privacy')} tone="quiet" />
        <AppButton label="Get support" onPress={() => router.push('/support')} tone="quiet" />
      </Card>
      <Card style={styles.dangerCard}>
        <Text style={uiStyles.sectionTitle}>Delete all local reports</Text>
        <Text style={uiStyles.muted}>Type DELETE exactly. You will confirm once more before the local transaction runs.</Text>
        <TextInput
          accessibilityLabel="Type DELETE to delete all saved reports"
          autoCapitalize="characters"
          autoCorrect={false}
          value={deleteText}
          onChangeText={setDeleteText}
          editable={!busy}
          style={styles.deleteInput}
        />
        <AppButton
          label="Delete all local reports"
          onPress={() => setConfirmingDeleteAll(true)}
          disabled={busy || deleteText !== 'DELETE'}
          tone="danger"
        />
      </Card>
      {confirmingDeleteAll ? (
        <Card style={styles.dangerCard}>
          <Text accessibilityRole="header" style={uiStyles.sectionTitle}>Delete every saved report?</Text>
          <Text accessibilityRole="alert" style={uiStyles.muted}>This deletes all local reports and verifies abandoned temporary-file cleanup. It cannot be undone.</Text>
          <AppButton label="Keep local reports" onPress={() => setConfirmingDeleteAll(false)} tone="quiet" />
          <AppButton label="Confirm delete all" onPress={() => { void deleteAll(); }} tone="danger" />
        </Card>
      ) : null}
      {receipt !== null ? <Text accessibilityRole="alert" style={styles.receipt}>{receipt}</Text> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  dangerCard: { borderColor: tokens.color.danger },
  deleteInput: {
    minHeight: tokens.target.minimum,
    borderColor: tokens.color.danger,
    borderWidth: 1,
    borderRadius: tokens.radius.control,
    color: tokens.color.text,
    backgroundColor: tokens.color.background,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 1.5,
    paddingHorizontal: 14,
  },
  receipt: { color: tokens.color.accent, fontSize: 15, lineHeight: 22 },
});
