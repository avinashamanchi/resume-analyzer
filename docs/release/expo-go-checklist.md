# Resume.AI Expo Go checklist

Candidate: `1.0.0 (1)`
Status vocabulary: `PASS`, `FAIL`, `BLOCKED`, `UNVERIFIED`.
Evidence must be synthetic and must not contain a resume, job description, contact value, token, request identifier, filename, device identifier, or credential.

Expo Go can verify JavaScript/native-client behavior for pasted text and text-based PDFs. Apple Vision/PDFKit OCR is always `UNVERIFIED — development build required` here.

| Gate | Status | Observation/evidence |
| --- | --- | --- |
| Node 22 frozen install and Expo Doctor | PASS | Frozen lockfile under Node 22; Expo Doctor 18/18 on 2026-08-09. |
| iOS static export | PASS | 1,147 modules; Hermes bundle approximately 4.83 MB on 2026-08-09. |
| Expo Go opens from LAN QR | UNVERIFIED | Requires the user's iPhone and Expo Go on the same network. |
| Service-unavailable state without a verified backend | UNVERIFIED | Confirm the app blocks analysis clearly and retains no staged PDF. |
| Paste synthetic resume text | UNVERIFIED | Confirm limits, remaining count, keyboard behavior, and no hidden save. |
| Add/remove optional synthetic role description | UNVERIFIED | Confirm score branch and immutable submitted context. |
| Pick readable text PDF under 10 MiB/10 pages | UNVERIFIED | Confirm source name is display-only and temporary copy is cleaned after processing. |
| Reject oversized, encrypted, malformed, and non-PDF files | UNVERIFIED | Record only stable error categories. |
| Scanned PDF | BLOCKED | Expo Go cannot load the local Vision/PDFKit module; use the development build. |
| Consent review, accept, and decline | UNVERIFIED | Decline must make no network analysis request and clean exact staged ownership. |
| Cancel, navigate away, background, and resume | UNVERIFIED | Older results/errors must never update newer UI or history. |
| Successful results and deterministic score explanation | UNVERIFIED | Confirm AI feedback cannot change score/components. |
| Save locally, History, reopen, delete | UNVERIFIED | Nothing saves automatically; delete affects the active local store. |
| Share text summary | UNVERIFIED | Review generated feedback for synthetic personal text before sharing. |
| Share PDF report and temporary export cleanup | UNVERIFIED | Confirm share dismissal/failure removes the temporary PDF. |
| Offline History and deletion | UNVERIFIED | Saved local reports remain usable without a network request. |
| 320×568 layout at 200% Dynamic Type | UNVERIFIED | No clipped actions or horizontal overflow. |
| VoiceOver labels, order, announcements, and focus recovery | UNVERIFIED | Test consent, errors, results, save/share, and delete confirmation. |
| Reduce Motion | UNVERIFIED | No required information depends on animation. |
| Privacy and self-help pages | UNVERIFIED | Copy must disclose provider retention and generated-feedback content. |

Completion requires dated observations from the actual iPhone. Automated tests and static export do not convert an `UNVERIFIED` row to `PASS`.
