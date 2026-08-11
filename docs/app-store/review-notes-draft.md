# App Review notes — draft only

Resume.AI is a guest-first resume coaching app. The first release has no login, account creation, Sign in with Apple, profile, cloud workspace, or account deletion flow. Users can delete individual local records or use Delete All for the active on-device workspace.

## Review path

1. No credentials are required. Continue Free on the paywall; no purchase is required to review the primary workflow.
2. Paste synthetic resume text or choose a synthetic PDF.
3. In the signed iOS app, PDFKit extracts selectable text on-device and Apple Vision handles scanned text on-device. The app displays extracted text for review.
4. Confirm the consent sheet. Only reviewed text and an optional job description are sent for analysis; the signed iOS app does not upload raw PDF bytes.
5. Inspect deterministic readiness components separately from optional AI coaching. AI may be unavailable without blocking the deterministic result.
6. Save locally only when prompted. Exercise the local report, local resume versions, comparison, and job notes screens; this workspace does not sync to Resume.AI servers.
7. Use Settings > Delete All to erase the active local workspace. Device backups may restore earlier local data, as disclosed in Privacy.

The compatibility web app differs: it may transiently upload a standard PDF to Render for bounded extraction. Raw PDF bytes are never sent to Groq and are not retained as report history.

## Purchases

Free users may keep 3 local reports, 1 resume version, 3 tracked jobs, and request up to 3 AI analyses per month. Resume.AI Pro uses Apple's in-app purchase sheet through RevenueCat. A verified entitlement permits up to 10,000 local reports, 200 resume versions, 500 tracked jobs, 100 comparison snapshots, and 100 AI analyses per month, plus PDF export. The screen uses Apple's localized price and includes Continue Free, Restore Purchases, Terms, Privacy, Apple subscription management, and Apple's purchase/refund-help link. Apple determines refund eligibility.

Exact products are `com.avinashamanchi.resumeai.pro.monthly` and `com.avinashamanchi.resumeai.pro.annual` in one `Resume.AI Pro` subscription group. Offer codes, win-back offers, promoted IAP, Family Sharing, and external digital payments remain disabled for v1.

Apple processes payment. RevenueCat processes anonymous entitlement identity and purchase history for app functionality and subscription analytics. Resume.AI receives no payment-card details and uses no purchase data for tracking. Purchase, cancellation, pending, renewal, expiration, refund/revoke, reinstall, and restore evidence remains **BLOCKED** until the exact products are configured and exercised in Apple Sandbox and the submitted TestFlight candidate.

## Privacy and limitations

The server keeps no content or report history. App-controlled telemetry is content-free. Generated feedback may restate submitted content. Saved reports, local resume versions, and job notes can enter device backups. Groq retention and the production Zero Data Retention setting are described in Privacy; the authoritative setting is still **UNVERIFIED**. Render can retain provider-side connection metadata under its terms.

The readiness score is deterministic coaching, not an exact ATS or hiring decision. AI may be incomplete or wrong. Resume.AI makes no hiring, interview, or employment guarantee and does not provide professional, legal, or employment advice.

Support candidate: https://avinashamanchi.github.io/resume-analyzer/support.html

Privacy candidate: https://avinashamanchi.github.io/resume-analyzer/privacy.html

Terms candidate: https://avinashamanchi.github.io/resume-analyzer/terms.html

All three URLs must return HTTPS 200 anonymously from the exact production release before submission. Signed PDFKit/Vision device evidence, Apple Sandbox, RevenueCat webhooks, production-like load evidence, TestFlight, and App Review remain external gates. These notes have not been submitted and no Apple approval is claimed.
