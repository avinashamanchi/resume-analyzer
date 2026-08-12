# Resume.AI Landing Live Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a polished first-viewport coaching demonstration and clear navigation before the existing Resume.AI analysis form.

**Architecture:** Keep the demo in a standalone browser module with pure stage helpers and no access to request lifecycle or tokens. Extend the semantic static document and stylesheet while preserving all form IDs, consent language, API behavior, and report rendering.

**Tech Stack:** Semantic HTML, modern CSS, dependency-free JavaScript, Flask static serving, Node test runner, Pytest

## Global Constraints

- Demo stages are exactly `original`, `annotated`, `priorities`, and `improved`.
- The demo cannot fetch, submit, read files, issue tokens, or touch session storage.
- The example must stay labeled as coaching and not a hiring decision.
- Preserve every existing form/report ID and request-lifecycle behavior.
- Reduced motion renders the completed comparison without autoplay.

---

### Task 1: Isolated coaching-demo module

**Files:**
- Create: `static/landing_demo.js`
- Create: `tests/landing_demo.test.cjs`

**Interfaces:**
- Produces: `globalThis.ResumeAILandingDemo.STAGES`, `nextStage(stage)`, and `createController(options)`.

- [ ] **Step 1: Write failing Node tests**

Load the browser module in `node:vm` and assert stage order, wraparound, reduced-motion completion, pause, replay, and disposal. Stub `fetch`, `sessionStorage`, and form submission to throw if called.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/landing_demo.test.cjs`
Expected: FAIL because `static/landing_demo.js` does not exist.

- [ ] **Step 3: Implement a timer-injected controller**

Expose fixed stages and accept `setTimer`, `clearTimer`, `onStage`, and `reducedMotion` options. `play`, `pause`, `replay`, `select`, and `dispose` must be deterministic and content-free.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test tests/landing_demo.test.cjs`
Expected: PASS with no network or storage access.

### Task 2: Entry hero and annotated document preview

**Files:**
- Modify: `static/index.html`
- Modify: `static/styles.css`
- Modify: `static/landing_demo.js`
- Modify: `tests/test_web_client.py`

**Interfaces:**
- Consumes: `ResumeAILandingDemo.createController()`.
- Preserves: `#analysis-form` and every existing field/report identifier.

- [ ] **Step 1: Add failing document-contract assertions**

Assert `#demo`, `#method`, `#analysis-form`, an accessible demo region, Pause, Replay, four stage controls, and navigation links. Assert the original consent copy remains present.

- [ ] **Step 2: Run the focused Flask/client tests and verify RED**

Run: `pytest tests/test_web_client.py -q && node --test tests/landing_demo.test.cjs`
Expected: document assertions FAIL before markup changes.

- [ ] **Step 3: Build the approved entry composition**

Add sticky navigation, a split hero, the fixed before/after sample, Method and Privacy sections, and a `Review my resume` anchor that focuses the form heading. Load `landing_demo.js` with `defer` before `app.js`.

- [ ] **Step 4: Implement responsive visual tokens and interaction binding**

Use the approved Paper/Ink/Cobalt/Highlighter palette, preserve the skip link and readable form controls, and bind IntersectionObserver, reduced motion, stage buttons, pause, and replay.

- [ ] **Step 5: Run web-client verification**

Run: `pytest tests/test_web_client.py -q && node --test tests/*web_client*.test.cjs tests/landing_demo.test.cjs`
Expected: PASS.

### Task 3: Full regression and visual release gate

**Files:**
- Modify only for verified defects: `static/index.html`, `static/styles.css`, `static/landing_demo.js`

- [ ] **Step 1: Capture desktop, tablet, 390-pixel, and 320-pixel entry screenshots**

Run Flask locally and verify the hero, demo, method, form transition, and footer without horizontal overflow.

- [ ] **Step 2: Verify keyboard, high zoom, reduced motion, and no-script fallback**

Expected: the skip link, navigation, controls, form, and static comparison remain understandable.

- [ ] **Step 3: Run complete backend/client/security verification and commit**

Run: `pytest -q && node --test tests/*.test.cjs && node scripts/scan-secrets.mjs --tracked`
Expected: PASS with existing production-boundary and retention tests unchanged.
