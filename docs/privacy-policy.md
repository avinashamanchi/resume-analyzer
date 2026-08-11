# Resume.AI privacy policy draft

Last reviewed: August 10, 2026. This is a pre-release draft. The shipping binary, public URLs, and live provider settings must be verified before release.

## Signed iOS app

In the signed iOS app, a selected PDF stays on the device while Apple PDFKit extracts selectable text or Apple Vision recognizes a scanned document. Resume.AI shows that result for review. Only reviewed text, plus an optional job description, leaves the device after the user confirms consent. Raw PDF bytes are not uploaded by the signed iOS app and are never sent to Groq.

Deterministic readiness scoring and local workspace features run without Groq. If the user requests AI coaching, the reviewed text and optional job description are sent through the Resume.AI service to Groq for that analysis. AI output can quote, transform, or restate submitted personal information, so users should review it before saving or sharing.

## Compatibility web app

The compatibility web app has a different PDF path. A selected standard PDF can be transiently uploaded to the Resume.AI service on Render for bounded text extraction. Raw PDF bytes are not sent to Groq and are not kept as report history. Extracted or pasted text and an optional job description are sent to Groq only after consent. The compatibility web app keeps no report history.

## Local workspace, deletion, and backups

The signed iOS app can store local reports, local resume versions, comparisons, and job notes in its on-device SQLite workspace. This workspace does not sync to Resume.AI servers. Resume.AI does not operate cloud resume, version, or job-note storage for this release.

Local workspace data may enter iCloud or computer device backups according to the user's Apple backup settings. iCloud backups are encrypted, but iCloud Backup is end-to-end encrypted only when Advanced Data Protection is enabled. Computer backups are not encrypted unless the user enables encrypted backups. Deleting an item or using Delete All removes it from the active local store; uninstalling the app removes its active local container. Restoring an older device backup may restore data previously deleted from the active app. Shipping-binary backup and restore behavior remains **UNVERIFIED** until the signed-device release gate is completed.

Raw PDF bytes, original filenames, installation tokens, and request identifiers are not saved in local reports. Temporary export files are removed after use on a best-effort basis, subject to iOS and any destination the user chooses in the share sheet.

## Security and service data

Resume.AI uses an opaque installation security identifier and server-side rate-limit state to authenticate requests, prevent replay, enforce plan allowances, and protect service capacity. The first release has no login or Resume.AI user account. The identifiers are not used for advertising, cross-app tracking, or profiling.

App-controlled telemetry is content-free and uses fixed event categories. It excludes resume text, job descriptions, local company names, roles, job notes, filenames, installation or account identifiers, RevenueCat identifiers, Apple identifiers, request bodies, provider responses, IP addresses, and raw exceptions. Render may independently process connection and HTTP metadata, Device/IP Data, and IP-based geolocation under its own policies.

## Subscriptions

Apple processes App Store payments. RevenueCat processes an anonymous entitlement identity and purchase history such as product, entitlement status, expiration, refund, and revocation for app functionality and subscription analytics. Resume.AI does not receive full payment-card details. The first release supplies no login account or personal profile to RevenueCat and does not use purchase data for tracking.

Free use is bounded to 3 local reports, 1 resume version, 3 tracked jobs, and up to 3 AI requests per calendar month. A verified Resume.AI Pro entitlement allows up to 10,000 local reports, 200 resume versions, 500 tracked jobs, 100 comparison snapshots, and up to 100 AI requests per calendar month, plus PDF export. These are safety and capacity limits, not promises of uninterrupted availability. Deleting the app or local data does not cancel a subscription; subscription management and cancellation occur through Apple.

## Providers and retention

Groq retains usage metadata. According to the provider controls reviewed for this draft, inference input and output may be logged for reliability and abuse prevention for up to 30 days unless Zero Data Retention is enabled. The production Zero Data Retention setting is **UNVERIFIED** and blocks release until an authorized operator records it.

Render application-log retention depends on the hosting plan. Resume.AI controls its content-free application logs, but not all provider-generated connection, security, or billing metadata. The policy will not promise deletion beyond verified provider terms.

## Product limits and support

Resume.AI provides deterministic coaching plus optional AI suggestions. It is not an employer's ATS, a hiring decision, or a prediction of employment. AI feedback may be incomplete or wrong. There is no interview or job guarantee, and the service is not professional, legal, or employment advice.

Release-candidate pages: [Support](https://avinashamanchi.github.io/resume-analyzer/support.html) and [Terms](https://avinashamanchi.github.io/resume-analyzer/terms.html). Anonymous HTTPS reachability was verified on 2026-08-11, and each deployed response matched its tracked release file byte for byte; recheck immediately before submission. Do not send resumes, job descriptions, tokens, request identifiers, or other private content to a public support channel.
