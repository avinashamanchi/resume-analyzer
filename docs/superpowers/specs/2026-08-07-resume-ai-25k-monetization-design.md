# Resume.AI 25k MAU Monetization Design

**Date:** 2026-08-07

**Status:** Approved product decisions; implementation pending

**Repository:** `avinashamanchi/resume-analyzer`

**Target:** iOS-first service sized and release-gated for 25,000 monthly active users

## 1. Outcome

Resume.AI remains useful before sign-in and when paid AI is unavailable. Every
accepted analysis produces the versioned deterministic resume-readiness score.
AI feedback is a separately admitted enhancement with an explicit status,
server-enforced allowance, and bounded provider cost. A RevenueCat monthly or
annual subscription unlocks the higher AI allowance and the complete local
workflow: role-specific versions, comparisons, job tracking, PDF exports, and
history without the Free plan's three-report cap.

The capacity target is 5 accepted analyses per second for 15 minutes plus a
one-second burst of 20 accepted analyses repeated every four seconds for 120
seconds. The burst target is an admission target, not a promise that 20
provider calls per second will run. The
global provider circuit breaker may return deterministic-only results during a
burst. No release claim is valid until the exact production-like Render shape
passes those gates with privacy-safe telemetry.

## 2. Fixed product decisions

- The app is guest-first. Installation identity is sufficient for Free and for
  a paid subscription used on one installation.
- Sign in with Apple is optional and appears only as `Use Pro on my other
  devices`. It is not required to analyze, purchase, restore on the current
  installation, save locally, export, compare, or track jobs.
- RevenueCat is the StoreKit integration. The entitlement remains
  `resume_pro`; products remain
  `com.avinashamanchi.resumeai.pro.monthly` and
  `com.avinashamanchi.resumeai.pro.annual`.
- Apple's localized StoreKit price is the only price rendered in the app.
- The mobile RevenueCat entitlement is a UI hint. The backend verifies the
  plan before spending paid AI budget.
- No raw PDF, extracted resume text, job description, role version, job record,
  or generated feedback is stored in cloud application storage.
- On-device PDFKit text extraction and Vision OCR are used in signed iOS builds
  when available. Extracted text must be shown for review before submission.
  Expo Go keeps paste-text and fixture flows.
- Existing server-side PDF parsing remains temporarily available to the web
  client and is protected by a separate PDF concurrency and byte budget.
- Deterministic scoring never depends on RevenueCat, Apple, Groq, or AI quota.
  AI output never changes the score.

## 3. Plans, allowances, and charging semantics

| Capability | Free | Resume.AI Pro monthly or annual |
| --- | --- | --- |
| Deterministic readiness score | Available under abuse controls | Available under abuse controls |
| AI feedback allowance | 3 provider dispatches per UTC calendar month | 100 provider dispatches per UTC calendar month |
| Local saved reports | 3 | No plan cap; 10,000-record device safety cap |
| Local role-specific versions | 1 active version | Up to 200 active versions |
| Version comparison | Score and text comparison for the saved Free version | Any two local versions |
| Local job tracker | Up to 3 active jobs | Up to 500 active jobs |
| Text sharing | Included | Included |
| PDF report export | Upgrade preview | Included |
| Cross-device paid identity | Not applicable | Optional Sign in with Apple |

Both subscription periods receive the same product capabilities. Annual is a
billing discount, not a larger AI allowance. The AI period key is the UTC
calendar month (`YYYY-MM`) so monthly and annual customers have identical,
auditable resets. A unit is reserved immediately before a provider dispatch and
is charged once dispatch starts, including provider timeout or invalid output,
because cost may already have been incurred. A reservation is released if the
provider is never called. Duplicate request IDs share one in-flight reservation
and never replay a completed sensitive response.

The response shows `used`, `limit`, and `resetsAt` without promising that all
remaining units can run simultaneously. Refunds, billing grace periods,
cancellations, and expirations follow RevenueCat's verified entitlement state.
Deterministic scoring and existing local content remain available after
entitlement loss; Pro creation/export limits are applied only to new actions.

