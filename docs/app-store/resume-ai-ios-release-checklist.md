# Resume.AI iOS release checklist

Last updated: 2026-08-09. `PASS` means directly observed evidence. `BLOCKED` means an authorized account, provider setting, signed binary, hardware check, or App Store action is still required. A local export is not an App Store build.

## Repository-controlled implementation

- [x] Native Expo Router app supports PDF selection, pasted text, optional job-description matching, review/consent, deterministic readiness feedback, separate AI coaching, local history, text sharing, and temporary PDF export.
- [x] Free users retain analysis, text sharing, and up to three local reports; Pro gates unlimited local history and PDF export without blocking Continue Free.
- [x] Pro purchase UI uses RevenueCat's StoreKit boundary, localized price, monthly/annual product identifiers, Restore Purchases, Privacy, Terms, and cancellation/error states.
- [x] Production EAS profile uses store distribution, the SDK-selected Xcode image, remote build-number auto-increment, and no submission credentials.
- [x] OTA updates are disabled for the first binary, export compliance is declared, tablet support is disabled, and the icon is configured.
- [x] Fresh local checks on 2026-08-09: 23 mobile suites / 609 tests, typecheck, lint, Expo Doctor 18/18, and a successful 1,147-module iOS export; backend 683 passed with 6 explicit real-Redis tests skipped locally, browser suite 25 passed, and the tracked-file secret/retention checks passed.
- [x] Production configuration fails closed unless the exact HTTPS API origin and a non-placeholder public RevenueCat Apple SDK key are present. The key is public app configuration, not a RevenueCat secret API key.
- [x] Resume.AI is guest-first and creates no user account, so Sign in with Apple and in-app account deletion are not applicable to this binary; users can delete individual reports, all local reports, and temporary files in-app.
- [ ] `BLOCKED` — the mobile production audit reports 12 high-severity advisories through Expo/Metro's transitive `image-size` dependency. npm proposes only a breaking Expo/React Native downgrade, and the currently published affected range has no safe in-range resolution; recheck before the signed candidate and do not force-downgrade silently.
- [x] In-app and static Privacy, Terms, and Support pages disclose content processing, local history, backups, providers, deletion, subscription terms, and product limitations.
- [x] PDF parsing and OCR boundaries enforce the repository's size, page, text, time, stream, and cleanup limits.

## Public service and privacy gates

- [ ] `BLOCKED` — production API health and complete analysis flow must pass anonymously against the deployed Render service.
- [ ] `BLOCKED` — Privacy timed out, while Terms and Support returned HTTP 404, during the anonymous 2026-08-09 release check; all three must return HTTPS 200 before submission.
- [ ] `BLOCKED` — Groq Zero Data Retention or the exact production retention configuration must be verified in the authoritative provider console and reflected in the policy.
- [ ] `BLOCKED` — Render retention, content-free application logging, rate limiting, and deletion behavior must match the submitted privacy answers.

## Paid product gates

- [ ] `BLOCKED` — latest Paid Apps Agreement, banking, and tax setup accepted in the authorized Apple account.
- [ ] `BLOCKED` — monthly `com.avinashamanchi.resumeai.pro.monthly` and annual `com.avinashamanchi.resumeai.pro.annual` subscriptions created and localized in one subscription group.
- [ ] `BLOCKED` — both products mapped to RevenueCat entitlement `resume_pro` and the current monthly/annual offering.
- [ ] `BLOCKED` — public RevenueCat Apple SDK key configured in EAS development, preview, and production environments; no secret API key enters the app.
- [ ] `BLOCKED` — sandbox and exact TestFlight candidate verify price loading, purchase, cancellation, interruption, already-owned state, renewal/expiration, and restore after reinstall.

## Physical iPhone and native gates

- [ ] Expo Go free-flow checkpoint observed on a physical iPhone.
- [ ] Signed Apple Vision OCR development build compiles and handles scanned PDFs on hardware.
- [ ] PDF picker, standard PDF upload, pasted text, consent, analysis, local save limits, deletion, text share, temporary PDF cleanup, offline states, and retry pass on hardware.
- [ ] VoiceOver, 200% Dynamic Type, Reduce Motion, dark appearance, keyboard avoidance, safe areas, and focus restoration pass on hardware.
- [ ] Backup/restore behavior is observed for iCloud and encrypted/unencrypted computer backups and matches the policy.

## Apple/TestFlight/App Review gates

- [ ] Active Apple Developer membership, agreements, App Store Connect access, and matching bundle ID `com.avinashamanchi.resumeai`.
- [ ] App Store Connect record has the correct primary language, SKU, availability, content rights, age rating, Digital Services Act trader status, seller name, and copyright.
- [ ] EAS login/project initialization and a credentialed archive built with Xcode 26 and the iOS 26 SDK or later.
- [ ] Archive privacy manifest/report, export compliance, age rating, App Privacy, content rights, category, seller, and copyright completed.
- [ ] Accepted 6.9-inch iPhone screenshots captured from the exact TestFlight candidate using synthetic resume content and the documented screenshot plan.
- [ ] TestFlight processing and full regression pass on the exact build.
- [ ] App Review receives the product screenshot, subscription path, reviewer notes, and working backend/legal URLs.
- [ ] App status is authoritatively published/Ready for Distribution and the public listing is opened anonymously.

## Current environment boundary

On 2026-08-09, EAS reported `Not logged in`; this Mac had Command Line Tools selected with no full Xcode. CocoaPods 1.17.0 is installed, but it cannot replace full Xcode, signing, or an authorized Apple account. Repository work may continue, but signed build, StoreKit, TestFlight, upload, review, and publication cannot be completed until those credentialed steps are performed.

No App Store acceptance or publication is claimed by this checklist.
