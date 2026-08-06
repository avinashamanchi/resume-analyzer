# Resume.AI App Store submission checklist

Status vocabulary: `PASS`, `FAIL`, `BLOCKED`, `UNVERIFIED`. Submission, Apple approval, and a live listing are separate events.

## Metadata and policy

- [ ] Name/subtitle/description present Resume.AI as resume feedback/coaching with a deterministic readiness score and optional AI feedback.
- [ ] No exact ATS, hiring-decision, interview, employment-outcome, professional, legal, or guarantee claim.
- [ ] AI disclosure explains that feedback may be incomplete or wrong and may quote or restate submitted personal/job content.
- [ ] Privacy answers disclose User Content processing, installation security identifier, coarse pseudonymous rate-limit key, local reports/backups, Groq processing after consent, provider retention limits, no ads, no tracking, no account, and no third-party analytics.
- [ ] Groq Zero Data Retention state is observed in the authoritative console. Until then, metadata says content may be retained for up to 30 days under published terms.
- [ ] Privacy and self-help URLs are anonymously reachable over HTTPS and match the shipping disclosures.
- [ ] App Review notes explain text PDF, pasted text, Vision OCR review/consent, local history, deletion, backup caveat, and synthetic review steps.
- [ ] Age rating, category, copyright, seller/contact, export compliance, and content-rights answers are completed by the authorized account holder.

## Required media

- [ ] 1024×1024 icon is accepted with no alpha channel.
- [ ] Required 1260×2736 iPhone screenshots are captured from the shipping TestFlight binary using synthetic content and the reviewed `docs/app-store/screenshot-plan.md` sequence.
- [ ] Screenshots show real UI only; no fabricated results, private data, unsupported capability, or exact ATS/employment claim.
- [ ] Screenshot captions remain readable and truthful at App Store display size.

## Release authority and status

- [ ] Every Expo Go, device, production-backend, backup/restore, and TestFlight blocker is green.
- [ ] The exact production commit, build number, backend release, privacy/support content, and provider configuration are recorded.
- [ ] Submission is explicitly authorized before `eas submit` or any App Store Connect submission action.
- [ ] App Review result is monitored and recorded as `WAITING`, `REJECTED`, or `APPROVED` with the authoritative reason/date.
- [ ] Publication is claimed only after the public App Store listing opens anonymously and Apple shows the version live.

Current status: `BLOCKED`. No accepted production deployment, EAS/Apple signing evidence, physical-device evidence, TestFlight build, App Store submission, Apple approval, or live listing has been observed.