## 4. Identity and entitlement architecture

### 4.1 Installation identity

`POST /v2/installations` returns the existing signed installation token plus a
server-derived opaque `revenueCatAppUserId`. The app configures RevenueCat with
that ID instead of allowing the SDK to invent an unrelated anonymous ID. The
backend derives both identifiers with distinct HMAC purposes. The client cannot
substitute a different RevenueCat user because every entitlement lookup is
bound to the installation ID authenticated by the signed installation token.

Purchase and restore are local StoreKit operations. After either operation the
app calls `POST /v2/entitlements/sync`. The server queries RevenueCat with its
secret API credential, confirms the exact app user, caches only entitlement
status and expiration, and returns a signed `PlanSnapshot`. RevenueCat webhooks
keep that cache current. A configured random webhook bearer secret is checked
with constant-time comparison; event IDs are idempotent. Webhook bodies and
RevenueCat responses are never logged.

### 4.2 Optional Apple identity

When a Pro customer explicitly chooses cross-device paid identity, the app uses
Sign in with Apple with a one-use nonce. `POST /v2/identity/apple` verifies the
issuer, audience `com.avinashamanchi.resumeai`, signature against Apple's JWKS,
expiration, and nonce. It HMAC-derives an opaque account ID from Apple's `sub`,
then returns a short-lived signed account token and an account-scoped
`revenueCatAppUserId`. Email, name, authorization code, Apple token, and raw
Apple subject are not stored.

The app calls RevenueCat `logIn(accountRevenueCatAppUserId)` to alias the
installation purchase, then calls the entitlement sync endpoint. A second
device repeats Apple verification, receives the same derived account identity,
logs in to RevenueCat, and gains only plan state. Local reports, versions, and
jobs do not sync. Disconnecting Apple returns the installation to its own
identity but never deletes local data.

Account tokens are accepted only alongside a valid installation token. This
keeps installation abuse controls and makes stolen account tokens insufficient
on their own.

### 4.3 Entitlement failure behavior

The backend caches a RevenueCat-verified plan snapshot for at most 25 hours and
uses webhook updates immediately. If the cache is absent or expired and
RevenueCat cannot be reached, deterministic scoring proceeds and paid AI
returns `plan_verification_unavailable`; the server does not silently spend Pro
budget or falsely downgrade the subscription in UI. The client presents a
retry action and retains its last UI snapshot with a `Verification needed`
label. No local Pro content is deleted or hidden.

## 5. API v2 and independent degradation

`POST /v2/analyses` accepts reviewed text or a compatibility PDF. Required
headers are:

- `Authorization: Installation <signed token>`
- `X-Resume-Source: reviewed_text` or `pdf`
- `X-Resume-AI: requested` or `not_requested`
- optional `X-Resume-Account: <short-lived account token>`

The multipart form retains `request_id`, `consent_version`, optional
`job_description`, and exactly one of `resume_text` or `resume_pdf`. Signed iOS
builds use `reviewed_text`; `pdf` exists for the web compatibility path. The
strict response is:

```json
{
  "schemaVersion": 2,
  "analysisId": "8ec8a3bc-7a15-4b75-9f94-a5353a2a2f9b",
  "sourceType": "reviewed_text",
  "score": {
    "scoreVersion": "resume-readiness-v1",
    "readinessScore": 78,
    "label": "Good",
    "components": {"structure": 23, "impact": 24, "readability": 18, "keywords": 13},
    "explanations": ["The resume includes the expected core sections."]
  },
  "ai": {
    "status": "complete",
    "feedback": {
      "matchedKeywords": ["Python"],
      "missingKeywords": ["Redis"],
      "strengths": ["Uses measurable outcomes."],
      "improvements": ["Add one reliability example."],
      "powerBullets": ["Built Python services used by 1,000 customers."],
      "summary": "Relevant experience with room for more role detail.",
      "simulatedRecruiterComment": "Simulated AI recruiter feedback: The resume shows relevant experience."
    },
    "allowance": {"used": 1, "limit": 3, "resetsAt": "2026-09-01T00:00:00Z"}
  }
}
```

