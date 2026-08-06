# Resume.AI privacy policy draft

Last reviewed: August 6, 2026. This is a pre-release draft. The public service URL and live provider settings must be verified before release.

Provider terms reviewed: [Groq Your Data](https://console.groq.com/docs/your-data), [Render logging](https://render.com/docs/logging), and [Render privacy](https://render.com/privacy) with its [July 2026 policy update](https://render.com/privacy-update). Backup statements were checked against Apple's [backup-method comparison](https://support.apple.com/en-bh/108771), [encrypted computer-backup guidance](https://support.apple.com/en-ie/108353), and [iCloud data-security overview](https://support.apple.com/en-ie/102651).

## Data flow

Selected standard PDFs are transiently sent to the Resume.AI server hosted on Render for text extraction. Raw PDF bytes are never sent to Groq. Reviewed, pasted, or extracted resume text and any optional job description are sent to Groq only after consent. On iOS, Vision OCR stays on-device until the user explicitly reviews the recognized text and consents to analysis.

The app server keeps no report or content history. Browser report history is not kept. Optional iOS reports use the app's local SQLite store. Raw/original PDF bytes, filenames, resume-input fields, job-description-input fields, installation tokens, and request identifiers are not stored in local reports. Generated feedback and bullet drafts may quote, transform, or restate names, contact information, resume content, or job-description content. Review generated feedback before saving, sharing, or allowing it to enter device backups. Saved reports may be included in iPhone or iPad backups stored in iCloud or on a Mac or PC. iCloud backups are always encrypted, but iCloud Backup is end-to-end encrypted only when Advanced Data Protection is enabled. Computer backups are not encrypted by default; encryption depends on the user enabling Encrypt local backup. Users can delete records from the active local store in Settings. Restoring an existing backup may restore reports deleted from the active app. Shipping-binary backup and restore behavior is UNVERIFIED and remains a Task 17 release gate.

Resume.AI uses an installation security identifier and a coarse pseudonymous rate-limit key to protect the service. They are not used for advertising, analytics, cross-app tracking, or user profiling. There are no ads or third-party analytics.

## Providers and retention limits

Groq always retains usage metadata. According to Groq's published data controls reviewed on August 6, 2026, inference input and output content may be temporarily logged for reliability and abuse prevention for up to 30 days unless Zero Data Retention is enabled. Zero Data Retention for this Resume.AI project or organization is **UNVERIFIED**. Release is blocked until an authorized operator observes the setting in the authoritative Groq console; this draft does not claim ZDR.

Render dashboard application-log retention is 7, 14, or 30 days depending on plan. Resume.AI application logs are content-free and contain only an app request ID, coarse status class, coarse response-size bucket, and bounded latency. Render may separately generate provider-side connection or HTTP request metadata, including the requested URL, Device/IP Data, and IP-based geolocation, under Render's policies. Resume.AI does not control that provider metadata and does not promise deletion beyond verified provider terms.

## Product limits

Resume.AI combines deterministic resume-readiness feedback with AI coaching. It is not an exact ATS, employment prediction, or employer decision system. There is no hiring guarantee. Feedback can be incomplete or wrong and is not professional, legal, or employment advice. Users should verify suggestions and decide what to change.

## Support

Public support is available at https://github.com/avinashamanchi/resume-analyzer/issues. Never post resumes, job descriptions, tokens, request identifiers, or other private identifiers in a public issue.
