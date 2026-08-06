# App Review notes — draft only

Resume.AI reviews a standard PDF or user-reviewed text after explicit consent. Standard PDFs are transiently uploaded to the Resume.AI server hosted on Render; raw PDF bytes are never sent to Groq. Reviewed, pasted, extracted, and optional job-description text are sent to Groq for AI coaching. Scanned-PDF Vision OCR runs on-device in the iOS development build and its text does not leave the device until the user reviews it and consents.

The service returns deterministic readiness feedback and separate AI coaching. It is not an exact ATS or employment prediction, has no hiring guarantee, and is not professional, legal, or employment advice.

No account is required. The server keeps no content or report history. Browser history is not kept. iOS reports use the app's local SQLite store only when the user chooses Save locally; deletion controls remove active local records. Saved reports may be included in iPhone or iPad backups stored in iCloud or on a Mac or PC. iCloud backups are always encrypted, but iCloud Backup is end-to-end encrypted only when Advanced Data Protection is enabled. Computer backups are not encrypted by default; encryption depends on the user enabling Encrypt local backup. Restoring an existing backup may restore reports deleted from the active app. Shipping-binary backup and restore behavior is UNVERIFIED and remains a Task 17 gate. An installation security identifier and coarse pseudonymous rate-limit key are used without advertising or tracking.

Provider disclosure: Groq retains usage metadata and may retain inference content for up to 30 days for reliability and abuse prevention unless Zero Data Retention is enabled. Zero Data Retention is **UNVERIFIED** in the authoritative Groq console and blocks release. Render application logs are retained for 7, 14, or 30 days by plan. App-controlled logs are content-free, while Render may retain provider-side connection and HTTP request metadata, Device/IP Data, and IP-based geolocation under its own policy.

Support: https://github.com/avinashamanchi/resume-analyzer/issues. Users are told never to post resumes, job descriptions, tokens, or private identifiers.

This metadata is not submitted. Production deployment, live provider settings, the public privacy URL, full Xcode/CocoaPods device builds, TestFlight, and App Store submission remain later release gates.