`ai.status` is exactly one of `complete`, `not_requested`, `quota_exhausted`,
`plan_verification_unavailable`, `temporarily_unavailable`, `timeout`, or
`invalid_provider_response`. `feedback` is non-null only for `complete`.
Provider problems therefore produce HTTP 200 with a validated score and a
content-free AI status. Invalid input, invalid auth, request abuse, and unsafe
PDF conditions remain non-200 errors.

The v1 endpoint remains during one App Store version and web migration. It does
not gain paid semantics. Removal requires observed v2 adoption and an explicit
deprecation release.

## 6. Admission, quotas, and circuit breakers

Admission runs before Flask parses form fields or reads multipart bytes. The
header-only phase verifies content length, exact source and AI intent headers,
installation/account tokens, request-level abuse limits, plan state, quota
availability, and capacity reservations. Every reservation has a 15-second TTL
and an owner nonce; release uses compare-and-delete. Redis outage fails closed
for AI/PDF capacity while allowing a bounded reviewed-text deterministic score
path through a per-process emergency limiter of 2 requests per second with no
burst carryover.

Exact initial limits are:

- Global analysis token bucket: 5 requests/second refill, capacity 20.
- Per installation: 30 analyses/minute and 300/day.
- Per optional account: 60 analyses/minute and 600/day across installations.
- Provider dispatch: 5/minute per installation and 10/minute per account, in
  addition to the monthly plan allowance.
- Global provider reservations: 48 concurrent with 15-second TTL.
- PDF parsing: 8 concurrent globally, 2 concurrent per process, and at most
  20 MiB declared PDF request bytes per process.
- Installation issuance: 60/hour and 500/day per canonical IPv4 `/24` or IPv6
  `/64`, plus a global 50/second bucket.

Existing authorized installations are never rejected solely because many
users share an IP prefix. IP is a high-ceiling issuance/flood signal, not a
per-analysis identity. Analysis denial requires an installation/account limit
or the global bucket. This is the NAT-safe boundary. Redis keys contain HMAC
digests, counters, short plan facts, and expiring nonces only.

If the provider bucket or its 48 reservations are unavailable, the request is
marked deterministic-only before the body is read; its AI allowance is not
charged. A request that claims `reviewed_text` but contains a PDF is rejected
before PDF parsing and receives no AI dispatch. A declared PDF that cannot
reserve global/local PDF capacity is rejected with `Retry-After` before its body
is read. Local byte accounting uses declared `Content-Length`; the existing
11 MiB request and 10 MiB PDF hard limits remain authoritative after parsing.

The 48-provider limit supports 5/second sustained when provider residence time
stays below 9.6 seconds. The configured provider deadline remains 8 seconds and
the total request deadline remains 10 seconds. If measured p95 provider time
cannot satisfy that budget, the load gate fails and capacity or product limits
must change before launch.

## 7. iOS extraction and review

The native module adds PDFKit text extraction beside the current Vision OCR.
It accepts only cache-owned PDFs, enforces 10 MiB and 10 pages, never writes
extracted text, and supports cancellation. PDFKit is tried first. Pages without
usable embedded text are processed with Vision. The combined text is capped at
30,000 Unicode code points.

Every extraction result opens a review editor that states `Only the reviewed
text will be sent`. The user can correct OCR, remove contact details, add the
optional job description, or cancel. Submission uses source type
`reviewed_text`; the raw PDF never reaches the mobile API. Cache cleanup remains
mandatory after success, failure, cancellation, backgrounding, and process
recovery. If the native module is unavailable, the app offers paste text and
does not claim PDF analysis support in that build.

## 8. Local workflow and storage

