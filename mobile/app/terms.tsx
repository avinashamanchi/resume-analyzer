import * as Linking from 'expo-linking';
import { Text } from 'react-native';

import { AppButton, Card, Eyebrow, Screen, Title, uiStyles } from '../src/components/primitives';
import { PRIVACY_URL, TERMS_URL } from '../src/legal/links';

export default function TermsScreen() {
  return (
    <Screen>
      <Eyebrow>Terms of Use</Eyebrow>
      <Title>Use feedback as guidance, not a guarantee.</Title>
      <Card>
        <Text style={uiStyles.sectionTitle}>Product limits</Text>
        <Text style={uiStyles.body}>Resume.AI provides structured resume feedback and optional AI coaching. It does not reproduce every applicant tracking system, make employment decisions, provide legal or employment advice, or guarantee an interview or job.</Text>
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>Pro subscriptions</Text>
        <Text style={uiStyles.body}>A Resume.AI Pro subscription unlocks the features shown on the plan screen for the displayed billing period. Apple handles payment, renewal, cancellation, and refunds under its policies. Restore Purchases can recover an active entitlement tied to the same Apple account. Deleting local reports or the app does not cancel the subscription.</Text>
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>Your responsibility</Text>
        <Text style={uiStyles.body}>Only submit content you are allowed to use. Review every suggestion before relying on, saving, or sharing it. Do not use the service for unlawful, abusive, deceptive, or privacy-invasive activity.</Text>
      </Card>
      <AppButton label="Open full Terms of Use" onPress={() => { void Linking.openURL(TERMS_URL); }} tone="secondary" />
      <AppButton label="Open Privacy Policy" onPress={() => { void Linking.openURL(PRIVACY_URL); }} tone="quiet" />
    </Screen>
  );
}
