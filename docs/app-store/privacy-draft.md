# App Store privacy answers — draft only

Last reviewed: August 6, 2026. Do not submit these answers until Task 17 verifies the shipping binary, production URL, provider configuration, and App Store Connect fields.

Evidence reviewed: https://console.groq.com/docs/your-data, https://render.com/docs/logging, https://render.com/privacy, https://render.com/privacy-update, https://support.apple.com/en-bh/108771, https://support.apple.com/en-ie/108353, and https://support.apple.com/en-ie/102651.

## Data used for app functionality

- User Content: after explicit consent, standard PDFs are transiently sent to the Resume.AI server on Render. Raw PDF bytes are not sent to Groq. Reviewed, pasted, extracted, or on-device Vision OCR resume text and optional job-description text are sent to Groq for one analysis.
- Identifiers: an installation security identifier and coarse pseudonymous rate-limit key protect the service. They are not linked to an account and are not used for advertising or tracking.
- Diagnostics: app-controlled logs contain only an app request ID, coarse status class, coarse response-size bucket, and bounded latency. They contain no resume text, job text, PDF, filename, token, IP address, header, cookie, authorization value, or body.

The app server keeps no report or content history. Browser history is not kept. Optional iOS reports use the app's local SQLite store and omit source content and identifiers. Saved reports may be included in iPhone or iPad backups stored in iCloud or on a Mac or PC. iCloud backups are always encrypted, but iCloud Backup is end-to-end encrypted only when Advanced Data Protection is enabled. Computer backups are not encrypted by default; encryption depends on the user enabling Encrypt local backup. Restoring an existing backup may restore reports deleted from the active app. Shipping-binary backup and restore behavior is UNVERIFIED and blocks final App Store answers until Task 17 observes it.

## Third-party processing and retention

Groq retains usage metadata and may temporarily log inference content for up to 30 days for reliability and abuse prevention unless Zero Data Retention is enabled. The relevant Zero Data Retention console state is **UNVERIFIED** and is a release blocker. Render application-log retention is 7, 14, or 30 days by plan. Render may also process provider-side connection and HTTP request metadata, Device/IP Data, and IP-based geolocation under its privacy terms. Do not promise deletion beyond published and verified terms.

## Tracking

No data is used for advertising, cross-app tracking, or data-broker profiling. No third-party analytics SDK is included.

## Limits

Resume.AI offers deterministic resume-readiness feedback plus AI coaching. It is not an exact ATS, does not predict employment, provides no hiring guarantee, and is not professional, legal, or employment advice.
