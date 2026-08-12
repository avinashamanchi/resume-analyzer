# Resume.AI landing and live-demo design

**Date:** 2026-08-11
**Status:** Approved for implementation

## Product frame

- **Subject:** Privacy-conscious resume-readiness coaching with deterministic checks separated from optional AI feedback.
- **Audience:** Job seekers who need to understand the product and its data boundary before uploading career material.
- **Single page job:** Demonstrate the coaching method, establish trust, and guide the visitor into the real review form.

## Scope

This redesign covers the public entry experience and the visual transition into the existing web analysis form. It does not change analysis contracts, consent, PDF limits, retention behavior, scores, or provider calls.

## Visual system

| Token | Value | Use |
| --- | --- | --- |
| Paper | `#F6F8FB` | Primary canvas |
| Editorial ink | `#172033` | Headlines and controls |
| Review cobalt | `#315CFF` | Primary action and annotations |
| Highlighter | `#C9F26B` | Improvement signals |
| Rule | `#D7DFE8` | Document structure |

- **Display:** Newsreader, with an editorial serif fallback.
- **Body:** Source Sans 3, with a system sans-serif fallback.
- **Utility:** IBM Plex Mono, with a system monospace fallback.
- **Layout:** A resume editor's proofing desk: decisive copy beside an annotated document preview, followed by the real form.
- **Signature:** A vague bullet is scanned, marked for specificity, and replaced with a stronger example while the readiness panel updates.

## Page structure

1. Sticky navigation: Resume.AI wordmark, Demo, Method, Privacy, Support, and Review my resume.
2. First viewport: product thesis, explicit coaching-not-hiring disclaimer, primary action, and live before/after demo.
3. Method strip separating deterministic checks from optional AI feedback.
4. Three-step explanation: choose material, approve transfer, review coaching.
5. Compact privacy boundary before the real input form.
6. Existing analysis form and report, visually integrated but behaviorally unchanged.
7. Legal/support footer.

The page must not promise interviews, ATS acceptance, hiring outcomes, or a live provider response from the demo.

## Live-demo behavior

The deterministic local simulation uses reviewed sample text and never uploads content or calls analysis endpoints.

The state machine is:

`original bullet -> annotated review -> coaching priorities -> improved example`

- It starts only when visible, includes Pause and Replay, and permits direct stage selection.
- The completed state labels the output as an example rather than a personalized result.
- Reduced-motion users receive the completed annotated comparison immediately.
- If JavaScript or motion initialization fails, the original and improved examples remain readable.
- The primary action scrolls and focuses the real analysis-form heading without submitting it.

## Navigation and responsive behavior

- Sticky navigation anchors account for header height and preserve the skip link.
- The mobile menu exposes Demo, Method, Privacy, and Support with correct expanded state.
- The document preview collapses to one column without shrinking text below a comfortable reading size.
- Form labels, notices, consent, cancel behavior, and report focus management remain intact.

## Implementation boundary

The Flask-served static client remains dependency-light. The demo is implemented as semantic HTML/CSS plus a small isolated controller in the existing static JavaScript surface. It must not share the request lifecycle, installation token, form state, or analysis renderer.

## Verification

Automated checks cover:

- deterministic stages, pause, replay, reduced motion, and off-screen suspension;
- zero demo fetches, file reads, form submissions, or session-storage writes;
- navigation, skip link, focus target, and mobile-menu semantics;
- preservation of existing client contracts and request lifecycle tests;
- copy that maintains the coaching-not-hiring and consent boundaries.

Visual checks cover desktop, tablet, 390-pixel iPhone, and 320-pixel narrow layouts, high zoom, keyboard focus, and reduced motion.

## Acceptance criteria

- The coaching method is understandable before the upload control appears.
- Visitors can reach the real form, privacy, terms, and support directly.
- The demo cannot be confused with a real personalized analysis.
- Web-client tests, backend tests, source scans, and production verification remain green.
