# Resume.AI App Store submission checklist

Status vocabulary: `PASS`, `FAIL`, `BLOCKED`, `UNVERIFIED`. Submission, Apple approval, and a live listing are separate events.

## Metadata and policy

- [x] Draft name/subtitle/description present Resume.AI as resume feedback/coaching with a deterministic readiness score and optional AI feedback.
- [x] Draft copy makes no exact ATS, hiring-decision, interview, employment-outcome, professional, legal, or guarantee claim.
- [x] Draft AI disclosure explains that feedback may be incomplete or wrong and may quote or restate submitted personal/job content.
- [x] Draft privacy answers distinguish signed-iOS on-device extraction from compatibility-web PDF upload and disclose User Content processing, installation security identity, local reports/versions/job notes and backups, Groq after consent, provider retention, RevenueCat purchases, no ads, no tracking, no login, and no behavioral analytics.
- [ ] Groq Zero Data Retention state is observed in the authoritative console. Until then, metadata says content may be retained for up to 30 days under published terms.
- [ ] Privacy and self-help URLs are anonymously reachable over HTTPS and match the shipping disclosures.
- [ ] App Review notes explain text PDF, pasted text, Vision OCR review/consent, local history, deletion, backup caveat, and synthetic review steps.
- [ ] Age rating, category, copyright, seller/contact, export compliance, and content-rights answers are completed by the authorized account holder.

## Required media

- [x] Repository icon is an opaque 1024×1024 RGB PNG.
- [ ] 1024×1024 icon is accepted by App Store Connect.
- [ ] Required 1260×2736 iPhone screenshots are captured from the shipping TestFlight binary using synthetic content and the reviewed `docs/app-store/screenshot-plan.md` sequence.
- [ ] Screenshots show real UI only; no fabricated results, private data, unsupported capability, or exact ATS/employment claim.
- [ ] Screenshot captions remain readable and truthful at App Store display size.

## Release authority and status

- [ ] Every Expo Go, device, production-backend, backup/restore, and TestFlight blocker is green.
- [ ] The exact production commit, build number, backend release, privacy/support content, and provider configuration are recorded.
- [ ] Submission is explicitly authorized before `eas submit` or any App Store Connect submission action.
- [ ] App Review result is monitored and recorded as `WAITING`, `REJECTED`, or `APPROVED` with the authoritative reason/date.
- [ ] Publication is claimed only after the public App Store listing opens anonymously and Apple shows the version live.

## Current local verification record

The August 10, 2026 working-tree gate used Python 3.12.13 and Node 22.23.2. It is implementation evidence, not signed-release evidence:

- Service: 148 production/security-boundary tests plus 597 remaining tests passed; 6 real-Redis tests were explicitly skipped because local `TEST_REDIS_URL` was absent.
- Browser client: 25 Node tests passed. The secret scan passed for 223 tracked files and the sensitive-retention scan passed.
- Mobile: 31 suites / 670 tests, typecheck, lint, Expo Doctor 18/18 with CocoaPods 1.17.0 available, the project-owned image gate, the Swift native-core invariant harness, and an iOS Expo export of 1,174 modules passed.
- Dependency gate: 12 high transitive findings remain through Expo/Metro `image-size` 1.2.1. Only the two reviewed parser advisories are allowlisted; any different high/critical advisory fails closed. The image gate reduces exposure from project-owned bundle assets but is not described as an upstream patch.
- Capacity tooling: protected staging identity/capacity canaries, fixed-cardinality content-free telemetry, two declared Render instances, and a bounded 25,000-principal load harness passed local contract tests. No production-like hosted load run has been recorded.

The current machine has only Apple Command Line Tools, not full Xcode. The custom Vision/PDFKit core invariants compile with Swift, but the Expo native module and final app cannot be archived or signed here. Signed build, physical-device behavior, production deployment, real Redis/provider load, backup/restore, Apple Sandbox, RevenueCat, TestFlight, review, and publication remain external gates.

Current status: `BLOCKED`. No accepted production deployment, EAS/Apple signing evidence, physical-device evidence, TestFlight build, App Store submission, Apple approval, or live listing has been observed.
