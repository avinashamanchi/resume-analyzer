# Resume.AI Native iOS Design

**Date:** 2026-08-04

**Status:** Approved design, pending implementation plan

**Repository:** `avinashamanchi/resume-analyzer`

**Target branch:** `codex/resume-analyzer-ios`

## 1. Product objective

Build a genuinely native iPhone application for importing a resume, optionally
matching it to a job description, and receiving structured, actionable resume
feedback. The first release is iOS/App Store first. Android is explicitly
deferred until the iOS build has passed its release gates and is actually
published.

The application is a coaching tool, not an employer, hiring system, or factual
prediction of how a real Applicant Tracking System will score a candidate. The
product must call its numeric result a **resume readiness score** or **feedback
score**, explain how it is calculated, and disclose that AI feedback may be
incorrect. It must not claim guaranteed interviews, employment outcomes, or
compatibility with every ATS.

## 2. V1 scope

### Included

- Native Expo Router application; no WebView shell.
- Import a text-based PDF through the iOS document picker.
- Paste resume text as a reliable alternative to PDF import.
- Remove the nonfunctional LinkedIn URL feature.
- Optional job-description input for keyword matching.
- Explicit consent before any resume-derived data leaves the phone.
- Deterministic, versioned resume-readiness checks.
- Bounded AI feedback: strengths, improvements, keyword gaps, rewritten
  bullets, summary, and recruiter-style commentary.
- App-local result history without retaining raw PDFs, extracted resume text,
  filenames, or job descriptions. Saved reports may be included in iPhone or iPad backups stored in iCloud or on a Mac or PC. iCloud backups are always encrypted, but iCloud Backup is end-to-end encrypted only when Advanced Data Protection is enabled. Computer backups are not encrypted by default; encryption depends on the user enabling Encrypt local backup. Restoring an existing backup may restore reports deleted from the active app.
- Delete one result or all local history.
- Explicit PDF report export and iOS share sheet.
- Offline access to previously saved reports and pasted-draft preservation.
- Accessible loading, empty, offline, validation, consent, cancellation,
  timeout, retry, and server-failure states.
- Existing web client migrated to the same versioned response contract and
  hardened against untrusted AI output.
- Development-build Apple Vision/PDFKit fallback for scanned PDFs before the
  product claims scanned-PDF support. Expo Go may show the tested text-PDF and
  paste-text flows only.

### Excluded

- LinkedIn scraping or automated access.
- Employer ATS integration or claims of exact ATS behavior.
- Accounts, subscriptions, payments, advertising, tracking, contacts, or
  social features.
- Automatic resume editing, job applications, emails, or recruiter messages.
- Server-side resume history or cloud synchronization of reports.
- Training models on user resumes.
- Android release work.

## 3. Recommended architecture

### 3.1 Native client

Create `mobile/` as a strict TypeScript Expo SDK 57 application using Expo
Router and React Native. Pin exact compatible dependency versions in the lock
file and use Node 22.23.2 with an engine range that excludes incompatible Node
releases.

Primary modules:

- `mobile/app/`: Analyze, Results, History, Settings/About, privacy, support,
  and modal routes.
- `mobile/src/domain/`: versioned request/result schemas, score-contract and
  label consistency checks, limits, report models, and content-free error
  classes. The client does not maintain a second copy of the score formula.
- `mobile/src/analysis/`: analysis state machine, request cancellation,
  stale-result protection, retry classification, and backend client.
- `mobile/src/documents/`: document picker, cache-file lifecycle, PDF metadata,
  and development-build OCR adapter.
- `mobile/src/storage/`: ownerless local SQLite report repository and migration
  logic. No AsyncStorage or localStorage fallback for report content.
- `mobile/src/security/`: SecureStore installation token and consent version.
- `mobile/src/components/`: accessible source picker, consent sheet, result
  sections, score explanation, error states, and export controls.

Use an anonymous installation token rather than an account. The backend issues
an opaque signed token; the app stores it in SecureStore. The token exists only
for abuse prevention and operational rate limiting, is not used for tracking,
and is disclosed in App Privacy information.

