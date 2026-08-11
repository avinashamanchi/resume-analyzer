# Resume.AI Apple Review Guidelines Hardening Plan

> **For implementation:** Execute each task in order with RED-before-production TDD and keep signed-build/provider/App Store work explicitly external.

**Goal:** Align the Resume.AI iOS package and reviewer materials with every applicable current Apple App Review requirement.

**Architecture:** Preserve the guest-first local workspace, reviewed remote-analysis consent boundary, and RevenueCat subscription model. Add official purchase/refund help, remove a development-only local-network declaration from the tracked release plist, and document every guideline decision.

**Tech stack:** Expo SDK 54, React Native, Expo Router, RevenueCat, Jest, TypeScript, Python backend.

---

### Task 1: Record complete applicability

**Files:**
- Create: `docs/app-store/apple-review-guideline-applicability.md`
- Modify: `docs/app-store/resume-ai-ios-release-checklist.md`

1. Map all five guideline sections to `IMPLEMENTED`, `EXTERNAL GATE`, or `NOT APPLICABLE`.
2. Record the guest-first/no-account decision, local deletion, AI consent, subscription, employment-claim limits, and public-link requirements.

### Task 2: Add Apple purchase and refund help

**Files:**
- Test: `mobile/__tests__/upgradeFlow.test.tsx`
- Modify: `mobile/src/legal/links.ts`
- Modify: `mobile/app/upgrade.tsx`
- Modify: `static/support.html`

1. Add a failing test for an official Apple purchase/refund-help control.
2. Observe RED, then add the exact official URL and accessible control.
3. Add matching restore, cancellation, and refund help to the support page.
4. Rerun focused tests to green.

### Task 3: Remove release-only permission drift

**Files:**
- Test: `mobile/__tests__/foundation.test.tsx`
- Create: `mobile/plugins/withReleaseNetworkPolicy.cjs`
- Modify: `mobile/app.json`

1. Add a failing assertion for a production-only release-plist policy.
2. Observe RED, register a config plugin that removes development-only Bonjour/local-network declarations, disables arbitrary ATS loads, and removes localhost transport exceptions during the production prebuild while preserving development-client behavior, then rerun the test.

### Task 4: Make reviewer instructions exact

**Files:**
- Modify: `docs/app-store/review-notes-draft.md`
- Modify: `docs/app-store/monetization-setup.md`
- Modify: `docs/app-store/resume-ai-ios-release-checklist.md`

1. Document the guest path, PDF/on-device extraction, exact reviewed remote payload, Free continuation, products, restore, deletion, and claim limitations.
2. Gate optional subscription offers and every credentialed step.

### Task 5: Verify

**Files:** none

1. Run focused tests, full mobile tests, typecheck, lint, Expo Doctor, asset gate, production audit gate, and cache-free iOS export.
2. Run the full backend suite and browser tests.
3. Stage only intended paths and commit independently.
