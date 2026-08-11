# Resume.AI external release gates

Status: **UNVERIFIED / BLOCKED FOR RELEASE**. Local tests and an Expo iOS export do not satisfy any checkbox below. Evidence must come from the exact signed candidate and authorized provider consoles. Never paste tokens, keys, resume content, account identifiers, or full provider responses into this file.

## Apple program and App Store Connect

- [ ] Seller type and legal name confirmed in the authorized Apple Developer account.
- [ ] If enrolling as an organization, legal entity details and D-U-N-S record are accepted by Apple; an individual enrollment does not claim a company seller name.
- [ ] Paid Apps Agreement, tax, and banking states are active.
- [ ] Privacy Policy URL, Support URL, age rating, export compliance, privacy nutrition labels, and reviewer contact are complete.
- [ ] Monthly and annual subscriptions are Approved or Ready to Submit, localized, priced, and attached to the submitted version when required.
- [ ] Restore Purchases, cancellation, interrupted purchase, refund/revocation, expiration, reinstall, and family-sharing policy are tested with Apple sandbox accounts.
- [ ] The exact EAS candidate was built with Xcode 26 or later and the iOS 26 SDK, then its build receipt was retained.
- [ ] VoiceOver, 200% text, reduced motion, smallest supported iPhone, oldest supported iOS, offline/error states, backup/restore, and Delete All are verified on physical devices.
- [ ] Native PDFKit selectable-text, Vision OCR fallback, multi-column ordering, deadline, cancellation, low-memory, and malformed/encrypted PDF cases are verified in a signed build.
- [ ] TestFlight internal and external smoke matrices pass without private data in diagnostics.
- [ ] Reviewer notes, a working review account only if one becomes necessary, and exact subscription navigation are supplied.

Apple sandbox evidence: **UNVERIFIED**

Signed PDFKit/Vision evidence: **UNVERIFIED**

TestFlight evidence: **UNVERIFIED**

App Review result: **UNVERIFIED — NOT SUBMITTED**

## RevenueCat and entitlement integrity

- [ ] Apple products map to only the `resume_pro` entitlement and the current offering contains the monthly and annual packages.
- [ ] Public Apple SDK key is present only in signed client environments; RevenueCat secret and webhook secrets remain backend-only.
- [ ] Purchase, restore, stale-cache, offline, expiration, grace-period, billing-retry, refund, revocation, and transfer behavior match the frozen server-verified plan.
- [ ] Duplicate, delayed, replayed, and out-of-order webhooks are idempotent and cannot extend an entitlement incorrectly.
- [ ] Anonymous RevenueCat identity behavior across reinstall is documented; the first release exposes no account login or Sign in with Apple capability.
- [ ] App Store privacy answers match Apple and RevenueCat processing and are rechecked against the submitted SDK versions.

RevenueCat webhook evidence: **UNVERIFIED**

## Render, Redis, provider, and 25k-MAU capacity

- [ ] An isolated staging service has at least two instances, the candidate process command, a dedicated Redis service, a deterministic provider stub, and a one-run staging marker/signing key.
- [ ] The production service never has `RESUME_AI_LOAD_STAGING_MARKER` configured.
- [ ] Every one of 25,000 anonymous principals passes the protected identity canary at least once. At 5 requests/second, 25,000 requests at 5 requests/second requires about 84 minutes; the shorter 15-minute analysis profile covers only 4,500 requests.
- [ ] Reviewed-text deterministic sustained profile meets p95 below 1 second and at least 99% HTTP 200.
- [ ] Burst profile meets at least 99% HTTP 200 without exceeding 48 provider slots, 8 global PDF slots, 2 process PDF slots, or 20 MiB declared process PDF bytes.
- [ ] A maximum-10-request real-provider canary meets p95 below 10 seconds; provider cost is not treated as backend-capacity evidence.
- [ ] PDF compatibility, installation issuance, entitlement cache/webhook, session refresh, Redis outage/recovery, provider outage, two-instance rollout, rollback, and secret rotation drills pass.
- [ ] Final provider/PDF/local reservations are zero, analysis IDs are unique, and no cross-principal material appears in responses.
- [ ] Content-free logs, metric samples, Redis diagnostic dump, and load result pass the retention artifact scanner.
- [ ] CPU, memory, connection, Redis, provider, error-budget, and cost headroom are recorded for the exact service shapes.

Render sustained load evidence: **UNVERIFIED**

Render burst load evidence: **UNVERIFIED**

Redis outage/recovery evidence: **UNVERIFIED**

Provider canary evidence: **UNVERIFIED**

## Publication truth

- [ ] Public Privacy, Terms, and Support URLs return HTTPS 200 anonymously and match the candidate.
- [ ] Crystal-clear App Store screenshots are captured from the signed build at Apple-accepted dimensions, with legible customer-language text and no fabricated UI.
- [ ] Metadata contains no exact-ATS, guaranteed-interview, guaranteed-job, unlimited, or professional-advice claim.
- [ ] Authorized operator explicitly approves upload and submission after all required evidence is attached.

Public URL evidence: **UNVERIFIED**

Authorized submission approval: **UNVERIFIED**
