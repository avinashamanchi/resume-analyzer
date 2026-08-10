# Resume.AI App Store Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Resume.AI's repository-controlled iOS release packet and harden its production build contract for the Pro subscription.

**Architecture:** Keep free analysis and text sharing available without purchase. Use RevenueCat only as the StoreKit adapter for monthly/annual Pro entitlements; the API endpoint and RevenueCat Apple SDK key are public EAS environment values, while provider and App Store credentials remain server-side/external.

**Tech Stack:** Expo SDK 54, React Native 0.81, RevenueCat, Python API, SQLite, Apple Vision, EAS Build, Jest, pytest.

## Global Constraints

- No account is required and Continue Free must remain functional.
- Subscription prices must come from StoreKit, with Restore Purchases, Privacy, and Terms visible before purchase.
- Standard PDF bytes are transient; raw PDF bytes never go to the AI provider.
- Production upload must use Xcode 26 and iOS 26 SDK or later.
- Groq retention and production API availability must be verified externally before submission.

---

### Task 1: Harden versioning and release configuration

**Files:**
- Modify: `mobile/__tests__/foundation.test.tsx`
- Modify: `mobile/eas.json`

- [ ] **Step 1: Write a failing release-profile assertion**

Assert remote app-version source, clean-commit enforcement, store distribution, remote build-number auto-increment, SDK-selected Xcode image, and absence of submit credentials or secret-key fields.

- [ ] **Step 2: Verify the current static build number fails**

Run: `npm test -- --runInBand __tests__/foundation.test.tsx`
Expected: FAIL because production uses local versioning with `autoIncrement: false`.

- [ ] **Step 3: Implement remote auto-increment**

Set `cli.appVersionSource` to `remote`, production `autoIncrement` to `true`, and iOS image to `auto`; retain the public API URL and configure the public RevenueCat SDK key through EAS rather than source.

- [ ] **Step 4: Re-run the focused test**

Run: `npm test -- --runInBand __tests__/foundation.test.tsx`
Expected: PASS.

### Task 2: Add a unified release checklist

**Files:**
- Create: `docs/app-store/resume-ai-ios-release-checklist.md`
- Modify: `docs/app-store/metadata-draft.json`
- Modify: `docs/app-store/review-notes-draft.md`

- [ ] **Step 1: Record code, purchase, backend, legal, screenshot, device, and App Review gates separately**

Use checked boxes only for fresh observed repository evidence. Keep RevenueCat products, Groq retention, public Render URLs, signed Vision OCR, sandbox purchase/restore, TestFlight, screenshots, and publication unchecked.

- [ ] **Step 2: Record the anonymous endpoint result**

Document the 2026-08-07 timeout for Privacy, Terms, and Support and require a fresh anonymous HTTP 200 check before submission.

- [ ] **Step 3: Keep metadata within Apple limits**

Retain the current name, subtitle, promotional text, description, and comma-without-spaces keyword field; validate byte limits in the publication test.

### Task 3: Verify free and paid boundaries

- [ ] **Step 1: Run mobile verification**

Run: `npm test -- --runInBand && npm run typecheck && npm run lint && npx expo-doctor && npm run export:ios`.

- [ ] **Step 2: Run backend verification**

Run the Python 3.12 test suite and the repository's bounded parser/resource-leak checks.

- [ ] **Step 3: Stop at purchase and provider gates**

Do not fake entitlements, hard-code prices, configure secret keys in source, or claim subscription readiness until App Store Connect, RevenueCat, sandbox, and TestFlight evidence exists.
