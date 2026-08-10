import React, { useState } from 'react';
import { Text } from 'react-native';

import { useAppController } from '../src/controllers/AppController';
import { AppButton, Card, Eyebrow, Screen, Title, uiStyles } from '../src/components/primitives';

export default function SupportScreen() {
  const { actions } = useAppController();
  const [error, setError] = useState(false);
  const openSupport = async () => {
    setError(false);
    try {
      await actions.openSupport();
    } catch {
      setError(true);
    }
  };
  return (
    <Screen>
      <Eyebrow>Self-help</Eyebrow>
      <Title>Troubleshoot without sharing private data.</Title>
      <Card>
        <Text style={uiStyles.sectionTitle}>First-party support page</Text>
        <Text style={uiStyles.body}>Open the first-party page for content-free troubleshooting. The first-party page links to the public project issue tracker for bug reports. Never send or publish a resume, job description, token, request identifier, filename, contact detail, or other private data.</Text>
        <AppButton label="Open troubleshooting page" onPress={() => { void openSupport(); }} />
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>Local diagnostic checklist</Text>
        <Text style={uiStyles.muted}>Before opening a public issue, note only the app version, iOS version, what you tapped, and the stable error category shown on screen. Keep reports free of resume or job-description content, names, contact details, tokens, filenames, and request identifiers.</Text>
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>Feedback limits</Text>
        <Text style={uiStyles.muted}>Resume.AI provides deterministic readiness feedback and AI coaching. It is not an exact ATS or employment prediction, offers no hiring guarantee, and is not professional, legal, or employment advice.</Text>
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>Saved-report backups</Text>
        <Text style={uiStyles.muted}>Raw/original PDF bytes, filenames, resume-input fields, job-description-input fields, installation tokens, and request identifiers are not stored in local reports.</Text>
        <Text style={uiStyles.muted}>Generated feedback and bullet drafts may quote, transform, or restate names, contact information, resume content, or job-description content.</Text>
        <Text style={uiStyles.muted}>Review generated feedback before saving, sharing, or allowing it to enter device backups.</Text>
        <Text style={uiStyles.muted}>Saved reports may be included in iPhone or iPad backups stored in iCloud or on a Mac or PC. iCloud backups are always encrypted, but iCloud Backup is end-to-end encrypted only when Advanced Data Protection is enabled. Computer backups are not encrypted by default; encryption depends on the user enabling Encrypt local backup. Restoring an existing backup may restore reports deleted from the active app.</Text>
      </Card>
      {error ? <Text accessibilityRole="alert" style={uiStyles.muted}>The troubleshooting page could not be opened.</Text> : null}
    </Screen>
  );
}
