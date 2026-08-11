# Resume.AI iOS release checklist

Last updated: 2026-08-11. `PASS` means directly observed evidence. `BLOCKED` means an authorized account, provider setting, signed binary, hardware check, or App Store action is still required. A local export is not an App Store build.

## Repository-controlled implementation

- [x] Native Expo Router app supports PDF selection, pasted text, optional job-description matching, review/consent, deterministic readiness feedback, separate AI coaching, local history, text sharing, and temporary PDF export.
- [x] Free users retain deterministic analysis, text sharing, 3 local reports, 1 resume version, 3 tracked jobs, and up to 3 monthly AI requests. Verified Pro permits up to 10,000 local reports, 200 resume versions, 500 tracked jobs, 100 snapshots, 100 monthly AI requests, and PDF export without blocking Continue Free.
- [x] Pro purchase UI uses RevenueCat's StoreKit boundary, localized price, monthly/annual product identifiers, Restore Purchases, subscription management, Privacy, Terms, official Apple purchase/refund help, and cancellation/error states.
- [x] Production EAS profile uses store distribution, the SDK-selected Xcode image, remote build-number auto-increment, and no submission credentials.
- [x] OTA updates are disabled for the first binary, export compliance is declared, tablet support is disabled, and the icon is configured.
- [x] Fresh clean-checkout evidence on 2026-08-11: all 753 backend tests passed with a temporary local Redis 8.10 service, browser 25 tests passed, mobile 31 suites / 671 tests passed, and TypeScript, lint, retention, secret, dependency, Expo Doctor 18/18, release-asset, prebuild stability, and a 5.02 MB Hermes iOS export passed.
- [x] Production configuration fails closed unless the exact HTTPS API origin and a non-placeholder public RevenueCat Apple SDK key are present. The key is public app configuration, not a RevenueCat secret API key.
- [x] Resume.AI is guest-first and the first binary exposes no login, account creation, or Sign in with Apple capability. Users can delete individual local records, Delete All active workspace data, and retry temporary-file cleanup.
- [x] Mobile CI fails closed on any high/critical advisory except the two explicitly reviewed `image-size` parser advisories (GitHub sources `1138808` and `1138809`) through Expo/Metro. The current report has 12 transitive findings; npm proposes only a breaking Expo/React Native downgrade. Project-owned images are signature-checked before export and CI rejects disguised ICNS, JPEG XL, HEIF, and AVIF content. The exception still must be rechecked before the signed candidate.
- [x] In-app and static Privacy, Terms, and Support pages disclose content processing, local history, backups, providers, deletion, subscription terms, and product limitations.
- [x] PDF parsing and OCR boundaries enforce the repository's size, page, text, time, stream, and cleanup limits.
- [x] `apple-review-guideline-applicability.md` records all five Apple guideline families, evidence, external gates, and absent capabilities that cannot be added without re-review.
- [x] A production-only Expo config plugin strips development Bonjour/local-network discovery declarations, disables arbitrary ATS loads, and removes localhost transport exceptions from the generated release Info.plist while leaving development builds usable; a sanitized production prebuild was inspected and contained none of those development declarations.

## Public service and privacy gates

- [ ] `BLOCKED` — the deployed Render root returns HTTP 200 but serves the legacy analyzer, and `/healthz` returned HTTP 404 on 2026-08-11. Deploy the current service, then pass health and a synthetic complete analysis flow anonymously.
- [x] Privacy, Terms, and Support each returned HTTPS 200 anonymously on 2026-08-11 and matched the tracked `static/` release files byte for byte; recheck immediately before submission.
- [ ] `BLOCKED` — Groq Zero Data Retention or the exact production retention configuration must be verified in the authoritative provider console and reflected in the policy.
- [ ] `BLOCKED` — Render retention, content-free application logging, rate limiting, and deletion behavior must match the submitted privacy answers.

## Paid product gates

