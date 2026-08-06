# Resume.AI App Store submission checklist

Status vocabulary: `PASS`, `FAIL`, `BLOCKED`, `UNVERIFIED`. Submission, Apple approval, and a live listing are separate events.

## Metadata and policy

- [x] Draft name/subtitle/description present Resume.AI as resume feedback/coaching with a deterministic readiness score and optional AI feedback.
- [x] Draft copy makes no exact ATS, hiring-decision, interview, employment-outcome, professional, legal, or guarantee claim.
- [x] Draft AI disclosure explains that feedback may be incomplete or wrong and may quote or restate submitted personal/job content.
- [x] Draft privacy answers disclose User Content processing, installation security identifier, coarse pseudonymous rate-limit key, local reports/backups, Groq processing after consent, provider retention limits, no ads, no tracking, no account, and no third-party analytics.
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

## Automated local verification record

The exact code candidate `11755915b05247ee0431ac13124ee5db965163dd` passed from a fresh `git clone --no-hardlinks` under Python 3.12.13 and Node 22.23.2:

- Service: 441 pytest tests; sensitive-retention verification passed.
- Browser client: 25 Node tests; the redacted scan passed for 160 tracked files.
- Mobile: 19 suites / 545 tests, typecheck, lint, Expo Doctor 20/20, iOS export (1,276 modules; 3.5 MB Hermes bundle), and npm audit with 0 vulnerabilities.
- Release structure: workflow YAML parsed, the icon was confirmed opaque at 1024×1024, and a clean iOS Expo prebuild completed without changing either package manifest.

The current machine has only Apple Command Line Tools, not full Xcode, so the custom Vision/PDFKit module is generated but not compiled here. Signed build, device behavior, production deployment, backup/restore, TestFlight, review, and publication remain external gates.

Current status: `BLOCKED`. No accepted production deployment, EAS/Apple signing evidence, physical-device evidence, TestFlight build, App Store submission, Apple approval, or live listing has been observed.
