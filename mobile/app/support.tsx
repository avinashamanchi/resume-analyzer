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
      <Eyebrow>Public support</Eyebrow>
      <Title>Tell us what happened.</Title>
      <Card>
        <Text style={uiStyles.sectionTitle}>Open a repository issue</Text>
        <Text style={uiStyles.body}>Use the public issue tracker for product questions and reproducible bugs. Never post resumes, job descriptions, tokens, or private identifiers.</Text>
        <AppButton label="Open public support" onPress={() => { void openSupport(); }} />
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>Helpful details</Text>
        <Text style={uiStyles.muted}>Include the app version, iOS version, what you tapped, and the stable error category shown on screen. Never include resume content.</Text>
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>Feedback limits</Text>
        <Text style={uiStyles.muted}>Resume.AI provides deterministic readiness feedback and AI coaching. It is not an exact ATS or employment prediction, offers no hiring guarantee, and is not professional, legal, or employment advice.</Text>
      </Card>
      {error ? <Text accessibilityRole="alert" style={uiStyles.muted}>Public support could not be opened.</Text> : null}
    </Screen>
  );
}