The existing report store migrates to schema version 2 and adds indexes for
stable keyset pagination. `listPage({before, limit})` uses the tuple
`(created_at, id)` and a maximum page size of 50. The History screen renders a
`FlatList`, initially loads 25 records, and fetches the next page without
reloading prior pages. Deletion removes an item in place and preserves the
cursor.

A separate local workspace database stores explicitly saved role versions and
job tracker records. It is not populated automatically by analysis. Saving a
version requires a disclosure that reviewed resume text and job details will
remain on this device and may enter device backups. The records are:

- `resume_versions`: opaque ID, user title, target role, reviewed resume text,
  optional job-description text, linked analysis ID, created/updated times,
  and archived flag.
- `version_snapshots`: immutable version ID, revision number, reviewed resume
  text, score JSON, optional AI feedback JSON, and created time.
- `jobs`: opaque ID, company label, role label, status, optional next-action
  date, optional notes, linked version ID, created/updated times, and archived
  flag.

Contact values and free-form notes are sensitive local content. They are never
sent to observability, RevenueCat, Apple identity, or cloud application storage.
Delete-one and delete-all operations are transactional and issue verified
receipts. The Settings delete-all control covers reports, workspace records,
SecureStore identity tokens, and abandoned cache files, while preserving the
ability to restore App Store purchases later.

Role-specific analysis sends the current reviewed text plus target role/job
description only after consent and consumes one AI unit. The app initializes an
editable local copy from the reviewed text and displays the returned bounded AI
suggestions beside it; suggestions are never auto-applied. Nothing is saved
until the user explicitly chooses `Save version on this device`. Comparison
itself is deterministic and local: line
changes, readiness-score component deltas, keyword deltas, and revision dates.
Job tracking is fully local and never triggers applications, email, reminders,
calendar writes, scraping, or recruiter contact.

## 9. UI behavior

The Analyze result always renders the readiness score first. The AI area then
renders one of three honest states: feedback, allowance/upgrade state, or a
service retry state. A provider outage cannot replace a valid score with a
generic failure screen.

Settings shows `Free`, `Pro — verified`, or `Pro — verification needed`, the AI
allowance/reset date, purchase/restore controls, and the optional cross-device
Apple action. There is no general account/profile screen. The Apple action
explains that only subscription identity crosses devices and local content does
not.

The History, Versions, Compare, and Jobs screens retain the existing safe-area,
44-point target, VoiceOver, 200% Dynamic Type, Reduce Motion, and 320x568
requirements. Long collections use virtualized pagination. Limits are visible
before an action, not discovered after editing work.

## 10. Privacy-safe observability

Operational telemetry uses a fixed vocabulary only:

- counters: route, status class, plan class, source class, AI status, admission
  outcome, provider outcome, and PDF outcome;
- histograms: admission, scoring, PDF, provider, and total latency using fixed
  buckets;
- gauges: provider reservations, PDF reservations, local PDF declared-byte
  budget, and Redis health;
- deployment facts: release version, process role, configured hard limits, and
  startup success.

Telemetry excludes IPs, IP digests, installation/account IDs or digests,
RevenueCat user IDs, Apple subjects/tokens, request bodies, filenames, resume or
job text, feedback, company/role labels, free-form notes, raw exceptions, and
provider responses. Request IDs may be returned to clients but are not metric
labels. Cardinality tests reject unknown labels before emission.

Release SLO gates on the production-like shape are:

- 5 accepted analyses/second for 15 minutes with at least 99% deterministic
  response success and p95 deterministic response latency below 1 second;
- a one-second 20-analysis burst repeated every four seconds for 120 seconds,
  with at least 99% deterministic response success; AI may degrade according
  to the 48-slot breaker;
- p95 complete-AI response below 10 seconds and zero provider calls beyond the
  configured concurrency;
- zero PDF parser calls beyond global 8/per-process 2 and zero declared bytes
  beyond the local 20 MiB budget;
- zero unbounded telemetry labels and zero sensitive fixture markers in logs,
  metrics, traces, crash reports, Redis keys, or retained request artifacts.