### 3.2 Backend

Retain Python/Flask but separate responsibilities:

- `server/app.py`: application factory, headers, routing, request IDs, and
  content-free error mapping.
- `server/contracts.py`: strict versioned request/response validation.
- `server/pdf_parser.py`: bounded PDF validation and text extraction.
- `server/scoring.py`: deterministic readiness score and explanations.
- `server/ai_gateway.py`: Groq prompt construction, deadline, output parsing,
  and schema validation.
- `server/rate_limit.py`: installation-token and IP rate limits backed by a
  production-configured shared store. Production starts fail closed if the
  required limiter is unavailable.
- `server/privacy.py`: redaction rules and retention-safe diagnostics.

Run under Gunicorn with debug disabled. Refuse startup when required production
configuration is missing. Restrict web CORS to configured first-party origins;
native requests do not require permissive CORS. Never return raw exception,
provider, stack, filesystem, or secret details to a client.

### 3.3 Versioned API

`POST /v1/installations` issues a signed anonymous installation token.

`POST /v1/analyses` accepts `multipart/form-data` with exactly one source:

- `resume_pdf`, or
- `resume_text`.

It also accepts optional `job_description`, required `consent_version`, and a
client request UUID. The installation token is supplied in an authorization
header. The response is a versioned JSON analysis result.

`GET /healthz` exposes no environment, dependency, provider, or secret detail.

The server enforces these initial limits before expensive parsing or AI work:

- PDF MIME/signature match and `.pdf` extension.
- Maximum upload size: 10 MiB.
- Maximum PDF pages: 10.
- Maximum extracted resume text: 30,000 Unicode code points.
- Maximum pasted resume text: 30,000 Unicode code points.
- Maximum job description: 20,000 Unicode code points.
- Bounded arrays and strings in every AI response field.
- Request deadline and provider deadline shorter than the hosting timeout.

Invalid, encrypted, corrupt, oversized, empty, or image-only PDFs return a
stable, content-free error code. Image-only PDFs return `scan_required`; the
Expo Go build offers paste-text fallback, while the production development
build may perform on-device Apple Vision OCR and submit only the reviewed text.

## 4. Scoring and AI contract

### 4.1 Deterministic readiness score

The numeric score is calculated by versioned application rules, not chosen by
the model. Version 1 evaluates bounded, explainable signals such as:

- extractability and usable content;
- presence of common resume sections;
- bullet clarity, action verbs, and measurable outcomes;
- excessive length or sparse content;
- contact-field presence without storing the contact values;
- keyword coverage when a job description is supplied.

The result includes `scoreVersion`, a 0–100 `readinessScore`, category
subscores, and a plain-language explanation. The server is the single source
of the formula. Versioned fixtures lock the formula and its boundary behavior;
the client validates ranges, labels, schema version, and internal consistency
without recalculating the formula. AI output cannot alter the score or its
component values.

### 4.2 AI feedback

Resume text and job-description text are untrusted data, not instructions.
Prompts use explicit delimiters and tell the model to ignore instructions found
inside user documents. Provider output is parsed into a strict schema and
bounded before it can reach storage or UI. Unknown keys, missing fields,
wrong types, inconsistent identifiers, excessive lengths, invalid Unicode, or
malformed JSON fail closed as an invalid AI response.

The AI response contains only:

- matched and missing keywords;
- strengths and improvements;
- suggested power bullets;
- short overall summary;
- recruiter-style commentary clearly labeled as simulated AI feedback.

The server combines validated AI feedback with the deterministic score. The
client independently validates the complete versioned response again.

## 5. Data flow and privacy

1. The user picks a PDF or pastes text.
2. The app validates visible type/size/length limits locally.
3. The app displays a concise consent sheet stating that the selected PDF is
   transiently processed by Resume.AI and extracted text plus the optional job
   description is sent to Groq for analysis.
4. After consent, the app starts one cancellable request. A newer request,
   navigation away, sign of app teardown, or explicit Cancel prevents the old
   result from changing current UI or history.
