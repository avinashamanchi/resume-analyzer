import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { useAppController } from '../../src/controllers/AppController';
import { AppButton, Card, Eyebrow, Screen, Title, uiStyles } from '../../src/components/primitives';
import { tokens } from '../../src/theme/tokens';
import { useBilling } from '../../src/billing/BillingProvider';
import { useLocalErasure } from '../../src/privacy/LocalErasureProvider';

export default function SettingsScreen() {
  const router = useRouter();
  const { actions } = useAppController();
  const billing = useBilling();
  const localErasure = useLocalErasure();
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
      if (await localErasure.eraseAll()) {
        setReceipt('All active local data was verified as cleared.');
        setDeleteText('');
      } else {
        setReceipt('All local data could not be verified as cleared. No success receipt was issued.');
      }
    } catch {
      setReceipt('All local data could not be verified as cleared. No success receipt was issued.');
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
        <Text style={uiStyles.sectionTitle}>{billing.entitlementActive ? 'Resume.AI Pro' : 'Resume.AI Free'}</Text>
        <Text style={uiStyles.muted}>{billing.entitlementActive
          ? 'Up to 10,000 local reports, 200 resume versions, 500 tracked jobs, and PDF exports are active.'
          : 'Analysis remains available. Free includes 3 local reports, 1 resume version, and 3 tracked jobs.'}</Text>
        {billing.allowance !== null ? (
          <Text style={uiStyles.body}>{billing.allowance.used} of {billing.allowance.limit} AI feedback requests used this month.</Text>
        ) : <Text style={uiStyles.muted}>Verified monthly AI feedback usage is temporarily unavailable.</Text>}
        {billing.planStatus === 'pro_verification_needed' ? (
          <Text accessibilityRole="alert" style={uiStyles.muted}>A StoreKit entitlement exists, but Pro stays locked until server verification succeeds.</Text>
        ) : null}
        <AppButton label="View Free and Pro plans" onPress={() => router.push('/upgrade')} tone="secondary" />
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>How data moves</Text>
        <Text style={uiStyles.body}>Reports are optional. Saved reports, reviewed resume versions, revisions, job labels, and job notes use separate app-local stores and never sync to Resume.AI’s server.</Text>
        <Text style={uiStyles.muted}>Raw/original PDF bytes, filenames, resume-input fields, job-description-input fields, installation tokens, and request identifiers are not stored in local reports.</Text>
        <Text style={uiStyles.muted}>Generated feedback and bullet drafts may quote, transform, or restate names, contact information, resume content, or job-description content.</Text>
        <Text style={uiStyles.muted}>Review generated feedback before saving, sharing, or allowing it to enter device backups.</Text>
        <Text style={uiStyles.muted}>Saved reports, resume versions, revisions, and job notes may be included in iPhone or iPad backups stored in iCloud or on a Mac or PC. iCloud backups are always encrypted, but iCloud Backup is end-to-end encrypted only when Advanced Data Protection is enabled. Computer backups are not encrypted by default; encryption depends on the user enabling Encrypt local backup. Restoring an existing backup may restore local data deleted from the active app.</Text>
        <Text style={uiStyles.muted}>The signed iOS app keeps raw PDF bytes on this device. PDFKit or Apple Vision extracts text locally; only text you review and explicitly submit is sent to Resume.AI’s service, and optional AI feedback may send that reviewed text to Groq.</Text>
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
        <AppButton label="Read Terms of Use" onPress={() => router.push('/terms')} tone="quiet" />
        <AppButton label="Open troubleshooting" onPress={() => router.push('/support')} tone="quiet" />
      </Card>
      <Card style={styles.dangerCard}>
        <Text style={uiStyles.sectionTitle}>Delete all local data</Text>
        <Text style={uiStyles.muted}>This clears the current analysis session, saved reports, temporary files, resume versions and revisions, and tracked jobs. Type DELETE exactly, then confirm once more.</Text>
        <TextInput
          accessibilityLabel="Type DELETE to delete all local data"
          autoCapitalize="characters"
          autoCorrect={false}
          value={deleteText}
          onChangeText={setDeleteText}
          editable={!busy && !localErasure.busy}
          style={styles.deleteInput}
        />
        <AppButton
          label="Delete all local data"
          onPress={() => setConfirmingDeleteAll(true)}
          disabled={busy || localErasure.busy || deleteText !== 'DELETE'}
          tone="danger"
        />
      </Card>
      {confirmingDeleteAll ? (
        <Card style={styles.dangerCard}>
          <Text accessibilityRole="header" style={uiStyles.sectionTitle}>Delete every active local data store?</Text>
          <Text accessibilityRole="alert" style={uiStyles.muted}>A content-free recovery marker keeps unfinished deletion phases pending after an interruption. Restoring an existing device backup may restore data deleted from the active app.</Text>
          <AppButton label="Keep local data" onPress={() => setConfirmingDeleteAll(false)} tone="quiet" />
          <AppButton label="Confirm delete all" onPress={() => { void deleteAll(); }} tone="danger" />
        </Card>
      ) : null}
      {receipt !== null ? <Text accessibilityRole="alert" style={styles.receipt}>{receipt}</Text> : null}
      {receipt === null && localErasure.message !== null ? <Text accessibilityRole="alert" style={styles.receipt}>{localErasure.message}</Text> : null}
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
