import React from 'react';
import { Text } from 'react-native';

import { Card, Eyebrow, Screen, Title, uiStyles } from '../src/components/primitives';

export default function PrivacyScreen() {
  return (
    <Screen>
      <Eyebrow>Plain-language privacy</Eyebrow>
      <Title>Your resume is not your profile.</Title>
      <Card>
        <Text style={uiStyles.sectionTitle}>What leaves this iPhone</Text>
        <Text style={uiStyles.body}>Only after you consent and tap Analyze, Resume.AI sends the selected PDF or pasted resume text and an optional job description to its server. The server extracts supported PDF text and sends resume text and optional job-description text to Groq for AI feedback.</Text>
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>What stays local</Text>
        <Text style={uiStyles.body}>Reports are saved only on this device, only when you choose Save locally. Saved reports contain scores and feedback—not the source resume, filename, job description, or request identifiers.</Text>
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>Temporary handling</Text>
        <Text style={uiStyles.body}>A selected PDF is copied into app-owned temporary storage for one request. Cleanup is verified and processing stops if cleanup cannot be confirmed. Resume and job text remain in memory for the current app session.</Text>
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>Anonymous security identifier</Text>
        <Text style={uiStyles.body}>Resume.AI uses an anonymous installation token to protect the service from abuse. It is not used for advertising or cross-app tracking.</Text>
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>Limits</Text>
        <Text style={uiStyles.body}>AI feedback can be incomplete or wrong. The readiness method is not an employer’s ATS and cannot promise a job, interview, or application outcome.</Text>
      </Card>
    </Screen>
  );
}