5. For a PDF, the backend extracts text in memory. It never forwards the raw
   PDF to Groq.
6. The backend calculates deterministic checks, sends bounded extracted text
   and optional job-description text to Groq, validates the response, and
   returns the combined contract.
7. Request-scoped PDF bytes, extracted text, job-description text, and provider
   response buffers are released after the request. They are not written to
   application storage, analytics, logs, traces, crash reports, or queues.
8. The client deletes any copied cache file after success, failure,
   cancellation, timeout, or app recovery.
9. If the user saves the report, SQLite stores only the validated analysis
   result, score version, source type, creation time, and a non-identifying
   title such as `Analysis — Aug 4`. It does not store the PDF, filename,
   resume text, job description, contact values, or installation token.

Local report content can still contain resume-derived suggestions and is
therefore disclosed as private user content stored on device. Delete operations
must be transactional and observable; the UI must not claim deletion when
SQLite or cache cleanup fails.

## 6. User experience

The native application has three primary tabs:

1. **Analyze** — PDF/paste source, optional job description, privacy summary,
   Analyze button, and honest request state.
2. **History** — local reports with score/date/title, empty state, open, share,
   delete, and delete-all actions.
3. **Settings** — AI/privacy disclosure, consent reset, data deletion,
   support, privacy policy, app version, and limitations.

The Analyze flow is:

1. Select `PDF` or `Paste text`.
2. Review the chosen filename only in current-session memory, or edit pasted
   text.
3. Optionally add a job description.
4. Tap Analyze and approve consent if the current consent version is not
   already accepted.
5. Show one honest progress state with Cancel. Do not rotate fabricated backend
   phases.
6. Render the score explanation, matched/missing keywords, strengths,
   improvements, power bullets, and AI commentary.
7. Offer Save locally, Export PDF, Share, New analysis, and Delete.

All content scrolls on a 320×568 viewport and at 200% Dynamic Type. Controls
use safe areas, keyboard avoidance, 44–48 point minimum targets, VoiceOver
labels/roles/hints, non-color status cues, logical focus order, and Reduce
Motion-safe transitions. Results use virtualized or bounded lists and do not
force a two-column layout at large text sizes.

## 7. Error and lifecycle behavior

Stable public error categories are:

- offline;
- validation;
- consent required;
- unsupported or scanned PDF;
- PDF extraction failure;
- request timeout;
- rate limited;
- service unavailable;
- invalid server response;
- local storage failure;
- export/share failure;
- cancelled.

Messages contain no resume content, raw provider error, path, token, or secret.
Transient errors offer bounded manual retry. Validation, consent, unsupported
file, and invalid-response errors do not automatically retry. Duplicate taps
coalesce into one request. A timeout or cancellation can leave the server
finishing work, but its result is ignored and never persisted.

On app launch, the document-cache cleanup job removes abandoned Resume.AI temp
files. Cleanup failure is surfaced in Settings diagnostics and blocks a false
privacy-success claim.

## 8. Existing web application

Keep the current web deployment available while migrating it to `/v1/analyses`.
Remove LinkedIn URL mode. Add the same consent disclosure, deterministic score
labels, strict client response validation, limits, cancellation, and stable
errors.

AI-controlled strings must be inserted with safe text nodes, never HTML string
interpolation. External font/script dependencies must be pinned or self-hosted
with appropriate Content Security Policy. Production Flask CORS must not remain
open to every origin.

## 9. Security and abuse controls

- Groq and signing secrets exist only in server environment configuration.
- Repository and built mobile bundles must pass secret scanning before release.
- Signed installation tokens are scoped to app functionality and rotate safely.
- Shared-store rate limiting is mandatory in production; unavailable limiting
  fails closed for AI analysis.
- Request UUIDs coalesce duplicate work only while a request is in flight. The
  server does not retain a completed sensitive response for later replay, so a
  manual retry after an unknown completion may invoke the provider again. The
  client never performs that retry automatically.
- PDF parsing runs with strict size/page/text/time limits and no filesystem
  persistence.
