import React from 'react';
import { Text } from 'react-native';

import type { NormalizedAnalysisResponseV2 } from '../domain/contracts';
import { Card, uiStyles } from './primitives';

const STATUS_MESSAGES: Readonly<Record<NormalizedAnalysisResponseV2['aiStatus'], string>> = {
  complete: 'AI feedback is ready.',
  not_requested: 'AI feedback was not requested.',
  quota_exhausted: 'Your AI feedback allowance has been used for this period.',
  plan_verification_unavailable: 'Your plan could not be verified right now.',
  temporarily_unavailable: 'AI feedback is temporarily unavailable.',
  timeout: 'AI feedback took too long to return.',
  invalid_provider_response: 'AI feedback could not be verified safely.',
};

export function AiStatusCard({
  status,
}: Readonly<{ status: NormalizedAnalysisResponseV2['aiStatus'] }>) {
  return (
    <Card>
      <Text style={uiStyles.sectionTitle}>Deterministic score available</Text>
      <Text accessibilityRole="alert" style={uiStyles.body}>{STATUS_MESSAGES[status]}</Text>
      <Text style={uiStyles.muted}>
        Your score above is still usable. Resume.AI did not invent or substitute AI feedback.
      </Text>
    </Card>
  );
}
