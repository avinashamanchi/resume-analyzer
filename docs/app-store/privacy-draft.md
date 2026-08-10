# App Store privacy answers — draft only

Last reviewed: August 9, 2026. Do not submit these answers until the shipping binary, production URL, provider configuration, and App Store Connect fields are verified.

Evidence reviewed: https://console.groq.com/docs/your-data, https://render.com/docs/logging, https://render.com/privacy, https://render.com/privacy-update, https://support.apple.com/en-bh/108771, https://support.apple.com/en-ie/108353, and https://support.apple.com/en-ie/102651.

## Data used for app functionality

- User Content: after explicit consent, standard PDFs are transiently sent to the Resume.AI server on Render. Raw PDF bytes are not sent to Groq. Reviewed, pasted, extracted, or on-device Vision OCR resume text and optional job-description text are sent to Groq for one analysis.
- Identifiers: an installation security identifier and coarse pseudonymous rate-limit key protect the service. They are not linked to an account and are not used for advertising or tracking.
- Purchases: Apple processes App Store payments. RevenueCat receives a pseudonymous app user identifier plus product, purchase, entitlement, and expiration information to offer, restore, and verify Resume.AI Pro. Resume.AI does not receive full payment-card details. Deleting the app or local reports does not cancel an Apple subscription.
- Diagnostics: app-controlled logs contain only an app request ID, coarse status class, coarse response-size bucket, and bounded latency. They contain no resume text, job text, PDF, filename, token, IP address, header, cookie, authorization value, or body.

The app server keeps no report or content history. Browser history is not kept. Optional iOS reports use the app's local SQLite store. Raw/original PDF bytes, filenames, resume-input fields, job-description-input fields, installation tokens, and request identifiers are not stored in local reports. Generated feedback and bullet drafts may quote, transform, or restate names, contact information, resume content, or job-description content. Review generated feedback before saving, sharing, or allowing it to enter device backups. Saved reports may be included in iPhone or iPad backups stored in iCloud or on a Mac or PC. iCloud backups are always encrypted, but iCloud Backup is end-to-end encrypted only when Advanced Data Protection is enabled. Computer backups are not encrypted by default; encryption depends on the user enabling Encrypt local backup. Restoring an existing backup may restore reports deleted from the active app. Shipping-binary backup and restore behavior is UNVERIFIED and blocks final App Store answers until Task 17 observes it.

## Third-party processing and retention

Groq retains usage metadata and may temporarily log inference content for up to 30 days for reliability and abuse prevention unless Zero Data Retention is enabled. The relevant Zero Data Retention console state is **UNVERIFIED** and is a release blocker. Render application-log retention is 7, 14, or 30 days by plan. Render may also process provider-side connection and HTTP request metadata, Device/IP Data, and IP-based geolocation under its privacy terms. Do not promise deletion beyond published and verified terms.

## Tracking

No data is used for advertising, cross-app tracking, or data-broker profiling. No third-party analytics SDK is included.

## Limits

Resume.AI offers deterministic resume-readiness feedback plus AI coaching. It is not an exact ATS, does not predict employment, provides no hiring guarantee, and is not professional, legal, or employment advice.