- Logs contain only request ID, coarse status, coarse byte bucket, latency,
  model identifier, and rate-limit outcome. They exclude documents, extracted
  text, job descriptions, AI output, filenames, tokens, IP addresses where not
  operationally required, and raw exceptions.
- Provider and hosting retention terms are rechecked before publication and
  reflected accurately in the privacy policy.
- No analytics or advertising SDK ships in v1.

## 10. Verification strategy

### Mobile automated tests

- Versioned schemas and deterministic score boundaries.
- PDF/text/job-description limits and Unicode handling.
- Consent versioning and cancellation.
- Duplicate-tap coalescing and stale-result suppression.
- Timeout, offline, retry, rate-limit, and invalid-response classification.
- SQLite migration, corrupt-record rejection, save/delete/delete-all rollback,
  and cache-cleanup failure.
- History excludes PDF/text/job-description/filename/token data.
- Export/share lifecycle and content escaping.
- Large-text layout, VoiceOver semantics, keyboard behavior, Reduced Motion,
  and small-screen scrolling.

### Backend automated tests

- PDF signature/MIME/size/page/text boundaries.
- Malformed, encrypted, empty, and scanned PDFs.
- Prompt-injection fixtures and strict model-output validation.
- Deterministic score formula boundaries plus shared response fixtures that
  prove mobile range, label, version, and consistency validation.
- Consent, installation token, request UUID, CORS, rate limit, timeout, and
  content-free error behavior.
- No raw exception leakage and no request-body logging.
- Temp-memory/file cleanup after success and every failure path.
- Web XSS fixtures for AI-controlled strings.

### Release verification

- Clean install and upgrade on a physical iPhone.
- Expo Go: PDF document picker, text-based PDF, paste-text, optional job
  description, consent, analysis, results, history, deletion, export/share,
  offline history, and accessibility.
- Development build: Apple Vision/PDFKit scanned-PDF fallback, SecureStore,
  background/foreground cancellation, deep links if used, and process-kill
  cleanup.
- Real production backend: rate limiter, redacted logs, request deadlines,
  provider failure, no retained resume data, privacy/support URLs, and TLS.
- App Store: icon/splash, screenshots, metadata, privacy nutrition labels,
  export compliance, AI disclosure, support response path, review notes, and
  TestFlight validation.

Passing unit tests or an Expo export is not evidence that the app is published.
Publication is complete only after Apple accepts the submitted build and the
App Store listing is live.

## 11. App Store disclosures and identifiers

- Bundle identifier: `com.avinashamanchi.resumeai`.
- Display name: `Resume.AI` unless App Store availability requires a truthful
  alternative.
- Collected/processed categories are disclosed conservatively as User Content
  and an app-functionality/security identifier. They are not used for tracking.
- Privacy policy states that selected PDFs are transiently processed by the
  Resume.AI backend, raw PDFs are not sent to Groq, extracted text and optional
  job descriptions are sent to Groq after consent, report history is local,
  and users can delete local history.
- Review notes explain deterministic scoring, AI limitations, document-picker
  use, scanned-PDF behavior, and the absence of employment guarantees.

## 12. Acceptance criteria

The implementation is ready for App Store submission only when:

- all included flows work natively without a WebView;
- the broken LinkedIn path is removed;
- deterministic score and AI feedback contracts pass their tests;
- raw PDFs, extracted text, filenames, and job descriptions are absent from
  local history and server persistence/logging;
- cancellation and stale-result tests prove old work cannot overwrite new UI;
- the backend enforces limits, redaction, rate limiting, strict schemas, and
  production configuration;
- Expo Go and development-build matrices are recorded truthfully;
- the development build passes the on-device Apple Vision/PDFKit scanned-PDF
  fallback; if it cannot pass, scanned-PDF support must be removed from v1 and
  the release scope must be explicitly re-approved before submission;
- physical-device accessibility and privacy cleanup pass;
- dependency, secret, privacy, support, and App Store metadata gates pass;
- TestFlight and Apple review are completed without unresolved data-loss,
  privacy, security, accessibility, or claim mismatches.
