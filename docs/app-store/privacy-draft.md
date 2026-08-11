# App Store privacy answers — draft only

Last reviewed: August 10, 2026. Do not submit these answers until the shipping binary, production URL, provider configuration, privacy report, and App Store Connect fields are verified.

## Data used for app functionality

- **User Content:** in the signed iOS app, PDFKit or Vision extracts PDF text on-device. Only text the user reviews, plus an optional job description, is sent through Resume.AI to Groq after consent. The signed iOS app does not upload raw PDF bytes. The compatibility web app can transiently upload a standard PDF to Render for bounded extraction; raw bytes are not sent to Groq or retained as report history.
- **Identifiers:** an opaque installation security identifier and server-side rate-limit state authenticate requests, prevent replay, enforce plan allowances, and protect the service. The first release has no login or Resume.AI account. The identifier is not used for advertising or tracking.
- **Purchases:** Apple processes App Store payments. RevenueCat processes an anonymous entitlement identity and product, entitlement, expiration, refund, and revocation history for Analytics and App Functionality. Resume.AI does not receive full payment-card details, provide a personal profile to RevenueCat, or use purchase history for tracking. Deleting the app or local data does not cancel an Apple subscription.
- **Diagnostics:** app-controlled metrics use fixed, content-free categories and exclude resume or job content, local workspace content, filenames, IP addresses, identifiers, headers, cookies, authorization values, request bodies, provider responses, and raw exceptions. Hosting providers may independently process infrastructure metadata under their policies.

The iOS app can store local reports, local resume versions, comparisons, and job notes in SQLite. This data does not sync to Resume.AI servers. It may enter device backups. Delete All removes the active local workspace, but restoring an older backup may restore previously deleted data. Shipping-binary backup and restore behavior is **UNVERIFIED** and blocks the final answers.

## Third-party processing and retention

Groq retains usage metadata and may temporarily log inference content for up to 30 days for reliability and abuse prevention unless Zero Data Retention is enabled. The production setting is **UNVERIFIED** and is a release blocker. Render application-log retention depends on plan and may include provider-controlled connection/HTTP metadata, Device/IP Data, and IP-based geolocation. The submitted policy must match the authoritative settings and terms.

## Tracking

No data is used for advertising, cross-app tracking, data-broker profiling, or behavioral/product-interaction analytics. RevenueCat processes purchase history only for subscription analytics and app functionality as disclosed above.

## Product limits

Resume.AI offers deterministic resume-readiness feedback plus optional AI coaching. It is not an employer's ATS, does not predict employment, provides no hiring guarantee, and is not professional, legal, or employment advice. AI may be incomplete or wrong.
