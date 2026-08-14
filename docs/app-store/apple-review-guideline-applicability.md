# Resume.AI — Apple App Review guideline applicability

Reviewed against Apple's App Review overview and App Review Guidelines on 2026-08-14. This matrix distinguishes repository implementation from credentialed release evidence; it cannot guarantee acceptance.

| Guideline | Status | Resume.AI decision and evidence |
| --- | --- | --- |
| 1.1 Objectionable content | IMPLEMENTED | Private resume/job content only; no supplied offensive content or public distribution. |
| 1.2 User-generated content | N/A | No public posting, profiles, feed, chat, following, or discovery. |
| 1.3 Kids Category | N/A | Employment/productivity app not marketed to children and not submitted to Kids Category. |
| 1.4 Physical harm | IMPLEMENTED | Clearly states the readiness method is not an employer ATS and offers no interview, job, legal, or employment guarantee. |
| 1.5 Developer information | EXTERNAL GATE | Seller, review contact, support contact, and legal-entity information require accurate App Store Connect entries. |
| 1.6 Data security | IMPLEMENTED + EXTERNAL GATE | Local SQLite, bounded temporary files, signed request/replay controls, content-free logs, rate limits, deletion, and tests exist. Final Render/Groq/RevenueCat settings and archive evidence remain external. |
| 1.7 Reporting criminal activity | N/A | No crime-reporting feature. |
| 2.1 App completeness | EXTERNAL GATE | Do not submit until live service, public legal/support links, IAP, exact candidate, and every PDF/text/AI/export flow pass on device with no placeholder state. |
| 2.2 Beta testing | EXTERNAL GATE | Unfinished builds belong in development/TestFlight; production metadata must not label the app beta. |
| 2.3 Accurate metadata | IMPLEMENTED + EXTERNAL GATE | Drafts accurately distinguish deterministic analysis from optional AI, local storage, limits, and subscriptions. Final screenshots/forms must match the signed binary. |
| 2.4 Hardware compatibility | IMPLEMENTED + EXTERNAL GATE | iPhone-only portrait v1 with bounded local collections and native PDF/Vision path. Verify supported devices, accessibility, memory, network failure, and disable untested Mac/Vision availability. |
| 2.5 Software requirements | IMPLEMENTED + EXTERNAL GATE | Public APIs, HTTPS, sandbox, no executable-code download, no background mode, Files picker. Archive privacy-manifest and IPv6-only checks remain. Development-only local-network declarations are forbidden in release. |
| 3.1.1 In-App Purchase | IMPLEMENTED + EXTERNAL GATE | All digital Pro features use Apple IAP through RevenueCat. Localized products, purchase, restore, and management are coded; products and signed testing remain external. |
| 3.1.2 Subscriptions | IMPLEMENTED + EXTERNAL GATE | Monthly/annual Pro provides ongoing AI allowance and workflow value; Free analysis continues. Period, full localized price, renewal, cancellation, restore, privacy, terms, and downgrade behavior are disclosed. |
| 3.1.3 Other purchase methods and 3.2 | N/A | No external digital checkout, reader content, enterprise-only service, ads, crypto, lending, or regulated financial service. |
| 4.1 Copycats | IMPLEMENTED | Original product/assets; verify final asset rights. |
| 4.2 Minimum functionality | IMPLEMENTED | Native file selection, on-device PDFKit/Vision extraction, review, deterministic analysis, local history/workspace, sharing, and PDF export—not a web wrapper. |
| 4.3 Spam | IMPLEMENTED | Distinct resume-coaching purpose; do not reuse another app's icon, screenshots, metadata, or binary. |
| 4.4–4.7 Extensions/Apple services/alternate icons/mini apps | N/A | None present. |
| 4.8 Login services | IMPLEMENTED | v1 is guest-first and exposes no login/account creation. Hidden account-linking code must remain unreachable and Sign in with Apple capability disabled unless a complete account lifecycle is released. |
| 4.9 Apple Pay | N/A | No physical-goods checkout or Apple Pay. |
| 4.10 Built-in capabilities | IMPLEMENTED | Pro charges for workflow/allowance value, not Files, Vision, PDFKit, or another built-in capability itself. |
| 5.1 Privacy | IMPLEMENTED + EXTERNAL GATE | In-app/static copy covers local data, temporary PDFs, reviewed API payload, Groq/Render/RevenueCat, backup behavior, retention, consent, and deletion. Public pages and App Privacy answers must match production. |
| 5.1.1 Collection/minimization | IMPLEMENTED | Raw iOS PDFs do not leave the device; reviewed text is sent only after consent. No ads/tracking, profile, card details, or contact-book access. |
| 5.1.1(v) Account deletion | N/A | No Resume.AI account in v1. Local record deletion and Delete All are available. If account creation is exposed, in-app account deletion becomes mandatory before submission. |
| 5.1.2 Data use/sharing | IMPLEMENTED + EXTERNAL GATE | Exact reviewed text and optional job description go to disclosed processors for requested functionality only. Verify provider retention/contracts and privacy labels. |
| 5.2 Intellectual property | IMPLEMENTED + EXTERNAL GATE | Users must have rights to resume/job content; verify every bundled/screenshot asset and seller copyright. |
| 5.3–5.5 Gambling/VPN/device management | N/A | None present. |
| 5.6 Developer conduct | EXTERNAL GATE | Honest claims, functional support, accurate privacy answers, no review manipulation, and responsive App Review communication are required. |

## 2026 submission questionnaire decision

- **Social media capabilities: No.** Resume.AI has no social feed or discovery surface and cannot redistribute, amplify, or expose user-generated content to many users. Enter `No` for Apple's social-media capability question; this answer becomes submission-blocking in September 2026. Re-review this decision before adding any public feed, discovery, community, or many-user sharing feature.
- Apple has required uploads to use the iOS 26 SDK or later since April 28, 2026. The repository remains on Expo SDK 54 for the already-tested iOS 15.1+ product surface; Expo's current `sdk-54` EAS image uses Xcode 26.0. The final build log and processed archive must still prove the actual SDK. Expo Go remains preview-only; production acceptance requires a signed development/TestFlight build.

## Submission-stopping external gates

- Privacy, Terms, and Support must return HTTPS 200 and match the in-app policy.
- Render/Groq production behavior and RevenueCat products, entitlement, offering, webhook/verification, and transfer rules must be live and measured.
- The exact signed archive must pass selectable/scanned PDF, temporary cleanup, consent, deterministic/AI failure, deletion, backup disclosure, purchase/restore/refund, accessibility, privacy-manifest, crash, and IPv6-only checks.
- Screenshots must come from the submitted build, contain no real resume/contact data, and accurately show iPhone UI.
- Paid Apps Agreement, tax/banking, age rating, App Privacy, content rights, category, DSA status, availability, export compliance, and IAP review metadata must be complete.

Optional offers, win-back, Family Sharing, promoted IAP, custom product pages, and alternative payments remain disabled for v1.
