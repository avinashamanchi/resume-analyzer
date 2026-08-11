# Resume.AI Security, Capacity, and App Review Addendum

**Status:** Approved through the owner's standing approval on 2026-08-09.
**Extends:** `2026-08-07-resume-ai-25k-monetization-design.md`.

## Outcome and claims

Resume.AI remains guest-first. Deterministic ATS feedback must remain available when optional AI is saturated or unavailable. Resumes contain high-value personal data, so uploads are ephemeral, bounded, content-free in logs, and excluded from analytics and backups. The scale contract is 25,000 MAU and 1,000 foreground sessions with measured, bounded server work—not 1,000 simultaneous PDF/AI jobs.

## Selected approach

Keep the Flask/Render service and Expo app, finish wiring the approved v2 degradation and verified-plan components into the real routes/composition, add global PDF/AI admission, and scale horizontally only after a reproducible production-like load gate identifies the required instance count.

## Trust boundaries and required controls

- Installation credentials are server-signed, expiring, rotation-safe, and rate-limited. Header parsing and admission happen before reading a resume body.
- A canonical `X-Resume-Request-ID` is reserved before body reads and must match the multipart request identifier exactly, preserving quota idempotency across retries.
- PDF upload size, compressed structure, page count, extraction time, text size, and child-process lifetime are bounded under one deadline. Timeout/error paths must prove no process, file, descriptor, or memory leak.
- Resume bytes and extracted text never appear in logs, error messages, traces, metrics, crash reports, or provider identifiers. Temporary files are unlinked on every path.
- Deterministic scoring and AI enrichment have separate breakers. AI allowance, concurrency, and entitlement consumption are atomic and idempotent; optional AI failure cannot erase a completed deterministic result.
- RevenueCat webhook authenticity uses raw-body HMAC, timestamp freshness, constant-time comparison, replay/idempotency, and out-of-order reconciliation. Apple identity verification pins issuer, audience, signature, nonce/state, and token lifetime.
- Production configuration fails closed for HTTPS origins, provider keys, webhook secrets, bundle/team identifiers, Redis, process limits, and non-debug mode. Secrets never use `EXPO_PUBLIC_`.

## Capacity and failure design

- The target remains five accepted analyses per second for 15 minutes plus the approved burst profile, measured against a production-like Render/Redis shape.
- Global PDF and AI semaphores are authoritative across processes/instances through Redis leases; local thread counts are not capacity control.
- Saturated AI returns a completed score with an honest AI status when contractually allowed. Saturated parsing returns a bounded retry response before reading the body.
- Autoscaling requires health/readiness checks, connection budgets, graceful shutdown, lease expiry, and rollback evidence. A local benchmark is not proof of Render capacity.

## App Store release design

- Digital paid analysis features use Apple IAP through RevenueCat, with purchase, pending, cancellation, restore, expiry, refund/revoke, and owner-switch states.
- The app clearly labels results as guidance rather than guaranteed hiring or ATS outcomes, explains AI transmission, and obtains affirmative consent before optional remote AI processing.
- If Sign in with Apple is offered, in-app deletion and Apple token revocation must be complete. Guest users must be able to delete local reports/workspace data without an account.
- Privacy/terms/support pages disclose resume retention, subprocess/provider processing, RevenueCat/Apple identity, deletion, and contact information.
- Screenshots use fictional resumes and claims that match actual functionality. A live backend and reviewer-accessible full flow are required.
- Signed Xcode 26 archive, privacy report, VoiceOver/Dynamic Type, large/malformed PDF device tests, TestFlight purchase/restore, and review notes remain external gates.

## Verification order

1. Add route-level failing tests proving v2 composition, pre-body admission, global leases, webhook forgery/replay rejection, and fail-closed production configuration.
2. Wire Tasks 2–4 of the approved 25k plan into the actual service and preserve v1 compatibility only where explicitly documented.
3. Wire mobile verified-plan, reviewed extraction, paginated history/workspace, and honest AI states.
4. Run backend/mobile/browser, leak/resource, secret/dependency, Expo export, and production-like load gates; record external provider/Apple evidence separately.

## Non-goals

No indefinite resume storage, no guarantee of employment or ATS acceptance, no unbounded OCR/PDF parser, no client-authoritative Pro flag, and no capacity claim from worker-count arithmetic alone.
