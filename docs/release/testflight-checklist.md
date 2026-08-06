# Resume.AI TestFlight checklist

Status vocabulary: `PASS`, `FAIL`, `BLOCKED`, `UNVERIFIED`. A successful archive or upload is not App Store publication.

## Candidate identity

| Item | Candidate | Status |
| --- | --- | --- |
| App name | Resume.AI | UNVERIFIED in App Store Connect |
| Bundle identifier | `com.avinashamanchi.resumeai` | UNVERIFIED with Apple account |
| Marketing version | `1.0.0` | CONFIGURED |
| Build number | `1` | CONFIGURED; availability unverified |
| EAS project ID/owner | Not configured | BLOCKED — requires authorized EAS account setup |
| Production API origin | `https://resume-analyzer-al3g.onrender.com` | BLOCKED — root returned HTTP 200 on 2026-08-06, but the accepted candidate health route returned HTTP 404 |
| Privacy URL | `https://resume-analyzer-al3g.onrender.com/static/privacy.html` | BLOCKED — returned HTTP 404 on 2026-08-06 |
| Support URL | `https://resume-analyzer-al3g.onrender.com/static/support.html` | BLOCKED — returned HTTP 404 on 2026-08-06 |

## Build and beta gates

- [ ] `npx eas-cli build --platform ios --profile production` is explicitly authorized and succeeds from a clean accepted commit.
- [ ] Archive contains the intended icon, splash, bundle ID, version/build, and no development URL/secret.
- [ ] Export-compliance answer matches `ITSAppUsesNonExemptEncryption=false` and actual binary behavior.
- [ ] Upload to App Store Connect is explicitly authorized and processing succeeds.
- [ ] Internal TestFlight install succeeds on a clean device and an upgrade from the prior test build.
- [ ] Production backend TLS, health, consent, limits, Redis rate/lease behavior, provider timeout, and content-free logs are observed with synthetic data.
- [ ] Privacy and self-help links open anonymously from the TestFlight build.
- [ ] Full physical-device checklist passes on the TestFlight binary, including Vision OCR and backup/restore observations.
- [ ] Crash/diagnostic output contains no source content, generated feedback, filenames, contact values, tokens, direct IPs, or request bodies.
- [ ] Twelve moderate transitive Expo/xcode/uuid advisories are rechecked; no breaking `--force` downgrade is applied silently.

Store the EAS/App Store build identifiers, dates, and redacted screenshots under `docs/release/evidence/` only after they exist. Do not store credentials, signing material, personal resumes, device identifiers, or provider secrets.
