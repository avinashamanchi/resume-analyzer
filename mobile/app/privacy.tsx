import React from 'react';
import { Text } from 'react-native';

import { Card, Eyebrow, Screen, Title, uiStyles } from '../src/components/primitives';

export default function PrivacyScreen() {
  return (
    <Screen>
      <Eyebrow>Plain-language privacy</Eyebrow>
      <Title>Your resume is not your profile.</Title>
      <Card>
        <Text style={uiStyles.sectionTitle}>Signed iOS request boundary</Text>
        <Text style={uiStyles.body}>The signed iOS app never uploads the selected PDF. PDFKit reads selectable text and Apple Vision handles scanned pages on this iPhone. You review the extracted text before analysis.</Text>
        <Text style={uiStyles.body}>After explicit consent, reviewed text and an optional job description are sent to the Resume.AI service hosted on Render for a deterministic score and optional AI feedback. Groq receives reviewed text only when optional AI feedback is requested. Raw PDF bytes never leave the signed iOS app.</Text>
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>Compatibility website</Text>
        <Text style={uiStyles.body}>The compatibility web app may transiently upload a selected PDF to Resume.AI’s Render service for bounded text extraction. Raw PDF bytes are not sent to Groq, and the browser does not keep report history.</Text>
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>What stays local</Text>
        <Text style={uiStyles.body}>Reports, reviewed resume versions, revisions, and job notes use app-local SQLite only after explicit save actions. They do not sync to Resume.AI’s server.</Text>
        <Text style={uiStyles.body}>Raw/original PDF bytes, filenames, resume-input fields, job-description-input fields, installation tokens, and request identifiers are not stored in local reports. Saved versions and job notes contain only the content you explicitly choose to save.</Text>
        <Text style={uiStyles.body}>Generated feedback and bullet drafts may quote, transform, or restate names, contact information, resume content, or job-description content. Review generated feedback before saving, sharing, or allowing it to enter device backups.</Text>
        <Text style={uiStyles.body}>Saved reports, resume versions, revisions, and job notes may be included in iPhone or iPad backups stored in iCloud or on a Mac or PC. iCloud backups are always encrypted, but iCloud Backup is end-to-end encrypted only when Advanced Data Protection is enabled. Computer backups are not encrypted by default; encryption depends on the user enabling Encrypt local backup. Restoring an existing backup may restore local data deleted from the active app.</Text>
        <Text style={uiStyles.body}>Delete all local data in Settings clears the current session, reports, temporary files, resume versions and revisions, and tracked jobs through a crash-recoverable local deletion workflow. It cannot remove copies restored later from an existing device backup.</Text>
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>Temporary PDF handling</Text>
        <Text style={uiStyles.body}>A selected PDF is copied into app-owned temporary storage for local extraction. The app verifies removal before exposing an extracted draft for review.</Text>
        <Text style={uiStyles.body}>If cleanup cannot be verified, Resume.AI does not expose the extracted draft or allow analysis until cleanup succeeds. Pasted resume and job-description text remain in memory only for the current app session unless you explicitly save a report, version, or job note.</Text>
        <Text style={uiStyles.body}>Vision OCR stays on this iPhone until you review the text and consent.</Text>
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>Security identifiers</Text>
        <Text style={uiStyles.body}>Resume.AI uses an anonymous installation token and a coarse pseudonymous rate-limit key to protect the service from abuse. They are not used for advertising, analytics, cross-app tracking, or user profiling.</Text>
      </Card>
      <Card>
        <Text style={uiStyles.sectionTitle}>Subscriptions without a Resume.AI account</Text>
        <Text style={uiStyles.body}>Apple processes App Store payments. RevenueCat uses an anonymous installation app-user identifier and purchase history such as product, entitlement status, and expiration for subscription functionality and subscription analytics. Resume.AI does not create a user account, request your Apple name or email, or use purchase information for tracking.</Text>
        <Text style={uiStyles.body}>Restore Purchases asks Apple and RevenueCat to recover an eligible purchase. Resume.AI does not receive or store full payment-card details. Deleting local data or the app does not cancel an Apple subscription; manage or cancel it separately in Apple subscription settings.</Text>
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