The load harness uses 25,000 synthetic installation principals and public test
fixtures only. Provider-success load runs against a controlled stub first; a
short staging canary verifies real provider behavior without private resumes.

## 11. Deployment and external gates

### Apple gate

- Paid Apps Agreement, banking, and tax state are active.
- The two exact subscription products exist in one `Resume.AI Pro` group with
  localized metadata, review image, terms, privacy links, and the intended
  storefront prices.
- Sign in with Apple capability is enabled for
  `com.avinashamanchi.resumeai`; the backend audience and Apple key material are
  verified in the production environment.
- Sandbox validates purchase, cancellation, interruption, restore, aliasing
  after optional Apple sign-in, second-device entitlement, expiration, grace
  period, refund, and disconnect behavior.
- The exact TestFlight candidate repeats purchase, restore, optional Apple
  identity, on-device extraction review, quota UI, pagination, delete-all, and
  accessibility checks.

### RevenueCat gate

- Entitlement and product identifiers exactly match this document.
- Current offering contains monthly and annual packages and returns localized
  StoreKit prices.
- The iOS app contains only the public Apple SDK key. Backend-only secrets are
  the RevenueCat REST credential and a random webhook bearer secret.
- Webhook delivery, duplicate delivery, out-of-order expiration, refund,
  account aliasing, and 25-hour cache expiry pass against staging.
- RevenueCat project transfer behavior is configured so restore and `logIn`
  produce the tested identity semantics; no launch relies on an unverified
  dashboard default.

### Render gate

- Redis uses `noeviction`, has measured headroom for 25,000 principals plus
  48 provider leases and 8 PDF leases, and fails closed without leaking details.
- The web service runs at least two instances in the production-like test and
  all admission/quota state is shared through Redis. Per-process PDF byte
  budgets remain local by design.
- Compute/RAM instance size and Gunicorn worker/thread counts are selected from
  measured staging results, written into `render.yaml`, and re-tested after the
  exact change. The current Starter declaration is not accepted as 25k proof.
- Production secrets for Groq, installation signing, RevenueCat REST/webhook,
  and Apple verification are configured in Render and absent from repository,
  mobile bundle, logs, and build output.
- Autoscaling, deploy health, rollback, Redis outage, provider outage, and
  webhook retry drills are recorded before rollout.

## 12. Rollout

1. Ship the v2 response and deterministic-only degradation behind a disabled
   server flag; keep clients on v1.
2. Enable privacy-safe metrics and run unit, contract, concurrency, and stub
   load gates.
3. Ship the mobile v2 reader, on-device review, pagination, and local workspace
   while purchases remain sandbox-only.
4. Complete Apple, RevenueCat, and Render gates, then enable v2 for internal
   TestFlight.
5. Release to 5%, 25%, 50%, and 100% with an automatic kill switch for AI
   dispatch. The kill switch preserves deterministic scoring.
6. Observe one full App Store version before removing v1 or changing the web
   PDF compatibility path.

## 13. Acceptance criteria

- Free and Pro users receive deterministic scoring when AI is not requested,
  quota is exhausted, plan verification is unavailable, the provider is down,
  or the 48-slot breaker is full.
- Monthly allowances are atomically enforced on the backend, duplicate request
  IDs cannot double-charge, and mobile entitlement state cannot authorize AI.
- Existing authorized users behind shared NAT are not blocked solely by IP.
- Signed iOS builds submit only reviewed text; raw PDFs stay on device and are
  verifiably cleaned.
- Optional Apple identity moves paid identity between devices without moving
  local content and without becoming a general sign-in requirement.
- Report history is keyset-paginated and remains responsive at the 10,000-record
  safety cap.
- Role versions, comparison, and job tracking are functional and local-only by
  default, with explicit save/delete behavior.
- Privacy-safe observability and both load profiles pass on the exact
  production-like Render shape.
- Apple sandbox/TestFlight, RevenueCat webhook/alias, and Render capacity gates
  have recorded evidence. Source changes and green unit tests alone do not
  satisfy those external gates.
