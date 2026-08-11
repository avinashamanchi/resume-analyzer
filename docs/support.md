# Resume.AI support

Release-candidate first-party support page: https://avinashamanchi.github.io/resume-analyzer/support.html.

The page provides content-free self-help and links to the public project issue tracker at https://github.com/avinashamanchi/resume-analyzer/issues. Its anonymous live reachability is **UNVERIFIED** until an authorized production deployment; failure to verify it blocks submission. Never send or publish resumes, job descriptions, tokens, request identifiers, filenames, contact information, or other private identifiers. Public issues must contain only app/iOS versions, reproduction actions, and the stable error category.

## Documents and analysis

In the signed iOS app, PDFKit extracts selectable text and Apple Vision recognizes scans on-device. Review that text before consent; the iOS app does not upload raw PDF bytes. The compatibility web app can transiently upload a standard PDF to Render for bounded extraction, but raw bytes do not go to Groq or report history. Use a readable, unencrypted PDF under 10 MB or paste no more than 30,000 characters. A job description is optional and limited to 20,000 characters.

Resume.AI provides deterministic readiness feedback plus optional AI coaching. It is not an exact ATS or employment prediction, offers no hiring guarantee, and is not professional, legal, or employment advice. AI may be incomplete or wrong.

## Local workspace and backups

Local reports, local resume versions, comparisons, and job notes do not sync to Resume.AI servers. Saved data may be included in iPhone or iPad backups stored in iCloud or on a Mac or PC. iCloud backups are always encrypted, but iCloud Backup is end-to-end encrypted only when Advanced Data Protection is enabled. Computer backups are not encrypted by default; encryption depends on the user enabling Encrypt local backup. Restoring an existing backup may restore reports deleted from the active app. Shipping-binary backup and restore behavior is UNVERIFIED and must be tested on the signed candidate.

Raw/original PDF bytes, filenames, resume-input fields, job-description-input fields, installation tokens, and request identifiers are not stored in local reports. Generated feedback and bullet drafts may quote, transform, or restate names, contact information, resume content, or job-description content. Review generated feedback before saving, sharing, or allowing it to enter device backups.

## Providers and subscriptions

Groq retains usage metadata and may retain inference content for up to 30 days for reliability and abuse prevention unless Zero Data Retention is enabled. The production setting is **UNVERIFIED**. Render application logs are retained for 7, 14, or 30 days by plan, and Render may retain provider-side request or connection metadata, Device/IP Data, and IP-based geolocation under its own policy. Resume.AI application metrics contain no submitted content.

Apple manages payment, cancellation, and refunds. RevenueCat verifies anonymous entitlement and purchase history but Resume.AI does not receive full payment-card details. If a valid subscription is not reflected, use Restore Purchases. Deleting the app or local workspace does not cancel the Apple subscription.
