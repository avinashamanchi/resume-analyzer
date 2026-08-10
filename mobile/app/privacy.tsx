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
        <Text style={uiStyles.body}>Only after you consent and tap Analyze, a selected standard PDF is transiently sent to the Resume.AI server hosted on Render for text extraction. Raw PDF bytes are never sent to Groq.</Text>
        <Text style={uiStyles.body}>Reviewed, pasted, or extracted resume text and optional job-description text are sent to Groq only after consent.</Text>
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>What stays local</Text>
        <Text style={uiStyles.body}>Reports use Resume.AI’s local SQLite store only when you choose Save locally. Raw/original PDF bytes, filenames, resume-input fields, job-description-input fields, installation tokens, and request identifiers are not stored in local reports.</Text>
        <Text style={uiStyles.body}>Generated feedback and bullet drafts may quote, transform, or restate names, contact information, resume content, or job-description content.</Text>
        <Text style={uiStyles.body}>Review generated feedback before saving, sharing, or allowing it to enter device backups.</Text>
        <Text style={uiStyles.body}>Saved reports may be included in iPhone or iPad backups stored in iCloud or on a Mac or PC. iCloud backups are always encrypted, but iCloud Backup is end-to-end encrypted only when Advanced Data Protection is enabled. Computer backups are not encrypted by default; encryption depends on the user enabling Encrypt local backup. Restoring an existing backup may restore reports deleted from the active app.</Text>
        <Text style={uiStyles.body}>Vision OCR stays on this iPhone until you review the text and consent. The app server keeps no report or content history.</Text>
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>Temporary handling</Text>
        <Text style={uiStyles.body}>A selected PDF is copied into app-owned temporary storage for one request. The selected PDF is uploaded and processed before temporary cleanup runs. After the request ends, Resume.AI verifies removal of its app-owned temporary PDF.</Text>
        <Text style={uiStyles.body}>If cleanup cannot be verified, Resume.AI does not show the analysis as successful and blocks future analysis until cleanup succeeds. Cleanup cannot undo processing already completed by the Resume.AI server or Groq.</Text>
        <Text style={uiStyles.body}>Pasted resume and job-description text remain in memory for the current app session.</Text>
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>Anonymous security identifier</Text>
        <Text style={uiStyles.body}>Resume.AI uses an anonymous installation token and a coarse pseudonymous rate-limit key to protect the service from abuse. They are not used for advertising, analytics, or cross-app tracking.</Text>
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>Subscriptions</Text>
        <Text style={uiStyles.body}>Apple processes App Store payments. RevenueCat uses a pseudonymous app user identifier and purchase history such as product, entitlement status, and expiration to offer, restore, and verify Resume.AI Pro.</Text>
        <Text style={uiStyles.body}>Resume.AI does not receive or store your full payment-card details. Deleting local reports or the app does not cancel an Apple subscription; manage or cancel it separately in your Apple subscription settings.</Text>
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>Provider retention</Text>
        <Text style={uiStyles.body}>Groq always retains usage metadata and may retain inference content for reliability and abuse prevention for up to 30 days unless Zero Data Retention is enabled. Resume.AI has not verified Zero Data Retention for this project.</Text>
        <Text style={uiStyles.body}>Render keeps application logs for 7, 14, or 30 days by plan. Resume.AI application logs are content-free. Render may separately retain provider-side connection and HTTP request metadata and may process Device/IP Data and IP-based geolocation under its policy.</Text>
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>Limits</Text>
        <Text style={uiStyles.body}>AI feedback can be incomplete or wrong. The readiness method is not an employer’s ATS and cannot promise a job, interview, or application outcome.</Text>
      </Card>
    </Screen>
  );
}
