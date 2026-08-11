# Resume.AI physical iPhone checklist

Candidate: `1.0.0 (1)`; bundle candidate `com.avinashamanchi.resumeai`.
Required build: EAS `development` profile produced from the accepted commit.
Status vocabulary: `PASS`, `FAIL`, `BLOCKED`, `UNVERIFIED`.

Do not use a real resume. Use synthetic content with no real contact, account, employer, school, device, or request identifiers. Store screenshots/logs only after redaction.

| Gate | Status | Observation/evidence |
| --- | --- | --- |
| Full Xcode toolchain and CocoaPods | BLOCKED | CocoaPods 1.17.0 is installed, but this Mac currently has Command Line Tools only and no full Xcode. |
| Authorized EAS/Apple credentials | BLOCKED | No credential or signing action has been authorized or observed. |
| Development build compiles, signs, installs, and launches | UNVERIFIED | Record EAS build URL/ID only after authorization; never record credentials. |
| Icon and dark launch screen on real device | UNVERIFIED | Confirm no transparency, clipping, stale Expo branding, or unintended text. |
| Native permissions match actual features | UNVERIFIED | No contacts, photos, microphone, camera, location, advertising, or tracking prompts. |
| Readable text PDF flow | UNVERIFIED | Pick, consent, analyze, results, cleanup. |
| Scanned PDF with Apple Vision/PDFKit | UNVERIFIED | Confirm local OCR, bounded deadline/cancel, deterministic reading order, editable review, consent, cleanup. |
| Encrypted/malformed/oversized/too-many-page PDF | UNVERIFIED | Fail closed with stable content-free messages. |
| OCR cancel, background, kill, relaunch | UNVERIFIED | No stale result, staged-file leak, or revived authority. |
| SecureStore installation token across relaunch/reinstall | UNVERIFIED | Record behavior only; never record the token. |
| Network offline/online, timeout, TLS failure, provider failure | UNVERIFIED | No automatic retry; no stale save; content-free error. |
| Save/reopen/delete local report | UNVERIFIED | Generated feedback warning appears before save/share. |
| Temporary share PDF cleanup | UNVERIFIED | Verify file removal after success, cancel, failure, background, and kill/recovery. |
| 320×568-equivalent screen and 200% Dynamic Type | UNVERIFIED | All content/actions scroll and remain reachable. |
| VoiceOver and Reduce Motion | UNVERIFIED | Test complete core flow, errors, deletion, OCR review, and focus restoration. |
| Memory/thermal behavior with 10-page PDF and 30,000 characters | UNVERIFIED | No crash, indefinite spinner, or unbounded retry. |

## Backup and restore matrix

Saved reports may enter device backups because they use the app's local SQLite store. Deleting an active record does not delete older backups.

| Backup gate | Status | Observation/evidence |
| --- | --- | --- |
| Unencrypted Mac/PC backup includes or excludes saved reports | UNVERIFIED | Observe backup, erase/reinstall/restore, and record report outcome. Computer backups are not encrypted by default. |
| Encrypted Mac/PC backup includes or excludes saved reports | UNVERIFIED | Repeat with Encrypt local backup enabled; do not record the backup password. |
| iCloud Backup includes or excludes saved reports | UNVERIFIED | iCloud backups are encrypted; end-to-end protection for iCloud Backup depends on Advanced Data Protection. Do not record Apple account details. |
| Delete report, restore older backup | UNVERIFIED | Record whether the deleted report returns; policy already warns that it may. |
| Delete all local data, fresh install without restore | UNVERIFIED | Confirm active reports are absent and no server history repopulates them. |

Any native compile, OCR, cleanup, privacy, data-loss, accessibility, or backup-disclosure mismatch is release-blocking.