- [ ] `BLOCKED` — latest Paid Apps Agreement, banking, and tax setup accepted in the authorized Apple account.
- [ ] `BLOCKED` — monthly `com.avinashamanchi.resumeai.pro.monthly` and annual `com.avinashamanchi.resumeai.pro.annual` subscriptions created and localized in one subscription group.
- [ ] `BLOCKED` — both products mapped to RevenueCat entitlement `resume_pro` and the current monthly/annual offering.
- [ ] `BLOCKED` — public RevenueCat Apple SDK key configured in EAS development, preview, and production environments; no secret API key enters the app.
- [ ] `BLOCKED` — sandbox and exact TestFlight candidate verify price loading, purchase, cancellation, interruption, already-owned state, renewal/expiration, and restore after reinstall.
- [ ] `BLOCKED` — offer codes, win-back offers, promoted IAP, Family Sharing, and external digital payments remain disabled unless separately configured and signed-tested.

## Physical iPhone and native gates

- [ ] Expo Go free-flow checkpoint observed on a physical iPhone.
- [ ] Signed Apple Vision OCR development build compiles and handles scanned PDFs on hardware.
- [ ] PDF picker, on-device PDFKit extraction, Vision OCR, reviewed-text consent, pasted text, analysis, local workspace limits, deletion, text share, temporary PDF cleanup, offline states, and retry pass on hardware.
- [ ] VoiceOver, 200% Dynamic Type, Reduce Motion, dark appearance, keyboard avoidance, safe areas, and focus restoration pass on hardware.
- [ ] Backup/restore behavior is observed for iCloud and encrypted/unencrypted computer backups and matches the policy.

## Apple/TestFlight/App Review gates

- [ ] Active Apple Developer membership, agreements, App Store Connect access, and matching bundle ID `com.avinashamanchi.resumeai`.
- [ ] App Store Connect record has the correct primary language, SKU, availability, content rights, age rating, Digital Services Act trader status, seller name, and copyright.
- [ ] EAS login/project initialization and a credentialed archive built with Xcode 26 and the iOS 26 SDK or later.
- [ ] Archive privacy manifest/report, export compliance, Apple's updated age-rating questionnaire, App Privacy, content rights, category, seller, and copyright completed.
- [ ] Accessibility Nutrition Label answers are based on the signed-device VoiceOver, Voice Control, Larger Text, contrast, and Reduce Motion results above; no unverified support is claimed.
- [ ] Product page name, icon, subtitle, description, promotional text, keywords, and 1–10 screenshots are complete, accurate, localized where offered, and contain no placeholder or real resume data.
- [ ] Required device capabilities and every generated Info.plist usage description match the exact archive and are exercised on a current iOS 26 device.
- [ ] Mac with Apple silicon and Apple Vision Pro availability are explicitly disabled for v1 unless the exact signed iPhone build, document picker, PDFKit, and Vision behavior are separately tested and supported there.
- [ ] Accepted 6.9-inch iPhone screenshots captured from the exact TestFlight candidate using synthetic resume content and the documented screenshot plan.
- [ ] TestFlight processing and full regression pass on the exact build.
- [ ] App Review receives the product screenshot, subscription path, reviewer notes, and working backend/legal URLs.
- [ ] App Review notes explicitly state no credentials are required and give the complete Free, PDF/Vision, consent, AI-fallback, local-save, and Delete All path.
- [ ] App status is authoritatively published/Ready for Distribution and the public listing is opened anonymously.

## Current environment boundary

On 2026-08-11, EAS reported `Not logged in`; this Mac still had Command Line Tools selected with no full Xcode. CocoaPods 1.17.0 is installed, but it cannot replace full Xcode, signing, or an authorized Apple account. The current Render service also requires an authorized deployment and production secrets. Signed build, StoreKit, TestFlight, upload, review, and publication cannot be completed until those credentialed steps are performed.

No App Store acceptance or publication is claimed by this checklist.
